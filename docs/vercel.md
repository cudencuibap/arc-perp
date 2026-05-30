# Vercel Frontend Deployment

Deploy the frontend to Vercel from the GitHub repository. Keep the Vercel project root at the repository root so npm can install workspace packages such as `@arc-perp/core`.

## Project Settings

- Framework preset: Vite
- Root directory: repository root
- Install command: `npm install`
- Build command: `npm --workspace @arc-perp/dex-web run build`
- Output directory: `apps/dex-web/dist`
- Node.js: 20+

The root `vercel.json` already encodes these settings. Do not set the Vercel root directory to `apps/dex-web`; doing so can hide `packages/core` from the build and produce `Cannot find module '@arc-perp/core'`.

## Environment Variables

Set these in Vercel:

```bash
VITE_MATCHING_ENGINE_URL=https://arc-perp-matching-engine.onrender.com
VITE_MARKET_DATA_URL=https://arc-perp-backend.onrender.com
VITE_WS_URL=wss://arc-perp-websocket-gateway.onrender.com/ws
VITE_ONCHAIN_CONFIG_URL=
VITE_WALLETCONNECT_PROJECT_ID=
```

Do not expose backend private keys, settlement private keys, Chainlink secrets, or agent wallet secrets to Vercel.

## Backend Requirement

The Vercel frontend talks directly to the deployed service that owns each route:

- Matching engine: `GET /state`, `POST /orders`
- Market data: `GET /history`
- WebSocket gateway: `WS /ws`

Set `VITE_ONCHAIN_CONFIG_URL` only when a settlement/onchain config endpoint is deployed. Leaving it empty disables the optional collateral modal request and avoids calling a missing endpoint.

## Local Preview

```bash
npm install
npm --workspace @arc-perp/dex-web run dev
```

Open:

```text
http://localhost:5173
```
