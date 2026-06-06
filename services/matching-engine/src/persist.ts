// Phase 3 — engine state persistence I/O. Pure functions over filesystem so
// the serialization/deserialization/seed-mm-filter logic is unit-testable
// without spawning the engine or doing real disk I/O (test passes path to
// a temp file).
//
// State file lives at `services/matching-engine/data/engine-state.json` and
// is written atomically: writeFile(.tmp) + rename(.tmp → real). A crash
// mid-write leaves the previous valid snapshot intact.
//
// Map and Set are converted to plain JSON-friendly shapes here (object
// keyed by symbol for Maps with known small keys, array for Sets); the
// inverse conversion happens on deserialize. This is preferred over a
// custom JSON replacer/reviver pair because the shapes are explicit and
// the schema can evolve with a single `version` field.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Balance, InternalState, MarketMeta, MarketSymbol, Order, Position, Trade } from "@arc-perp/core";
import type { MatchingEngine } from "@arc-perp/core";

const SYMBOLS: MarketSymbol[] = ["BTC-PERP", "ETH-PERP", "SOL-PERP"];
const TRADE_TAIL_CAP = 1000;
const TRADE_AGE_CAP_MS = 86_400_000; // 24h
const SCHEMA_VERSION = 1;

export interface PersistedEngineState {
  version: number;
  savedAt: string;
  books: Record<MarketSymbol, { bids: Order[]; asks: Order[] }>;
  balances: Balance[];
  positions: Position[];
  trades: Trade[];
  markets: Record<MarketSymbol, MarketMeta>;
  agentIds: string[];
}

// serialize — engine in-memory state → JSON-friendly shape. Trims trades to
// the more selective of {tail TRADE_TAIL_CAP, ts ≥ now − 24h} to keep state
// file size bounded across long uptimes. seed-mm-* orders are NOT filtered
// here so the snapshot reflects actual engine state for debugging; filtering
// happens in deserialize so reload starts with clean bot liquidity that
// seedLiquidity regenerates on its 700ms timer.
export function serialize(engine: MatchingEngine, now: number = Date.now()): PersistedEngineState {
  const state = engine.getInternalState();
  const tradeCutoff = now - TRADE_AGE_CAP_MS;
  const trades = state.trades
    .filter((trade) => trade.ts >= tradeCutoff)
    .slice(-TRADE_TAIL_CAP);
  return {
    version: SCHEMA_VERSION,
    savedAt: new Date(now).toISOString(),
    books: mapToSymbolRecord(state.books),
    balances: [...state.balances.values()],
    positions: [...state.positions.values()],
    trades,
    markets: mapToSymbolRecord(state.markets),
    agentIds: [...state.agentIds]
  };
}

// deserialize — raw JSON string → InternalState. Convenience wrapper around
// parseAndValidate + toInternalState for callers that have a string blob
// (the loadState path goes parsed → toInternalState directly, skipping the
// redundant JSON.stringify+parse round-trip that drops undefined fields and
// signed zeros).
export function deserialize(raw: string): InternalState {
  return toInternalState(parseAndValidate(raw));
}

function parseAndValidate(raw: string): PersistedEngineState {
  let parsed: PersistedEngineState;
  try {
    parsed = JSON.parse(raw) as PersistedEngineState;
  } catch (error) {
    throw new Error(`engine-state.json is not valid JSON: ${errorMessage(error)}`);
  }
  if (parsed.version !== SCHEMA_VERSION) {
    throw new Error(`engine-state.json schema version ${parsed.version} is not supported by this build (expected ${SCHEMA_VERSION})`);
  }
  return parsed;
}

// Atomic write — writeFile to a sibling .tmp file then rename. fs.rename is
// atomic on the same filesystem on both POSIX and Windows, so a crash
// mid-write either leaves the previous snapshot intact (tmp file orphan,
// real file untouched) or the new snapshot fully written.
export async function saveState(state: PersistedEngineState, statePath: string): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.tmp`;
  const data = JSON.stringify(state, null, 2);
  await writeFile(tmpPath, data, "utf8");
  await rename(tmpPath, statePath);
}

// loadState — returns null if file does not exist (fresh boot), throws if
// file exists but is malformed/wrong-version. Caller decides whether to
// exit(1) on throw or rebuild from a backup.
export async function loadState(statePath: string): Promise<PersistedEngineState | null> {
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: PersistedEngineState;
  try {
    parsed = JSON.parse(raw) as PersistedEngineState;
  } catch (error) {
    throw new Error(`engine-state.json is not valid JSON: ${errorMessage(error)}`);
  }
  if (parsed.version !== SCHEMA_VERSION) {
    throw new Error(`engine-state.json schema version ${parsed.version} is not supported by this build (expected ${SCHEMA_VERSION})`);
  }
  return parsed;
}

// toInternalState — already-parsed PersistedEngineState → engine-ready
// InternalState. Drops seed-mm-* orders from books here so the reloaded
// engine doesn't carry stale bot quotes; seedLiquidity will repopulate
// within ~700ms.
export function toInternalState(parsed: PersistedEngineState): InternalState {
  const books = new Map<MarketSymbol, { bids: Order[]; asks: Order[] }>();
  for (const symbol of SYMBOLS) {
    const side = parsed.books?.[symbol] ?? { bids: [], asks: [] };
    books.set(symbol, {
      bids: (side.bids ?? []).filter(notSeedMaker),
      asks: (side.asks ?? []).filter(notSeedMaker)
    });
  }
  const balances = new Map<string, Balance>();
  for (const balance of parsed.balances ?? []) balances.set(balance.traderId, balance);
  const positions = new Map<string, Position>();
  for (const position of parsed.positions ?? []) positions.set(`${position.traderId}:${position.symbol}`, position);
  const markets = new Map<MarketSymbol, MarketMeta>();
  for (const symbol of SYMBOLS) {
    const meta = parsed.markets?.[symbol];
    if (meta) markets.set(symbol, meta);
  }
  return {
    books,
    balances,
    positions,
    trades: parsed.trades ?? [],
    markets,
    agentIds: new Set(parsed.agentIds ?? [])
  };
}

function mapToSymbolRecord<T>(map: Map<MarketSymbol, T>): Record<MarketSymbol, T> {
  const out = {} as Record<MarketSymbol, T>;
  for (const [key, value] of map.entries()) out[key] = value;
  return out;
}

function notSeedMaker(order: Order): boolean {
  return !order.traderId.startsWith("seed-mm-");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
