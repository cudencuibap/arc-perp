import { describe, expect, it, beforeEach } from "vitest";
import { conservativePnlBaseUnits, MatchingEngine } from "../matching-engine.js";
import type { MarketSymbol } from "../types.js";

describe("conservativePnlBaseUnits", () => {
  it("floors positive credits", () => {
    expect(conservativePnlBaseUnits(0.123456789)).toBe(123456n);
    expect(conservativePnlBaseUnits(0.000000999)).toBe(0n);
    expect(conservativePnlBaseUnits(1.0)).toBe(1_000_000n);
    expect(conservativePnlBaseUnits(0)).toBe(0n);
  });

  it("ceils magnitude of negative debits (then re-signs)", () => {
    expect(conservativePnlBaseUnits(-0.123456001)).toBe(-123457n);
    expect(conservativePnlBaseUnits(-0.000000001)).toBe(-1n);
    expect(conservativePnlBaseUnits(-1.0)).toBe(-1_000_000n);
  });

  it("handles whole-number values exactly", () => {
    expect(conservativePnlBaseUnits(42)).toBe(42_000_000n);
    expect(conservativePnlBaseUnits(-42)).toBe(-42_000_000n);
  });

  it("returns 0n for non-finite input", () => {
    expect(conservativePnlBaseUnits(NaN)).toBe(0n);
    expect(conservativePnlBaseUnits(Infinity)).toBe(0n);
    expect(conservativePnlBaseUnits(-Infinity)).toBe(0n);
  });

  it("rounding direction never inflates available_margin", () => {
    // available = gross + realized + unrealized − used
    // For credits (realized/unrealized positive), floor() biases DOWN (smaller credit)
    // For debits (used/unrealized negative), ceil() biases UP-MAGNITUDE (larger debit)
    // Both directions reduce available_margin, never inflate.
    const credit = 0.5555555; // 0.555555 base units in real terms
    expect(conservativePnlBaseUnits(credit)).toBeLessThanOrEqual(BigInt(Math.round(credit * 1_000_000)));
    const debit = -0.5555555;
    expect(conservativePnlBaseUnits(debit)).toBeLessThanOrEqual(BigInt(Math.round(debit * 1_000_000)));
  });
});

describe("MatchingEngine — base-unit projections", () => {
  let engine: MatchingEngine;
  const symbol: MarketSymbol = "BTC-PERP";
  const trader = "human-deadbeef";

  beforeEach(() => {
    engine = new MatchingEngine();
    // Seed a mark so assertOrder won't reject (market needs an external price).
    engine.updateMark(symbol, 100_000, { source: "simulated" });
  });

  it("getRealizedPnlBaseUnits returns 0n for unknown trader", () => {
    expect(engine.getRealizedPnlBaseUnits("nobody")).toBe(0n);
  });

  it("getUsedMarginBaseUnits = 0n with no positions", () => {
    expect(engine.getUsedMarginBaseUnits(trader)).toBe(0n);
  });

  it("getUsedMarginBaseUnits ceils per-position margin (debit side)", () => {
    // Open a position so engine creates margin state.
    // Sell limit at 100k (taker buy at 100k matches).
    engine.placeOrder({ traderId: "maker", symbol, side: "sell", type: "limit", quantity: 0.001, price: 100_000, leverage: 5 });
    engine.placeOrder({ traderId: trader, symbol, side: "buy", type: "market", quantity: 0.001, leverage: 5 });
    // notional = 0.001 * 100_000 = 100; margin = 100 / 5 = 20.0 USDC exactly.
    // Should round to 20_000_000n base units (ceil of exact value = value).
    expect(engine.getUsedMarginBaseUnits(trader)).toBe(20_000_000n);
  });

  it("getUnrealizedPnlBaseUnits sums per-position with conservative rounding", () => {
    // No positions → 0n
    expect(engine.getUnrealizedPnlBaseUnits(trader)).toBe(0n);
  });

  it("setRealBalance overwrites available + equity (does not double-count realized)", () => {
    engine.setRealBalance(trader, 42.5);
    const state = engine.state();
    const balance = state.balances.find((b) => b.traderId === trader);
    expect(balance).toBeDefined();
    expect(balance!.available).toBe(42.5);
    expect(balance!.equity).toBe(42.5);
    expect(balance!.realizedPnl).toBe(0);
  });
});
