import type { AgentNode, DistrictHeat, EngineEvent, MarketWorldState } from "./types.js";

const districts = ["btc-core", "eth-quarter", "sol-harbor", "risk-tower", "treasury-vault"];

export function createWorldState(events: EngineEvent[], agentIds: string[]): MarketWorldState {
  const recent = events.slice(-80);
  const heatByDistrict = new Map<string, DistrictHeat>(
    districts.map((id) => [
      id,
      {
        id,
        label: id.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" "),
        activity: 0,
        risk: id === "risk-tower" ? 0.4 : 0.15,
        liquidity: id === "treasury-vault" ? 0.7 : 0.35
      }
    ])
  );

  for (const event of recent) {
    const district = event.type === "liquidation" ? "risk-tower" : event.type === "balance" ? "treasury-vault" : symbolDistrict(event);
    const heat = heatByDistrict.get(district);
    if (heat) {
      heat.activity = Math.min(1, heat.activity + 0.04);
      if (event.type === "liquidation") heat.risk = Math.min(1, heat.risk + 0.2);
      if (event.type === "orderbook" || event.type === "trade") heat.liquidity = Math.min(1, heat.liquidity + 0.03);
    }
  }

  const now = Date.now();
  const agents: AgentNode[] = agentIds.slice(0, 32).map((id, index) => {
    const district = districts[index % districts.length]!;
    return {
      id,
      role: id.includes("mm") ? "market-maker" : id.includes("treasury") ? "treasury" : "trader",
      district,
      x: 12 + ((index * 23 + Math.floor(now / 900)) % 76),
      y: 14 + ((index * 31 + Math.floor(now / 1200)) % 72),
      intensity: 0.35 + ((index * 7) % 50) / 100
    };
  });

  return { ts: now, districts: [...heatByDistrict.values()], agents };
}

function symbolDistrict(event: EngineEvent): string {
  const symbol = "payload" in event && event.payload && "symbol" in event.payload ? event.payload.symbol : undefined;
  if (symbol === "BTC-PERP") return "btc-core";
  if (symbol === "ETH-PERP") return "eth-quarter";
  if (symbol === "SOL-PERP") return "sol-harbor";
  return "btc-core";
}
