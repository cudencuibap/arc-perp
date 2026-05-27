const engineUrl = process.env.MATCHING_ENGINE_URL ?? "http://localhost:4101";

setInterval(async () => {
  const res = await fetch(`${engineUrl}/state`).catch(() => undefined);
  if (!res?.ok) return;
  const state = await res.json() as { positions: Array<{ traderId: string; symbol: string; size: number; markPrice: number; liquidationPrice: number }> };
  const atRisk = state.positions.filter((position) => position.size > 0 ? position.markPrice <= position.liquidationPrice * 1.02 : position.markPrice >= position.liquidationPrice * 0.98);
  if (atRisk.length > 0) console.log("risk-engine at-risk positions", atRisk.slice(0, 5));
}, 1500);

console.log("risk-engine monitoring simulated margin");
