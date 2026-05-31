# Arc Migration Audit

Audit of `arc-perp` against the `circle:use-arc` skill (Arc testnet build standards).
Reference: chain id `5042002`, RPC `https://rpc.testnet.arc.network`, canonical USDC `0x3600000000000000000000000000000000000000` (6 decimals), USDC-native gas (18 decimals on the native wrapper), CCTP domain `26`, explorer `https://testnet.arcscan.app`, faucet `https://faucet.circle.com`.

Audit date: 2026-05-31. Code not modified.

---

## P0 — Blockers

> Status: all 4 P0 items closed in commits `9ee6d6b`, `a706e68`, `55dcc8c`, `30c627c`. Full `npm run build` passes after the fixes.

### ✅ P0-1. Native currency mis-labelled as "ARC" instead of USDC — **DONE** (`9ee6d6b`)

On Arc, USDC is the native gas token. Every viem `Chain` definition in this repo declares `nativeCurrency: { name: "Arc", symbol: "ARC", decimals: 18 }` — wrong symbol/name. This bleeds into MetaMask, wagmi's `useBalance`, and any wallet that reads `nativeCurrency.symbol`.

- `packages/core/src/onchain.ts:4`
- `services/settlement-service/src/index.ts:21`
- `packages/agent-wallets/src/index.ts:34`
- `contracts/scripts/deploy-arc.mjs:15`

**Fix:** Set `nativeCurrency` to `{ name: "USD Coin", symbol: "USDC", decimals: 18 }`. Better: import `arcTestnet` from `viem/chains` (see P1-1) and delete all four copies.

### ✅ P0-2. Deploy script defaults to deploying `MockUSDC` instead of pinning canonical Arc USDC — **DONE** (`a706e68`)

`contracts/scripts/deploy-arc.mjs:22-23` falls back to deploying `MockUSDC` whenever `ARC_USDC_ADDRESS` is not set. Arc testnet has a canonical USDC at `0x3600000000000000000000000000000000000000`. Deploying a mock means agents, depositors, and the collateral vault all hold an unrelated token — breaking interop with Circle's faucet, CCTP, Gateway, and any external wallet pre-funded from `faucet.circle.com`.

- `contracts/scripts/deploy-arc.mjs:22-23`
- `contracts/src/MockUSDC.sol` (entire file — should not be on the deploy path for Arc)
- `docs/onchain-mvp.md:19-26` (documents the MockUSDC path as the happy path)

**Fix:** Hardcode `0x36000…0000` as the Arc testnet USDC default. Keep `MockUSDC` only behind an explicit `DEPLOY_MOCK_USDC=true` opt-in for local/anvil flows, never Arc.

### ✅ P0-3. Frontend "0 ARC" label and reliance on native balance for gas readiness — **DONE** (`55dcc8c`)

`apps/dex-web/src/main.tsx:227,252` calls `useBalance({ address })` and renders `"0 ARC"` as the fallback label. Users will assume they need a separate ARC token for gas; they don't — they need USDC, both for collateral *and* for paying gas. The dual-decimal trap (skill section "Core Concepts") makes this worse: the native balance is reported in 18 decimals, the ERC-20 USDC in 6, and the UI doesn't distinguish.

- `apps/dex-web/src/main.tsx:227` — `useBalance` call
- `apps/dex-web/src/main.tsx:252` — `"0 ARC"` literal

**Fix:** Replace the fallback string with `"0 USDC"`, format `nativeBalance` with explicit 18-dec parsing and a `USDC` suffix, and add a tooltip clarifying "gas-USDC (18 dec) vs. collateral-USDC (6 dec)."

### ✅ P0-4. No Arc faucet / funding guidance surfaced to the user — **DONE** (`30c627c`)

The skill's only hard rule for first-run UX: "ALWAYS fund the wallet from https://faucet.circle.com before sending transactions." Nowhere in the frontend, `docs/onchain-mvp.md`, or `.env.example` is the faucet URL mentioned. New users hit "Deposit" against a zero-balance wallet and see opaque viem errors.

- `apps/dex-web/src/main.tsx:248-256` (`WalletControls` block — best place to surface this)
- `docs/onchain-mvp.md` (no faucet mention)
- `.env.example` (no faucet pointer)

**Fix:** When connected wallet has zero native balance, render a "Get testnet USDC →" link to `https://faucet.circle.com` next to Deposit/Withdraw. Mention faucet in `docs/onchain-mvp.md` Prerequisites.

---

## P1 — Needed before mainnet / public testnet demo

### P1-1. Custom `arcTestnet` definition duplicated in 4 places instead of using viem's built-in

Skill explicitly states: *"Arc Testnet is available by default in Viem — a custom chain definition is NEVER required."* The repo ships four hand-rolled copies with slightly different shapes (some missing `public` rpc, all wrong on `nativeCurrency`). Drift risk is high.

- `packages/core/src/onchain.ts:1-9`
- `services/settlement-service/src/index.ts:18-23`
- `packages/agent-wallets/src/index.ts:31-36`
- `contracts/scripts/deploy-arc.mjs:12-17`

**Fix:** `import { arcTestnet } from "viem/chains"` in `packages/core/src/onchain.ts`, re-export from there, and delete the three other inline definitions.

### P1-2. No chain-ID guard in `settlement-service` before writing transactions

`services/settlement-service/src/index.ts:111-117` calls `walletClient.writeContract(...)` against whatever RPC is configured, with the chain object hardcoded to `5042002`. If `ARC_RPC_URL` is ever misconfigured (e.g. swapped to Sepolia during local testing), the service will sign with `chainId=5042002` against a non-Arc node and either fail with a confusing replay-protection error or worse. Skill rule: *"ALWAYS verify the user is on Arc (chain ID `5042002`) before submitting transactions."*

- `services/settlement-service/src/index.ts:25-28` (clients constructed)
- `services/settlement-service/src/index.ts:32` (health endpoint — currently doesn't probe chain id)

**Fix:** At startup, `await publicClient.getChainId()`; abort if it isn't `5042002`. Expose it on `/health`.

### P1-3. Deployer / settlement keys passed as plain env vars, no keystore option

Skill security rule: *"NEVER pass private keys as plain-text CLI flags in deployed environments, including testnet and staging. Prefer encrypted keystores or interactive import."*

- `contracts/scripts/deploy-arc.mjs:8-11` — `DEPLOYER_PRIVATE_KEY` env only
- `services/settlement-service/src/index.ts:10` — `SETTLEMENT_PRIVATE_KEY` env only
- `packages/agent-wallets/src/index.ts:8-26` — agent keys encrypted on disk with a *shared* `AGENT_WALLET_SECRET`, which is itself in env

**Fix:** Add a keystore path option (`KEYSTORE_FILE` + interactive password prompt for the deploy script; OS keychain / Render secret file for `settlement-service`). Acceptable to keep env as fallback for local-only dev.

### P1-4. `docs/onchain-mvp.md` teaches MockUSDC as the default

Mirrors P0-2 from the docs side. Reads as if MockUSDC is the expected path; should instead lead with "Use canonical Arc USDC at 0x3600…0000, faucet at faucet.circle.com," and treat MockUSDC as an unreachable fallback.

- `docs/onchain-mvp.md:19-26`

**Fix:** Rewrite the "Deploy Contracts" section to default to the canonical USDC and add a one-paragraph note on faucet → vault → trade flow.

### P1-5. `.env.example` missing canonical USDC and Arc-specific defaults

- `.env.example:33-37` leaves `ARC_USDC_ADDRESS`, vault, settlement, treasury blank.

**Fix:** Pre-fill `ARC_USDC_ADDRESS=0x3600000000000000000000000000000000000000` and add a comment block pointing to faucet + explorer URLs.

---

## P2 — Nice to have

### P2-1. Dead Chainlink config on Arc testnet

`services/market-data/src/index.ts:118-181` polls Chainlink Data Streams / Data Feeds. Arc testnet has no Chainlink price feeds; the code already gracefully falls back to Binance, but the env block in `.env.example:18-23` is dead weight on Arc and may mislead operators into thinking Chainlink is wired up.

- `services/market-data/src/index.ts:118-181`
- `.env.example:18-23`

**Fix:** Either remove the Chainlink block when running against Arc, or document it as "not available on Arc testnet — kept for non-Arc deployments."

### P2-2. `docs/onchain-mvp.md` missing Arc explorer / CCTP domain / hex chain id

The skill's Quick Reference table lists facts the docs should include for anyone joining the project: explorer `testnet.arcscan.app`, CCTP domain `26`, hex chain id `0x4CEF52`.

- `docs/onchain-mvp.md:5-9`

**Fix:** Replace the "Arc Testnet" mini-section with the skill's full Quick Reference table.

### P2-3. `MockUSDC` `name` is "Arc Test USDC" — collides with real USDC UX

If `MockUSDC` stays in-repo (for non-Arc local dev), its `name` / `symbol` (`"Arc Test USDC"` / `"USDC"`, `contracts/src/MockUSDC.sol:5-6`) are too close to the real thing. A wallet importing both will show two "USDC" entries indistinguishable from the address column.

- `contracts/src/MockUSDC.sol:5-6`

**Fix:** Rename to `"Mock USDC (do not use on Arc)"` / `"mUSDC"`.

### P2-4. wagmi config has no fallback transport

`apps/dex-web/src/main.tsx:21-29` uses a single `http()` transport against the default RPC. If Arc's public RPC throttles, the whole UI stalls.

- `apps/dex-web/src/main.tsx:21-29`

**Fix:** Wrap in `fallback([http(primary), http(secondary)])` once a second Arc RPC endpoint is published.

### P2-5. `useBalance` decimals are not normalized to 6-dec USDC convention

Cosmetic — the UI uses `nativeBalance.decimals` (18) for formatting, while every other USDC amount in the app uses 6. Future contributors will mix these up.

- `apps/dex-web/src/main.tsx:252` — uses `formatUnits(value, decimals)` against the 18-dec native

**Fix:** After P0-3 fix lands, add a helper `formatGasUsdc(value: bigint)` colocated with the existing `formatUsdc` for 6-dec values, with both clearly named.

---

## Summary

| Priority | Count | Status | Items |
|---|---|---|---|
| **P0** | 4 | ✅ 4 / 4 done | Native currency symbol; MockUSDC default deploy; "0 ARC" UI label; no faucet pointer |
| **P1** | 5 | ☐ 0 / 5 | Centralize `arcTestnet` to viem; chain-id guard; keystore option; rewrite onchain docs; canonical USDC in env |
| **P2** | 5 | ☐ 0 / 5 | Dead Chainlink config; missing Arc facts in docs; MockUSDC naming; fallback transport; gas vs collateral decimal helper |

**Effort estimate**

- P0: ~3 hours. Mostly mechanical — find/replace `nativeCurrency` (4 sites), flip deploy default + remove fallback from happy path, fix one UI label, add a faucet link component.
- P1: ~3–4 hours. Centralizing the chain definition + chain-ID guard + keystore plumbing are independent and small; doc rewrites are quick.
- P2: ~1–2 hours of polish.

**Total: ~half a day of focused work to clear P0 + P1**, plus a smoke-test cycle against Arc testnet (deploy, fund from faucet, deposit, trade, withdraw).

**Not in scope of this audit**
- No oracle / price feed lives onchain on Arc in this repo — `market-data` runs offchain, so the "oracle compatible with Arc" question reduces to P2-1 (dead config) rather than a blocker.
- The matching engine and websocket gateway are pure offchain Node services; they have no chain coupling and need no changes.
