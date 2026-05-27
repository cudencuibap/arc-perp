import { EventEmitter } from "node:events";
import type { Balance, EngineEvent, MarketMeta, MarketState, MarketSymbol, Order, OrderBookSnapshot, OrderRequest, Position, Side, Trade } from "./types.js";

const symbols: MarketSymbol[] = ["BTC-PERP", "ETH-PERP", "SOL-PERP"];
const defaultMarks: Record<MarketSymbol, number> = {
  "BTC-PERP": 68000,
  "ETH-PERP": 3600,
  "SOL-PERP": 145
};

export class MatchingEngine extends EventEmitter {
  private books = new Map<MarketSymbol, { bids: Order[]; asks: Order[] }>();
  private balances = new Map<string, Balance>();
  private positions = new Map<string, Position>();
  private trades: Trade[] = [];
  private markets = new Map<MarketSymbol, MarketMeta>();
  private agentIds = new Set<string>();

  constructor() {
    super();
    for (const symbol of symbols) {
      this.books.set(symbol, { bids: [], asks: [] });
      this.markets.set(symbol, {
        symbol,
        markPrice: defaultMarks[symbol],
        indexPrice: defaultMarks[symbol],
        fundingRate: 0.0001,
        openInterest: 0,
        volume24h: 0,
        regime: "calm",
        spreadBps: 8,
        ts: Date.now()
      });
    }
  }

  placeOrder(request: OrderRequest): { orderId: string; trades: Trade[] } {
    this.assertOrder(request);
    this.ensureBalance(request.traderId);
    if (request.agentId) this.agentIds.add(request.agentId);
    const mark = this.mark(request.symbol);
    const order: Order = {
      id: randomId("ord"),
      traderId: request.traderId,
      agentId: request.agentId,
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      quantity: request.quantity,
      remaining: request.quantity,
      price: request.type === "market" ? (request.side === "buy" ? Number.MAX_SAFE_INTEGER : 0) : request.price ?? mark,
      leverage: clamp(request.leverage ?? 5, 1, 50),
      walletAddress: request.walletAddress,
      settleOnchain: request.settleOnchain,
      createdAt: Date.now()
    };

    const fills = this.match(order);
    if (order.remaining > 0 && order.type === "limit") {
      const book = this.book(order.symbol);
      const side = order.side === "buy" ? book.bids : book.asks;
      side.push(order);
      this.sortBook(order.symbol);
    }
    this.emitBook(order.symbol);
    return { orderId: order.id, trades: fills };
  }

  updateMark(symbol: MarketSymbol, price: number, meta: Partial<Omit<MarketMeta, "symbol" | "markPrice" | "ts">> = {}): void {
    if (!symbols.includes(symbol) || price <= 0) return;
    const previous = this.markets.get(symbol);
    const next: MarketMeta = {
      symbol,
      markPrice: price,
      indexPrice: meta.indexPrice ?? previous?.indexPrice ?? price,
      fundingRate: meta.fundingRate ?? previous?.fundingRate ?? 0,
      openInterest: meta.openInterest ?? previous?.openInterest ?? this.openInterest(symbol),
      volume24h: meta.volume24h ?? previous?.volume24h ?? this.volume24h(symbol),
      regime: meta.regime ?? previous?.regime ?? "calm",
      spreadBps: meta.spreadBps ?? previous?.spreadBps ?? 8,
      source: meta.source ?? previous?.source,
      latencyMs: meta.latencyMs ?? previous?.latencyMs,
      volatilityBps: meta.volatilityBps ?? previous?.volatilityBps,
      ts: Date.now()
    };
    this.markets.set(symbol, next);
    this.pruneStaleOrders(symbol, next.markPrice);
    for (const position of [...this.positions.values()].filter((item) => item.symbol === symbol)) {
      this.revalue(position.traderId, symbol);
    }
    this.emitEvent({ type: "mark", payload: next });
  }

  liquidate(traderId: string, symbol: MarketSymbol): boolean {
    const key = positionKey(traderId, symbol);
    const position = this.positions.get(key);
    if (!position || position.size === 0) return false;
    const balance = this.ensureBalance(traderId);
    balance.realizedPnl += position.unrealizedPnl - position.margin * 0.04;
    balance.equity = Math.max(0, balance.equity + position.unrealizedPnl - position.margin * 0.04);
    balance.available = balance.equity;
    this.positions.delete(key);
    this.emitEvent({ type: "liquidation", payload: { traderId, symbol, size: position.size, markPrice: position.markPrice, ts: Date.now() } });
    this.emitEvent({ type: "balance", payload: balance });
    return true;
  }

  state(): MarketState {
    return {
      symbols,
      books: symbols.map((symbol) => this.snapshot(symbol)),
      trades: this.trades.slice(-100),
      positions: [...this.positions.values()],
      balances: [...this.balances.values()],
      markets: symbols.map((symbol) => this.market(symbol))
    };
  }

  agentList(): string[] {
    return [...this.agentIds];
  }

  private match(taker: Order): Trade[] {
    const book = this.book(taker.symbol);
    const makers = taker.side === "buy" ? book.asks : book.bids;
    const fills: Trade[] = [];
    while (taker.remaining > 0 && makers.length > 0) {
      const maker = makers[0]!;
      const crosses = taker.side === "buy" ? taker.price >= maker.price : taker.price <= maker.price;
      if (!crosses) break;
      const quantity = Math.min(taker.remaining, maker.remaining);
      maker.remaining = round(maker.remaining - quantity);
      taker.remaining = round(taker.remaining - quantity);
      const buyerId = taker.side === "buy" ? taker.traderId : maker.traderId;
      const sellerId = taker.side === "sell" ? taker.traderId : maker.traderId;
      const trade: Trade = {
        id: randomId("trd"),
        symbol: taker.symbol,
        price: maker.price,
        quantity,
        takerSide: taker.side,
        buyerId,
        sellerId,
        ts: Date.now()
      };
      this.trades.push(trade);
      fills.push(trade);
      const buyerWallet = taker.side === "buy" ? taker.walletAddress : maker.walletAddress;
      const sellerWallet = taker.side === "sell" ? taker.walletAddress : maker.walletAddress;
      this.applyFill(buyerId, taker.symbol, quantity, trade.price, taker.side === "buy" ? taker.leverage : maker.leverage, buyerWallet);
      this.applyFill(sellerId, taker.symbol, -quantity, trade.price, taker.side === "sell" ? taker.leverage : maker.leverage, sellerWallet);
      const market = this.market(taker.symbol);
      this.markets.set(taker.symbol, {
        ...market,
        markPrice: trade.price,
        openInterest: this.openInterest(taker.symbol),
        volume24h: this.volume24h(taker.symbol),
        ts: Date.now()
      });
      this.emitEvent({ type: "trade", payload: trade });
      if (maker.remaining <= 0) makers.shift();
    }
    return fills;
  }

  private applyFill(traderId: string, symbol: MarketSymbol, signedQuantity: number, price: number, leverage: number, walletAddress?: string): void {
    const balance = this.ensureBalance(traderId);
    const key = positionKey(traderId, symbol);
    const existing = this.positions.get(key);
    const oldSize = existing?.size ?? 0;
    const newSize = round(oldSize + signedQuantity);
    const notional = Math.abs(signedQuantity * price);
    const margin = notional / leverage;
    balance.available = round(Math.max(0, balance.available - margin));
    if (newSize === 0) {
      if (existing) balance.realizedPnl = round(balance.realizedPnl + existing.unrealizedPnl);
      this.positions.delete(key);
      this.emitEvent({ type: "balance", payload: balance });
      return;
    }
    const entryPrice = entryForFill(existing?.entryPrice ?? price, oldSize, newSize, signedQuantity, price);
    const nextMargin = marginForFill(existing?.margin ?? 0, oldSize, newSize, margin);
    const position: Position = {
      traderId,
      symbol,
      walletAddress: walletAddress ?? existing?.walletAddress,
      size: newSize,
      entryPrice,
      markPrice: this.mark(symbol),
      leverage,
      unrealizedPnl: 0,
      margin: nextMargin,
      liquidationPrice: 0
    };
    this.positions.set(key, this.revaluePosition(position));
    this.emitEvent({ type: "position", payload: this.positions.get(key)! });
    this.emitEvent({ type: "balance", payload: balance });
  }

  private revalue(traderId: string, symbol: MarketSymbol): void {
    const key = positionKey(traderId, symbol);
    const position = this.positions.get(key);
    if (!position) return;
    this.positions.set(key, this.revaluePosition(position));
    this.emitEvent({ type: "position", payload: this.positions.get(key)! });
  }

  private revaluePosition(position: Position): Position {
    const markPrice = this.mark(position.symbol);
    const direction = Math.sign(position.size);
    const unrealizedPnl = round((markPrice - position.entryPrice) * Math.abs(position.size) * direction);
    const riskFactor = position.leverage >= 20 ? 0.08 : 0.45;
    const moveToLiquidation = position.entryPrice / position.leverage * riskFactor;
    return {
      ...position,
      markPrice,
      unrealizedPnl,
      liquidationPrice: round(position.size > 0 ? position.entryPrice - moveToLiquidation : position.entryPrice + moveToLiquidation)
    };
  }

  private snapshot(symbol: MarketSymbol): OrderBookSnapshot {
    const book = this.book(symbol);
    return {
      symbol,
      bids: aggregate(book.bids, "buy").slice(0, 20),
      asks: aggregate(book.asks, "sell").slice(0, 20),
      ts: Date.now()
    };
  }

  private emitBook(symbol: MarketSymbol): void {
    this.emitEvent({ type: "orderbook", payload: this.snapshot(symbol) });
  }

  private emitEvent(event: EngineEvent): void {
    this.emit("event", event);
  }

  private book(symbol: MarketSymbol): { bids: Order[]; asks: Order[] } {
    return this.books.get(symbol)!;
  }

  private mark(symbol: MarketSymbol): number {
    return this.market(symbol).markPrice;
  }

  private market(symbol: MarketSymbol): MarketMeta {
    return this.markets.get(symbol) ?? {
      symbol,
      markPrice: defaultMarks[symbol],
      indexPrice: defaultMarks[symbol],
      fundingRate: 0,
      openInterest: 0,
      volume24h: 0,
      regime: "calm",
      spreadBps: 8,
      ts: Date.now()
    };
  }

  private openInterest(symbol: MarketSymbol): number {
    return round([...this.positions.values()].filter((position) => position.symbol === symbol).reduce((sum, position) => sum + Math.abs(position.size * position.markPrice), 0));
  }

  private volume24h(symbol: MarketSymbol): number {
    const cutoff = Date.now() - 86_400_000;
    return round(this.trades.filter((trade) => trade.symbol === symbol && trade.ts >= cutoff).reduce((sum, trade) => sum + trade.price * trade.quantity, 0));
  }

  private sortBook(symbol: MarketSymbol): void {
    const book = this.book(symbol);
    book.bids.sort((a, b) => b.price - a.price || a.createdAt - b.createdAt);
    book.asks.sort((a, b) => a.price - b.price || a.createdAt - b.createdAt);
  }

  private pruneStaleOrders(symbol: MarketSymbol, markPrice: number): void {
    const book = this.book(symbol);
    const maxDistance = markPrice * 0.08;
    book.bids = book.bids.filter((order) => Math.abs(order.price - markPrice) <= maxDistance && order.price < markPrice * 1.01);
    book.asks = book.asks.filter((order) => Math.abs(order.price - markPrice) <= maxDistance && order.price > markPrice * 0.99);
  }

  private ensureBalance(traderId: string): Balance {
    const balance = this.balances.get(traderId) ?? { traderId, equity: 100000, available: 100000, realizedPnl: 0 };
    this.balances.set(traderId, balance);
    return balance;
  }

  private assertOrder(request: OrderRequest): void {
    if (!symbols.includes(request.symbol)) throw new Error("Unsupported market");
    const market = this.market(request.symbol);
    if (!market.source) throw new Error("Market is waiting for external pricing");
    if (request.quantity <= 0) throw new Error("Quantity must be positive");
    if (request.type === "limit" && (!request.price || request.price <= 0)) throw new Error("Limit price required");
    if (request.type === "limit" && request.price && Math.abs(request.price - market.markPrice) / market.markPrice > 0.08) {
      throw new Error("Limit price is outside live market band");
    }
  }
}

function aggregate(orders: Order[], side: Side) {
  const levels = new Map<number, number>();
  for (const order of orders) levels.set(order.price, round((levels.get(order.price) ?? 0) + order.remaining));
  const rows = [...levels.entries()].map(([price, quantity]) => ({ price, quantity }));
  return rows.sort((a, b) => side === "buy" ? b.price - a.price : a.price - b.price);
}

function positionKey(traderId: string, symbol: MarketSymbol): string {
  return `${traderId}:${symbol}`;
}

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function entryForFill(previousEntry: number, oldSize: number, newSize: number, signedQuantity: number, price: number): number {
  if (oldSize === 0 || Math.sign(oldSize) !== Math.sign(newSize)) return price;
  if (Math.sign(oldSize) !== Math.sign(signedQuantity)) return previousEntry;
  return round(((previousEntry * Math.abs(oldSize)) + (price * Math.abs(signedQuantity))) / Math.abs(newSize));
}

function marginForFill(previousMargin: number, oldSize: number, newSize: number, addedMargin: number): number {
  if (oldSize === 0 || Math.sign(oldSize) === Math.sign(newSize) && Math.abs(newSize) > Math.abs(oldSize)) return round(previousMargin + addedMargin);
  if (Math.sign(oldSize) === Math.sign(newSize)) return round(previousMargin * (Math.abs(newSize) / Math.abs(oldSize)));
  return addedMargin;
}

function round(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}
