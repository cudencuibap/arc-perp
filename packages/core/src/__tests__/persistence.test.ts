import { describe, expect, it, beforeEach } from "vitest";
import { MatchingEngine } from "../matching-engine.js";
import type { MarketSymbol } from "../types.js";

const symbol: MarketSymbol = "BTC-PERP";

function seedBook(engine: MatchingEngine, mark: number) {
  engine.updateMark(symbol, mark, { source: "simulated" });
}

describe("MatchingEngine.getInternalState — deep clone semantics", () => {
  it("returns Maps populated with all known symbols", () => {
    const engine = new MatchingEngine();
    const state = engine.getInternalState();
    expect(state.books.size).toBe(3);
    expect(state.markets.size).toBe(3);
    expect(state.balances.size).toBe(0);
    expect(state.positions.size).toBe(0);
    expect(state.trades).toEqual([]);
    expect(state.agentIds.size).toBe(0);
  });

  it("mutating the returned state does not affect engine internals", () => {
    const engine = new MatchingEngine();
    seedBook(engine, 100_000);
    engine.placeOrder({ traderId: "maker", symbol, side: "sell", type: "limit", quantity: 0.01, price: 100_100, leverage: 5 });
    const snapshot = engine.getInternalState();
    snapshot.books.get(symbol)!.asks.pop();
    snapshot.balances.set("rogue", { traderId: "rogue", equity: 999, available: 999, realizedPnl: 0 });
    snapshot.agentIds.add("phantom-agent");
    // Engine state untouched
    const live = engine.getInternalState();
    expect(live.books.get(symbol)!.asks.length).toBe(1);
    expect(live.balances.has("rogue")).toBe(false);
    expect(live.agentIds.has("phantom-agent")).toBe(false);
  });
});

describe("MatchingEngine.restoreInternalState — round-trip", () => {
  it("restored engine.state() matches original", () => {
    const original = new MatchingEngine();
    seedBook(original, 100_000);
    original.placeOrder({ traderId: "maker", symbol, side: "sell", type: "limit", quantity: 0.01, price: 100_000, leverage: 5 });
    original.placeOrder({ traderId: "human-aaa", symbol, side: "buy", type: "market", quantity: 0.005, leverage: 5 });
    const snapshot = original.getInternalState();

    const restored = new MatchingEngine();
    restored.restoreInternalState(snapshot);

    const aOrig = original.state();
    const aRest = restored.state();
    expect(aRest.positions).toEqual(aOrig.positions);
    expect(aRest.balances).toEqual(aOrig.balances);
    expect(aRest.trades).toEqual(aOrig.trades);
    expect(aRest.books).toEqual(aOrig.books);
  });

  it("auto-seeds missing books/markets if snapshot is partial", () => {
    const engine = new MatchingEngine();
    const partial = engine.getInternalState();
    partial.books.delete("BTC-PERP");
    partial.markets.delete("ETH-PERP");
    const fresh = new MatchingEngine();
    fresh.restoreInternalState(partial);
    const state = fresh.state();
    expect(state.markets.find((m) => m.symbol === "BTC-PERP")).toBeDefined();
    expect(state.markets.find((m) => m.symbol === "ETH-PERP")).toBeDefined();
  });
});

describe("Phase 3 mark-gap safety — restored positions revalued + auto-liquidated by first updateMark", () => {
  let engine: MatchingEngine;

  beforeEach(() => {
    engine = new MatchingEngine();
    seedBook(engine, 100_000);
  });

  // Test (a): unrealized PnL recalculated against fresh mark after restore.
  it("updateMark after restore recomputes unrealized PnL against new mark", () => {
    // Open a 0.01 BTC long at 100_000 (notional 1_000, margin 200 @ 5x)
    engine.placeOrder({ traderId: "maker", symbol, side: "sell", type: "limit", quantity: 0.01, price: 100_000, leverage: 5 });
    engine.placeOrder({ traderId: "user", symbol, side: "buy", type: "market", quantity: 0.01, leverage: 5 });
    const original = engine.getInternalState();

    // Simulate restart: fresh instance, restore snapshot. Original mark is 100_000.
    const fresh = new MatchingEngine();
    fresh.restoreInternalState(original);
    const positionBeforeMark = fresh.state().positions.find((p) => p.traderId === "user");
    expect(positionBeforeMark).toBeDefined();
    // unrealizedPnl was 0 at fill price; restore preserves it.
    expect(positionBeforeMark!.unrealizedPnl).toBe(0);

    // Fresh mark arrives at 101_000 (+1k = +1% on a long 0.01 BTC → +10 USDC)
    fresh.updateMark(symbol, 101_000, { source: "simulated" });
    const positionAfter = fresh.state().positions.find((p) => p.traderId === "user");
    expect(positionAfter).toBeDefined();
    expect(positionAfter!.markPrice).toBe(101_000);
    expect(positionAfter!.unrealizedPnl).toBeCloseTo(10, 6);
  });

  // Test (b): position underwater per fresh mark is auto-liquidated on first
  // updateMark, before any new order can be accepted. Closes the mark-gap
  // window where a position survives by the engine being offline during a
  // bad price move.
  it("first updateMark after restore auto-liquidates an underwater position", () => {
    // Open a 0.01 BTC long at 100_000, 10x leverage.
    // At 10x leverage, riskFactor = 0.45 (per revaluePosition line 255).
    // moveToLiquidation = entryPrice / leverage * riskFactor = 100_000 / 10 * 0.45 = 4_500
    // liquidationPrice for a long = entryPrice − moveToLiquidation = 95_500
    engine.placeOrder({ traderId: "maker", symbol, side: "sell", type: "limit", quantity: 0.01, price: 100_000, leverage: 10 });
    engine.placeOrder({ traderId: "user", symbol, side: "buy", type: "market", quantity: 0.01, leverage: 10 });

    const positionPre = engine.state().positions.find((p) => p.traderId === "user");
    expect(positionPre).toBeDefined();
    expect(positionPre!.liquidationPrice).toBeCloseTo(95_500, 1);

    const snapshot = engine.getInternalState();
    const fresh = new MatchingEngine();
    fresh.restoreInternalState(snapshot);

    // Position still present immediately post-restore (no mark update yet).
    expect(fresh.state().positions.find((p) => p.traderId === "user")).toBeDefined();

    // Market crashed during downtime — fresh mark at 90_000 (< liquidationPrice 95_500).
    // updateMark must auto-liquidate before returning.
    fresh.updateMark(symbol, 90_000, { source: "simulated" });

    expect(fresh.state().positions.find((p) => p.traderId === "user")).toBeUndefined();

    // Balance reflects the liquidation: realizedPnl recorded a loss + 4% penalty.
    const balance = fresh.state().balances.find((b) => b.traderId === "user");
    expect(balance).toBeDefined();
    expect(balance!.realizedPnl).toBeLessThan(0);
  });

  it("first updateMark after restore leaves a still-solvent position alone", () => {
    engine.placeOrder({ traderId: "maker", symbol, side: "sell", type: "limit", quantity: 0.01, price: 100_000, leverage: 10 });
    engine.placeOrder({ traderId: "user", symbol, side: "buy", type: "market", quantity: 0.01, leverage: 10 });
    const snapshot = engine.getInternalState();
    const fresh = new MatchingEngine();
    fresh.restoreInternalState(snapshot);

    // Mark moves down to 98_000 — bad but well above liquidationPrice 95_500.
    fresh.updateMark(symbol, 98_000, { source: "simulated" });

    const position = fresh.state().positions.find((p) => p.traderId === "user");
    expect(position).toBeDefined();
    expect(position!.markPrice).toBe(98_000);
    expect(position!.unrealizedPnl).toBeLessThan(0); // recorded loss, not liquidated
  });
});
