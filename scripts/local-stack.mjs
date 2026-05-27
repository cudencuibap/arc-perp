import { spawn } from "node:child_process";

const mode = process.argv[2] === "start" ? "start" : "dev";
const isStart = mode === "start";

const services = [
  ["engine", "@arc-perp/matching-engine"],
  ["market-data", "@arc-perp/market-data"],
  ["settlement", "@arc-perp/settlement-service"],
  ["gateway", "@arc-perp/websocket-gateway"],
  ["web", "@arc-perp/dex-web"]
];

const children = services.map(([name, workspace]) => {
  const args = ["--workspace", workspace, "run", isStart ? "start" : "dev"];
  const child = spawn("npm", args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      MATCHING_ENGINE_URL: process.env.MATCHING_ENGINE_URL ?? "http://localhost:4101",
      MATCHING_ENGINE_WS: process.env.MATCHING_ENGINE_WS ?? "ws://localhost:4101/stream",
      MARKET_DATA_HTTP_URL: process.env.MARKET_DATA_HTTP_URL ?? "http://localhost:4102",
      SETTLEMENT_SERVICE_URL: process.env.SETTLEMENT_SERVICE_URL ?? "http://localhost:4105",
      VITE_API_URL: process.env.VITE_API_URL ?? "http://localhost:4100",
      VITE_WS_URL: process.env.VITE_WS_URL ?? "ws://localhost:4100/ws"
    }
  });
  child.on("exit", (code) => {
    if (code && code !== 0) console.error(`[${name}] exited with code ${code}`);
  });
  return child;
});

function shutdown() {
  for (const child of children) child.kill();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
