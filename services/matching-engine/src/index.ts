import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createWorldState, MatchingEngine, type EngineEvent, type MarketSymbol, type OrderRequest } from "@arc-perp/core";
import { computeRequiredMarginBaseUnits, defaultFetchBalance, evaluateRealBalance } from "./real-balance.js";
import { loadState, saveState, serialize, toInternalState } from "./persist.js";

const port = Number(process.env.MATCHING_ENGINE_PORT ?? process.env.PORT ?? 4101);
const settlementUrl = process.env.SETTLEMENT_SERVICE_URL ?? "http://localhost:4105";
// Phase 2b gate. Default off — flip true after agents are funded with on-chain USDC.
const useRealBalance = process.env.ENGINE_USE_REAL_BALANCE === "true";
// Arc constraint: USDC is the native gas token. Reserve a slice that the
// engine never lets the wallet lock as margin so the wallet can always pay
// for the next withdraw/transfer tx. 100_000 base units = 0.1 USDC.
const gasReserveBaseUnits = BigInt(process.env.ENGINE_GAS_RESERVE_USDC_BASE_UNITS ?? "100000");
// Phase 3 — engine state persistence.
const __dirname = dirname(fileURLToPath(import.meta.url));
const statePath = resolve(__dirname, "../data/engine-state.json");
const persistEnabled = (process.env.ENGINE_PERSIST_ENABLED ?? "true") !== "false";
const snapshotDebounceMs = Number(process.env.ENGINE_SNAPSHOT_DEBOUNCE_MS ?? 500);
const snapshotHeartbeatMs = Number(process.env.ENGINE_SNAPSHOT_HEARTBEAT_MS ?? 30_000);
const REQUIRED_WARM_SYMBOLS: MarketSymbol[] = ["BTC-PERP", "ETH-PERP", "SOL-PERP"];
let restoreTs = 0; // 0 = no restore happened, no warmup required. Set on boot when state loaded.
let persistDebounceTimer: NodeJS.Timeout | undefined;
let persistChain: Promise<void> = Promise.resolve();
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/stream" });
const engine = new MatchingEngine();
const recentEvents: EngineEvent[] = [];

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true, service: "matching-engine" }));
app.get("/state", (_req, res) => res.json(engine.state()));
app.post("/orders", async (req, res) => {
  const order = req.body as OrderRequest;
  // Phase 3: post-restore warmup gate. While the engine is replaying from
  // disk and waiting for fresh marks from market-data, all order placement
  // is rejected with a structured error so autonomous agents back off
  // until prices are current. Once every required symbol has received a
  // post-restore mark, restoreTs is cleared and this branch becomes a no-op.
  if (restoreTs > 0 && !isWarm()) {
    res.status(503)
      .setHeader("Retry-After", "1")
      .json({
        error: "engine_warming",
        code: "ENGINE_WARMING",
        retryAfter: 1,
        message: "Engine warming up after restart — waiting for fresh marks from market-data."
      });
    return;
  }
  if (useRealBalance && order.walletAddress) {
    const markets = engine.state().markets.find((m) => m.symbol === order.symbol);
    const referencePrice = order.type === "limit" && order.price ? order.price : markets?.markPrice ?? 0;
    if (referencePrice <= 0) {
      res.status(400).json({ error: "invalid_market", code: "INVALID_MARKET", message: "Market is waiting for external pricing" });
      return;
    }
    const requiredBaseUnits = computeRequiredMarginBaseUnits({ quantity: order.quantity, price: referencePrice, leverage: order.leverage ?? 5 });
    const decision = await evaluateRealBalance({
      walletAddress: order.walletAddress,
      requiredBaseUnits,
      gasReserveBaseUnits,
      projection: {
        realizedBaseUnits: engine.getRealizedPnlBaseUnits(order.traderId),
        unrealizedBaseUnits: engine.getUnrealizedPnlBaseUnits(order.traderId),
        usedMarginBaseUnits: engine.getUsedMarginBaseUnits(order.traderId)
      },
      fetchBalance: (addr) => defaultFetchBalance(settlementUrl, addr)
    });
    if (decision.kind === "settlement_down") {
      res.status(503)
        .setHeader("Retry-After", "1")
        .json({
          error: "settlement_unreachable",
          code: "SETTLEMENT_DOWN",
          retryAfter: 1,
          message: `Settlement service unreachable: ${decision.cause}. Retry in 1s.`
        });
      return;
    }
    console.log(`[matching-engine] balance fetch lat=${decision.latencyMs}ms trader=${order.traderId} avail=${decision.availableBaseUnits} required=${requiredBaseUnits}`);
    if (decision.kind === "insufficient") {
      res.status(400).json({
        error: "insufficient_margin",
        code: "INSUFFICIENT_MARGIN",
        availableBaseUnits: decision.availableBaseUnits.toString(),
        requiredBaseUnits: decision.requiredBaseUnits.toString(),
        message: "Insufficient margin. Please deposit USDC first."
      });
      return;
    }
    engine.setRealBalance(order.traderId, decision.availableUsdc);
  }
  try {
    const result = engine.placeOrder(order);
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
  // Phase 3: debounced persist on any state-mutating event. mark events
  // skip — they are very frequent (5/sec per symbol from market-data) and
  // market state is auto-recovered on restart anyway. The 30s heartbeat
  // catches any market drift that matters for warmup boundaries.
  if (persistEnabled && (event.type === "trade" || event.type === "balance" || event.type === "position" || event.type === "liquidation")) {
    schedulePersist();
  }
});

setInterval(() => {
  broadcast({ type: "world", payload: createWorldState(recentEvents, engine.agentList()) });
}, 1000);

setInterval(seedLiquidity, 700);
setInterval(settleFunding, Number(process.env.FUNDING_SETTLEMENT_INTERVAL_MS ?? 30000));
if (persistEnabled) setInterval(triggerHeartbeatPersist, snapshotHeartbeatMs);

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

void boot();

async function boot() {
  if (persistEnabled) {
    try {
      const parsed = await loadState(statePath);
      if (parsed) {
        engine.restoreInternalState(toInternalState(parsed));
        restoreTs = Date.now();
        console.log(`[matching-engine] restored from ${statePath} savedAt=${parsed.savedAt} positions=${parsed.positions.length} balances=${parsed.balances.length} trades=${parsed.trades.length}; warmup until all symbols mark > ${new Date(restoreTs).toISOString()}`);
      } else {
        console.log(`[matching-engine] no prior state at ${statePath}; starting fresh`);
      }
    } catch (error) {
      console.error(`[matching-engine] loadState failed: ${error instanceof Error ? error.message : "unknown"}; delete ${statePath} to start fresh`);
      process.exit(1);
    }
  }
  server.listen(port, () => {
    console.log(`matching-engine listening on ${port}; persist=${persistEnabled} warmup=${restoreTs > 0}`);
  });
}

function isWarm(): boolean {
  if (restoreTs === 0) return true;
  const markets = engine.state().markets;
  const allFresh = REQUIRED_WARM_SYMBOLS.every((symbol) => {
    const meta = markets.find((m) => m.symbol === symbol);
    return meta !== undefined && meta.ts > restoreTs;
  });
  if (allFresh) restoreTs = 0; // warmup permanently complete; skip check forever
  return allFresh;
}

function schedulePersist() {
  if (persistDebounceTimer) clearTimeout(persistDebounceTimer);
  persistDebounceTimer = setTimeout(() => {
    persistDebounceTimer = undefined;
    queuePersist();
  }, snapshotDebounceMs);
}

function triggerHeartbeatPersist() {
  if (persistDebounceTimer) clearTimeout(persistDebounceTimer);
  persistDebounceTimer = undefined;
  queuePersist();
}

function queuePersist(): Promise<void> {
  persistChain = persistChain.then(() => saveState(serialize(engine), statePath))
    .catch((error) => console.error(`[matching-engine] persist failed: ${error instanceof Error ? error.message : "unknown"}`));
  return persistChain;
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[matching-engine] shutdown signal — flushing final snapshot");
  if (persistDebounceTimer) clearTimeout(persistDebounceTimer);
  if (persistEnabled) {
    try { await queuePersist(); } catch { /* already logged */ }
  }
  process.exit(0);
}

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
