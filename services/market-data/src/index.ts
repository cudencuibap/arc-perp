import cors from "cors";
import express from "express";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import type { MarketMeta, MarketState, MarketSymbol } from "@arc-perp/core";

type Source = NonNullable<MarketMeta["source"]>;
type Regime = MarketMeta["regime"];

interface MarketTick {
  symbol: MarketSymbol;
  price: number;
  indexPrice: number;
  source: Source;
  providerTs: number;
  receivedAt: number;
}

interface PriceState {
  symbol: MarketSymbol;
  markPrice: number;
  indexPrice: number;
  targetPrice: number;
  lastRawPrice: number;
  source: Source;
  providerTs: number;
  receivedAt: number;
  latencyMs: number;
  volatilityBps: number;
  spreadBps: number;
  regime: Regime;
  fundingRate: number;
  staleTicks: number;
  history: Array<{ ts: number; price: number }>;
}

interface HistoryCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const symbols: MarketSymbol[] = ["BTC-PERP", "ETH-PERP", "SOL-PERP"];
const binanceSymbols: Record<MarketSymbol, string> = {
  "BTC-PERP": "btcusdt",
  "ETH-PERP": "ethusdt",
  "SOL-PERP": "solusdt"
};
const defaultPrices: Record<MarketSymbol, number> = {
  "BTC-PERP": 68000,
  "ETH-PERP": 3600,
  "SOL-PERP": 145
};

const port = Number(process.env.MARKET_DATA_PORT ?? process.env.PORT ?? 4102);
const engineUrl = process.env.MATCHING_ENGINE_URL ?? "http://localhost:4101";
const binanceWsUrl = process.env.BINANCE_WS_URL ?? `wss://stream.binance.com:9443/stream?streams=${symbols.map((symbol) => `${binanceSymbols[symbol]}@ticker`).join("/")}`;
const chainlinkPollMs = Number(process.env.CHAINLINK_POLL_MS ?? 1000);
const publishMs = Number(process.env.MARKET_DATA_PUBLISH_MS ?? 200);
const staleAfterMs = Number(process.env.MARKET_DATA_STALE_MS ?? 6000);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/stream" });
const prices = new Map<MarketSymbol, PriceState>(symbols.map((symbol) => [symbol, initialState(symbol)]));
const historyCache = new Map<string, { ts: number; candles: HistoryCandle[] }>();
let binanceSocket: WebSocket | undefined;
let binanceReconnectMs = 500;
let chainlinkTimer: NodeJS.Timeout | undefined;
let preferredSource: Source = "simulated";
let lastEngineState: MarketState | undefined;

app.use(cors());
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "market-data",
    source: preferredSource,
    prices: [...prices.values()].map(publicPrice)
  });
});
app.get("/prices", (_req, res) => res.json([...prices.values()].map(publicPrice)));
app.get("/history", async (req, res) => {
  const symbol = String(req.query.symbol ?? "BTC-PERP") as MarketSymbol;
  const interval = String(req.query.interval ?? "5m");
  const days = Math.max(1, Math.min(90, Number(req.query.days ?? 30)));
  if (!symbols.includes(symbol)) {
    res.status(400).json({ error: "Unsupported symbol" });
    return;
  }
  try {
    const candles = await historicalCandles(symbol, interval, days);
    res.json({ symbol, interval, days, source: "binance", candles });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "History unavailable", candles: fallbackHistory(symbol, interval, days) });
  }
});

wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "market-data-state", payload: [...prices.values()].map(publicPrice) }));
});

startChainlink();
connectBinance();
setInterval(publishMarks, publishMs);
setInterval(refreshEngineState, 1200);

server.listen(port, () => {
  const address = server.address() as AddressInfo;
  console.log(`market-data listening on ${address.port}`);
});

function startChainlink() {
  const hasDataStreams = Boolean(process.env.CHAINLINK_STREAMS_URL && process.env.CHAINLINK_FEED_IDS);
  const hasDataFeeds = Boolean(process.env.CHAINLINK_RPC_URL && process.env.CHAINLINK_FEED_ADDRESSES);
  if (!hasDataStreams && !hasDataFeeds) {
    console.log("market-data Chainlink config not found; Binance websocket fallback enabled");
    return;
  }
  preferredSource = "chainlink";
  chainlinkTimer = setInterval(async () => {
    try {
      if (hasDataStreams) await pollChainlinkDataStreams();
      else await pollChainlinkDataFeeds();
    } catch (error) {
      console.error("market-data Chainlink poll failed", error instanceof Error ? error.message : error);
    }
  }, chainlinkPollMs);
  console.log("market-data Chainlink primary feed enabled");
}

async function pollChainlinkDataStreams() {
  const baseUrl = process.env.CHAINLINK_STREAMS_URL!;
  const feedIds = parseSymbolMap(process.env.CHAINLINK_FEED_IDS);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  for (const symbol of symbols) {
    const feedId = feedIds[symbol];
    if (!feedId) continue;
    const url = new URL(baseUrl);
    url.searchParams.set("feedID", feedId);
    const headers: Record<string, string> = { accept: "application/json" };
    const apiKey = process.env.CHAINLINK_API_KEY;
    const apiSecret = process.env.CHAINLINK_API_SECRET;
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    if (apiKey && apiSecret) {
      headers["x-api-key"] = apiKey;
      headers["x-timestamp"] = timestamp;
      headers["x-signature"] = createHmac("sha256", apiSecret).update(`${timestamp}:${feedId}`).digest("hex");
    }
    const started = Date.now();
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Data Streams ${symbol} ${res.status}`);
    const payload = await res.json() as Record<string, unknown>;
    const price = readNumber(payload, ["price", "mid", "midPrice", "answer", "benchmarkPrice"]);
    if (price) acceptTick({ symbol, price, indexPrice: price, source: "chainlink", providerTs: readNumber(payload, ["timestamp", "validFromTimestamp", "observationsTimestamp"]) ?? started, receivedAt: Date.now() });
  }
}

async function pollChainlinkDataFeeds() {
  const rpcUrl = process.env.CHAINLINK_RPC_URL!;
  const addresses = parseSymbolMap(process.env.CHAINLINK_FEED_ADDRESSES);
  for (const symbol of symbols) {
    const address = addresses[symbol];
    if (!address) continue;
    const [decimalsHex, latestHex] = await Promise.all([
      ethCall(rpcUrl, address, "0x313ce567"),
      ethCall(rpcUrl, address, "0xfeaf968c")
    ]);
    const decimals = Number(BigInt(decimalsHex));
    const words = latestHex.slice(2).match(/.{1,64}/g) ?? [];
    const answer = fromSignedWord(words[1] ?? "0");
    const updatedAt = Number(BigInt(`0x${words[3] ?? "0"}`)) * 1000;
    const price = Number(answer) / 10 ** decimals;
    if (Number.isFinite(price) && price > 0) acceptTick({ symbol, price, indexPrice: price, source: "chainlink", providerTs: updatedAt || Date.now(), receivedAt: Date.now() });
  }
}

async function ethCall(rpcUrl: string, to: string, data: string): Promise<string> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "eth_call", params: [{ to, data }, "latest"] })
  });
  const json = await res.json() as { result?: string; error?: { message?: string } };
  if (!json.result) throw new Error(json.error?.message ?? "Chainlink RPC call failed");
  return json.result;
}

function connectBinance() {
  binanceSocket = new WebSocket(binanceWsUrl);
  binanceSocket.on("open", () => {
    if (preferredSource !== "chainlink") preferredSource = "binance";
    binanceReconnectMs = 500;
    console.log("market-data Binance websocket connected");
    broadcast({ type: "market-data-health", payload: { source: "binance", connected: true, ts: Date.now() } });
  });
  binanceSocket.on("message", (message) => {
    try {
      const payload = JSON.parse(message.toString()) as { data?: Record<string, string | number> };
      const data = payload.data ?? payload as unknown as Record<string, string | number>;
      const streamSymbol = String(data.s ?? "").toLowerCase();
      const symbol = symbols.find((item) => binanceSymbols[item].toUpperCase() === streamSymbol.toUpperCase());
      const price = Number(data.c ?? data.p);
      const providerTs = Number(data.E ?? Date.now());
      if (symbol && Number.isFinite(price) && price > 0) acceptTick({ symbol, price, indexPrice: price, source: "binance", providerTs, receivedAt: Date.now() });
    } catch (error) {
      console.error("market-data Binance parse failed", error instanceof Error ? error.message : error);
    }
  });
  binanceSocket.on("close", () => reconnectBinance());
  binanceSocket.on("error", () => binanceSocket?.terminate());
}

function reconnectBinance() {
  broadcast({ type: "market-data-health", payload: { source: "binance", connected: false, retryMs: binanceReconnectMs, ts: Date.now() } });
  setTimeout(connectBinance, binanceReconnectMs);
  binanceReconnectMs = Math.min(12000, Math.floor(binanceReconnectMs * 1.7));
}

function acceptTick(tick: MarketTick) {
  const state = prices.get(tick.symbol)!;
  if (tick.source === "binance" && state.source === "chainlink" && Date.now() - state.receivedAt < staleAfterMs) return;
  const firstLiveTick = tick.source !== "simulated" && state.source === "simulated";
  const history = firstLiveTick
    ? [{ ts: tick.receivedAt, price: tick.price }]
    : [...state.history, { ts: tick.receivedAt, price: tick.price }].filter((item) => item.ts >= tick.receivedAt - 60_000).slice(-360);
  const volatilityBps = computeVolatility(history);
  state.targetPrice = tick.price;
  if (firstLiveTick) state.markPrice = tick.price;
  state.indexPrice = tick.indexPrice;
  state.lastRawPrice = tick.price;
  state.source = tick.source;
  state.providerTs = tick.providerTs;
  state.receivedAt = tick.receivedAt;
  state.latencyMs = Math.max(0, tick.receivedAt - tick.providerTs);
  state.volatilityBps = volatilityBps;
  state.spreadBps = Math.max(3, Math.min(75, 5 + volatilityBps * 0.9));
  state.regime = volatilityBps > 55 ? "stress" : volatilityBps > 26 ? "volatile" : volatilityBps > 10 ? "active" : "calm";
  state.staleTicks = 0;
  state.history = history;
  broadcast({ type: "market-data-tick", payload: publicPrice(state) });
}

async function publishMarks() {
  const now = Date.now();
  for (const state of prices.values()) {
    if (now - state.receivedAt > staleAfterMs) simulateTick(state, now);
    const smoothing = state.source === "simulated" ? 0.18 : Math.min(0.5, 0.16 + state.volatilityBps / 180);
    state.markPrice = round(state.markPrice + (state.targetPrice - state.markPrice) * smoothing);
    state.fundingRate = fundingFor(state);
    await fetch(`${engineUrl}/marks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(publicPrice(state))
    }).catch((error) => console.error("market-data publish failed", error instanceof Error ? error.message : error));
  }
}

async function refreshEngineState() {
  const res = await fetch(`${engineUrl}/state`).catch(() => undefined);
  if (!res?.ok) return;
  lastEngineState = await res.json() as MarketState;
}

function simulateTick(state: PriceState, now: number) {
  state.staleTicks += 1;
  const volatility = Math.max(0.00008, state.volatilityBps / 10000 / 12);
  const shock = gaussian() * volatility;
  const price = Math.max(1, state.targetPrice * (1 + shock));
  acceptTick({ symbol: state.symbol, price, indexPrice: price, source: "simulated", providerTs: now, receivedAt: now });
  if (state.staleTicks % 20 === 1) console.error(`market-data feed stale for ${state.symbol}; using simulated continuity`);
}

function fundingFor(state: PriceState): number {
  const basis = (state.markPrice - state.indexPrice) / state.indexPrice;
  const positions = lastEngineState?.positions.filter((position) => position.symbol === state.symbol) ?? [];
  const longNotional = positions.filter((position) => position.size > 0).reduce((sum, position) => sum + Math.abs(position.size * state.markPrice), 0);
  const shortNotional = positions.filter((position) => position.size < 0).reduce((sum, position) => sum + Math.abs(position.size * state.markPrice), 0);
  const skew = longNotional + shortNotional > 0 ? (longNotional - shortNotional) / (longNotional + shortNotional) : 0;
  return round(Math.max(-0.003, Math.min(0.003, basis * 0.14 + skew * 0.00035)));
}

function publicPrice(state: PriceState) {
  return {
    symbol: state.symbol,
    price: round(state.markPrice),
    markPrice: round(state.markPrice),
    indexPrice: round(state.indexPrice),
    fundingRate: state.fundingRate,
    regime: state.regime,
    spreadBps: round(state.spreadBps),
    source: state.source,
    latencyMs: Math.round(state.latencyMs),
    volatilityBps: round(state.volatilityBps)
  };
}

async function historicalCandles(symbol: MarketSymbol, interval: string, days: number): Promise<HistoryCandle[]> {
  const safeInterval = binanceInterval(interval);
  const cacheKey = `${symbol}:${safeInterval}:${days}`;
  const cached = historyCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 120_000) return cached.candles;
  const endTime = Date.now();
  let startTime = endTime - days * 86_400_000;
  const candles: HistoryCandle[] = [];
  while (startTime < endTime) {
    const url = new URL("https://data-api.binance.vision/api/v3/klines");
    url.searchParams.set("symbol", binanceSymbols[symbol].toUpperCase());
    url.searchParams.set("interval", safeInterval);
    url.searchParams.set("startTime", String(startTime));
    url.searchParams.set("endTime", String(endTime));
    url.searchParams.set("limit", "1000");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Binance history ${response.status}`);
    const rows = await response.json() as Array<[number, string, string, string, string, string, number]>;
    if (rows.length === 0) break;
    for (const row of rows) {
      candles.push({
        time: Math.floor(row[0] / 1000),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5])
      });
    }
    const next = Number(rows.at(-1)?.[6] ?? startTime) + 1;
    if (next <= startTime) break;
    startTime = next;
  }
  const deduped = [...new Map(candles.map((candle) => [candle.time, candle])).values()];
  historyCache.set(cacheKey, { ts: Date.now(), candles: deduped });
  return deduped;
}

function binanceInterval(interval: string) {
  if (["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d"].includes(interval)) return interval;
  return "5m";
}

function fallbackHistory(symbol: MarketSymbol, interval: string, days: number): HistoryCandle[] {
  const step = timeframeMs(interval);
  const now = Math.floor(Date.now() / step) * step;
  const price = prices.get(symbol)?.markPrice ?? defaultPrices[symbol];
  const count = Math.min(2000, Math.floor((days * 86_400_000) / step));
  return Array.from({ length: count }, (_, index) => {
    const drift = Math.sin(index / 21) * price * 0.012 + Math.cos(index / 47) * price * 0.006;
    const close = Math.max(0.01, price + drift);
    const open = Math.max(0.01, close - Math.sin(index / 9) * price * 0.002);
    return {
      time: Math.floor((now - (count - index) * step) / 1000),
      open,
      high: Math.max(open, close) + price * 0.0018,
      low: Math.min(open, close) - price * 0.0018,
      close,
      volume: Math.max(1, price * selectedVolumeScale(symbol) * (0.8 + (index % 9) / 9))
    };
  });
}

function timeframeMs(interval: string) {
  const unit = interval.at(-1);
  const value = Number(interval.slice(0, -1)) || 5;
  if (unit === "m") return value * 60_000;
  if (unit === "h") return value * 3_600_000;
  if (unit === "d") return value * 86_400_000;
  return 300_000;
}

function selectedVolumeScale(symbol: MarketSymbol) {
  if (symbol === "BTC-PERP") return 0.08;
  if (symbol === "ETH-PERP") return 0.7;
  return 18;
}

function initialState(symbol: MarketSymbol): PriceState {
  const price = defaultPrices[symbol];
  return {
    symbol,
    markPrice: price,
    indexPrice: price,
    targetPrice: price,
    lastRawPrice: price,
    source: "simulated",
    providerTs: Date.now(),
    receivedAt: 0,
    latencyMs: 0,
    volatilityBps: 0,
    spreadBps: 8,
    regime: "calm",
    fundingRate: 0,
    staleTicks: 0,
    history: [{ ts: Date.now(), price }]
  };
}

function parseSymbolMap(value?: string): Partial<Record<MarketSymbol, string>> {
  const map: Partial<Record<MarketSymbol, string>> = {};
  for (const part of (value ?? "").split(",")) {
    const [symbol, id] = part.split("=").map((item) => item.trim());
    if (symbols.includes(symbol as MarketSymbol) && id) map[symbol as MarketSymbol] = id;
  }
  return map;
}

function readNumber(payload: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = payload[key];
    const parsed = typeof value === "object" && value && "value" in value ? Number((value as { value: unknown }).value) : Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function fromSignedWord(word: string): bigint {
  const value = BigInt(`0x${word}`);
  const maxInt = 1n << 255n;
  return value >= maxInt ? value - (1n << 256n) : value;
}

function computeVolatility(history: Array<{ price: number }>): number {
  if (history.length < 3) return 0;
  const returns = history.slice(1).map((point, index) => Math.log(point.price / history[index]!.price));
  const mean = returns.reduce((sum, item) => sum + item, 0) / returns.length;
  const variance = returns.reduce((sum, item) => sum + (item - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * 10000 * Math.sqrt(Math.min(60, history.length));
}

function broadcast(event: unknown) {
  const message = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
}

function gaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function round(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}
