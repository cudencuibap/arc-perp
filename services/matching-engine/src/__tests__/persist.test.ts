import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MatchingEngine, type MarketSymbol } from "@arc-perp/core";
import { deserialize, loadState, saveState, serialize, toInternalState, type PersistedEngineState } from "../persist.js";

const symbol: MarketSymbol = "BTC-PERP";

function seedEngine(): MatchingEngine {
  const engine = new MatchingEngine();
  engine.updateMark(symbol, 100_000, { source: "simulated" });
  return engine;
}

describe("serialize", () => {
  it("snapshots schema-version 1 with savedAt", () => {
    const engine = seedEngine();
    const snap = serialize(engine, 1_700_000_000_000);
    expect(snap.version).toBe(1);
    expect(snap.savedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(Object.keys(snap.books)).toContain("BTC-PERP");
  });

  it("trims trades older than 24h", () => {
    const engine = seedEngine();
    const now = Date.now();
    // Fabricate ancient + recent trades via private state mutation.
    const state = engine.getInternalState();
    state.trades.push(
      { id: "old-1", symbol, price: 100_000, quantity: 0.01, takerSide: "buy", buyerId: "a", sellerId: "b", ts: now - 86_400_000 - 1 },
      { id: "old-2", symbol, price: 100_000, quantity: 0.01, takerSide: "buy", buyerId: "a", sellerId: "b", ts: now - 86_400_000 - 10_000 },
      { id: "fresh-1", symbol, price: 100_000, quantity: 0.01, takerSide: "buy", buyerId: "a", sellerId: "b", ts: now - 1000 }
    );
    engine.restoreInternalState(state);
    const snap = serialize(engine, now);
    expect(snap.trades.find((t) => t.id === "old-1")).toBeUndefined();
    expect(snap.trades.find((t) => t.id === "old-2")).toBeUndefined();
    expect(snap.trades.find((t) => t.id === "fresh-1")).toBeDefined();
  });

  it("caps trades at the most recent 1000", () => {
    const engine = seedEngine();
    const now = Date.now();
    const state = engine.getInternalState();
    for (let i = 0; i < 1500; i++) {
      state.trades.push({ id: `t-${i}`, symbol, price: 100_000, quantity: 0.001, takerSide: "buy", buyerId: "a", sellerId: "b", ts: now - i });
    }
    engine.restoreInternalState(state);
    const snap = serialize(engine, now);
    expect(snap.trades.length).toBe(1000);
  });
});

describe("deserialize", () => {
  it("drops seed-mm-* orders from books on reload (bot liquidity regenerates)", () => {
    const baseState: PersistedEngineState = {
      version: 1,
      savedAt: "2026-06-06T00:00:00.000Z",
      books: {
        "BTC-PERP": {
          bids: [
            { id: "seed-1", traderId: "seed-mm-BTC-PERP", agentId: "mm-BTC-PERP", symbol: "BTC-PERP", side: "buy", type: "limit", quantity: 0.1, remaining: 0.1, price: 99_500, leverage: 5, createdAt: 0 },
            { id: "user-1", traderId: "human-aaa", symbol: "BTC-PERP", side: "buy", type: "limit", quantity: 0.05, remaining: 0.05, price: 99_000, leverage: 5, createdAt: 0 }
          ],
          asks: [
            { id: "seed-2", traderId: "seed-mm-BTC-PERP", agentId: "mm-BTC-PERP", symbol: "BTC-PERP", side: "sell", type: "limit", quantity: 0.1, remaining: 0.1, price: 100_500, leverage: 5, createdAt: 0 }
          ]
        },
        "ETH-PERP": { bids: [], asks: [] },
        "SOL-PERP": { bids: [], asks: [] }
      },
      balances: [],
      positions: [],
      trades: [],
      markets: {} as PersistedEngineState["markets"],
      agentIds: []
    };
    const internal = deserialize(JSON.stringify(baseState));
    const btcBook = internal.books.get("BTC-PERP")!;
    expect(btcBook.bids.length).toBe(1);
    expect(btcBook.bids[0]!.id).toBe("user-1");
    expect(btcBook.asks.length).toBe(0);
  });

  it("rejects unknown schema version", () => {
    expect(() => deserialize(JSON.stringify({ version: 99, books: {}, balances: [], positions: [], trades: [], markets: {}, agentIds: [] })))
      .toThrow(/schema version 99/);
  });

  it("rejects malformed JSON", () => {
    expect(() => deserialize("{ not json"))
      .toThrow(/not valid JSON/);
  });
});

describe("saveState + loadState round-trip", () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `arc-perp-persist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(tmpDir, { recursive: true });
    statePath = join(tmpDir, "engine-state.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("loadState returns null when file does not exist", async () => {
    const result = await loadState(statePath);
    expect(result).toBeNull();
  });

  it("save → load gives identical PersistedEngineState (post-JSON normalization)", async () => {
    const engine = seedEngine();
    engine.placeOrder({ traderId: "maker", symbol, side: "sell", type: "limit", quantity: 0.01, price: 100_000, leverage: 5 });
    engine.placeOrder({ traderId: "human-aaa", symbol, side: "buy", type: "market", quantity: 0.005, leverage: 5 });
    const snap = serialize(engine);
    await saveState(snap, statePath);
    const loaded = await loadState(statePath);
    // JSON serialization drops undefined fields and signed zeros; compare
    // both sides through the same lens so the round-trip is exact.
    expect(JSON.stringify(loaded)).toBe(JSON.stringify(snap));
  });

  it("saveState writes atomically — no .tmp left on disk after success", async () => {
    const engine = seedEngine();
    await saveState(serialize(engine), statePath);
    let tmpExists = false;
    try {
      await readFile(`${statePath}.tmp`, "utf8");
      tmpExists = true;
    } catch { /* expected ENOENT */ }
    expect(tmpExists).toBe(false);
  });

  it("loadState throws on corrupt file (caller decides exit)", async () => {
    await writeFile(statePath, "{ this is not json", "utf8");
    await expect(loadState(statePath)).rejects.toThrow(/not valid JSON/);
  });

  it("loadState throws on wrong schema version", async () => {
    await writeFile(statePath, JSON.stringify({ version: 999, books: {}, balances: [], positions: [], trades: [], markets: {}, agentIds: [] }), "utf8");
    await expect(loadState(statePath)).rejects.toThrow(/schema version 999/);
  });
});

describe("toInternalState", () => {
  it("converts parsed state to engine-ready InternalState (Maps + Set)", () => {
    const engine = seedEngine();
    const snap = serialize(engine);
    const internal = toInternalState(snap);
    expect(internal.books).toBeInstanceOf(Map);
    expect(internal.balances).toBeInstanceOf(Map);
    expect(internal.positions).toBeInstanceOf(Map);
    expect(internal.markets).toBeInstanceOf(Map);
    expect(internal.agentIds).toBeInstanceOf(Set);
    expect(internal.books.size).toBe(3);
  });

  it("restoreInternalState(toInternalState(serialize(engine))) reproduces engine.state()", () => {
    const original = seedEngine();
    original.placeOrder({ traderId: "maker", symbol, side: "sell", type: "limit", quantity: 0.01, price: 100_000, leverage: 5 });
    original.placeOrder({ traderId: "human-aaa", symbol, side: "buy", type: "market", quantity: 0.005, leverage: 5 });
    const snap = serialize(original);
    const fresh = new MatchingEngine();
    fresh.restoreInternalState(toInternalState(snap));
    const a = original.state();
    const b = fresh.state();
    expect(b.positions).toEqual(a.positions);
    expect(b.balances).toEqual(a.balances);
    expect(b.trades).toEqual(a.trades);
  });
});
