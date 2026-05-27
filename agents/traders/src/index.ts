import { getAgentWallet } from "@arc-perp/agent-wallets";

const gatewayUrl = process.env.WEBSOCKET_GATEWAY_URL ?? "http://localhost:4100";
const symbols = ["BTC-PERP", "ETH-PERP", "SOL-PERP"];
const deposited = new Set<string>();
const traderAgentCount = Math.max(0, Number(process.env.TRADER_AGENT_COUNT ?? 4));
const intervalMs = Math.max(1000, Number(process.env.TRADER_INTERVAL_MS ?? 2500));

setInterval(async () => {
  if (traderAgentCount === 0) return;
  const state = await fetch(`${gatewayUrl}/api/state`).then((res) => res.json()).catch(() => undefined) as { markets?: Array<{ symbol: string; regime: string; volatilityBps?: number; fundingRate: number; source?: string }> } | undefined;
  const liveMarkets = (state?.markets ?? []).filter((market) => market.source);
  if (liveMarkets.length === 0) return;
  const market = weightedMarket(liveMarkets);
  const volatility = market.volatilityBps ?? 0;
  const momentumBias = market.regime === "stress" || market.regime === "volatile" ? 0.62 : 0.52;
  const fundingBias = market.fundingRate > 0 ? -0.06 : market.fundingRate < 0 ? 0.06 : 0;
  const side = Math.random() < momentumBias + fundingBias ? "buy" : "sell";
  const sizeMultiplier = market.regime === "stress" ? 2.8 : market.regime === "volatile" ? 1.8 : market.regime === "active" ? 1.25 : 1;
  const agentId = `trader-${Math.floor(Math.random() * traderAgentCount) + 1}`;
  const wallet = getAgentWallet(agentId);
  await ensureDeposit(agentId, wallet);
  await fetch(`${gatewayUrl}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      traderId: `sim-${agentId}`,
      agentId,
      symbol: market.symbol,
      side,
      type: "market",
      quantity: Number(((0.01 + Math.random() * 0.18) * sizeMultiplier * (1 + volatility / 80)).toFixed(4)),
      leverage: 8 + Math.floor(Math.random() * (market.regime === "stress" ? 43 : 34)),
      walletAddress: wallet?.address,
      settleOnchain: Boolean(wallet)
    })
  }).catch(() => undefined);
}, intervalMs);

function weightedMarket(markets: Array<{ symbol: string; regime: string; volatilityBps?: number; fundingRate: number }>) {
  const weighted = markets.flatMap((market) => {
    const weight = market.regime === "stress" ? 5 : market.regime === "volatile" ? 4 : market.regime === "active" ? 2 : 1;
    return Array.from({ length: weight }, () => market);
  });
  return weighted[Math.floor(Math.random() * weighted.length)]!;
}

async function ensureDeposit(agentId: string, wallet: ReturnType<typeof getAgentWallet>) {
  const amount = Number(process.env.AGENT_AUTO_DEPOSIT_USDC ?? 0);
  if (!wallet || amount <= 0 || deposited.has(agentId)) return;
  deposited.add(agentId);
  const config = await fetch(`${gatewayUrl}/api/onchain/config`).then((res) => res.json()).catch(() => undefined);
  if (config) await wallet.depositCollateral(amount, config).catch((error: unknown) => console.warn("agent deposit failed", agentId, error instanceof Error ? error.message : error));
}

console.log("random trader agents active", { traderAgentCount, intervalMs });
