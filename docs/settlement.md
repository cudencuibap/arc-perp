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
