import { getAgentWallet } from "@arc-perp/agent-wallets";

const gatewayUrl = process.env.WEBSOCKET_GATEWAY_URL ?? "http://localhost:4100";
const symbols = ["BTC-PERP", "ETH-PERP", "SOL-PERP"];
const deposited = new Set<string>();
const maxMarketMakerAgents = Math.max(2, Number(process.env.MARKET_MAKER_AGENT_COUNT ?? 6));
const intervalMs = Math.max(1000, Number(process.env.MARKET_MAKER_INTERVAL_MS ?? 1800));

setInterval(async () => {
  const state = await stateSnapshot();
  for (const market of state.markets.filter((item) => item.source)) {
    const volatility = market.volatilityBps ?? 0;
    const spread = market.markPrice * ((market.spreadBps + volatility * 0.25) / 10000);
    const skew = Math.sin(Date.now() / 4800 + symbols.indexOf(market.symbol)) * spread * 0.25;
    const bid = market.markPrice - spread + skew;
    const ask = market.markPrice + spread + skew;
    const orders = [
      { side: "a" as const, orderSide: "buy" as const, price: bid },
      { side: "b" as const, orderSide: "sell" as const, price: ask }
    ].filter((item) => agentIndex(market.symbol, item.side) < maxMarketMakerAgents);
    await Promise.all(orders.map((item) => order(agentIdFor(market.symbol, item.side), market.symbol, item.orderSide, item.price, sizeFor(market.symbol, volatility))));
  }
}, intervalMs);

async function stateSnapshot(): Promise<{ markets: Array<{ symbol: string; markPrice: number; spreadBps: number; volatilityBps?: number; source?: string }> }> {
  const res = await fetch(`${gatewayUrl}/api/state`).catch(() => undefined);
  if (!res?.ok) {
    return { markets: [] };
  }
  return await res.json() as { markets: Array<{ symbol: string; markPrice: number; spreadBps: number; volatilityBps?: number; source?: string }> };
}

function sizeFor(symbol: string, volatilityBps: number) {
  const base = symbol === "BTC-PERP" ? 0.06 : symbol === "ETH-PERP" ? 0.7 : 18;
  const riskOff = Math.max(0.28, 1 - volatilityBps / 85);
  return Number((base * riskOff * (0.6 + Math.random() * 0.9)).toFixed(4));
}

function agentIndex(symbol: string, side: "a" | "b") {
  return symbols.indexOf(symbol) * 2 + (side === "a" ? 0 : 1);
}

function agentIdFor(symbol: string, side: "a" | "b") {
  return `mm-${agentIndex(symbol, side) + 1}-${symbol}`;
}

async function order(agentId: string, symbol: string, side: "buy" | "sell", price: number, quantity: number) {
  const wallet = getAgentWallet(agentId);
  await ensureDeposit(agentId, wallet);
  await fetch(`${gatewayUrl}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      traderId: agentId,
      agentId,
      symbol,
      side,
      type: "limit",
      quantity,
      price: Number(price.toFixed(2)),
      leverage: 4,
      walletAddress: wallet?.address,
      settleOnchain: Boolean(wallet)
    })
  }).catch(() => undefined);
}

async function ensureDeposit(agentId: string, wallet: ReturnType<typeof getAgentWallet>) {
  const amount = Number(process.env.AGENT_AUTO_DEPOSIT_USDC ?? 0);
  if (!wallet || amount <= 0 || deposited.has(agentId)) return;
  deposited.add(agentId);
  const config = await fetch(`${gatewayUrl}/api/onchain/config`).then((res) => res.json()).catch(() => undefined);
  if (config) await wallet.depositCollateral(amount, config).catch((error: unknown) => console.warn("agent deposit failed", agentId, error instanceof Error ? error.message : error));
}

console.log("market-maker agents active", { maxMarketMakerAgents, intervalMs });
