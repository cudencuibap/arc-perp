# Render Deployment

Arc Perp backend services can run on Render as separate Node.js web services. Use Node.js 20 and deploy from the same GitHub repository.

## Services

Create one Render service for each backend process:

| Service | Workspace | Build command | Start command |
| --- | --- | --- | --- |
| matching-engine | `@arc-perp/matching-engine` | `npm install && npm run build` | `npm --workspace @arc-perp/matching-engine run start` |
| market-data | `@arc-perp/market-data` | `npm install && npm run build` | `npm --workspace @arc-perp/market-data run start` |
| settlement-service | `@arc-perp/settlement-service` | `npm install && npm run build` | `npm --workspace @arc-perp/settlement-service run start` |
| websocket-gateway | `@arc-perp/websocket-gateway` | `npm install && npm run build` | `npm --workspace @arc-perp/websocket-gateway run start` |

Agents are optional worker services:

| Worker | Workspace | Start command |
| --- | --- | --- |
| market-makers | `@arc-perp/market-makers` | `npm --workspace @arc-perp/market-makers run start` |
| traders | `@arc-perp/traders` | `npm --workspace @arc-perp/traders run start` |
| treasury | `@arc-perp/treasury` | `npm --workspace @arc-perp/treasury run start` |

## Environment

Set these service URLs after Render assigns hostnames:

```bash
MATCHING_ENGINE_URL=https://arc-perp-matching-engine.onrender.com
MATCHING_ENGINE_WS=wss://arc-perp-matching-engine.onrender.com/stream
MARKET_DATA_HTTP_URL=https://arc-perp-market-data.onrender.com
SETTLEMENT_SERVICE_URL=https://arc-perp-settlement-service.onrender.com
```

Set Arc and settlement variables only in Render's environment UI:

```bash
ARC_RPC_URL=https://rpc.testnet.arc.network
ARC_USDC_ADDRESS=
COLLATERAL_VAULT_ADDRESS=
PERP_SETTLEMENT_ADDRESS=
TREASURY_VAULT_ADDRESS=
SETTLEMENT_PRIVATE_KEY=
AGENT_WALLET_SECRET=
```

Never put private keys or secrets in GitHub.

## Gateway

The frontend should talk only to `websocket-gateway`:

```bash
VITE_API_URL=https://arc-perp-websocket-gateway.onrender.com
VITE_WS_URL=wss://arc-perp-websocket-gateway.onrender.com/ws
```

Use those values in Vercel.

## Notes

- Render free instances may sleep, which can interrupt WebSocket sessions.
- Use paid or always-on services for realistic trading demos.
- Keep agent counts low while testing:

```bash
MARKET_MAKER_AGENT_COUNT=6
TRADER_AGENT_COUNT=4
MARKET_MAKER_INTERVAL_MS=1800
TRADER_INTERVAL_MS=2500
```
