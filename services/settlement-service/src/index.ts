import cors from "cors";
import express from "express";
import { collateralVaultAbi, perpSettlementAbi, type OnchainConfig } from "@arc-perp/core/onchain";
import { createPublicClient, createWalletClient, getAddress, http, keccak256, parseUnits, stringToHex, type Address, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";

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

serverListen();

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
  app.listen(port, () => console.log(`settlement-service listening on ${port}; enabled=${isEnabled()}`));
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
