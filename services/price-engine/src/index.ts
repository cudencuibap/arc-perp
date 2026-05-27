const engineUrl = process.env.MATCHING_ENGINE_URL ?? "http://localhost:4101";
const markets = [
  { symbol: "BTC-PERP", price: 68000, index: 67990, baseVol: 0.00032, spread: 7, drift: 0, regime: "calm" },
  { symbol: "ETH-PERP", price: 3600, index: 3598, baseVol: 0.00042, spread: 8, drift: 0, regime: "calm" },
  { symbol: "SOL-PERP", price: 145, index: 145.1, baseVol: 0.00062, spread: 10, drift: 0, regime: "calm" }
];
let tick = 0;

setInterval(async () => {
  for (const market of markets) {
    if (Math.random() < 0.015) {
      market.regime = Math.random() > 0.72 ? "stress" : Math.random() > 0.45 ? "volatile" : "active";
      market.drift = (Math.random() - 0.5) * market.baseVol * 3;
    } else if (Math.random() < 0.04) {
      market.regime = "calm";
      market.drift *= 0.5;
    }
    const multiplier = market.regime === "stress" ? 6 : market.regime === "volatile" ? 3.2 : market.regime === "active" ? 1.7 : 1;
    const shock = gaussian() * market.baseVol * multiplier + market.drift;
    market.index = Math.max(1, market.index * (1 + shock * 0.65));
    market.price = Math.max(1, market.price + (market.index - market.price) * 0.08 + market.price * shock * 0.38);
    market.spread = Math.max(3, Math.min(42, market.spread * 0.92 + (6 + multiplier * 5 + Math.random() * 4) * 0.08));
    const fundingRate = Math.max(-0.003, Math.min(0.003, ((market.price - market.index) / market.index) * 0.16));
    await fetch(`${engineUrl}/marks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        symbol: market.symbol,
        price: Number(market.price.toFixed(2)),
        indexPrice: Number(market.index.toFixed(2)),
        fundingRate: Number(fundingRate.toFixed(6)),
        regime: market.regime,
        spreadBps: Number(market.spread.toFixed(2))
      })
    }).catch(() => undefined);
  }
  tick += 1;
  if (tick % 18 === 0) void whaleTrade();
  if (tick % 90 === 0) void liquidateOne();
}, 250);

console.log("price-engine publishing simulated marks");

async function whaleTrade() {
  const market = markets[Math.floor(Math.random() * markets.length)]!;
  const side = Math.random() > 0.5 ? "buy" : "sell";
  const size = market.symbol === "BTC-PERP" ? 0.8 + Math.random() * 2.4 : market.symbol === "ETH-PERP" ? 9 + Math.random() * 24 : 250 + Math.random() * 900;
  await fetch(`${engineUrl}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      traderId: `whale-${Math.floor(Math.random() * 6)}`,
      agentId: `whale-${market.symbol}`,
      symbol: market.symbol,
      side,
      type: "market",
      quantity: Number(size.toFixed(4)),
      leverage: 12
    })
  }).catch(() => undefined);
}

async function liquidateOne() {
  const res = await fetch(`${engineUrl}/state`).catch(() => undefined);
  if (!res?.ok) return;
  const state = await res.json() as { positions: Array<{ traderId: string; symbol: string; size: number }> };
  const candidates = state.positions.filter((position) => Math.abs(position.size) > 0 && !position.traderId.startsWith("seed-mm"));
  const target = candidates[Math.floor(Math.random() * candidates.length)];
  if (!target) return;
  await fetch(`${engineUrl}/liquidations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ traderId: target.traderId, symbol: target.symbol })
  }).catch(() => undefined);
}

function gaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}
