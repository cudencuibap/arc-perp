export type MarketSymbol = "BTC-PERP" | "ETH-PERP" | "SOL-PERP";
export type Side = "buy" | "sell";
export type OrderType = "limit" | "market";

export interface OrderRequest {
  traderId: string;
  symbol: MarketSymbol;
  side: Side;
  type: OrderType;
  quantity: number;
  price?: number;
  leverage?: number;
  agentId?: string;
  walletAddress?: string;
  settleOnchain?: boolean;
}

export interface Order extends Required<Omit<OrderRequest, "price" | "leverage" | "agentId" | "walletAddress" | "settleOnchain">> {
  id: string;
  remaining: number;
  price: number;
  leverage: number;
  agentId?: string;
  walletAddress?: string;
  settleOnchain?: boolean;
  createdAt: number;
}

export interface Trade {
  id: string;
  symbol: MarketSymbol;
  price: number;
  quantity: number;
  takerSide: Side;
  buyerId: string;
  sellerId: string;
  ts: number;
}

export interface Position {
  traderId: string;
  symbol: MarketSymbol;
  walletAddress?: string;
  size: number;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  unrealizedPnl: number;
  margin: number;
  liquidationPrice: number;
}

export interface Balance {
  traderId: string;
  equity: number;
  available: number;
  realizedPnl: number;
}

export interface OrderBookLevel {
  price: number;
  quantity: number;
}

export interface OrderBookSnapshot {
  symbol: MarketSymbol;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  ts: number;
}

export interface MarketMeta {
  symbol: MarketSymbol;
  markPrice: number;
  indexPrice: number;
  fundingRate: number;
  openInterest: number;
  volume24h: number;
  regime: "calm" | "active" | "volatile" | "stress";
  spreadBps: number;
  source?: "chainlink" | "binance" | "simulated";
  latencyMs?: number;
  volatilityBps?: number;
  ts: number;
}

export type EngineEvent =
  | { type: "orderbook"; payload: OrderBookSnapshot }
  | { type: "trade"; payload: Trade }
  | { type: "position"; payload: Position }
  | { type: "balance"; payload: Balance }
  | { type: "liquidation"; payload: { traderId: string; symbol: MarketSymbol; size: number; markPrice: number; ts: number } }
  | { type: "world"; payload: MarketWorldState }
  | { type: "mark"; payload: MarketMeta };

export interface MarketState {
  symbols: MarketSymbol[];
  books: OrderBookSnapshot[];
  trades: Trade[];
  positions: Position[];
  balances: Balance[];
  markets: MarketMeta[];
}

// Phase 3 — full engine state surface for serialization. Returned by
// MatchingEngine.getInternalState; consumed by MatchingEngine.restoreInternalState.
// Maps and Sets are preserved (not lossy-converted) so a direct restore is
// possible without an intermediate JSON step.
export interface InternalState {
  books: Map<MarketSymbol, { bids: Order[]; asks: Order[] }>;
  balances: Map<string, Balance>;
  positions: Map<string, Position>;
  trades: Trade[];
  markets: Map<MarketSymbol, MarketMeta>;
  agentIds: Set<string>;
}

export interface AgentNode {
  id: string;
  role: "market-maker" | "trader" | "liquidator" | "treasury" | "arbitrage";
  district: string;
  x: number;
  y: number;
  intensity: number;
}

export interface DistrictHeat {
  id: string;
  label: string;
  activity: number;
  risk: number;
  liquidity: number;
}

export interface MarketWorldState {
  ts: number;
  districts: DistrictHeat[];
  agents: AgentNode[];
}
