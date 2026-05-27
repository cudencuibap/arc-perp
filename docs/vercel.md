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
VITE_API_URL=https://arc-perp-websocket-gateway.onrender.com
VITE_WS_URL=wss://arc-perp-websocket-gateway.onrender.com/ws
VITE_WALLETCONNECT_PROJECT_ID=
```

Do not expose backend private keys, settlement private keys, Chainlink secrets, or agent wallet secrets to Vercel.

## Backend Requirement

The Vercel frontend expects the Render gateway to expose:

- `GET /health`
- `GET /api/state`
- `GET /api/history`
- `POST /api/orders`
- `GET /api/onchain/config`
- `GET /api/onchain/accounts/:address`
- `WS /ws`

## Local Preview

```bash
npm install
npm --workspace @arc-perp/dex-web run dev
```

Open:

```text
http://localhost:5173
```
