import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "mazegen-wasm-state-"));
const script = resolve("scripts/wasm-state.mjs");
const artifacts = ["maze_wasm_bg.wasm", "maze_wasm.js", "maze_wasm.d.ts", "maze_wasm_bg.wasm.d.ts"];

function write(path, contents = "") {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

function run(command) {
  return spawnSync(process.execPath, [script, command], {
    encoding: "utf8",
    env: { ...process.env, MAZEGEN_ROOT: root },
  });
}

test.after(() => rmSync(root, { recursive: true, force: true }));

test("reports current, stale, and divergent WASM packages", () => {
  for (const directory of ["maze-core/src", "maze-core-macros/src", "maze-runner/src", "maze-wasm/src"]) {
    write(join(root, directory, "input.rs"));
  }
  for (const file of ["Cargo.toml", "Cargo.lock", "maze-core/Cargo.toml", "maze-core-macros/Cargo.toml", "maze-runner/Cargo.toml", "maze-wasm/Cargo.toml"]) {
    write(join(root, file));
  }
  for (const artifact of artifacts) {
    write(join(root, "maze-wasm/pkg", artifact), artifact);
    write(join(root, "maze-web/src/wasm/pkg", artifact), artifact);
  }

  assert.equal(run("--needs-rebuild").status, 0);
  assert.match(run("--verify").stdout, /passed/);

  const future = new Date(Date.now() + 2_000);
  utimesSync(join(root, "maze-core/src/input.rs"), future, future);
  const stale = run("--needs-rebuild");
  assert.equal(stale.status, 2);
  assert.match(stale.stdout, /Rust or WASM inputs are newer/);

  write(join(root, "maze-web/src/wasm/pkg/maze_wasm.js"), "different");
  const divergent = run("--needs-rebuild");
  assert.equal(divergent.status, 2);
  assert.match(divergent.stdout, /out-of-sync maze_wasm.js/);
});
