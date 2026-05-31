# Arc Perp Hybrid Onchain MVP

This repo keeps the realtime offchain matching engine and adds Arc testnet settlement around it.

## Arc Testnet

- Chain ID: `5042002`
- RPC: `https://rpc.testnet.arc.network`
- Explorer: `https://testnet.arcscan.app`
- USDC (canonical, gas + ERC-20): `0x3600000000000000000000000000000000000000`

## Get Testnet USDC

USDC is the native gas token on Arc. Fund any deployer or trader wallet from the Circle faucet before sending transactions:

- Faucet: `https://faucet.circle.com`

## Deploy Contracts

Use a funded Arc testnet deployer key from your shell only. Do not write private keys into git.

```bash
npm --workspace @arc-perp/contracts run build
DEPLOYER_PRIVATE_KEY=0x... npm --workspace @arc-perp/contracts run deploy:arc
```

If `ARC_USDC_ADDRESS` is not set, the deploy script deploys `MockUSDC` for testnet MVP testing. The script prints:

```text
ARC_USDC_ADDRESS=
TREASURY_VAULT_ADDRESS=
COLLATERAL_VAULT_ADDRESS=
PERP_SETTLEMENT_ADDRESS=
```

Copy those values into your local `.env`. Set `SETTLEMENT_PRIVATE_KEY` to the operator key that owns `PerpSettlement`.

## Runtime Model

- Offchain: orderbook, matching, WebSocket updates, liquidations, agent strategy loops.
- Onchain: USDC collateral deposits/withdrawals, settlement records, fee routing, funding transfers.

When `SETTLEMENT_PRIVATE_KEY`, `ARC_USDC_ADDRESS`, `COLLATERAL_VAULT_ADDRESS`, and `PERP_SETTLEMENT_ADDRESS` are configured, `settlement-service` sends real Arc testnet transactions and stores tx hash, gas used, and block number in `/history`.

## Agent Wallets

Set `AGENT_WALLET_SECRET` to enable persistent encrypted agent wallets. The encrypted files are stored under `AGENT_WALLET_DIR` and are gitignored.

```bash
AGENT_WALLET_SECRET=
AGENT_AUTO_DEPOSIT_USDC=10
```

Agents include their wallet address on orders. Filled trades and periodic funding then route to settlement service.
