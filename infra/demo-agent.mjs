// Standalone Arc-testnet demo agent.
// Flow: load key -> (optional) ERC-8004 register -> approve USDC -> deposit
//   into CollateralVault -> submit limit order -> if no fill, fallback to
//   market order -> print settlement tx hashes + arcscan links.
//
// Run from repo root:
//   node infra/demo-agent.mjs                    (default: register + trade)
//   node infra/demo-agent.mjs --no-register      (skip ERC-8004 register)
//   node infra/demo-agent.mjs --metadata-uri=ipfs://...

import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, formatUnits, parseUnits, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC_URL = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const CHAIN_ID = 5042002;
const USDC = getAddress("0x3600000000000000000000000000000000000000");
const COLLATERAL_VAULT = getAddress("0xeba02c6911c35e5db6b984bb49db9f281c181c70");
const IDENTITY_REGISTRY = getAddress("0x8004A818BFB912233c491871b3d84c89A494BD9e");
const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:4100";
const EXPLORER = "https://testnet.arcscan.app";

const flags = new Set(process.argv.slice(2).filter((a) => !a.includes("=")));
const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.includes("=")).map((a) => a.replace(/^--/, "").split("=")));
const skipRegister = flags.has("--no-register");
const metadataUri = args["metadata-uri"] ?? "ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei";
const depositAmountUsdc = Number(args["deposit"] ?? "5");
const orderQty = Number(args["qty"] ?? "0.001");
const symbol = args["symbol"] ?? "BTC-PERP";

const erc20Abi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] }
];

const collateralVaultAbi = [
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] }
];

const identityAbi = [
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "metadataURI", type: "string" }], outputs: [{ type: "uint256" }] }
];

function loadKey() {
  const text = readFileSync("infra/agent-demo-wallet.txt", "utf8");
  const map = Object.fromEntries(text.split(/\r?\n/).filter(Boolean).map((line) => line.split("=").map((s) => s.trim())));
  if (!map.PRIVATE_KEY) throw new Error("PRIVATE_KEY missing in infra/agent-demo-wallet.txt");
  return map.PRIVATE_KEY.startsWith("0x") ? map.PRIVATE_KEY : `0x${map.PRIVATE_KEY}`;
}

function arcChain() {
  return {
    id: CHAIN_ID,
    name: "Arc Testnet",
    nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } }
  };
}

function txLink(hash) {
  return `${EXPLORER}/tx/${hash}`;
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function getMarkPrice(sym) {
  const state = await fetchJson(`${GATEWAY}/api/state`);
  const m = state.markets.find((x) => x.symbol === sym);
  if (!m) throw new Error(`market ${sym} not found in /api/state`);
  return m.markPrice;
}

async function pollForFills(traderId, sym, sinceTs, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await fetchJson(`${GATEWAY}/api/state`);
    const fills = state.trades.filter((t) => t.symbol === sym && t.ts >= sinceTs && (t.buyerId === traderId || t.sellerId === traderId));
    if (fills.length > 0) return fills;
    await new Promise((r) => setTimeout(r, 700));
  }
  return [];
}

async function main() {
  const pk = loadKey();
  const account = privateKeyToAccount(pk);
  const chain = arcChain();
  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, chain, transport: http(RPC_URL) });

  console.log(`agent address:    ${account.address}`);
  console.log(`gateway:          ${GATEWAY}`);
  console.log(`rpc:              ${RPC_URL}`);

  // Pre-flight: native (USDC) balance for gas + ERC-20 USDC for deposit
  const nativeWei = await publicClient.getBalance({ address: account.address });
  console.log(`native USDC:      ${Number(formatUnits(nativeWei, 18)).toFixed(6)} (gas)`);
  const tokenBal = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  console.log(`erc20 USDC:       ${Number(formatUnits(tokenBal, 6)).toFixed(6)} (collateral source)`);
  if (Number(formatUnits(nativeWei, 18)) < 0.05) throw new Error("insufficient native USDC for gas; claim from https://faucet.circle.com");
  if (tokenBal < parseUnits(String(depositAmountUsdc), 6)) {
    throw new Error(`insufficient ERC-20 USDC for ${depositAmountUsdc} USDC deposit (have ${formatUnits(tokenBal, 6)})`);
  }

  // (b) ERC-8004 register
  if (!skipRegister) {
    console.log(`\n[1] ERC-8004 register("${metadataUri}")`);
    const hash = await walletClient.writeContract({
      address: IDENTITY_REGISTRY,
      abi: identityAbi,
      functionName: "register",
      args: [metadataUri]
    });
    const rcpt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`    tx=${hash}  block=${rcpt.blockNumber}  gas=${rcpt.gasUsed}`);
    console.log(`    ${txLink(hash)}`);
  } else {
    console.log("\n[1] ERC-8004 register: SKIPPED (--no-register)");
  }

  // (c) Approve USDC -> CollateralVault
  const amount = parseUnits(String(depositAmountUsdc), 6);
  const allowance = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [account.address, COLLATERAL_VAULT] });
  if (allowance < amount) {
    console.log(`\n[2] USDC.approve(CollateralVault, ${depositAmountUsdc} USDC)`);
    const approveHash = await walletClient.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [COLLATERAL_VAULT, amount] });
    const rcpt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
    console.log(`    tx=${approveHash}  block=${rcpt.blockNumber}  gas=${rcpt.gasUsed}`);
    console.log(`    ${txLink(approveHash)}`);
  } else {
    console.log(`\n[2] USDC.approve: skipped (existing allowance ${formatUnits(allowance, 6)} USDC sufficient)`);
  }

  // (d) Deposit into CollateralVault
  console.log(`\n[3] CollateralVault.deposit(${depositAmountUsdc} USDC)`);
  const depositHash = await walletClient.writeContract({ address: COLLATERAL_VAULT, abi: collateralVaultAbi, functionName: "deposit", args: [amount] });
  const depositRcpt = await publicClient.waitForTransactionReceipt({ hash: depositHash });
  console.log(`    tx=${depositHash}  block=${depositRcpt.blockNumber}  gas=${depositRcpt.gasUsed}`);
  console.log(`    ${txLink(depositHash)}`);

  const vaultBal = await publicClient.readContract({ address: COLLATERAL_VAULT, abi: collateralVaultAbi, functionName: "balanceOf", args: [account.address] });
  console.log(`    vault balance: ${formatUnits(vaultBal, 6)} USDC`);

  // (f) Submit limit order at mark - 0.5% (user spec)
  const mark = await getMarkPrice(symbol);
  const limitPrice = Number((mark * (1 - 0.005)).toFixed(2));
  console.log(`\n[4] POST /api/orders  ${symbol} BUY limit qty=${orderQty} @ ${limitPrice} (mark=${mark.toFixed(2)}, -0.5%)`);
  const submittedAt = Date.now();
  const traderId = `agent-${account.address.slice(2, 10)}`;
  const limitResp = await fetchJson(`${GATEWAY}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      traderId,
      symbol,
      side: "buy",
      type: "limit",
      quantity: orderQty,
      price: limitPrice,
      leverage: 5,
      walletAddress: account.address,
      settleOnchain: true
    })
  });
  console.log(`    orderId=${limitResp.orderId}  immediate fills=${(limitResp.trades ?? []).length}`);
  reportSettlements(limitResp.settlements);

  let fills = limitResp.trades ?? [];
  if (fills.length === 0) {
    console.log(`    no immediate cross; polling for 8s in case an opposing order arrives...`);
    fills = await pollForFills(traderId, symbol, submittedAt, 8000);
  }

  // (h) Fallback: market order to guarantee the demo completes
  if (fills.length === 0) {
    console.log(`\n[5] No fill on limit order (expected — mark-0.5% buy sits inside spread).`);
    console.log(`    Submitting MARKET buy to demonstrate fill -> onchain settlement.`);
    const marketResp = await fetchJson(`${GATEWAY}/api/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        traderId,
        symbol,
        side: "buy",
        type: "market",
        quantity: orderQty,
        leverage: 5,
        walletAddress: account.address,
        settleOnchain: true
      })
    });
    console.log(`    orderId=${marketResp.orderId}  fills=${(marketResp.trades ?? []).length}`);
    reportSettlements(marketResp.settlements);
    fills = marketResp.trades ?? [];
  }

  console.log(`\nDone. Total fills observed: ${fills.length}`);
  for (const fill of fills) console.log(`  fill ${fill.id}  ${fill.quantity} ${symbol} @ ${fill.price}  (taker=${fill.takerSide})`);
}

function reportSettlements(settlements) {
  if (!Array.isArray(settlements) || settlements.length === 0) return;
  for (const s of settlements) {
    if (s.status === "confirmed") {
      console.log(`    SETTLEMENT confirmed tx=${s.txHash}  gas=${s.gasUsed}  block=${s.blockNumber}`);
      console.log(`    ${txLink(s.txHash)}`);
    } else {
      console.log(`    SETTLEMENT ${s.status}  ${s.error ?? s.id ?? ""}`);
    }
  }
}

main().catch((err) => { console.error("ERROR:", err.message ?? err); process.exit(1); });
