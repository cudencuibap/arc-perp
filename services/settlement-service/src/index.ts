import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, "../../../.env") });

import cors from "cors";
import express from "express";
import { collateralVaultAbi, perpSettlementAbi, type OnchainConfig } from "@arc-perp/core/onchain";
import { createPublicClient, createWalletClient, getAddress, http, keccak256, parseAbiItem, parseUnits, stringToHex, type Address, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

const port = Number(process.env.SETTLEMENT_SERVICE_PORT ?? 4105);
const rpcUrl = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const chainId = 5042002;
const settlementKey = normalizePrivateKey(process.env.SETTLEMENT_PRIVATE_KEY);
const usdcAddress = normalizeAddress(process.env.ARC_USDC_ADDRESS);
const collateralVaultAddress = normalizeAddress(process.env.COLLATERAL_VAULT_ADDRESS);
const perpSettlementAddress = normalizeAddress(process.env.PERP_SETTLEMENT_ADDRESS);
const treasuryVaultAddress = normalizeAddress(process.env.TREASURY_VAULT_ADDRESS);
const app = express();
const history: SettlementRecord[] = [];

const arcChain = {
  id: chainId,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } }
} as const;

const publicClient = createPublicClient({ chain: arcChain, transport: http(rpcUrl) });
const account = settlementKey ? privateKeyToAccount(settlementKey) : undefined;
const walletClient = account ? createWalletClient({ account, chain: arcChain, transport: http(rpcUrl) }) : undefined;

const statePath = resolve(__dirname, "../data/settlement-events.json");
const tmpStatePath = `${statePath}.tmp`;
const vaultDeployBlock = BigInt(process.env.VAULT_DEPLOY_BLOCK ?? "0");
const catchupChunkSize = 9000n;

const depositedEvent = parseAbiItem("event Deposited(address indexed account, uint256 amount)");
const withdrawnEvent = parseAbiItem("event Withdrawn(address indexed account, uint256 amount)");

interface AccountBalance { deposited: bigint; withdrawn: bigint; }
const processedEvents = new Set<string>();
const balances = new Map<string, AccountBalance>();
let lastSeenBlock = 0n;
let persistChain: Promise<void> = Promise.resolve();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true, service: "settlement-service", enabled: isEnabled() }));
app.get("/config", (_req, res) => res.json(onchainConfig()));
app.get("/history", (_req, res) => res.json(history.slice(-200).reverse()));

app.get("/accounts/:address", async (req, res) => {
  const address = normalizeAddress(req.params.address);
  if (!address || !collateralVaultAddress) {
    res.status(400).json({ error: "address or collateral vault is not configured" });
    return;
  }
  try {
    const [balance, locked, available] = await Promise.all([
      publicClient.readContract({ address: collateralVaultAddress, abi: collateralVaultAbi, functionName: "balanceOf", args: [address] }),
      publicClient.readContract({ address: collateralVaultAddress, abi: collateralVaultAbi, functionName: "lockedOf", args: [address] }),
      publicClient.readContract({ address: collateralVaultAddress, abi: collateralVaultAbi, functionName: "availableOf", args: [address] })
    ]);
    res.json({ address, balance: balance.toString(), locked: locked.toString(), available: available.toString() });
  } catch (error) {
    res.status(502).json({ error: errorMessage(error) });
  }
});

app.get("/balances/:address", (req, res) => {
  const param = req.params.address;
  if (!param.startsWith("0x") || param.length !== 42) {
    res.status(400).json({ error: "invalid address" });
    return;
  }
  const key = param.toLowerCase();
  const bal = balances.get(key);
  const deposited = bal?.deposited ?? 0n;
  const withdrawn = bal?.withdrawn ?? 0n;
  res.json({
    address: key,
    deposited: deposited.toString(),
    withdrawn: withdrawn.toString(),
    net: (deposited - withdrawn).toString(),
    lastSeenBlock: lastSeenBlock.toString()
  });
});

app.post("/settlements/trade", async (req, res) => {
  const request = req.body as SettlementRequest;
  const trader = normalizeAddress(request.walletAddress);
  if (!trader) {
    res.status(400).json({ error: "walletAddress is required" });
    return;
  }
  const record = await recordSettlement({
    kind: "trade",
    account: trader,
    ref: request.ref ?? request.tradeId ?? `${request.symbol}-${Date.now()}`,
    pnl: Number(request.pnl ?? 0),
    fee: Number(request.fee ?? 0),
    metadata: request
  });
  res.status(record.status === "failed" ? 502 : 202).json(record);
});

app.post("/funding/settle", async (req, res) => {
  const request = req.body as { walletAddress?: string; symbol?: string; fundingPayment?: number; ref?: string };
  const trader = normalizeAddress(request.walletAddress);
  if (!trader) {
    res.status(400).json({ error: "walletAddress is required" });
    return;
  }
  const record = await recordSettlement({
    kind: "funding",
    account: trader,
    ref: request.ref ?? `funding-${request.symbol ?? "ALL"}-${Date.now()}`,
    pnl: Number(request.fundingPayment ?? 0),
    fee: 0,
    metadata: request
  });
  res.status(record.status === "failed" ? 502 : 202).json(record);
});

void boot();

async function recordSettlement(input: { kind: SettlementRecord["kind"]; account: Address; ref: string; pnl: number; fee: number; metadata: unknown }): Promise<SettlementRecord> {
  const base: SettlementRecord = {
    id: `stl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: input.kind,
    account: input.account,
    ref: input.ref,
    pnl: input.pnl,
    fee: input.fee,
    status: "pending_config",
    createdAt: Date.now(),
    metadata: input.metadata
  };

  if (!isEnabled() || !walletClient || !perpSettlementAddress) {
    history.push(base);
    return base;
  }

  try {
    const hash = await walletClient.writeContract({
      address: perpSettlementAddress,
      abi: perpSettlementAbi,
      functionName: "recordSettlement",
      args: [input.account, toUsdcSigned(input.pnl), toUsdcUnsigned(input.fee), refHash(input.ref)]
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const next = { ...base, status: "confirmed" as const, txHash: hash, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber.toString() };
    history.push(next);
    return next;
  } catch (error) {
    const failed = { ...base, status: "failed" as const, error: errorMessage(error) };
    history.push(failed);
    return failed;
  }
}

function onchainConfig(): OnchainConfig {
  return {
    chainId,
    rpcUrl,
    usdcAddress,
    collateralVaultAddress,
    perpSettlementAddress,
    treasuryVaultAddress,
    settlementEnabled: isEnabled()
  };
}

function isEnabled() {
  return Boolean(settlementKey && collateralVaultAddress && perpSettlementAddress && usdcAddress);
}

function refHash(ref: string): Hash {
  return keccak256(stringToHex(ref));
}

function toUsdcUnsigned(value: number) {
  return parseUnits(Math.max(0, value).toFixed(6), 6);
}

function toUsdcSigned(value: number) {
  const units = toUsdcUnsigned(Math.abs(value));
  return value < 0 ? -units : units;
}

function normalizePrivateKey(value?: string): `0x${string}` | undefined {
  if (!value) return undefined;
  return value.startsWith("0x") ? value as `0x${string}` : `0x${value}` as `0x${string}`;
}

function normalizeAddress(value?: string): Address | undefined {
  if (!value || !value.startsWith("0x")) return undefined;
  try {
    return getAddress(value);
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "unknown settlement error";
}

function serverListen() {
  app.listen(port, () => console.log(`settlement-service listening on ${port}; enabled=${isEnabled()}; listener=${Boolean(collateralVaultAddress)}`));
}

async function boot() {
  try {
    await loadState();
    await catchup();
    startWatching();
  } catch (error) {
    console.error(`[settlement] boot failed: ${errorMessage(error)}`);
    process.exit(1);
  }
  serverListen();
}

async function loadState() {
  await mkdir(dirname(statePath), { recursive: true });
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.log("[settlement] no prior state file, starting fresh");
      return;
    }
    throw error;
  }
  let parsed: { version?: number; lastSeenBlock?: string; processedEvents?: string[]; balances?: Record<string, { deposited?: string; withdrawn?: string }> };
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`state file corrupt at ${statePath}: ${errorMessage(error)} — refusing to start (delete file to reset)`);
  }
  lastSeenBlock = BigInt(parsed.lastSeenBlock ?? "0");
  for (const key of parsed.processedEvents ?? []) processedEvents.add(key);
  for (const [addr, b] of Object.entries(parsed.balances ?? {})) {
    balances.set(addr.toLowerCase(), { deposited: BigInt(b.deposited ?? "0"), withdrawn: BigInt(b.withdrawn ?? "0") });
  }
  console.log(`[settlement] loaded state: ${balances.size} accounts, ${processedEvents.size} events, lastSeenBlock=${lastSeenBlock}`);
}

async function catchup() {
  if (!collateralVaultAddress) {
    console.log("[settlement] vault address not configured, skipping catchup");
    return;
  }
  const startBlock = lastSeenBlock > 0n ? lastSeenBlock + 1n : vaultDeployBlock;
  const headBlock = await publicClient.getBlockNumber();
  if (startBlock > headBlock) {
    console.log(`[settlement] catchup: nothing to do (lastSeen=${lastSeenBlock}, head=${headBlock})`);
    return;
  }
  console.log(`[settlement] catchup ${startBlock} → ${headBlock} on ${collateralVaultAddress}`);
  let from = startBlock;
  let total = 0;
  while (from <= headBlock) {
    const to = from + catchupChunkSize - 1n > headBlock ? headBlock : from + catchupChunkSize - 1n;
    const logs = await publicClient.getLogs({
      address: collateralVaultAddress,
      events: [depositedEvent, withdrawnEvent],
      fromBlock: from,
      toBlock: to
    });
    for (const log of logs) await processLog(log);
    total += logs.length;
    if (to > lastSeenBlock) {
      lastSeenBlock = to;
      await persistState();
    }
    from = to + 1n;
  }
  console.log(`[settlement] catchup done: processed ${total} logs through block ${lastSeenBlock}`);
}

function startWatching() {
  if (!collateralVaultAddress) {
    console.log("[settlement] vault address not configured, event listener disabled");
    return;
  }
  publicClient.watchEvent({
    address: collateralVaultAddress,
    events: [depositedEvent, withdrawnEvent],
    onLogs: (logs) => enqueueLogs(logs),
    onError: (error) => console.error(`[settlement] watchEvent error: ${errorMessage(error)}`)
  });
  console.log(`[settlement] watching Deposited/Withdrawn on ${collateralVaultAddress}`);
}

function enqueueLogs(logs: readonly unknown[]): Promise<void> {
  persistChain = persistChain.then(async () => {
    for (const log of logs) await processLog(log);
  }).catch((error) => console.error(`[settlement] log handler error: ${errorMessage(error)}`));
  return persistChain;
}

async function processLog(log: unknown) {
  const entry = log as { transactionHash?: Hash; logIndex?: number; blockNumber?: bigint; eventName?: string; args?: { account?: Address; amount?: bigint } };
  if (!entry.transactionHash || entry.logIndex == null || entry.blockNumber == null || !entry.eventName || !entry.args?.account || entry.args.amount == null) {
    console.warn("[settlement] skipping malformed log", entry);
    return;
  }
  const key = `${entry.transactionHash}:${entry.logIndex}`;
  if (processedEvents.has(key)) return;
  const addr = entry.args.account.toLowerCase();
  const current = balances.get(addr) ?? { deposited: 0n, withdrawn: 0n };
  if (entry.eventName === "Deposited") current.deposited += entry.args.amount;
  else if (entry.eventName === "Withdrawn") current.withdrawn += entry.args.amount;
  else return;
  balances.set(addr, current);
  processedEvents.add(key);
  if (entry.blockNumber > lastSeenBlock) lastSeenBlock = entry.blockNumber;
  await persistState();
  console.log(`[settlement] ${entry.eventName} ${entry.args.amount} ${addr} @ block ${entry.blockNumber} tx ${entry.transactionHash}`);
}

async function persistState() {
  const data = {
    version: 1,
    lastSeenBlock: lastSeenBlock.toString(),
    processedEvents: [...processedEvents],
    balances: Object.fromEntries(
      [...balances.entries()].map(([addr, b]) => [addr, { deposited: b.deposited.toString(), withdrawn: b.withdrawn.toString() }])
    )
  };
  try {
    await writeFile(tmpStatePath, JSON.stringify(data, null, 2), "utf8");
    await rename(tmpStatePath, statePath);
  } catch (error) {
    console.error(`[settlement] persist failed: ${errorMessage(error)}`);
  }
}

interface SettlementRequest {
  tradeId?: string;
  ref?: string;
  walletAddress?: string;
  symbol?: string;
  notional?: number;
  pnl?: number;
  fee?: number;
}

interface SettlementRecord {
  id: string;
  kind: "trade" | "funding";
  account: Address;
  ref: string;
  pnl: number;
  fee: number;
  status: "pending_config" | "confirmed" | "failed";
  createdAt: number;
  txHash?: Hash;
  gasUsed?: string;
  blockNumber?: string;
  error?: string;
  metadata?: unknown;
}
