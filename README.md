# Arc Perp

Arc Perp is a hybrid perpetual exchange MVP for Arc testnet. It keeps matching, orderbooks, realtime execution, and agent behavior offchain while routing collateral, settlement records, fees, and PnL accounting through Arc-compatible settlement services and contracts.

The current app is built as a TypeScript monorepo with React frontends, Node.js services, autonomous agent workers, and minimal Solidity contracts.

## Status

- Hyperliquid-inspired DEX UI with candlestick charting, orderbook, trade tape, order ticket, account tabs, funding/history panels, and agent-world visualization.
- Realtime offchain engine for order matching, fills, positions, balances, liquidations, and WebSocket state sync.
- Market data service with live Binance streams and 30-day historical candle preload for BTC, ETH, and SOL perps.
- Arc testnet contract boundaries for collateral vault, perp settlement, treasury vault, and mock USDC.
- Wallet UI built with wagmi/viem for MetaMask, Rabby, and injected wallets.
- Lightweight local npm scripts for daily development without Docker.
- Docker Compose remains available for infrastructure parity, but it is not required for normal local usage.

## Workspace

```text
apps/
  dex-web/              React trading UI
  admin-panel/          Admin/operator UI
services/
  matching-engine/      Offchain orderbook and execution
  market-data/          Live and historical market data
  websocket-gateway/    Public API and WebSocket fanout
  settlement-service/   Arc settlement transaction bridge
  risk-engine/
  liquidation-engine/
agents/
  market-makers/
  traders/
  treasury/
packages/
  core/
  agent-wallets/
contracts/
  Solidity contracts and deploy scripts
docs/
  render.md
  vercel.md
  onchain-mvp.md
  websocket.md
```

## Local Setup Without Docker

Requirements:

- Node.js 20+
- npm 10+

Install and build:

```bash
npm install
npm run build
```

Run the core local stack:

```bash
npm run dev:local
```

Default local URLs:

- DEX web: `http://localhost:5173`
- Gateway API: `http://localhost:4100`
- Gateway WebSocket: `ws://localhost:4100/ws`
- Matching engine: `http://localhost:4101`
- Market data: `http://localhost:4102`
- Settlement service: `http://localhost:4105`

Production-style local run after build:

```bash
npm run start:local
```

## Environment

Use `.env.example` as the template. Do not commit `.env` or real secrets.

Important public frontend variables:

```bash
VITE_API_URL=https://your-render-gateway.onrender.com
VITE_WS_URL=wss://your-render-gateway.onrender.com/ws
VITE_WALLETCONNECT_PROJECT_ID=
```

Important backend variables:

```bash
MATCHING_ENGINE_URL=
MATCHING_ENGINE_WS=
MARKET_DATA_HTTP_URL=
SETTLEMENT_SERVICE_URL=
ARC_RPC_URL=https://rpc.testnet.arc.network
ARC_USDC_ADDRESS=
COLLATERAL_VAULT_ADDRESS=
PERP_SETTLEMENT_ADDRESS=
TREASURY_VAULT_ADDRESS=
SETTLEMENT_PRIVATE_KEY=
AGENT_WALLET_SECRET=
```

`SETTLEMENT_PRIVATE_KEY`, `AGENT_WALLET_SECRET`, Chainlink secrets, and WalletConnect IDs must be configured only through local `.env` files or deployment provider secret stores.

## Deployment

- Frontend: see [docs/vercel.md](docs/vercel.md)
- Backend services: see [docs/render.md](docs/render.md)
- Onchain MVP setup: see [docs/onchain-mvp.md](docs/onchain-mvp.md)
- WebSocket API: see [docs/websocket.md](docs/websocket.md)

## Docker

Docker support is kept for parity and one-command stack tests, but daily local usage should use npm scripts. To run Docker manually:

```bash
docker compose build
docker compose up
```

To remove local Docker resources:

```bash
docker compose down --rmi local --volumes --remove-orphans
```

## Security

Never commit:

- `.env`
- private keys
- mnemonics
- encrypted agent wallet files
- runtime databases or caches
- contract deployment secrets

The repository intentionally ignores `node_modules`, `dist`, logs, runtime data, cache/temp directories, agent wallets, and contract artifacts.
