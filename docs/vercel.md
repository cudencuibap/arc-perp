# Vercel Frontend Deployment

Deploy `apps/dex-web` to Vercel from the GitHub repository.

## Project Settings

- Framework preset: Vite
- Root directory: `apps/dex-web`
- Build command: `npm run build`
- Output directory: `dist`
- Install command: `npm install`
- Node.js: 20+

Because this is an npm workspace, Vercel should install from the repository root. If Vercel does not detect the workspace correctly, keep the root directory as the repository root and use:

```bash
npm --workspace @arc-perp/dex-web run build
```

with output directory:

```text
apps/dex-web/dist
```

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
