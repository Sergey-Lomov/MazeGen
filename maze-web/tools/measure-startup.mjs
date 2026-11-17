// Times a real `npm run dev` start: spawns it exactly as a developer would (npm, `predev`
// scripts, Vite CLI, config load, plugins) and stamps every output line with the elapsed time
// until Vite prints that the server is ready. No browser is involved; the server is stopped
// afterwards.
//
//   node tools/measure-startup.mjs          warm start: every cache kept
//   node tools/measure-startup.mjs --cold   drops the Vite optimizer cache, the Paraglide output
//                                           and its marker first (the app-level cold state)
//
// A machine reboot additionally empties the OS file cache: flush the standby list (RAMMap,
// Empty -> Empty Standby List, as administrator) right before running this to reproduce it.
import { spawn, execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readyPattern = /ready in|Local:\s+http/i;
const timeoutMs = 15 * 60 * 1000;

if (process.argv.includes("--cold")) {
  for (const path of [
    "node_modules/.vite",
    "node_modules/.cache/mazegen-paraglide.json",
    "generated/paraglide",
  ]) {
    rmSync(join(root, path), { recursive: true, force: true });
  }
}

const start = performance.now();
const stamp = () => `[${((performance.now() - start) / 1000).toFixed(1).padStart(6)}s]`;
const child = spawn("npm run dev", { cwd: root, shell: true, env: { ...process.env, FORCE_COLOR: "0" } });
let ready = false;

function stop() {
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /pid ${child.pid} /t /f`, { stdio: "ignore" });
    } catch {
      // already gone
    }
  } else {
    child.kill("SIGTERM");
  }
}

function onData(chunk) {
  for (const line of chunk.toString().split(/\r?\n/)) {
    if (line.trim() === "") continue;
    console.log(`${stamp()} ${line}`);
    if (!ready && readyPattern.test(line)) {
      ready = true;
      console.log(`${stamp()} server ready`);
      stop();
    }
  }
}

child.stdout.on("data", onData);
child.stderr.on("data", onData);
child.on("exit", () => process.exit(ready ? 0 : 1));
setTimeout(() => {
  console.log(`${stamp()} timeout without ready`);
  stop();
}, timeoutMs).unref();
