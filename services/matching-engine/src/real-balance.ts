// Phase 2b — pure evaluator for the real-balance margin check.
//
// Decoupled from express, fetch, and the engine class so the math can be
// unit-tested in isolation. The HTTP wrapper in index.ts:
//   1) projects engine state into base units via the 3 helpers,
//   2) calls evaluateRealBalance(...) with an injectable fetcher,
//   3) maps the returned Decision to an HTTP response.

export type FetchBalanceFn = (walletAddress: string) => Promise<{ deposited: bigint; withdrawn: bigint; latencyMs: number }>;

export interface EngineProjection {
  realizedBaseUnits: bigint;
  unrealizedBaseUnits: bigint;
  usedMarginBaseUnits: bigint;
}

export type Decision =
  | {
      kind: "accept";
      availableBaseUnits: bigint;
      availableUsdc: number;
      requiredBaseUnits: bigint;
      latencyMs: number;
    }
  | {
      kind: "insufficient";
      availableBaseUnits: bigint;
      requiredBaseUnits: bigint;
      latencyMs: number;
    }
  | {
      kind: "settlement_down";
      cause: string;
    };

export interface EvaluateInput {
  walletAddress: string;
  requiredBaseUnits: bigint;
  gasReserveBaseUnits: bigint;
  projection: EngineProjection;
  fetchBalance: FetchBalanceFn;
}

// available_margin (per user-provided formula):
//   = (deposited − withdrawn) + realized_pnl + unrealized_pnl − used_margin − gas_reserve
// All arithmetic in BigInt 6-decimal USDC base units. Settlement provides raw
// integer deposited/withdrawn. Engine state is projected through conservative
// rounding helpers so this layer never inflates available beyond truth.
export async function evaluateRealBalance(input: EvaluateInput): Promise<Decision> {
  let fetched: { deposited: bigint; withdrawn: bigint; latencyMs: number };
  try {
    fetched = await input.fetchBalance(input.walletAddress);
  } catch (error) {
    return { kind: "settlement_down", cause: error instanceof Error ? error.message : "unknown settlement error" };
  }

  const gross = fetched.deposited - fetched.withdrawn;
  const availableBaseUnits =
    gross
    + input.projection.realizedBaseUnits
    + input.projection.unrealizedBaseUnits
    - input.projection.usedMarginBaseUnits
    - input.gasReserveBaseUnits;

  if (availableBaseUnits < input.requiredBaseUnits) {
    return {
      kind: "insufficient",
      availableBaseUnits,
      requiredBaseUnits: input.requiredBaseUnits,
      latencyMs: fetched.latencyMs
    };
  }

  return {
    kind: "accept",
    availableBaseUnits,
    availableUsdc: Number(availableBaseUnits) / 1_000_000,
    requiredBaseUnits: input.requiredBaseUnits,
    latencyMs: fetched.latencyMs
  };
}

// Compute required initial margin for an order in base units. Uses limit
// price when present, otherwise mark. Leverage clamped to [1, 50] to match
// engine clamp. Result is ceil'd so we never under-reserve.
export function computeRequiredMarginBaseUnits(params: {
  quantity: number;
  price: number;
  leverage: number;
}): bigint {
  const leverage = Math.max(1, Math.min(50, params.leverage || 1));
  const notional = params.quantity * params.price;
  const margin = notional / leverage;
  return BigInt(Math.ceil(margin * 1_000_000));
}

// Default HTTP fetcher with content-type guard, 3s timeout, and latency
// measurement. Throws on non-200, non-JSON, or timeout — caller (evaluator)
// converts thrown errors into settlement_down decisions.
export async function defaultFetchBalance(settlementUrl: string, walletAddress: string, timeoutMs = 3000): Promise<{ deposited: bigint; withdrawn: bigint; latencyMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(`${settlementUrl}/balances/${walletAddress}`, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Math.round(performance.now() - started);
  const ctype = res.headers.get("content-type") ?? "";
  if (!res.ok) throw new Error(`settlement responded ${res.status}`);
  if (!ctype.includes("json")) throw new Error(`settlement returned non-JSON content-type=${ctype}`);
  const body = await res.json() as { deposited?: string; withdrawn?: string };
  return {
    deposited: BigInt(body.deposited ?? "0"),
    withdrawn: BigInt(body.withdrawn ?? "0"),
    latencyMs
  };
}
