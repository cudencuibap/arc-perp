import { describe, expect, it } from "vitest";
import { computeRequiredMarginBaseUnits, evaluateRealBalance, type EngineProjection } from "../real-balance.js";

const ZERO_PROJECTION: EngineProjection = {
  realizedBaseUnits: 0n,
  unrealizedBaseUnits: 0n,
  usedMarginBaseUnits: 0n
};

function mockFetch(deposited: bigint, withdrawn: bigint, latencyMs = 5) {
  return async () => ({ deposited, withdrawn, latencyMs });
}

describe("evaluateRealBalance — formula sanity", () => {
  it("ACCEPT when gross alone covers required (no PnL, no margin)", async () => {
    const decision = await evaluateRealBalance({
      walletAddress: "0xabc",
      requiredBaseUnits: 1_000_000n,
      gasReserveBaseUnits: 100_000n,
      projection: ZERO_PROJECTION,
      fetchBalance: mockFetch(2_000_000n, 0n)
    });
    expect(decision.kind).toBe("accept");
    if (decision.kind === "accept") {
      // 2_000_000 (gross) - 100_000 (gas) = 1_900_000 available
      expect(decision.availableBaseUnits).toBe(1_900_000n);
      expect(decision.availableUsdc).toBeCloseTo(1.9, 6);
    }
  });

  it("ACCEPT with mixed PnL components matches hand calculation", async () => {
    // gross = 1_000_000, realized = +200_000, unrealized = -50_000,
    // used = 300_000, gas = 100_000 → available = 1_000_000 + 200_000
    // - 50_000 - 300_000 - 100_000 = 750_000
    const decision = await evaluateRealBalance({
      walletAddress: "0xabc",
      requiredBaseUnits: 750_000n,
      gasReserveBaseUnits: 100_000n,
      projection: {
        realizedBaseUnits: 200_000n,
        unrealizedBaseUnits: -50_000n,
        usedMarginBaseUnits: 300_000n
      },
      fetchBalance: mockFetch(1_000_000n, 0n)
    });
    expect(decision.kind).toBe("accept");
    if (decision.kind === "accept") expect(decision.availableBaseUnits).toBe(750_000n);
  });
});

describe("evaluateRealBalance — INSUFFICIENT_MARGIN", () => {
  it("rejects when required exceeds available by 1 base unit (BigInt boundary)", async () => {
    const decision = await evaluateRealBalance({
      walletAddress: "0xabc",
      requiredBaseUnits: 1_900_001n,
      gasReserveBaseUnits: 100_000n,
      projection: ZERO_PROJECTION,
      fetchBalance: mockFetch(2_000_000n, 0n)
    });
    expect(decision.kind).toBe("insufficient");
    if (decision.kind === "insufficient") {
      expect(decision.availableBaseUnits).toBe(1_900_000n);
      expect(decision.requiredBaseUnits).toBe(1_900_001n);
    }
  });

  it("accepts when required == available exactly (BigInt boundary)", async () => {
    const decision = await evaluateRealBalance({
      walletAddress: "0xabc",
      requiredBaseUnits: 1_900_000n,
      gasReserveBaseUnits: 100_000n,
      projection: ZERO_PROJECTION,
      fetchBalance: mockFetch(2_000_000n, 0n)
    });
    expect(decision.kind).toBe("accept");
  });

  it("rejects when withdraw drains all gross", async () => {
    const decision = await evaluateRealBalance({
      walletAddress: "0xabc",
      requiredBaseUnits: 1n,
      gasReserveBaseUnits: 0n,
      projection: ZERO_PROJECTION,
      fetchBalance: mockFetch(5_000_000n, 5_000_000n)
    });
    expect(decision.kind).toBe("insufficient");
  });

  it("gas reserve is enforced — wallet with gross == reserve has 0 available", async () => {
    const decision = await evaluateRealBalance({
      walletAddress: "0xabc",
      requiredBaseUnits: 1n,
      gasReserveBaseUnits: 100_000n,
      projection: ZERO_PROJECTION,
      fetchBalance: mockFetch(100_000n, 0n)
    });
    expect(decision.kind).toBe("insufficient");
    if (decision.kind === "insufficient") expect(decision.availableBaseUnits).toBe(0n);
  });

  it("realized loss subtracts conservatively", async () => {
    // gross 1M, realized −500_001 (engine-side conservative ceil already applied)
    // → available = 1_000_000 + (−500_001) − 100_000 = 399_999
    const decision = await evaluateRealBalance({
      walletAddress: "0xabc",
      requiredBaseUnits: 400_000n,
      gasReserveBaseUnits: 100_000n,
      projection: { realizedBaseUnits: -500_001n, unrealizedBaseUnits: 0n, usedMarginBaseUnits: 0n },
      fetchBalance: mockFetch(1_000_000n, 0n)
    });
    expect(decision.kind).toBe("insufficient");
    if (decision.kind === "insufficient") expect(decision.availableBaseUnits).toBe(399_999n);
  });
});

describe("evaluateRealBalance — SETTLEMENT_DOWN", () => {
  it("returns settlement_down when fetcher throws", async () => {
    const decision = await evaluateRealBalance({
      walletAddress: "0xabc",
      requiredBaseUnits: 1n,
      gasReserveBaseUnits: 0n,
      projection: ZERO_PROJECTION,
      fetchBalance: async () => { throw new Error("ECONNREFUSED 127.0.0.1:4105"); }
    });
    expect(decision.kind).toBe("settlement_down");
    if (decision.kind === "settlement_down") expect(decision.cause).toContain("ECONNREFUSED");
  });

  it("returns settlement_down when fetcher rejects with non-Error", async () => {
    const decision = await evaluateRealBalance({
      walletAddress: "0xabc",
      requiredBaseUnits: 1n,
      gasReserveBaseUnits: 0n,
      projection: ZERO_PROJECTION,
      fetchBalance: async () => { throw "string error"; }
    });
    expect(decision.kind).toBe("settlement_down");
    if (decision.kind === "settlement_down") expect(decision.cause).toBe("unknown settlement error");
  });
});

describe("computeRequiredMarginBaseUnits", () => {
  it("ceils notional / leverage to base units (never under-reserves)", () => {
    // 0.001 BTC * 100_000 USD = 100 notional, /5 = 20 USDC = 20_000_000n
    expect(computeRequiredMarginBaseUnits({ quantity: 0.001, price: 100_000, leverage: 5 })).toBe(20_000_000n);
  });

  it("ceils when math produces a fractional base unit", () => {
    // 0.0001 * 100_000 = 10 notional, /3 = 3.333... USDC = 3_333_333.333... base units
    // ceil → 3_333_334n
    expect(computeRequiredMarginBaseUnits({ quantity: 0.0001, price: 100_000, leverage: 3 })).toBe(3_333_334n);
  });

  it("clamps leverage to engine bounds [1, 50]", () => {
    expect(computeRequiredMarginBaseUnits({ quantity: 1, price: 100, leverage: 0 })).toBe(100_000_000n); // leverage clamped to 1
    expect(computeRequiredMarginBaseUnits({ quantity: 1, price: 5000, leverage: 100 })).toBe(100_000_000n); // leverage clamped to 50 → 5000/50 = 100
  });
});
