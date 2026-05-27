const engineUrl = process.env.MATCHING_ENGINE_URL ?? "http://localhost:4101";

setInterval(async () => {
  const res = await fetch(`${engineUrl}/state`).catch(() => undefined);
  if (!res?.ok) return;
  const state = await res.json() as { positions: Array<{ traderId: string; symbol: string; size: number; markPrice: number; liquidationPrice: number }> };
  for (const position of state.positions) {
    const shouldLiquidate = position.size > 0 ? position.markPrice <= position.liquidationPrice : position.markPrice >= position.liquidationPrice;
    if (!shouldLiquidate) continue;
    await fetch(`${engineUrl}/liquidations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ traderId: position.traderId, symbol: position.symbol })
    }).then((res) => {
      if (res.ok) console.log("liquidation-engine liquidated", position.traderId, position.symbol, position.markPrice, position.liquidationPrice);
    }).catch(() => undefined);
  }
}, 1200);

console.log("liquidation-engine running simulated liquidations");
