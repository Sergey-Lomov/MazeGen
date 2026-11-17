import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.MAZEGEN_ROOT
  ? resolve(process.env.MAZEGEN_ROOT)
  : resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifacts = ["maze_wasm_bg.wasm", "maze_wasm.js", "maze_wasm.d.ts", "maze_wasm_bg.wasm.d.ts"];
const sourceRoots = ["maze-core/src", "maze-core-macros/src", "maze-runner/src", "maze-wasm/src"];
const sourceFiles = ["Cargo.toml", "Cargo.lock", "maze-core/Cargo.toml", "maze-core-macros/Cargo.toml", "maze-runner/Cargo.toml", "maze-wasm/Cargo.toml"];
const wasmPackage = join(root, "maze-wasm", "pkg");
const webPackage = join(root, "maze-web", "src", "wasm", "pkg");

function newestMtime(path) {
  const entry = statSync(path);
  if (!entry.isDirectory()) return entry.mtimeMs;
  return readdirSync(path, { withFileTypes: true }).reduce((newest, child) => (
    Math.max(newest, newestMtime(join(path, child.name)))
  ), entry.mtimeMs);
}

function artifactDigest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function rebuildReason() {
  for (const artifact of artifacts) {
    const sourceArtifact = join(wasmPackage, artifact);
    const webArtifact = join(webPackage, artifact);
    if (!existsSync(sourceArtifact) || !existsSync(webArtifact)) return `missing ${artifact}`;
    if (artifactDigest(sourceArtifact) !== artifactDigest(webArtifact)) return `out-of-sync ${artifact}`;
  }

  const newestSource = Math.max(
    ...sourceRoots.map((path) => newestMtime(join(root, path))),
    ...sourceFiles.map((path) => newestMtime(join(root, path))),
  );
  const oldestArtifact = Math.min(...artifacts.map((artifact) => statSync(join(webPackage, artifact)).mtimeMs));
  return newestSource > oldestArtifact ? "Rust or WASM inputs are newer than the package" : null;
}

const command = process.argv[2];
if (command === "--needs-rebuild") {
  const reason = rebuildReason();
  console.log(reason ? `rebuild: ${reason}` : "reuse: WASM package is current");
  process.exitCode = reason ? 2 : 0;
} else if (command === "--verify") {
  const reason = rebuildReason();
  if (reason) {
    console.error(`WASM package verification failed: ${reason}`);
    process.exitCode = 1;
  } else {
    console.log("WASM package verification passed.");
  }
} else {
  console.error("Usage: node scripts/wasm-state.mjs --needs-rebuild | --verify");
  process.exitCode = 1;
}
