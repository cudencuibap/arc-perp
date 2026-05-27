import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

const srcPath = fileURLToPath(new URL("../src", import.meta.url));
const outPath = fileURLToPath(new URL("../artifacts", import.meta.url));
const sources = Object.fromEntries(readdirSync(srcPath).filter((file) => file.endsWith(".sol")).map((file) => [
  file,
  { content: readFileSync(join(srcPath, file), "utf8") }
]));

const output = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
  }
})));

const errors = (output.errors ?? []).filter((item) => item.severity === "error");
if (errors.length > 0) {
  for (const error of errors) console.error(error.formattedMessage);
  process.exit(1);
}

mkdirSync(outPath, { recursive: true });
for (const [sourceName, contracts] of Object.entries(output.contracts)) {
  for (const [contractName, artifact] of Object.entries(contracts)) {
    if (!artifact.evm.bytecode.object) continue;
    writeFileSync(join(outPath, `${contractName}.json`), JSON.stringify({
      sourceName,
      contractName,
      abi: artifact.abi,
      bytecode: `0x${artifact.evm.bytecode.object}`
    }, null, 2));
  }
}

console.log(`compiled ${Object.keys(output.contracts).length} Solidity sources`);
