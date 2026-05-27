import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { createWorldState, MatchingEngine, type EngineEvent, type MarketSymbol, type OrderRequest } from "@arc-perp/core";

const port = Number(process.env.MATCHING_ENGINE_PORT ?? 4101);
const settlementUrl = process.env.SETTLEMENT_SERVICE_URL ?? "http://localhost:4105";
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/stream" });
const engine = new MatchingEngine();
const recentEvents: EngineEvent[] = [];

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true, service: "matching-engine" }));
app.get("/state", (_req, res) => res.json(engine.state()));
app.post("/orders", (req, res) => {
  try {
    const result = engine.placeOrder(req.body as OrderRequest);
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid order" });
  }
});
app.post("/marks", (req, res) => {
  engine.updateMark(req.body.symbol as MarketSymbol, Number(req.body.price), {
    indexPrice: Number(req.body.indexPrice) || undefined,
    fundingRate: Number.isFinite(Number(req.body.fundingRate)) ? Number(req.body.fundingRate) : undefined,
    openInterest: Number(req.body.openInterest) || undefined,
    volume24h: Number(req.body.volume24h) || undefined,
    regime: req.body.regime,
    spreadBps: Number(req.body.spreadBps) || undefined,
    source: req.body.source,
    latencyMs: Number.isFinite(Number(req.body.latencyMs)) ? Number(req.body.latencyMs) : undefined,
    volatilityBps: Number.isFinite(Number(req.body.volatilityBps)) ? Number(req.body.volatilityBps) : undefined
  });
  res.status(202).json({ ok: true });
});
app.post("/liquidations", (req, res) => {
  const liquidated = engine.liquidate(String(req.body.traderId), req.body.symbol as MarketSymbol);
  res.status(liquidated ? 202 : 404).json({ liquidated });
});

wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "state", payload: engine.state() }));
});

engine.on("event", (event: EngineEvent) => {
  recentEvents.push(event);
  if (recentEvents.length > 200) recentEvents.shift();
  broadcast(event);
});

setInterval(() => {
  broadcast({ type: "world", payload: createWorldState(recentEvents, engine.agentList()) });
}, 1000);

setInterval(seedLiquidity, 700);
setInterval(settleFunding, Number(process.env.FUNDING_SETTLEMENT_INTERVAL_MS ?? 30000));

server.listen(port, () => {
  console.log(`matching-engine listening on ${port}`);
});

function broadcast(event: EngineEvent | { type: "state"; payload: unknown }) {
  const message = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
}

function seedLiquidity() {
  const markets = engine.state().markets;
  for (const market of markets) {
    if (!market.source) continue;
    const spread = market.markPrice * (market.spreadBps / 10000);
    const skew = Math.sin(Date.now() / 5200) * spread * 0.35;
    const sizeBase = market.symbol === "BTC-PERP" ? 0.08 : market.symbol === "ETH-PERP" ? 0.7 : 18;
    engine.placeOrder({ traderId: `seed-mm-${market.symbol}`, agentId: `mm-${market.symbol}`, symbol: market.symbol, side: "buy", type: "limit", quantity: Number((sizeBase * (0.45 + Math.random())).toFixed(4)), price: Number((market.markPrice - spread + skew).toFixed(2)), leverage: 5 });
    engine.placeOrder({ traderId: `seed-mm-${market.symbol}`, agentId: `mm-${market.symbol}`, symbol: market.symbol, side: "sell", type: "limit", quantity: Number((sizeBase * (0.45 + Math.random())).toFixed(4)), price: Number((market.markPrice + spread + skew).toFixed(2)), leverage: 5 });
  }
}

async function settleFunding() {
  const state = engine.state();
  for (const position of state.positions) {
    if (!position.walletAddress || position.size === 0) continue;
    const market = state.markets.find((item) => item.symbol === position.symbol);
    if (!market) continue;
    const notional = Math.abs(position.size * market.markPrice);
    const direction = position.size > 0 ? -1 : 1;
    const fundingPayment = notional * market.fundingRate * direction;
    if (Math.abs(fundingPayment) < 0.000001) continue;
    await fetch(`${settlementUrl}/funding/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        walletAddress: position.walletAddress,
        symbol: position.symbol,
        fundingPayment,
        ref: `funding-${position.traderId}-${position.symbol}-${Date.now()}`
      })
    }).catch(() => undefined);
  }
}
