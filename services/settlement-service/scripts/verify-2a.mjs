// Phase 2a verification harness — spawns settlement-service, checks readiness,
// curls endpoints, restarts 3x, verifies state file hash is idempotent.
// Run from repo root: node services/settlement-service/scripts/verify-2a.mjs

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const entry = path.resolve(repoRoot, "services/settlement-service/src/index.ts");
const statePath = path.resolve(repoRoot, "services/settlement-service/data/settlement-events.json");
const PORT = 4105;
const READY_RE = /listening on 4105; enabled=(\w+); listener=(\w+)/;
const LOADED_RE = /loaded state: (\d+) accounts, (\d+) events, lastSeenBlock=(\d+)/;
const ERR_RE = /boot failed|EADDRINUSE|Error: |TypeError: |ReferenceError: /;
const READY_TIMEOUT_MS = 8 * 60_000; // 8 min for first catchup

const checks = [];
function record(name, ok, notes = "") {
  checks.push({ name, ok, notes });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${notes ? ` — ${notes}` : ""}`);
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port);
  });
}

async function waitPortFree(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortFree(PORT)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function startService() {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? "npx.cmd" : "npx", ["tsx", entry], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWin
    });
    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Timeout (${READY_TIMEOUT_MS / 1000}s) waiting for ready marker. Last stdout tail:\n${stdoutBuf.slice(-2000)}\nLast stderr tail:\n${stderrBuf.slice(-1000)}`));
    }, READY_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdoutBuf += text;
      process.stdout.write(text);
      if (settled) return;
      const m = stdoutBuf.match(READY_RE);
      if (m) {
        settled = true;
        clearTimeout(timer);
        const loadedMatch = stdoutBuf.match(LOADED_RE);
        resolve({ child, enabled: m[1], listener: m[2], loaded: loadedMatch ? { accounts: Number(loadedMatch[1]), events: Number(loadedMatch[2]), lastSeenBlock: loadedMatch[3] } : null, stdout: stdoutBuf });
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      process.stderr.write(text);
      if (settled) return;
      if (ERR_RE.test(text)) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`stderr error: ${text.slice(0, 400)}`));
      }
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Service exited before ready, code=${code}\nstdout tail:\n${stdoutBuf.slice(-2000)}\nstderr tail:\n${stderrBuf.slice(-1000)}`));
    });
  });
}

async function killService(child) {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" }).on("exit", () => resolve());
    } else {
      child.kill("SIGTERM");
      setTimeout(resolve, 1500);
    }
  });
}

async function fetchJson(url) {
  const res = await fetch(url);
  const ctype = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (!ctype.includes("json")) {
    throw new Error(`non-JSON response from ${url} (status=${res.status}, ctype=${ctype}): ${text.slice(0, 200)}`);
  }
  return { status: res.status, body: JSON.parse(text) };
}

async function readState() {
  const raw = await readFile(statePath, "utf8");
  const parsed = JSON.parse(raw);
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, parsed, hash };
}

(async () => {
  console.log(`[verify-2a] repo root: ${repoRoot}`);
  console.log(`[verify-2a] state path: ${statePath}`);
  console.log(`[verify-2a] entry: ${entry}`);

  if (!(await isPortFree(PORT))) {
    console.error(`[verify-2a] Port ${PORT} is already in use. Stop any running settlement-service first.`);
    process.exit(2);
  }

  // ============== STAGE 1: First boot (clean) — catchup from VAULT_DEPLOY_BLOCK
  console.log("\n========== STAGE 1: First boot + catchup ==========");
  let r1;
  try {
    r1 = await startService();
  } catch (e) {
    record("Stage 1 boot", false, e.message);
    process.exit(1);
  }
  record(`Service started: enabled=${r1.enabled}; listener=${r1.listener}`, r1.enabled === "true" && r1.listener === "true");
  record(`First boot has NO 'loaded state' (clean start)`, r1.loaded === null);

  await new Promise((r) => setTimeout(r, 1500));

  try {
    const health = await fetchJson(`http://localhost:${PORT}/health`);
    record("/health responds 200 JSON", health.status === 200, `body=${JSON.stringify(health.body)}`);
  } catch (e) { record("/health responds 200 JSON", false, e.message); }

  try {
    const bal = await fetchJson(`http://localhost:${PORT}/balances/0x0000000000000000000000000000000000000001`);
    const ok = bal.status === 200 && bal.body.deposited === "0" && bal.body.withdrawn === "0" && bal.body.net === "0";
    record("/balances zero-address returns zeros", ok, `body=${JSON.stringify(bal.body)}`);
  } catch (e) { record("/balances zero-address returns zeros", false, e.message); }

  let s1;
  try {
    s1 = await readState();
    record("State file exists + valid JSON", true, `lastSeenBlock=${s1.parsed.lastSeenBlock} accounts=${Object.keys(s1.parsed.balances || {}).length} events=${(s1.parsed.processedEvents || []).length} hash=${s1.hash.slice(0, 16)}`);
  } catch (e) {
    record("State file exists + valid JSON", false, e.message);
    await killService(r1.child);
    process.exit(1);
  }

  await killService(r1.child);
  if (!(await waitPortFree())) { record("Port freed after stage 1 kill", false, "Port still in use after 15s"); process.exit(1); }

  // ============== STAGE 2 & 3: Restart twice, assert state hash is identical
  for (let i = 2; i <= 3; i++) {
    console.log(`\n========== STAGE ${i}: Restart ${i - 1} (idempotency) ==========`);
    let r;
    try {
      r = await startService();
    } catch (e) {
      record(`Stage ${i} boot`, false, e.message);
      process.exit(1);
    }
    record(`Restart ${i - 1}: enabled=${r.enabled}; listener=${r.listener}`, r.enabled === "true" && r.listener === "true");
    record(`Restart ${i - 1}: 'loaded state' log present`, r.loaded !== null, r.loaded ? `lastSeenBlock=${r.loaded.lastSeenBlock} accounts=${r.loaded.accounts} events=${r.loaded.events}` : "NOT FOUND");
    if (r.loaded) {
      record(`Restart ${i - 1}: loaded lastSeenBlock matches state file`, r.loaded.lastSeenBlock === s1.parsed.lastSeenBlock, `loaded=${r.loaded.lastSeenBlock} state=${s1.parsed.lastSeenBlock}`);
    }

    await new Promise((r) => setTimeout(r, 1500));

    let s;
    try { s = await readState(); } catch (e) { record(`Restart ${i - 1}: state readable`, false, e.message); await killService(r.child); process.exit(1); }
    record(`Restart ${i - 1}: state hash matches stage 1`, s.hash === s1.hash, `s1=${s1.hash.slice(0, 16)} now=${s.hash.slice(0, 16)}`);
    record(`Restart ${i - 1}: lastSeenBlock unchanged`, s.parsed.lastSeenBlock === s1.parsed.lastSeenBlock, `${s.parsed.lastSeenBlock}`);

    await killService(r.child);
    if (i < 3 && !(await waitPortFree())) { record(`Port freed after stage ${i} kill`, false, "Port still in use after 15s"); process.exit(1); }
  }

  // Summary
  console.log("\n========== SUMMARY ==========");
  const failed = checks.filter((c) => !c.ok);
  console.log(`${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length) {
    console.log("\nFAILURES:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.notes}`);
    process.exit(1);
  }
  console.log("ALL PASS");
  process.exit(0);
})().catch((err) => {
  console.error("\nFATAL:", err.stack || err.message || err);
  process.exit(2);
});
