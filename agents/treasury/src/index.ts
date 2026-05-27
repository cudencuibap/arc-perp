import { getAgentWallet } from "@arc-perp/agent-wallets";

const gatewayUrl = process.env.WEBSOCKET_GATEWAY_URL ?? "http://localhost:4100";
const wallet = getAgentWallet("treasury-bot");

setInterval(async () => {
  const res = await fetch(`${gatewayUrl}/api/state`).catch(() => undefined);
  if (!res?.ok) return;
  const state = await res.json() as { balances: Array<{ equity: number; available: number }> };
  const equity = state.balances.reduce((sum, balance) => sum + balance.equity, 0);
  const available = state.balances.reduce((sum, balance) => sum + balance.available, 0);
  const settlements = await fetch(`${gatewayUrl}/api/settlements/history`).then((item) => item.json()).catch(() => []);
  console.log("treasury-agent reserves", { equity: Math.round(equity), available: Math.round(available), wallet: wallet?.address, settlements: Array.isArray(settlements) ? settlements.length : 0 });
}, 5000);

console.log("treasury agent watching hybrid venue solvency");
