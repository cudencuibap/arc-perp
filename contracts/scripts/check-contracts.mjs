import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = new URL("../src", import.meta.url);
const srcPath = fileURLToPath(srcDir);
const files = readdirSync(srcDir).filter((file) => file.endsWith(".sol"));
for (const file of files) {
  const source = readFileSync(join(srcPath, file), "utf8");
  if (!source.includes("pragma solidity ^0.8.24;")) throw new Error(`${file} is missing pragma`);
  if (source.includes("tx.origin")) throw new Error(`${file} uses tx.origin`);
}
console.log(`checked ${files.length} Arc Perp contracts`);
