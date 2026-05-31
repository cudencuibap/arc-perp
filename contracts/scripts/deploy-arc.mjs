import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const rpcUrl = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const rawKey = process.env.DEPLOYER_PRIVATE_KEY ?? process.env.SETTLEMENT_PRIVATE_KEY;
if (!rawKey) throw new Error("Set DEPLOYER_PRIVATE_KEY or SETTLEMENT_PRIVATE_KEY in your shell. Do not commit it.");

const account = privateKeyToAccount(rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`);
const chain = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } }
};
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
const artifactDir = fileURLToPath(new URL("../artifacts", import.meta.url));

const useMockUsdc = process.env.DEPLOY_MOCK_USDC === "true" || !process.env.ARC_USDC_ADDRESS;
const usdc = useMockUsdc ? await deploy("MockUSDC") : process.env.ARC_USDC_ADDRESS;
const treasury = await deploy("TreasuryVault");
const collateral = await deploy("CollateralVault", [usdc, treasury]);
const settlement = await deploy("PerpSettlement", [collateral]);

console.log("Setting settlement contract on CollateralVault");
const hash = await walletClient.writeContract({
  address: collateral,
  abi: artifact("CollateralVault").abi,
  functionName: "setSettlement",
  args: [settlement]
});
await publicClient.waitForTransactionReceipt({ hash });

console.log("\nArc Perp deployment complete\n");
console.log(`ARC_USDC_ADDRESS=${usdc}`);
console.log(`TREASURY_VAULT_ADDRESS=${treasury}`);
console.log(`COLLATERAL_VAULT_ADDRESS=${collateral}`);
console.log(`PERP_SETTLEMENT_ADDRESS=${settlement}`);
console.log("SETTLEMENT_PRIVATE_KEY=<operator key with PerpSettlement owner rights>");

async function deploy(name, args = []) {
  const item = artifact(name);
  console.log(`Deploying ${name}`);
  const hash = await walletClient.deployContract({ abi: item.abi, bytecode: item.bytecode, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`${name} ${receipt.contractAddress} tx=${hash}`);
  return receipt.contractAddress;
}

function artifact(name) {
  return JSON.parse(readFileSync(join(artifactDir, `${name}.json`), "utf8"));
}
