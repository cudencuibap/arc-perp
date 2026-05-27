import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { collateralVaultAbi, erc20Abi, type OnchainConfig } from "@arc-perp/core/onchain";
import { createPublicClient, createWalletClient, http, parseUnits, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export interface ManagedAgentWallet {
  agentId: string;
  address: Address;
  canTransact: boolean;
  depositCollateral: (amountUsdc: number, config: OnchainConfig) => Promise<string | undefined>;
}

export function getAgentWallet(agentId: string): ManagedAgentWallet | undefined {
  const secret = process.env.AGENT_WALLET_SECRET;
  if (!secret) return undefined;
  const privateKey = loadOrCreatePrivateKey(agentId, secret);
  const account = privateKeyToAccount(privateKey);
  return {
    agentId,
    address: account.address,
    canTransact: true,
    depositCollateral: (amountUsdc, config) => depositCollateral(privateKey, amountUsdc, config)
  };
}

async function depositCollateral(privateKey: `0x${string}`, amountUsdc: number, config: OnchainConfig) {
  if (!config.usdcAddress || !config.collateralVaultAddress || amountUsdc <= 0) return undefined;
  const account = privateKeyToAccount(privateKey);
  const chain = {
    id: config.chainId,
    name: "Arc Testnet",
    nativeCurrency: { name: "Arc", symbol: "ARC", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } }
  } as const;
  const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(config.rpcUrl) });
  const amount = parseUnits(amountUsdc.toFixed(6), 6);
  const allowance = await publicClient.readContract({
    address: config.usdcAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, config.collateralVaultAddress]
  });
  if (allowance < amount) {
    const approveHash = await walletClient.writeContract({
      address: config.usdcAddress,
      abi: erc20Abi,
      functionName: "approve",
      args: [config.collateralVaultAddress, amount]
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
  }
  const depositHash = await walletClient.writeContract({
    address: config.collateralVaultAddress,
    abi: collateralVaultAbi,
    functionName: "deposit",
    args: [amount]
  });
  await publicClient.waitForTransactionReceipt({ hash: depositHash });
  return depositHash;
}

function loadOrCreatePrivateKey(agentId: string, secret: string): `0x${string}` {
  const file = walletFile(agentId);
  if (existsSync(file)) {
    return decrypt(readFileSync(file, "utf8"), secret) as `0x${string}`;
  }
  const privateKey = generatePrivateKey();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, encrypt(privateKey, secret), { encoding: "utf8", mode: 0o600 });
  return privateKey;
}

function walletFile(agentId: string) {
  const base = process.env.AGENT_WALLET_DIR ?? "./data/agent-wallets";
  return join(base, `${agentId.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);
}

function encrypt(value: string, secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ v: 1, iv: iv.toString("hex"), tag: tag.toString("hex"), ciphertext: ciphertext.toString("hex") });
}

function decrypt(payload: string, secret: string) {
  const parsed = JSON.parse(payload) as { iv: string; tag: string; ciphertext: string };
  const decipher = createDecipheriv("aes-256-gcm", key(secret), Buffer.from(parsed.iv, "hex"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(parsed.ciphertext, "hex")), decipher.final()]).toString("utf8");
}

function key(secret: string) {
  return createHash("sha256").update(secret).digest();
}
