# Settlement Service

Tracks on-chain CollateralVault `Deposited` / `Withdrawn` events and exposes the resulting per-address running totals via HTTP. Designed to be the source of truth for human trader balances in the matching engine.

## Environment

Required for `enabled=true` (operator able to write settlements on-chain):

- `SETTLEMENT_PRIVATE_KEY` — operator EOA key, hex `0x…`
- `ARC_USDC_ADDRESS` — `0x3600000000000000000000000000000000000000` (canonical)
- `COLLATERAL_VAULT_ADDRESS` — `0xEBa02c6911c35E5dB6b984Bb49dB9F281C181c70`
- `PERP_SETTLEMENT_ADDRESS` — `0xc7BA31Fd7284491b1a93bd046361F76FfDD5a915`

Required for the event listener (read-only deposit/withdraw tracking, runs even without an operator key):

- `COLLATERAL_VAULT_ADDRESS`
- `ARC_RPC_URL` — defaults to `https://rpc.testnet.arc.network`
- `VAULT_DEPLOY_BLOCK` — see Known Limitations below

`.env` autoload from repo root is wired in `src/index.ts` so `npm run dev:settlement` works standalone (not only through `npm run dev:local`).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | `{ ok, service, enabled }` |
| `GET` | `/config` | `OnchainConfig` (chain id, RPC, contract addresses, `settlementEnabled`) |
| `GET` | `/accounts/:address` | Live on-chain vault read: `balanceOf`, `lockedOf`, `availableOf` |
| `GET` | `/balances/:address` | Persistent listener totals: `{ deposited, withdrawn, net, lastSeenBlock }` (decimal strings, 6-decimal USDC base units) |
| `GET` | `/history` | In-memory settlement record log (lost on restart) |
| `POST` | `/settlements/trade` | Record PnL/fee on-chain via `perpSettlement.recordSettlement` (deferred — not used until Phase 7+) |
| `POST` | `/funding/settle` | Record funding payment on-chain (deferred) |

## Persistence

Single state file at `services/settlement-service/data/settlement-events.json`:

```json
{
  "version": 1,
  "lastSeenBlock": "45641229",
  "processedEvents": ["0xabc…:0", "0xdef…:1"],
  "balances": {
    "0x2bb6…": { "deposited": "11000000", "withdrawn": "0" }
  }
}
```

- Bundled write: lastSeenBlock + processedEvents Set + balances Map persisted together every event.
- Atomic via `writeFile(tmp)` + `rename(tmp, real)` so a crash mid-persist leaves the previous snapshot intact.
- Persist serialized through a promise chain so concurrent `onLogs` callbacks (Deposited vs Withdrawn in the same block) cannot race.
- Address keys lowercased.

The directory is git-ignored via the root `data/` rule.

## Boot sequence

1. `loadState()` reads the JSON file if present, otherwise starts empty. Corrupt JSON → exit(1) with a message asking the operator to delete the file.
2. `catchup()` queries `getLogs(Deposited|Withdrawn, fromBlock = max(lastSeenBlock + 1, VAULT_DEPLOY_BLOCK), toBlock = head)` in 9000-block chunks, processing each log through the same handler used for live events.
3. `startWatching()` registers a viem `watchEvent` subscription for ongoing Deposited / Withdrawn logs.
4. `serverListen()` binds port 4105.

## Verification harness

`scripts/verify-2a.mjs` is a self-contained regression test that:

1. Confirms port 4105 is free, deletes any prior state file.
2. Spawns `tsx src/index.ts`, waits for the `listening on 4105; enabled=true; listener=true` marker.
3. Curls `/health` and `/balances/0x…0001`, asserts JSON shapes.
4. Reads the state file and hashes it.
5. Restarts the service two more times, asserts the persisted `processedEvents` and `balances` are unchanged across restarts and that `lastSeenBlock` advances monotonically.

Run it from the repo root: `node services/settlement-service/scripts/verify-2a.mjs`.

## Known limitations

### Historical deposits before `VAULT_DEPLOY_BLOCK` are invisible

The listener catches up only from `VAULT_DEPLOY_BLOCK` onward (default `45614815` in `.env.example`). Any `Deposited` / `Withdrawn` events emitted before that block are not in the listener's state and `/balances/:address` returns zeros for them.

For example, `0x2Bb67950aF59C701EAea02236D0C5cE2F9643cf5` has a real on-chain vault balance of 4.29 USDC (verified via `vault.balanceOf` during an earlier debug session), but `/balances/0x2Bb6…` returns `deposited=0`, `net=0` because those deposit transactions happened before block 45614815.

Before promoting this service to production, do **one** of the following:

- Set `VAULT_DEPLOY_BLOCK` to the actual block at which CollateralVault was deployed (find via `https://testnet.arcscan.app/address/0xEBa02c6911c35E5dB6b984Bb49dB9F281C181c70` → Contract → creation tx → block #).
- Or write a backfill script that calls `vault.balanceOf(addr)` on-chain for every known depositor and seeds the listener's `balances` map directly, then resumes the listener from `VAULT_DEPLOY_BLOCK`.

For local development against the testnet, leaving the default is acceptable — only deposits made from this point forward are needed to exercise the deposit-driven balance flow.

### Settlement writes are not wired yet

`/settlements/trade` and `/funding/settle` work and will broadcast `recordSettlement(…)` on-chain when called, but no caller invokes them in the live trade path. Wiring real settlement writes is deferred to a later phase so that during Phase 2-6 development we are not burning operator USDC gas on every fill.

### `/history` is in-memory only

The settlement record log resets on every restart. If real settlement writes are wired before this is persisted, restarting the service will lose visibility into prior settlement attempts (the on-chain effect is still durable).

## Phase 2b — Real balance gate (matching-engine)

The matching-engine `POST /orders` handler can route human/agent traders through a real-balance check before placing the order. Gate is off by default for safe rollout.

### Feature flag

| Env | Default | Behavior |
|---|---|---|
| `ENGINE_USE_REAL_BALANCE` | `false` | When `"true"`, orders carrying a `walletAddress` go through `evaluateRealBalance`; otherwise they take the existing sim path |
| `ENGINE_GAS_RESERVE_USDC_BASE_UNITS` | `100000` (= 0.1 USDC) | Per-wallet base units reserved for Arc gas. Untouchable as margin. Arc uses USDC as native gas — without reserve, a wallet can lock all USDC into margin and brick its own ability to transact |
| `SETTLEMENT_SERVICE_URL` | `http://localhost:4105` | Source of `/balances/:address` for the gate |

Rollback: flip `ENGINE_USE_REAL_BALANCE=false` and restart matching-engine. Zero git churn.

### available_margin formula

Per the user-provided spec, in BigInt 6-decimal USDC base units:

```
available = (deposited − withdrawn)         ← from settlement /balances
          + realized_pnl                     ← from engine state, conservative
          + unrealized_pnl_using_mark_price  ← from engine state, conservative
          − Σ(initial_margin of open positions)
          − gas_reserve
```

The first term is exact (settlement listener stores base units). The middle three are projected from the matching-engine into base units by `getRealizedPnlBaseUnits`, `getUnrealizedPnlBaseUnits`, `getUsedMarginBaseUnits` with conservative rounding (credits floor, debits ceil-magnitude). Worst-case bias is ≤1 base unit per term against the user, never over-leveraging.

### Error responses

- **400 INSUFFICIENT_MARGIN** — available < required. Body includes `availableBaseUnits`, `requiredBaseUnits` as decimal strings for client retry math.
- **503 SETTLEMENT_DOWN** — fetcher threw (network, non-JSON, non-200, timeout). Response includes `Retry-After: 1` header and `{ retryAfter: 1, code: "SETTLEMENT_DOWN" }` body for autonomous agent retry logic that parses by error code rather than message text.

### Latency observability

Every accepted/insufficient decision logs `[matching-engine] balance fetch lat=Xms trader=Y avail=Z required=R`. This is the input for the eventual decision to migrate from per-order HTTP polling to a WS push from settlement-service.

### Known limitations introduced by Phase 2b

1. **Cross margin only** — `setRealBalance` overwrites the trader's `available` globally. Isolated-margin per-position is not modeled. Deferred.
2. **On-chain withdraw bypass** — `CollateralVault.withdraw(amount)` is callable by anyone for their own balance, with no guard against `lockedOf > 0` (because no one calls `lockCollateral`). A user with an open position can withdraw all their collateral on-chain; the listener picks it up and future orders reject, but the existing position survives and must be manually liquidated. Fix paths: wire `lockCollateral` from engine to vault (contract change, redeploy), or have the settlement listener detect Withdrawn → POST `/internal/forceClose` to engine. Deferred.
3. **Engine restart wipes realized PnL + positions** — engine state is in-memory only. On restart, real_deposit reloads from the settlement listener (which persists), but PnL and positions reset to zero. Users effectively get a "free" reset on every engine restart. Defer engine state persistence to a later phase.
4. **Deposit → trade latency** — Block confirmation + listener pickup adds ~1–2s between an approved on-chain deposit and the `/balances/:address` value reflecting it. Orders placed in that window will see the pre-deposit balance and may reject. Front-end should disable trading or show a "syncing" indicator after deposit confirms, until `/balances/:address.lastSeenBlock` advances past the deposit's block.
5. **Agent funding requirement** — Agents (`market-makers`, `traders`, `treasury`) submit orders carrying their generated `walletAddress`. With `ENGINE_USE_REAL_BALANCE=true`, they go through the real-balance gate just like humans. They need on-chain USDC in their wallets first — set `AGENT_AUTO_DEPOSIT_USDC > 0` and operator wallet funds them on startup. Default `0` will cause every agent order to reject with INSUFFICIENT_MARGIN, draining the orderbook.
