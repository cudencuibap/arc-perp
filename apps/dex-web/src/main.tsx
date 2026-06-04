import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, BarChart3, Bell, Bot, ChartCandlestick, CircleDollarSign, Clock3, Copy, Crosshair, Crown, Eye, Gauge, Layers3, LineChart, Maximize2, MousePointer2, Radio, Ruler, Search, Send, Settings, ShieldAlert, SlidersHorizontal, Target, TrendingUp, Vault, Wallet, Zap } from "lucide-react";
import { type EngineEvent, type MarketMeta, type MarketState, type MarketSymbol, type MarketWorldState, type OrderBookLevel, type OrderBookSnapshot, type Position, type Trade } from "@arc-perp/core";
import { arcTestnet, collateralVaultAbi, erc20Abi, type OnchainConfig } from "@arc-perp/core/onchain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CandlestickSeries, ColorType, createChart, HistogramSeries, LineSeries, type IChartApi, type UTCTimestamp } from "lightweight-charts";
import { createConfig, http, WagmiProvider, useAccount, useBalance, useChainId, useConnect, useDisconnect, useReadContracts, useSwitchChain, useWriteContract } from "wagmi";
import { injected, metaMask, walletConnect } from "wagmi/connectors";
import { formatUnits, maxUint256, parseUnits } from "viem";
import "./styles.css";

const isLocalHost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const MATCHING_ENGINE_URL = import.meta.env.VITE_MATCHING_ENGINE_URL ?? (isLocalHost ? "http://localhost:4101" : "https://arc-perp-matching-engine.onrender.com");
const MARKET_DATA_URL = import.meta.env.VITE_MARKET_DATA_URL ?? (isLocalHost ? "http://localhost:4102" : "https://arc-perp-market-data.onrender.com");
const ONCHAIN_CONFIG_URL = import.meta.env.VITE_ONCHAIN_CONFIG_URL;
const WS_BASE_URL = import.meta.env.VITE_WS_URL ?? (isLocalHost ? "ws://localhost:4100/ws" : "wss://arc-perp-websocket-gateway.onrender.com/ws");
const symbols: MarketSymbol[] = ["BTC-PERP", "ETH-PERP", "SOL-PERP"];
const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID;
const queryClient = new QueryClient();
const wagmiConfig = createConfig({
  chains: [arcTestnet],
  transports: { [arcTestnet.id]: http(arcTestnet.rpcUrls.default.http[0]) },
  connectors: [
    injected({ shimDisconnect: true }),
    metaMask(),
    ...(walletConnectProjectId ? [walletConnect({ projectId: walletConnectProjectId })] : [])
  ]
});

const ARC_CHAIN_ID_HEX = `0x${arcTestnet.id.toString(16)}`;

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

async function ensureArcTestnet(): Promise<void> {
  const ethereum = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (!ethereum) throw new Error("No EIP-1193 wallet detected");
  try {
    await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARC_CHAIN_ID_HEX }] });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code !== 4902) throw err;
    await ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: ARC_CHAIN_ID_HEX,
        chainName: "Arc Testnet",
        nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
        rpcUrls: ["https://rpc.testnet.arc.network"],
        blockExplorerUrls: ["https://testnet.arcscan.app"]
      }]
    });
  }
}

type Direction = "up" | "down" | "flat";
type GatewayEvent = { type: "gateway"; payload: { connected?: boolean; upstream?: string; marketData?: string; ts: number } };
type MarketDataEvent =
  | { type: "market-data-health"; payload: { source: string; connected?: boolean; retryMs?: number; ts: number } }
  | { type: "market-data-tick"; payload: MarketMeta & { price?: number } }
  | { type: "market-data-state"; payload: Array<MarketMeta & { price?: number }> };
type PricePoint = { ts: number; price: number; volume?: number };
type OrderMode = "Market" | "Limit" | "Stop Market" | "Stop Limit" | "TWAP" | "Scale";
type LocalOrder = { id: string; symbol: MarketSymbol; side: "buy" | "sell"; type: OrderMode; quantity: number; price?: number; trigger?: number; status: string; createdAt: number };
type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
type ChartTool = "cursor" | "crosshair" | "trend" | "measure" | "fib";
type Indicator = "MA" | "EMA" | "VWAP" | "BB" | "RSI" | "MACD" | "CVD" | "OI" | "Funding";
type Candle = { ts: number; open: number; high: number; low: number; close: number; volume: number; cvd: number; openInterest: number; funding: number };
type HistoryCandle = { time: number; open: number; high: number; low: number; close: number; volume: number };

function App() {
  const [state, setState] = useState<MarketState>();
  const [selected, setSelected] = useState<MarketSymbol>("BTC-PERP");
  const [trades, setTrades] = useState<Trade[]>([]);
  const [world, setWorld] = useState<MarketWorldState>();
  const [status, setStatus] = useState("connecting");
  const [feedStatus, setFeedStatus] = useState("feed pending");
  const [priceDirection, setPriceDirection] = useState<Direction>("flat");
  const [history, setHistory] = useState<Record<MarketSymbol, PricePoint[]>>({ "BTC-PERP": [], "ETH-PERP": [], "SOL-PERP": [] });
  const [localOrders, setLocalOrders] = useState<LocalOrder[]>([]);
  const reconnectTimer = useRef<number | undefined>(undefined);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const selectedRef = useRef<MarketSymbol>(selected);
  const latestPrices = useRef<Record<string, number>>({});

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    let closed = false;

    function connect(delay = 0) {
      window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = window.setTimeout(() => {
        if (closed) return;
        setStatus("connecting");
        const socket = new WebSocket(WS_BASE_URL);
        socketRef.current = socket;

        socket.onopen = () => setStatus("live");
        socket.onmessage = (message) => {
          const event = JSON.parse(message.data) as EngineEvent | { type: "state"; payload: MarketState } | GatewayEvent | MarketDataEvent;
          if (event.type === "gateway") {
            if (event.payload.upstream === "reconnecting") setStatus("reconnecting");
            if (event.payload.marketData === "live") setFeedStatus("feed live");
            if (event.payload.marketData === "reconnecting") setFeedStatus("feed reconnecting");
            return;
          }
          if (event.type === "market-data-health") {
            setFeedStatus(event.payload.connected === false ? "feed reconnecting" : `${event.payload.source} feed`);
            return;
          }
          if (event.type === "market-data-tick") {
            pushPrice(event.payload.symbol, event.payload.markPrice ?? event.payload.price ?? 0);
            return;
          }
          if (event.type === "market-data-state") {
            for (const item of event.payload) pushPrice(item.symbol, item.markPrice ?? item.price ?? 0);
            return;
          }
          if (event.type === "state") {
            setState(event.payload);
            setTrades(event.payload.trades.slice().reverse());
            for (const trade of event.payload.trades) pushPrice(trade.symbol, trade.price, trade.price * trade.quantity);
          }
          if (event.type === "orderbook") mergeBook(event.payload);
          if (event.type === "mark") {
            mergeMarket(event.payload);
            pushPrice(event.payload.symbol, event.payload.markPrice);
          }
          if (event.type === "trade") {
            setTrades((prev) => [event.payload, ...prev].slice(0, 80));
            pushPrice(event.payload.symbol, event.payload.price, event.payload.price * event.payload.quantity);
          }
          if (event.type === "position") mergePosition(event.payload);
          if (event.type === "balance") {
            setState((prev) => prev ? { ...prev, balances: [...prev.balances.filter((item) => item.traderId !== event.payload.traderId), event.payload] } : prev);
          }
          if (event.type === "liquidation") setTrades((prev) => [{
            id: `liq-${event.payload.traderId}-${event.payload.ts}`,
            symbol: event.payload.symbol,
            price: event.payload.markPrice,
            quantity: Math.abs(event.payload.size),
            takerSide: event.payload.size > 0 ? "sell" as const : "buy" as const,
            buyerId: "liquidation-engine",
            sellerId: event.payload.traderId,
            ts: event.payload.ts
          }, ...prev].slice(0, 80));
          if (event.type === "world") setWorld(event.payload);
        };
        socket.onclose = () => {
          if (closed) return;
          setStatus("reconnecting");
          connect(900);
        };
        socket.onerror = () => socket.close();
      }, delay);
    }

    fetch(`${MATCHING_ENGINE_URL}/state`).then((res) => res.json()).then((snapshot: MarketState) => {
      setState(snapshot);
      setTrades(snapshot.trades.slice().reverse());
    }).catch(() => undefined);

    connect();
    return () => {
      closed = true;
      window.clearTimeout(reconnectTimer.current);
      socketRef.current?.close();
    };
  }, []);

  function mergeBook(book: OrderBookSnapshot) {
    setState((prev) => prev ? { ...prev, books: prev.books.map((item) => item.symbol === book.symbol ? book : item) } : prev);
  }

  function mergeMarket(market: MarketMeta) {
    const previous = latestPrices.current[market.symbol] ?? market.markPrice;
    latestPrices.current[market.symbol] = market.markPrice;
    if (market.symbol === selectedRef.current) setPriceDirection(market.markPrice > previous ? "up" : market.markPrice < previous ? "down" : "flat");
    setState((prev) => prev ? { ...prev, markets: prev.markets.map((item) => item.symbol === market.symbol ? market : item) } : prev);
  }

  function pushPrice(symbol: MarketSymbol, price: number, volume = 0) {
    if (!Number.isFinite(price) || price <= 0) return;
    setHistory((prev) => ({
      ...prev,
      [symbol]: [...(prev[symbol] ?? []), { ts: Date.now(), price, volume }].slice(-900)
    }));
  }

  function mergePosition(position: Position) {
    setState((prev) => prev ? {
      ...prev,
      positions: [...prev.positions.filter((item) => !(item.traderId === position.traderId && item.symbol === position.symbol)), position]
    } : prev);
  }

  const market = state?.markets.find((item) => item.symbol === selected);
  const book = state?.books.find((item) => item.symbol === selected);
  const positions = state?.positions.filter((item) => item.symbol === selected) ?? [];
  const allPositions = state?.positions ?? [];
  const balances = state?.balances ?? [];
  const recentTrades = trades.filter((trade) => trade.symbol === selected);
  const mark = market?.markPrice ?? (selected === "BTC-PERP" ? 68000 : selected === "ETH-PERP" ? 3600 : 145);

  return (
    <main>
      <TopBar status={status} feedStatus={feedStatus} markets={state?.markets ?? []} />
      <MarketHeader selected={selected} setSelected={setSelected} market={market} direction={priceDirection} />
      <MarketStrip markets={state?.markets ?? []} selected={selected} setSelected={setSelected} />
      <section className="trade-layout">
        <div className="left-stack">
          <ErrorBoundary fallback={<article className="panel chart-panel"><div className="ticket-note">Chart unavailable — check console. Reload to retry.</div></article>}>
            <ChartPanel selected={selected} market={market} trades={recentTrades} points={history[selected] ?? []} />
          </ErrorBoundary>
          <AccountDock positions={allPositions} balances={balances} selected={selected} orders={localOrders} trades={trades} />
          <World world={world} stress={market?.regime === "stress" ? 1 : market?.regime === "volatile" ? 0.72 : 0.35} />
        </div>
        <OrderBook book={book} mark={mark} direction={priceDirection} />
        <div className="right-stack">
          <OrderTicket selected={selected} mark={mark} onLocalOrder={(order) => setLocalOrders((prev) => [order, ...prev].slice(0, 24))} />
          <RiskBox market={market} positions={positions} />
          <Tape trades={recentTrades} />
          <Vaults balances={balances} positions={allPositions} />
          <Leaderboard positions={allPositions} balances={balances} />
        </div>
      </section>
    </main>
  );
}

function TopBar({ status, feedStatus, markets }: { status: string; feedStatus: string; markets: MarketMeta[] }) {
  return <nav className="topbar">
    <div className="brand"><CircleDollarSign size={19} /> Arc Perp</div>
    <div className="ticker-tape">
      {markets.map((market) => <span key={market.symbol}><b>{market.symbol.replace("-PERP", "")}</b> {money(market.markPrice)} <em className={market.fundingRate >= 0 ? "pos" : "neg"}>{pct(market.fundingRate, 3)}</em></span>)}
    </div>
    <div className="status-stack">
      <span className={`connection ${status}`}><Radio size={14} /> {status}</span>
      <span className={`connection ${feedStatus.includes("reconnecting") ? "reconnecting" : "live"}`}><Zap size={14} /> {feedStatus}</span>
      <WalletControls />
    </div>
  </nav>;
}

function WalletControls() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connectors, connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const { data: nativeBalance } = useBalance({ address });
  const [config, setConfig] = useState<OnchainConfig>();
  const [modal, setModal] = useState<"deposit" | "withdraw" | undefined>();

  useEffect(() => {
    if (!ONCHAIN_CONFIG_URL) return;
    fetch(ONCHAIN_CONFIG_URL).then((res) => res.json()).then(setConfig).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (isConnected && chainId !== arcTestnet.id) switchChain({ chainId: arcTestnet.id });
  }, [chainId, isConnected, switchChain]);

  if (!isConnected) {
    return <div className="wallet-menu">
      {connectors.slice(0, 3).map((connector) => <button key={connector.uid} onClick={() => connect({ connector })} disabled={isPending}>
        {connector.name === "Injected" ? "Browser Wallet" : connector.name}
      </button>)}
    </div>;
  }

  const onArc = chainId === arcTestnet.id;
  return <div className="wallet-connected">
    <button className={onArc ? "network ok" : "network warn"} onClick={() => ensureArcTestnet().catch((err) => console.error("[ARC SWITCH]", err))}>{onArc ? "Arc testnet" : "Switch to Arc Testnet"}</button>
    <button onClick={() => setModal("deposit")} disabled={!onArc} title={onArc ? "" : "Switch to Arc Testnet first"}>Deposit</button>
    <button onClick={() => setModal("withdraw")} disabled={!onArc} title={onArc ? "" : "Switch to Arc Testnet first"}>Withdraw</button>
    <span title="Gas-USDC balance (18 decimals, native gas on Arc). Collateral USDC is the 6-decimal ERC-20.">{nativeBalance ? `${Number(formatUnits(nativeBalance.value, nativeBalance.decimals)).toFixed(4)} ${nativeBalance.symbol}` : "0 USDC"}</span>
    {(!nativeBalance || nativeBalance.value === 0n) && <a className="faucet-link" href="https://faucet.circle.com" target="_blank" rel="noreferrer">Faucet</a>}
    <button onClick={() => disconnect()}>{shortAddress(address)}</button>
    {modal && config && <CollateralModal mode={modal} config={config} onClose={() => setModal(undefined)} />}
  </div>;
}

function CollateralModal({ mode, config, onClose }: { mode: "deposit" | "withdraw"; config: OnchainConfig; onClose: () => void }) {
  const { address } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const [amount, setAmount] = useState("100");
  const [status, setStatus] = useState("");
  const { writeContractAsync } = useWriteContract();
  const contracts = address && config.usdcAddress && config.collateralVaultAddress ? [
    { address: config.usdcAddress, abi: erc20Abi, functionName: "balanceOf", args: [address] },
    { address: config.collateralVaultAddress, abi: collateralVaultAbi, functionName: "balanceOf", args: [address] },
    { address: config.collateralVaultAddress, abi: collateralVaultAbi, functionName: "lockedOf", args: [address] },
    { address: config.collateralVaultAddress, abi: collateralVaultAbi, functionName: "availableOf", args: [address] }
  ] as const : undefined;
  const { data } = useReadContracts({ contracts, query: { enabled: Boolean(contracts) } });
  const usdc = data?.[0]?.result as bigint | undefined;
  const vault = data?.[1]?.result as bigint | undefined;
  const locked = data?.[2]?.result as bigint | undefined;
  const available = data?.[3]?.result as bigint | undefined;

  async function submit() {
    if (!config.usdcAddress || !config.collateralVaultAddress) {
      setStatus("Contracts not configured");
      return;
    }
    console.log("[DEPOSIT DEBUG]", {
      walletChainId: chainId,
      targetChainId: arcTestnet.id,
      match: chainId === arcTestnet.id,
      usdcAddress: config.usdcAddress,
      vaultAddress: config.collateralVaultAddress
    });
    if (chainId !== arcTestnet.id) {
      console.error("[DEPOSIT BLOCKED] Wrong chain. Attempting to switch...");
      setStatus("Switching to Arc Testnet");
      try {
        await ensureArcTestnet();
        await switchChainAsync({ chainId: arcTestnet.id });
      } catch (err) {
        setStatus(`Chain switch failed: ${err instanceof Error ? err.message : "rejected"}`);
        return;
      }
    }
    try {
      const value = parseUnits(amount || "0", 6);
      setStatus(mode === "deposit" ? "Approving USDC" : "Withdrawing");
      if (mode === "deposit") {
        await writeContractAsync({ chainId: arcTestnet.id, address: config.usdcAddress, abi: erc20Abi, functionName: "approve", args: [config.collateralVaultAddress, maxUint256] });
        setStatus("Depositing");
        await writeContractAsync({ chainId: arcTestnet.id, address: config.collateralVaultAddress, abi: collateralVaultAbi, functionName: "deposit", args: [value] });
      } else {
        await writeContractAsync({ chainId: arcTestnet.id, address: config.collateralVaultAddress, abi: collateralVaultAbi, functionName: "withdraw", args: [value] });
      }
      setStatus("Transaction sent");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Transaction failed");
    }
  }

  return <div className="modal-backdrop">
    <article className="panel collateral-modal">
      <div className="panel-title"><h2><Wallet size={17} /> {mode === "deposit" ? "Deposit USDC" : "Withdraw USDC"}</h2><button onClick={onClose}>Close</button></div>
      <div className="portfolio-grid">
        <Metric label="Wallet USDC" value={formatUsdc(usdc)} />
        <Metric label="Vault balance" value={formatUsdc(vault)} />
        <Metric label="Locked" value={formatUsdc(locked)} />
        <Metric label="Available" value={formatUsdc(available)} />
      </div>
      <label>Amount USDC<input value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
      <button className="primary buy" onClick={submit}>{mode === "deposit" ? "Approve + Deposit" : "Withdraw"}</button>
      <div className="ticket-note">{status || (config.settlementEnabled ? "Arc settlement enabled" : "Set contract addresses to enable settlement")}</div>
    </article>
  </div>;
}

function MarketStrip({ markets, selected, setSelected }: { markets: MarketMeta[]; selected: MarketSymbol; setSelected: (symbol: MarketSymbol) => void }) {
  const [query, setQuery] = useState("");
  const filtered = symbols.filter((symbol) => symbol.toLowerCase().includes(query.toLowerCase()));
  return <section className="market-strip">
    <div className="market-search"><Search size={15} /><input placeholder="Search markets" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
    {filtered.map((symbol) => {
      const market = markets.find((item) => item.symbol === symbol);
      return <button key={symbol} className={selected === symbol ? "active market-card" : "market-card"} onClick={() => setSelected(symbol)}>
        <span><b>{symbol.replace("-PERP", "")}</b><em className={(market?.fundingRate ?? 0) >= 0 ? "pos" : "neg"}>{pct(market?.fundingRate, 4)}</em></span>
        <strong>{money(market?.markPrice)}</strong>
        <small>OI {compact(market?.openInterest)} · Vol {compact(market?.volume24h)}</small>
        <i className="mini-spark" style={{ "--spark": `${Math.min(100, Math.max(8, (market?.volatilityBps ?? 12) * 1.5))}%` } as React.CSSProperties} />
      </button>;
    })}
  </section>;
}

function MarketHeader({ selected, setSelected, market, direction }: { selected: MarketSymbol; setSelected: (symbol: MarketSymbol) => void; market?: MarketMeta; direction: Direction }) {
  return <header className="market-header">
    <section className="market-tabs">
      {symbols.map((symbol) => <button className={symbol === selected ? "active" : ""} onClick={() => setSelected(symbol)} key={symbol}>{symbol}</button>)}
    </section>
    <section className="ticker">
      <div><span className="label">Mark</span><strong className={`live-price ${direction}`}>{money(market?.markPrice)}</strong></div>
      <div><span className="label">Index</span><strong>{money(market?.indexPrice)}</strong></div>
      <div><span className="label">Funding</span><strong className={(market?.fundingRate ?? 0) >= 0 ? "pos" : "neg"}>{pct(market?.fundingRate, 4)}</strong></div>
      <div><span className="label">Volatility</span><strong>{(market?.volatilityBps ?? 0).toFixed(1)} bps</strong></div>
      <div><span className="label">Feed</span><strong>{market?.source ?? "sim"}/{Math.round(market?.latencyMs ?? 0)}ms</strong></div>
      <div><span className="label">Regime</span><strong className={`regime ${market?.regime ?? "calm"}`}>{market?.regime ?? "calm"}</strong></div>
    </section>
  </header>;
}

class ErrorBoundary extends React.Component<{ fallback: React.ReactNode; children: React.ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) { console.error("ErrorBoundary caught:", error, info); }
  render() { return this.state.error ? this.props.fallback : this.props.children; }
}

function ChartPanel({ selected, market, trades, points }: { selected: MarketSymbol; market?: MarketMeta; trades: Trade[]; points: PricePoint[] }) {
  const [timeframe, setTimeframe] = useState<Timeframe>("5m");
  const [tool, setTool] = useState<ChartTool>("crosshair");
  const [indicators, setIndicators] = useState<Set<Indicator>>(new Set(["MA", "VWAP", "BB", "RSI"]));
  const [hover, setHover] = useState<number | undefined>();
  const [historical, setHistorical] = useState<HistoryCandle[]>([]);
  const [historyStatus, setHistoryStatus] = useState("loading 30d");
  const liveCandles = useMemo(() => buildCandles(points, trades, market, timeframe), [points, trades, market, timeframe]);
  const candles = useMemo(() => mergeHistoryCandles(historical, liveCandles), [historical, liveCandles]);
  const metrics = useMemo(() => chartMetrics(candles), [candles]);
  const latest = candles[candles.length - 1];
  const previous = candles[candles.length - 2] ?? latest;
  const change = latest && previous ? (latest.close - previous.close) / previous.close : 0;

  function toggleIndicator(indicator: Indicator) {
    setIndicators((prev) => {
      const next = new Set(prev);
      if (next.has(indicator)) next.delete(indicator);
      else next.add(indicator);
      return next;
    });
  }

  const width = 980;
  const height = 420;
  const top = 26;
  const priceHeight = 250;
  const volumeTop = 294;
  const volumeHeight = 58;
  const lowerTop = 366;
  const lowerHeight = 42;
  const prices = [
    ...candles.flatMap((candle) => [candle.high, candle.low, candle.close]),
    ...metrics.bbUpper,
    ...metrics.bbLower
  ].filter(Number.isFinite);
  const minPrice = Math.min(...prices, market?.markPrice ?? 0);
  const maxPrice = Math.max(...prices, market?.markPrice ?? 1);
  const pricePad = Math.max((maxPrice - minPrice) * 0.12, (market?.markPrice ?? 1) * 0.002);
  const low = minPrice - pricePad;
  const high = maxPrice + pricePad;
  const xFor = (index: number) => 42 + (index / Math.max(1, candles.length - 1)) * (width - 96);
  const yFor = (price: number) => top + ((high - price) / Math.max(1, high - low)) * priceHeight;
  const maxVol = Math.max(...candles.map((candle) => candle.volume), 1);
  const candleWidth = Math.max(4, Math.min(11, (width - 120) / Math.max(12, candles.length) * 0.62));
  const hoverCandle = hover === undefined ? latest : candles[hover];
  const firstCandle = candles[0];
  const syncedFrom = firstCandle ? new Date(firstCandle.ts).toLocaleTimeString() : "waiting";
  const lastSync = latest ? new Date(latest.ts).toLocaleTimeString() : "waiting";

  useEffect(() => {
    let cancelled = false;
    setHistoryStatus("loading 30d");
    fetch(`${MARKET_DATA_URL}/history?symbol=${selected}&interval=${timeframe}&days=30`)
      .then((res) => res.json())
      .then((payload: { candles?: HistoryCandle[]; source?: string }) => {
        if (cancelled) return;
        const candles = payload.candles ?? [];
        setHistorical(candles);
        setHistoryStatus(candles.length > 0 ? `${payload.source ?? "history"} 30d · ${candles.length} bars` : "live only");
      })
      .catch(() => {
        if (!cancelled) {
          setHistorical([]);
          setHistoryStatus("live only");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected, timeframe]);

  const pathFor = (values: number[]) => values.map((value, index) => Number.isFinite(value) ? `${index === 0 ? "M" : "L"} ${xFor(index).toFixed(2)} ${yFor(value).toFixed(2)}` : "").join(" ");
  const normalizedPath = (values: number[], baseTop: number, paneHeight: number) => {
    const finite = values.filter(Number.isFinite);
    const min = Math.min(...finite, 0);
    const max = Math.max(...finite, 1);
    return values.map((value, index) => {
      const y = baseTop + ((max - value) / Math.max(1e-9, max - min)) * paneHeight;
      return `${index === 0 ? "M" : "L"} ${xFor(index).toFixed(2)} ${y.toFixed(2)}`;
    }).join(" ");
  };

  return <article className="panel chart-panel">
    <div className="chart-topbar">
      <div className="chart-identity">
        <h2><ChartCandlestick size={17} /> {selected}</h2>
        <strong className={change >= 0 ? "pos" : "neg"}>{money(latest?.close ?? market?.markPrice)}</strong>
        <span className={change >= 0 ? "pos" : "neg"}>{pct(change)}</span>
        <em>{timeframe} · {historyStatus} · synced {syncedFrom}</em>
      </div>
      <div className="chart-actions">
        {(["1m", "5m", "15m", "1h", "4h", "1d"] as Timeframe[]).map((item) => <button key={item} className={timeframe === item ? "active" : ""} onClick={() => setTimeframe(item)}>{item}</button>)}
        <button title="Maximize"><Maximize2 size={14} /></button>
        <button title="Alerts"><Bell size={14} /></button>
        <button title="Settings"><Settings size={14} /></button>
      </div>
    </div>
    <div className="chart-workspace">
      <aside className="drawing-toolbar">
        {([
          ["cursor", MousePointer2],
          ["crosshair", Crosshair],
          ["trend", LineChart],
          ["measure", Ruler],
          ["fib", Gauge]
        ] as Array<[ChartTool, React.ComponentType<{ size?: number }>]>).map(([name, Icon]) => <button key={name} className={tool === name ? "active" : ""} onClick={() => setTool(name)} title={name}><Icon size={15} /></button>)}
      </aside>
      <div className="chart-canvas-wrap">
        <div className="indicator-bar">
          {(["MA", "EMA", "VWAP", "BB", "RSI", "MACD", "CVD", "OI", "Funding"] as Indicator[]).map((indicator) => <button key={indicator} className={indicators.has(indicator) ? "active" : ""} onClick={() => toggleIndicator(indicator)}>{indicator}</button>)}
        </div>
        <PerpChartCanvas candles={candles} metrics={metrics} indicators={indicators} mark={market?.markPrice} tool={tool} onHover={setHover} />
        <div className="chart-readout">
          <span>O <b>{money(hoverCandle?.open)}</b></span>
          <span>H <b>{money(hoverCandle?.high)}</b></span>
          <span>L <b>{money(hoverCandle?.low)}</b></span>
          <span>C <b>{money(hoverCandle?.close)}</b></span>
          <span>Vol <b>{compact(hoverCandle?.volume)}</b></span>
          <span>CVD <b className={(hoverCandle?.cvd ?? 0) >= 0 ? "pos" : "neg"}>{compact(hoverCandle?.cvd)}</b></span>
          <span>Last sync <b>{lastSync}</b></span>
        </div>
      </div>
    </div>
    <div className="analysis-strip">
      <Metric label="Spread" value={`${market?.spreadBps.toFixed(2) ?? "0.00"} bps`} />
      <Metric label="VWAP distance" value={pct(((latest?.close ?? 0) - (metrics.vwap.at(-1) ?? latest?.close ?? 1)) / Math.max(1, metrics.vwap.at(-1) ?? 1), 3)} />
      <Metric label="RSI" value={(metrics.rsi.at(-1) ?? 50).toFixed(1)} tone={(metrics.rsi.at(-1) ?? 50) > 70 ? "neg" : (metrics.rsi.at(-1) ?? 50) < 30 ? "pos" : undefined} />
      <Metric label="OI" value={compact(market?.openInterest)} />
      <Metric label="Funding" value={pct(market?.fundingRate, 4)} tone={(market?.fundingRate ?? 0) >= 0 ? "pos" : "neg"} />
    </div>
  </article>;
}

function PerpChartCanvas({ candles, metrics, indicators, mark, tool, onHover }: { candles: Candle[]; metrics: ReturnType<typeof chartMetrics>; indicators: Set<Indicator>; mark?: number; tool: ChartTool; onHover: (index: number | undefined) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    element.replaceChildren();
    const chart = createChart(element, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#080c12" },
        textColor: "#7f8ca0",
        panes: { separatorColor: "#17202a", separatorHoverColor: "#253142" }
      },
      grid: {
        vertLines: { color: "rgba(148, 163, 184, 0.08)" },
        horzLines: { color: "rgba(148, 163, 184, 0.08)" }
      },
      crosshair: {
        mode: tool === "cursor" ? 0 : 1,
        vertLine: { color: "rgba(229, 231, 235, .38)", labelBackgroundColor: "#111923" },
        horzLine: { color: "rgba(229, 231, 235, .28)", labelBackgroundColor: "#111923" }
      },
      rightPriceScale: {
        borderColor: "#17202a",
        scaleMargins: { top: 0.08, bottom: 0.08 }
      },
      timeScale: {
        borderColor: "#17202a",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
        barSpacing: 7
      },
      localization: {
        priceFormatter: (price: number) => price.toLocaleString(undefined, { maximumFractionDigits: 2 })
      }
    });
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#38e1a0",
      downColor: "#ff657c",
      borderUpColor: "#38e1a0",
      borderDownColor: "#ff657c",
      wickUpColor: "#38e1a0",
      wickDownColor: "#ff657c",
      priceLineColor: "#4c9aff",
      lastValueVisible: true,
      priceLineVisible: true
    });
    candleSeries.setData(candles.map((candle) => ({ time: toChartTime(candle.ts), open: candle.open, high: candle.high, low: candle.low, close: candle.close })));
    if (mark) candleSeries.createPriceLine({ price: mark, color: "#4c9aff", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "Mark" });
    const latest = candles.at(-1);
    if (latest) {
      candleSeries.createPriceLine({ price: latest.close * 0.996, color: "#e5e7eb", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "Entry" });
      candleSeries.createPriceLine({ price: latest.close * 1.018, color: "#38e1a0", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "TP" });
      candleSeries.createPriceLine({ price: latest.close * 0.982, color: "#ff657c", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "SL" });
    }

    if (indicators.has("MA")) chart.addSeries(LineSeries, { color: "#facc15", lineWidth: 1, priceLineVisible: false }).setData(lineData(candles, metrics.ma));
    if (indicators.has("EMA")) chart.addSeries(LineSeries, { color: "#a78bfa", lineWidth: 1, priceLineVisible: false }).setData(lineData(candles, metrics.ema));
    if (indicators.has("VWAP")) chart.addSeries(LineSeries, { color: "#4c9aff", lineWidth: 1, lineStyle: 2, priceLineVisible: false }).setData(lineData(candles, metrics.vwap));
    if (indicators.has("BB")) {
      chart.addSeries(LineSeries, { color: "rgba(148, 163, 184, .55)", lineWidth: 1, priceLineVisible: false }).setData(lineData(candles, metrics.bbUpper));
      chart.addSeries(LineSeries, { color: "rgba(148, 163, 184, .55)", lineWidth: 1, priceLineVisible: false }).setData(lineData(candles, metrics.bbLower));
    }

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
      lastValueVisible: false,
      priceLineVisible: false
    }, 1);
    volumeSeries.setData(candles.map((candle) => ({
      time: toChartTime(candle.ts),
      value: candle.volume,
      color: candle.close >= candle.open ? "rgba(56, 225, 160, .45)" : "rgba(255, 101, 124, .45)"
    })));

    if (indicators.has("RSI")) chart.addSeries(LineSeries, { color: "#facc15", lineWidth: 1, priceLineVisible: false }, 2).setData(lineData(candles, metrics.rsi));
    if (indicators.has("MACD")) chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, 2).setData(metrics.macd.map((value, index) => ({ time: toChartTime(candles[index]?.ts ?? Date.now()), value, color: value >= 0 ? "rgba(56, 225, 160, .62)" : "rgba(255, 101, 124, .62)" })));
    if (indicators.has("CVD")) chart.addSeries(LineSeries, { color: "#38e1a0", lineWidth: 1, priceLineVisible: false }, 2).setData(lineData(candles, candles.map((candle) => candle.cvd)));
    if (indicators.has("OI")) chart.addSeries(LineSeries, { color: "#4c9aff", lineWidth: 1, priceLineVisible: false }, 2).setData(lineData(candles, candles.map((candle) => candle.openInterest)));
    if (indicators.has("Funding")) chart.addSeries(LineSeries, { color: "#a78bfa", lineWidth: 1, priceLineVisible: false }, 2).setData(lineData(candles, candles.map((candle) => candle.funding)));

    chart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        onHover(undefined);
        return;
      }
      const time = Number(param.time) * 1000;
      const index = candles.findIndex((candle) => Math.floor(candle.ts / 1000) === Number(param.time));
      if (index >= 0) onHover(index);
      else {
        const nearest = candles.reduce((best, candle, itemIndex) => Math.abs(candle.ts - time) < Math.abs((candles[best]?.ts ?? 0) - time) ? itemIndex : best, 0);
        onHover(nearest);
      }
    });

    chart.timeScale().fitContent();
    if (candles.length > 180) chart.timeScale().setVisibleLogicalRange({ from: candles.length - 180, to: candles.length + 8 });

    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, indicators, mark, onHover, tool, metrics]);

  return <div className={`lw-chart ${tool}`} ref={containerRef} />;
}

function OrderTicket({ selected, mark, onLocalOrder }: { selected: MarketSymbol; mark: number; onLocalOrder: (order: LocalOrder) => void }) {
  const { address } = useAccount();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [mode, setMode] = useState<OrderMode>("Limit");
  const [price, setPrice] = useState(String(mark.toFixed(2)));
  const [stopPrice, setStopPrice] = useState(String((mark * 1.01).toFixed(2)));
  const [quantity, setQuantity] = useState("0.1");
  const [leverage, setLeverage] = useState("10");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [postOnly, setPostOnly] = useState(false);
  const [takeProfit, setTakeProfit] = useState(String((mark * 1.025).toFixed(2)));
  const [stopLoss, setStopLoss] = useState(String((mark * 0.985).toFixed(2)));
  const [twapMinutes, setTwapMinutes] = useState("12");
  const [slices, setSlices] = useState("6");
  const [scaleEnd, setScaleEnd] = useState(String((mark * 0.985).toFixed(2)));
  const [message, setMessage] = useState("");

  useEffect(() => {
    setPrice(mark.toFixed(2));
    setStopPrice((mark * (side === "buy" ? 1.01 : 0.99)).toFixed(2));
    setTakeProfit((mark * (side === "buy" ? 1.025 : 0.975)).toFixed(2));
    setStopLoss((mark * (side === "buy" ? 0.985 : 1.015)).toFixed(2));
    setScaleEnd((mark * (side === "buy" ? 0.985 : 1.015)).toFixed(2));
    setQuantity(selected === "BTC-PERP" ? "0.10" : selected === "ETH-PERP" ? "1.25" : "25");
  }, [selected, mark, side]);

  async function place(type: "limit" | "market", qty: number, orderPrice?: number) {
    const response = await fetch(`${MATCHING_ENGINE_URL}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        traderId: walletTraderId(address),
        agentId: walletTraderId(address),
        symbol: selected,
        side,
        type,
        quantity: qty,
        price: type === "limit" ? orderPrice : undefined,
        leverage: Number(leverage),
        walletAddress: address,
        settleOnchain: Boolean(address)
      })
    });
    if (!response.ok) throw new Error((await response.json()).error ?? "Order rejected");
  }

  async function submit() {
    const qty = Number(quantity);
    const count = Math.max(1, Math.min(24, Number(slices) || 1));
    const id = `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    try {
      setMessage("Submitting");
      if (mode === "TWAP") {
        for (let index = 0; index < count; index += 1) {
          window.setTimeout(() => place("market", round(qty / count)), index * 900);
        }
        onLocalOrder({ id, symbol: selected, side, type: mode, quantity: qty, status: `${count} scheduled slices · ${twapMinutes}m plan`, createdAt: Date.now() });
      } else if (mode === "Scale") {
        const start = Number(price);
        const end = Number(scaleEnd);
        for (let index = 0; index < count; index += 1) {
          const level = count === 1 ? start : start + ((end - start) * index) / (count - 1);
          await place("limit", round(qty / count), Number(level.toFixed(2)));
        }
        onLocalOrder({ id, symbol: selected, side, type: mode, quantity: qty, price: start, status: `${count} resting levels`, createdAt: Date.now() });
      } else if (mode === "Stop Market" || mode === "Stop Limit") {
        onLocalOrder({ id, symbol: selected, side, type: mode, quantity: qty, price: mode === "Stop Limit" ? Number(price) : undefined, trigger: Number(stopPrice), status: "simulated trigger", createdAt: Date.now() });
      } else {
        await place(mode === "Market" ? "market" : "limit", qty, Number(price));
        onLocalOrder({ id, symbol: selected, side, type: mode, quantity: qty, price: mode === "Limit" ? Number(price) : undefined, status: mode === "Market" ? "sent" : postOnly ? "post-only sent" : "sent", createdAt: Date.now() });
      }
      if (Number(takeProfit) > 0) onLocalOrder({ id: `${id}_tp`, symbol: selected, side: side === "buy" ? "sell" : "buy", type: "Stop Limit", quantity: qty, price: Number(takeProfit), trigger: Number(takeProfit), status: reduceOnly ? "TP reduce-only" : "TP attached", createdAt: Date.now() });
      if (Number(stopLoss) > 0) onLocalOrder({ id: `${id}_sl`, symbol: selected, side: side === "buy" ? "sell" : "buy", type: "Stop Market", quantity: qty, trigger: Number(stopLoss), status: reduceOnly ? "SL reduce-only" : "SL attached", createdAt: Date.now() });
      setMessage("Accepted");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Order rejected");
    }
  }

  return <article className="panel ticket">
    <div className="panel-title"><h2><Send size={17} /> Order</h2><span>{selected}</span></div>
    <div className="segmented"><button className={side === "buy" ? "buy active" : ""} onClick={() => setSide("buy")}>Buy</button><button className={side === "sell" ? "sell active" : ""} onClick={() => setSide("sell")}>Sell</button></div>
    <div className="order-modes">{(["Market", "Limit", "Stop Market", "Stop Limit", "TWAP", "Scale"] as OrderMode[]).map((item) => <button key={item} className={mode === item ? "active" : ""} onClick={() => setMode(item)}>{item}</button>)}</div>
    {(mode === "Limit" || mode === "Stop Limit" || mode === "Scale") && <label>Price<input value={price} onChange={(event) => setPrice(event.target.value)} /></label>}
    {(mode === "Stop Market" || mode === "Stop Limit") && <label>Trigger<input value={stopPrice} onChange={(event) => setStopPrice(event.target.value)} /></label>}
    <label>Size<input value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
    <label>Leverage<input value={leverage} onChange={(event) => setLeverage(event.target.value)} /></label>
    {mode === "TWAP" && <div className="two-col"><label>Minutes<input value={twapMinutes} onChange={(event) => setTwapMinutes(event.target.value)} /></label><label>Slices<input value={slices} onChange={(event) => setSlices(event.target.value)} /></label></div>}
    {mode === "Scale" && <div className="two-col"><label>End price<input value={scaleEnd} onChange={(event) => setScaleEnd(event.target.value)} /></label><label>Orders<input value={slices} onChange={(event) => setSlices(event.target.value)} /></label></div>}
    <div className="two-col"><label>TP<input value={takeProfit} onChange={(event) => setTakeProfit(event.target.value)} /></label><label>SL<input value={stopLoss} onChange={(event) => setStopLoss(event.target.value)} /></label></div>
    <div className="checks"><label><input type="checkbox" checked={reduceOnly} onChange={(event) => setReduceOnly(event.target.checked)} /> Reduce only</label><label><input type="checkbox" checked={postOnly} onChange={(event) => setPostOnly(event.target.checked)} /> Post only</label></div>
    <button className={`primary ${side}`} onClick={submit}>{side === "buy" ? "Long" : "Short"} {selected}</button>
    <div className="ticket-note">{message || `Notional ${money(Number(quantity) * mark)} · Margin ${money((Number(quantity) * mark) / Math.max(1, Number(leverage)))}`}</div>
  </article>;
}

function OrderBook({ book, mark, direction }: { book?: OrderBookSnapshot; mark: number; direction: Direction }) {
  const [view, setView] = useState<"Book" | "Depth" | "Flow">("Book");
  const [group, setGroup] = useState("0.5");
  const asks = [...(book?.asks ?? [])].slice(0, 12).reverse();
  const bids = [...(book?.bids ?? [])].slice(0, 12);
  const maxQty = Math.max(...[...asks, ...bids].map((level) => level.quantity), 1);
  const bidTotal = bids.reduce((sum, level) => sum + level.quantity, 0);
  const askTotal = asks.reduce((sum, level) => sum + level.quantity, 0);
  const imbalance = bidTotal / Math.max(1e-9, bidTotal + askTotal);
  const depth = [...asks.map((level, index) => ({ ...level, side: "ask" as const, total: asks.slice(index).reduce((sum, row) => sum + row.quantity, 0) })).reverse(), ...bids.map((level, index) => ({ ...level, side: "bid" as const, total: bids.slice(0, index + 1).reduce((sum, row) => sum + row.quantity, 0) }))];

  return <article className="panel orderbook">
    <div className="panel-title"><h2><Activity size={17} /> Order Book</h2><span>Spread {money((asks.at(-1)?.price ?? mark) - (bids[0]?.price ?? mark))}</span></div>
    <div className="book-toolbar">
      {(["Book", "Depth", "Flow"] as const).map((item) => <button key={item} className={view === item ? "active" : ""} onClick={() => setView(item)}>{item}</button>)}
      <select value={group} onChange={(event) => setGroup(event.target.value)} aria-label="grouping">
        <option>0.1</option><option>0.5</option><option>1</option><option>5</option><option>10</option>
      </select>
    </div>
    <div className="imbalance"><span style={{ width: `${imbalance * 100}%` }} /><b>{(imbalance * 100).toFixed(0)}% bid</b><em>{((1 - imbalance) * 100).toFixed(0)}% ask</em></div>
    {view === "Book" && <>
      <div className="book-head"><span>Price</span><span>Size</span><span>Total</span></div>
      <div className="book-levels">
        {asks.map((level) => <BookRow level={level} maxQty={maxQty} side="ask" key={`a-${level.price}-${level.quantity}`} />)}
        <div className={`book-mark ${direction}`}>{money(mark)}</div>
        {bids.map((level) => <BookRow level={level} maxQty={maxQty} side="bid" key={`b-${level.price}-${level.quantity}`} />)}
      </div>
    </>}
    {view === "Depth" && <div className="depth-chart">
      {depth.map((level, index) => <span key={`${level.side}-${level.price}-${index}`} className={level.side} style={{ left: `${(index / Math.max(1, depth.length - 1)) * 100}%`, height: `${Math.min(100, (level.total / Math.max(bidTotal, askTotal, 1)) * 100)}%` }} />)}
      <b>{money(mark)}</b>
    </div>}
    {view === "Flow" && <div className="flow-panel">
      {[...asks.slice(-5), ...bids.slice(0, 5)].map((level, index) => <div key={`${level.price}-${index}`} className={index < 5 ? "flow ask" : "flow bid"}><span>{index < 5 ? "Ask wall" : "Bid wall"}</span><b>{money(level.price)}</b><em>{level.quantity.toFixed(4)}</em></div>)}
    </div>}
  </article>;
}

function BookRow({ level, maxQty, side }: { level: OrderBookLevel; maxQty: number; side: "bid" | "ask" }) {
  const depth = Math.min(100, (level.quantity / maxQty) * 100);
  return <div className={`book-row ${side}`}>
    <span className="depth" style={{ width: `${depth}%` }} />
    <b>{level.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b>
    <span>{level.quantity.toFixed(4)}</span>
    <span>{(level.price * level.quantity).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
  </div>;
}

function Tape({ trades }: { trades: Trade[] }) {
  return <article className="panel tape-panel">
    <div className="panel-title"><h2>Trades</h2><span>Live tape</span></div>
    <div className="tape-head"><span>Price</span><span>Size</span><span>Time</span></div>
    {trades.slice(0, 18).map((trade) => <div className={`tape ${trade.takerSide}`} key={trade.id}>
      <span>{trade.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span><span>{trade.quantity.toFixed(4)}</span><span>{new Date(trade.ts).toLocaleTimeString()}</span>
    </div>)}
  </article>;
}

function AccountDock({ positions, balances, selected, orders, trades }: { positions: Position[]; balances: MarketState["balances"]; selected: MarketSymbol; orders: LocalOrder[]; trades: Trade[] }) {
  const [tab, setTab] = useState<"Positions" | "Orders" | "Fills" | "Funding" | "Portfolio">("Positions");
  const { address } = useAccount();
  const traderId = walletTraderId(address);
  const [config, setConfig] = useState<OnchainConfig>();
  const [closing, setClosing] = useState<string>();
  useEffect(() => {
    if (!ONCHAIN_CONFIG_URL) return;
    fetch(ONCHAIN_CONFIG_URL).then((res) => res.json()).then(setConfig).catch(() => undefined);
  }, []);
  const vaultRead = useReadContracts({
    contracts: address && config?.collateralVaultAddress ? [
      { address: config.collateralVaultAddress, abi: collateralVaultAbi, functionName: "balanceOf", args: [address] }
    ] as const : undefined,
    query: { enabled: Boolean(address && config?.collateralVaultAddress) }
  });
  const vaultBalance = vaultRead.data?.[0]?.result as bigint | undefined;

  const walletLower = address?.toLowerCase();
  const isMine = (item: { traderId: string; walletAddress?: string }) => item.traderId === traderId || (walletLower && item.walletAddress?.toLowerCase() === walletLower);
  const myPositions = positions.filter(isMine);
  const myFills = trades.filter((trade) => trade.buyerId === traderId || trade.sellerId === traderId);
  const equity = balances.find((balance) => balance.traderId === traderId)?.equity ?? 100000;
  const usedMargin = myPositions.reduce((sum, position) => sum + position.margin, 0);
  const pnl = myPositions.reduce((sum, position) => sum + position.unrealizedPnl, 0);

  async function closePosition(position: Position) {
    const key = `${position.traderId}:${position.symbol}`;
    setClosing(key);
    try {
      await fetch(`${MATCHING_ENGINE_URL}/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          traderId,
          agentId: traderId,
          symbol: position.symbol,
          side: position.size > 0 ? "sell" : "buy",
          type: "market",
          quantity: Math.abs(position.size),
          leverage: position.leverage,
          walletAddress: address,
          settleOnchain: Boolean(address)
        })
      });
    } finally {
      setClosing(undefined);
    }
  }

  return <article className="panel positions">
    <div className="panel-title">
      <h2><ShieldAlert size={17} /> Account</h2>
      <span className="account-meta">
        <em>{address ? shortAddress(address) : "Not connected"}</em>
        <em title="On-chain CollateralVault balance">Deposited {vaultBalance != null ? formatUsdc(vaultBalance) : "—"}</em>
        <em title="Simulated trading equity"><Wallet size={14} /> {money(equity)}</em>
      </span>
    </div>
    <div className="tabs">{(["Positions", "Orders", "Fills", "Funding", "Portfolio"] as const).map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}</div>
    {tab === "Positions" && <>
      <div className="position-grid account head"><span>Market</span><span>Size</span><span>Entry</span><span>PnL</span><span>Liq</span><span>Notional</span><span>Margin</span><span>ROE%</span><span></span></div>
      {myPositions.slice(0, 8).map((position) => {
        const notional = Math.abs(position.size) * position.markPrice;
        const roe = position.margin > 0 ? (position.unrealizedPnl / position.margin) * 100 : 0;
        const key = `${position.traderId}:${position.symbol}`;
        return <div className={`position-grid account ${position.unrealizedPnl >= 0 ? "pnl-up" : "pnl-down"}`} key={key}>
          <span>{position.symbol.replace("-PERP", "")}</span>
          <span>{position.size.toFixed(3)}</span>
          <span>{position.entryPrice.toFixed(2)}</span>
          <span className={position.unrealizedPnl >= 0 ? "pos" : "neg"}>{position.unrealizedPnl.toFixed(2)}</span>
          <span>{position.liquidationPrice.toFixed(2)}</span>
          <span>{compact(notional)}</span>
          <span>{compact(position.margin)}</span>
          <span className={roe >= 0 ? "pos" : "neg"}>{roe.toFixed(2)}%</span>
          <button className="close-pos" onClick={() => closePosition(position)} disabled={closing === key} title="Market-close this position">{closing === key ? "…" : "×"}</button>
        </div>;
      })}
      {myPositions.length === 0 && <div className="empty">{address ? "No positions for connected wallet — place an order to start" : "Connect wallet to see your positions"}</div>}
    </>}
    {tab === "Orders" && <>
      <div className="order-grid head"><span>Time</span><span>Market</span><span>Type</span><span>Side</span><span>Size</span><span>Status</span></div>
      {orders.map((order) => <div className="order-grid" key={order.id}><span>{new Date(order.createdAt).toLocaleTimeString()}</span><span>{order.symbol.replace("-PERP", "")}</span><span>{order.type}</span><span className={order.side === "buy" ? "pos" : "neg"}>{order.side}</span><span>{order.quantity}</span><span>{order.status}</span></div>)}
      {orders.length === 0 && <div className="empty">No local order activity yet</div>}
    </>}
    {tab === "Fills" && <>
      <div className="order-grid head"><span>Time</span><span>Market</span><span>Side</span><span>Price</span><span>Size</span><span>Notional</span></div>
      {myFills.slice(0, 12).map((trade) => {
        const mySide = trade.buyerId === traderId ? "buy" : "sell";
        return <div className="order-grid" key={trade.id}><span>{new Date(trade.ts).toLocaleTimeString()}</span><span>{trade.symbol.replace("-PERP", "")}</span><span className={mySide === "buy" ? "pos" : "neg"}>{mySide}</span><span>{money(trade.price)}</span><span>{trade.quantity.toFixed(4)}</span><span>{compact(trade.price * trade.quantity)}</span></div>;
      })}
      {myFills.length === 0 && <div className="empty">{address ? "No fills yet for connected wallet" : "Connect wallet to see your fills"}</div>}
    </>}
    {tab === "Funding" && <>
      <div className="order-grid head"><span>Time</span><span>Market</span><span>Rate</span><span>Payment</span><span>Status</span><span>Tx</span></div>
      {myPositions.slice(0, 10).map((position, index) => {
        const payment = position.size * position.markPrice * 0.0001 * (position.size > 0 ? -1 : 1);
        return <div className="order-grid" key={`${position.traderId}-${position.symbol}-funding`}><span>{new Date(Date.now() - index * 3600000).toLocaleTimeString()}</span><span>{position.symbol.replace("-PERP", "")}</span><span>0.0100%</span><span className={payment >= 0 ? "pos" : "neg"}>{money(payment)}</span><span>hourly</span><span>pending</span></div>;
      })}
      {myPositions.length === 0 && <div className="empty">Funding history appears after positions open</div>}
    </>}
    {tab === "Portfolio" && <div className="portfolio-grid">
      <Metric label="Account value" value={money(equity + pnl)} />
      <Metric label="Unrealized PnL" value={money(pnl)} tone={pnl >= 0 ? "pos" : "neg"} />
      <Metric label="Used margin" value={money(usedMargin)} />
      <Metric label="Free collateral" value={money(Math.max(0, equity - usedMargin))} />
      <Metric label="On-chain deposit" value={vaultBalance != null ? formatUsdc(vaultBalance) : "—"} />
    </div>}
  </article>;
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className="metric"><span>{label}</span><strong className={tone}>{value}</strong></div>;
}

function RiskBox({ market, positions }: { market?: MarketMeta; positions: Position[] }) {
  const net = positions.reduce((sum, item) => sum + item.size, 0);
  const margin = positions.reduce((sum, item) => sum + item.margin, 0);
  const pnl = positions.reduce((sum, item) => sum + item.unrealizedPnl, 0);
  return <article className="panel risk-box">
    <div className="panel-title"><h2><SlidersHorizontal size={17} /> Risk</h2><span>{market?.regime ?? "calm"}</span></div>
    <Metric label="Net exposure" value={`${net.toFixed(4)} ${market?.symbol.replace("-PERP", "") ?? ""}`} />
    <Metric label="Margin used" value={money(margin)} />
    <Metric label="Funding / 8h" value={pct(market?.fundingRate, 4)} tone={(market?.fundingRate ?? 0) >= 0 ? "pos" : "neg"} />
    <Metric label="Unrealized PnL" value={money(pnl)} tone={pnl >= 0 ? "pos" : "neg"} />
  </article>;
}

function Vaults({ balances, positions }: { balances: MarketState["balances"]; positions: Position[] }) {
  const equity = balances.reduce((sum, balance) => sum + balance.equity, 0);
  const pnl = positions.reduce((sum, position) => sum + Math.max(0, position.unrealizedPnl), 0);
  return <article className="panel vaults">
    <div className="panel-title"><h2><Vault size={17} /> Vaults</h2><span>Simulated</span></div>
    <div className="vault-row"><span><Target size={15} /> Market Maker Vault</span><b>{compact(equity * 0.38)}</b><em className="pos">+{pct((pnl / Math.max(1, equity)) * 4)}</em></div>
    <div className="vault-row"><span><Layers3 size={15} /> Delta Neutral Vault</span><b>{compact(equity * 0.22)}</b><em className="pos">+4.18%</em></div>
    <div className="vault-row"><span><Clock3 size={15} /> TWAP Executor</span><b>{compact(equity * 0.14)}</b><em>capacity open</em></div>
  </article>;
}

function Leaderboard({ positions, balances }: { positions: Position[]; balances: MarketState["balances"] }) {
  const rows = balances.map((balance) => {
    const traderPositions = positions.filter((position) => position.traderId === balance.traderId);
    const pnl = balance.realizedPnl + traderPositions.reduce((sum, position) => sum + position.unrealizedPnl, 0);
    return { traderId: balance.traderId, equity: balance.equity, pnl, markets: traderPositions.length };
  }).sort((a, b) => b.pnl - a.pnl).slice(0, 5);
  return <article className="panel leaderboard">
    <div className="panel-title"><h2><Crown size={17} /> Leaderboard</h2><span><Copy size={14} /> Copy</span></div>
    {rows.map((row, index) => <div className="leader-row" key={row.traderId}><span>{index + 1}</span><b>{row.traderId}</b><em className={row.pnl >= 0 ? "pos" : "neg"}>{money(row.pnl)}</em><small>{row.markets} markets</small></div>)}
    {rows.length === 0 && <div className="empty">Leaderboard appears after the first fills</div>}
  </article>;
}

function World({ world, stress }: { world?: MarketWorldState; stress: number }) {
  const districts = useMemo(() => world?.districts ?? [], [world]);
  return <article className="panel world-panel" style={{ "--stress": stress } as React.CSSProperties}>
    <div className="panel-title"><h2><Bot size={17} /> Agent World</h2><span>Stress {(stress * 100).toFixed(0)}%</span></div>
    <div className="districts">{districts.map((district) => <div className="district" key={district.id} style={{ "--heat": district.activity, "--risk": district.risk } as React.CSSProperties}>
      <strong>{district.label}</strong><span>Risk {(district.risk * 100).toFixed(0)}%</span><span>Liquidity {(district.liquidity * 100).toFixed(0)}%</span>
    </div>)}</div>
    <div className={stress > 0.7 ? "world panic" : "world"}>
      <span className="zone treasury-zone">Treasury</span>
      <span className="zone whale-zone a">Whales</span>
      <span className="zone whale-zone b">Liquidations</span>
      <span className="treasury-flow" />
      {stress > 0.65 && Array.from({ length: Math.round(stress * 4) }, (_, index) => <span key={index} className="liquidation-burst" style={{ left: `${22 + index * 17}%`, top: `${38 + (index % 2) * 18}%` }} />)}
      {world?.agents.map((agent) => <span key={agent.id} className={`agent ${agent.role} ${stress > 0.75 && agent.role === "trader" ? "panic-agent" : ""}`} style={{ left: `${agent.x}%`, top: `${agent.y}%`, opacity: stress > 0.9 && agent.role === "liquidator" ? 0 : agent.intensity }} title={agent.id} />)}
    </div>
  </article>;
}

function buildCandles(points: PricePoint[], trades: Trade[], market?: MarketMeta, timeframe: Timeframe = "5m"): Candle[] {
  const mark = market?.markPrice ?? points.at(-1)?.price ?? trades[0]?.price ?? 100;
  const step = timeframeMs(timeframe);
  const now = Date.now();
  const events = [
    ...points.map((point) => ({ ts: point.ts, price: point.price, volume: point.volume ?? 0 })),
    ...trades.map((trade) => ({ ts: trade.ts, price: trade.price, volume: trade.price * trade.quantity }))
  ].filter((item) => Number.isFinite(item.price) && item.price > 0).sort((a, b) => a.ts - b.ts);

  if (events.length === 0) {
    return Array.from({ length: 96 }, (_, index) => {
      const ts = Math.floor((now - (95 - index) * step) / step) * step;
      const drift = Math.sin(index / 7) * mark * 0.001 + Math.cos(index / 13) * mark * 0.0008;
      return {
        ts,
        open: mark + drift,
        high: mark + drift + mark * 0.0008,
        low: mark + drift - mark * 0.0008,
        close: mark + drift,
        volume: 0,
        cvd: 0,
        openInterest: market?.openInterest ?? mark * 900,
        funding: market?.fundingRate ?? 0
      };
    });
  }

  const bucketed = new Map<number, Candle>();
  let cvd = 0;
  for (const event of events) {
    const ts = Math.floor(event.ts / step) * step;
    const existing = bucketed.get(ts);
    const signedVolume = event.volume * (existing && event.price < existing.close ? -1 : 1);
    cvd += signedVolume;
    if (!existing) {
      bucketed.set(ts, {
        ts,
        open: event.price,
        high: event.price,
        low: event.price,
        close: event.price,
        volume: Math.abs(event.volume),
        cvd,
        openInterest: market?.openInterest ?? event.price * 900,
        funding: market?.fundingRate ?? 0
      });
      continue;
    }
    existing.high = Math.max(existing.high, event.price);
    existing.low = Math.min(existing.low, event.price);
    existing.close = event.price;
    existing.volume += Math.abs(event.volume);
    existing.cvd = cvd;
  }

  const endBucket = Math.floor(now / step) * step;
  const startBucket = Math.max(endBucket - step * 95, Math.min(...bucketed.keys()));
  const candles: Candle[] = [];
  let previousClose = events[0]?.price ?? mark;
  let previousCvd = 0;
  for (let ts = startBucket; ts <= endBucket; ts += step) {
    const candle = bucketed.get(ts);
    if (candle) {
      const minRange = Math.max(candle.close * 0.00015, 0.01);
      if (candle.high === candle.low) {
        candle.high += minRange;
        candle.low -= minRange;
      }
      previousClose = candle.close;
      previousCvd = candle.cvd;
      candles.push({ ...candle });
    } else {
      candles.push({
        ts,
        open: previousClose,
        high: previousClose,
        low: previousClose,
        close: previousClose,
        volume: 0,
        cvd: previousCvd,
        openInterest: market?.openInterest ?? previousClose * 900,
        funding: market?.fundingRate ?? 0
      });
    }
  }

  const recent = candles.slice(-96);
  let runningCvd = 0;
  return recent.map((candle, index) => {
    runningCvd = candle.cvd || runningCvd;
    return {
      ...candle,
      volume: candle.volume || (index === recent.length - 1 ? Math.max(1, candle.close * 0.0001 * selectedVolumeScale(market?.symbol)) : 0),
      cvd: runningCvd,
      openInterest: (market?.openInterest ?? candle.close * 900) * (0.985 + Math.sin(index / 13) * 0.015),
      funding: (market?.fundingRate ?? 0.0001) * (1 + Math.sin(index / 8) * 0.35)
    };
  });
}

function mergeHistoryCandles(history: HistoryCandle[], live: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  let cvd = 0;
  for (const candle of history) {
    const ts = candle.time * 1000;
    const previousClose = history[Math.max(0, history.findIndex((item) => item.time === candle.time) - 1)]?.close ?? candle.open;
    cvd += (candle.close >= previousClose ? 1 : -1) * candle.volume * candle.close;
    map.set(ts, {
      ts,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      cvd,
      openInterest: candle.close * 900,
      funding: 0
    });
  }
  for (const candle of live) map.set(candle.ts, { ...map.get(candle.ts), ...candle });
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}

function toChartTime(ts: number): UTCTimestamp {
  return Math.floor(ts / 1000) as UTCTimestamp;
}

function lineData(candles: Candle[], values: number[]) {
  return candles.map((candle, index) => ({ time: toChartTime(candle.ts), value: values[index] ?? candle.close })).filter((item) => Number.isFinite(item.value));
}

function chartMetrics(candles: Candle[]) {
  const closes = candles.map((candle) => candle.close);
  const ma = rollingAverage(closes, 20);
  const emaLine = ema(closes, 21);
  const vwap = rollingVwap(candles);
  const stdev = rollingStd(closes, ma, 20);
  const bbUpper = ma.map((value, index) => value + stdev[index]! * 2);
  const bbLower = ma.map((value, index) => value - stdev[index]! * 2);
  const rsiLine = rsi(closes, 14);
  const macd = ema(closes, 12).map((value, index) => value - ema(closes, 26)[index]!);
  return { ma, ema: emaLine, vwap, bbUpper, bbLower, rsi: rsiLine, macd };
}

function timeframeMs(timeframe: Timeframe) {
  return ({ "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 } as Record<Timeframe, number>)[timeframe];
}

function selectedVolumeScale(symbol?: MarketSymbol) {
  if (symbol === "BTC-PERP") return 0.08;
  if (symbol === "ETH-PERP") return 0.7;
  if (symbol === "SOL-PERP") return 18;
  return 1;
}

function rollingAverage(values: number[], period: number) {
  return values.map((_, index) => {
    const window = values.slice(Math.max(0, index - period + 1), index + 1);
    return window.reduce((sum, value) => sum + value, 0) / Math.max(1, window.length);
  });
}

function rollingStd(values: number[], average: number[], period: number) {
  return values.map((_, index) => {
    const window = values.slice(Math.max(0, index - period + 1), index + 1);
    const mean = average[index] ?? values[index] ?? 0;
    const variance = window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, window.length);
    return Math.sqrt(variance);
  });
}

function ema(values: number[], period: number) {
  const multiplier = 2 / (period + 1);
  const result: number[] = [];
  for (const value of values) {
    const previous = result.at(-1) ?? value;
    result.push(value * multiplier + previous * (1 - multiplier));
  }
  return result;
}

function rollingVwap(candles: Candle[]) {
  let volumeSum = 0;
  let priceVolumeSum = 0;
  return candles.map((candle) => {
    const typical = (candle.high + candle.low + candle.close) / 3;
    volumeSum += candle.volume;
    priceVolumeSum += typical * candle.volume;
    return priceVolumeSum / Math.max(1, volumeSum);
  });
}

function rsi(values: number[], period: number) {
  return values.map((value, index) => {
    if (index === 0) return 50;
    const window = values.slice(Math.max(1, index - period + 1), index + 1);
    let gains = 0;
    let losses = 0;
    for (let item = 0; item < window.length; item += 1) {
      const current = window[item] ?? value;
      const previous = values[Math.max(0, index - window.length + item)] ?? current;
      const delta = current - previous;
      if (delta >= 0) gains += delta;
      else losses += Math.abs(delta);
    }
    if (losses === 0) return 100;
    const rs = gains / losses;
    return 100 - (100 / (1 + rs));
  });
}

function money(value?: number) {
  if (!Number.isFinite(value)) return "$0.00";
  return `$${value!.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

function formatUsdc(value?: bigint) {
  return `${Number(formatUnits(value ?? 0n, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC`;
}

function shortAddress(address?: string) {
  if (!address) return "Wallet";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function walletTraderId(address?: string): string {
  return address ? `human-${address.slice(2, 10).toLowerCase()}` : "human-demo";
}

function compact(value?: number) {
  if (!Number.isFinite(value)) return "$0";
  return `$${Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(value!)}`;
}

function pct(value?: number, digits = 2) {
  if (!Number.isFinite(value)) return "0.00%";
  return `${(value! * 100).toFixed(digits)}%`;
}

function normalizedPoint(price: number, points: Array<{ price: number }>) {
  const prices = points.map((point) => point.price);
  const min = Math.min(...prices, price);
  const max = Math.max(...prices, price);
  return max === min ? 0.5 : (price - min) / (max - min);
}

function round(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

createRoot(document.getElementById("root")!).render(
  <WagmiProvider config={wagmiConfig}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </WagmiProvider>
);
