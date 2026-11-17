// Fails `npm test` fast when the wasm build is missing: suites run against the real `maze-core`
// module and are never skipped without it.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const wasm = resolve(dirname(fileURLToPath(import.meta.url)), "../src/wasm/pkg/maze_wasm_bg.wasm");
if (!existsSync(wasm)) {
  console.error(`Missing ${wasm}\nBuild it first: scripts/wasm-rebuild.sh (macOS/Linux) or scripts/windows/wasm-rebuild.ps1 (Windows).`);
  process.exit(1);
}
