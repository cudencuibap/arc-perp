import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";

const port = Number(process.env.WEBSOCKET_GATEWAY_PORT ?? 4100);
const engineUrl = process.env.MATCHING_ENGINE_URL ?? "http://localhost:4101";
const engineWs = process.env.MATCHING_ENGINE_WS ?? "ws://localhost:4101/stream";
const marketDataWs = process.env.MARKET_DATA_WS ?? "ws://localhost:4102/stream";
const settlementUrl = process.env.SETTLEMENT_SERVICE_URL ?? "http://localhost:4105";
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
let upstream: WebSocket | undefined;
let marketDataUpstream: WebSocket | undefined;
let reconnectMs = 500;
let marketDataReconnectMs = 500;

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true, service: "websocket-gateway" }));
app.get("/api/state", async (_req, res) => {
  const upstreamRes = await fetch(`${engineUrl}/state`);
  res.status(upstreamRes.status).json(await upstreamRes.json());
});
app.get("/api/history", async (req, res) => {
  const url = new URL(`${process.env.MARKET_DATA_HTTP_URL ?? "http://localhost:4102"}/history`);
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === "string") url.searchParams.set(key, value);
  }
  const upstreamRes = await fetch(url);
  res.status(upstreamRes.status).json(await upstreamRes.json());
});
app.get("/api/onchain/config", async (_req, res) => {
  const upstreamRes = await fetch(`${settlementUrl}/config`);
  res.status(upstreamRes.status).json(await upstreamRes.json());
});
app.get("/api/onchain/accounts/:address", async (req, res) => {
  const upstreamRes = await fetch(`${settlementUrl}/accounts/${req.params.address}`);
  res.status(upstreamRes.status).json(await upstreamRes.json());
});
app.get("/api/settlements/history", async (_req, res) => {
  const upstreamRes = await fetch(`${settlementUrl}/history`);
  res.status(upstreamRes.status).json(await upstreamRes.json());
});
app.post("/api/orders", async (req, res) => {
  const upstreamRes = await fetch(`${engineUrl}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req.body)
  });
  const body = await upstreamRes.json();
  if (upstreamRes.ok && req.body?.settleOnchain && req.body?.walletAddress && Array.isArray(body.trades)) {
    body.settlements = await Promise.all(body.trades.map((trade: { id: string; symbol: string; price: number; quantity: number }) => settleTrade(req.body.walletAddress, trade)));
  }
  res.status(upstreamRes.status).json(body);
});

wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "gateway", payload: { connected: true, ts: Date.now() } }));
});

connectUpstream();
connectMarketData();
server.listen(port, () => console.log(`websocket-gateway listening on ${port}`));

function connectUpstream() {
  if (upstream && upstream.readyState === WebSocket.OPEN) return;
  upstream = new WebSocket(engineWs);
  upstream.on("open", () => {
    reconnectMs = 500;
    broadcast({ type: "gateway", payload: { upstream: "live", ts: Date.now() } });
  });
  upstream.on("pong", () => broadcast({ type: "gateway", payload: { upstream: "heartbeat", ts: Date.now() } }));
  upstream.on("message", (message) => {
    broadcastRaw(message.toString());
  });
  upstream.on("close", () => {
    broadcast({ type: "gateway", payload: { upstream: "reconnecting", ts: Date.now() } });
    setTimeout(connectUpstream, reconnectMs);
    reconnectMs = Math.min(8000, reconnectMs * 1.6);
  });
  upstream.on("error", () => upstream?.terminate());
}

function connectMarketData() {
  if (marketDataUpstream && marketDataUpstream.readyState === WebSocket.OPEN) return;
  marketDataUpstream = new WebSocket(marketDataWs);
  marketDataUpstream.on("open", () => {
    marketDataReconnectMs = 500;
    broadcast({ type: "gateway", payload: { marketData: "live", ts: Date.now() } });
  });
  marketDataUpstream.on("message", (message) => broadcastRaw(message.toString()));
  marketDataUpstream.on("close", () => {
    broadcast({ type: "gateway", payload: { marketData: "reconnecting", ts: Date.now() } });
    setTimeout(connectMarketData, marketDataReconnectMs);
    marketDataReconnectMs = Math.min(8000, marketDataReconnectMs * 1.6);
  });
  marketDataUpstream.on("error", () => marketDataUpstream?.terminate());
}

setInterval(() => {
  if (upstream?.readyState === WebSocket.OPEN) upstream.ping();
  if (marketDataUpstream?.readyState === WebSocket.OPEN) marketDataUpstream.ping();
}, 15000);

function broadcast(event: unknown) {
  broadcastRaw(JSON.stringify(event));
}

function broadcastRaw(message: string) {
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
}

async function settleTrade(walletAddress: string, trade: { id: string; symbol: string; price: number; quantity: number }) {
  const notional = trade.price * trade.quantity;
  const fee = notional * 0.00025;
  const upstreamRes = await fetch(`${settlementUrl}/settlements/trade`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ walletAddress, tradeId: trade.id, symbol: trade.symbol, notional, pnl: 0, fee })
  }).catch(() => undefined);
  if (!upstreamRes) return { status: "settlement_unreachable", tradeId: trade.id };
  return upstreamRes.json();
}
