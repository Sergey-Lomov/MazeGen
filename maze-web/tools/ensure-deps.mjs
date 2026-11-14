// Runs `npm install` when `node_modules` lags behind the manifests, e.g. after a pull or merge
// brought a new dependency: otherwise Vite fails with "Failed to resolve import". It runs before
// every script that needs the packages (`dev`, `build`, `test`, `test:watch`).
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** The declared packages that are not installed, or installed in another version than the lock
 * file pins. */
export function findStaleDependencies(root = projectRoot) {
  const manifest = readJson(join(root, "package.json")) ?? {};
  const lockPackages = readJson(join(root, "package-lock.json"))?.packages ?? {};
  const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  return names.filter((name) => {
    const installed = readJson(join(root, "node_modules", name, "package.json"));
    if (!installed) return true;
    const pinned = lockPackages[`node_modules/${name}`]?.version;
    return pinned !== undefined && pinned !== installed.version;
  });
}

export function ensureDependencies(root = projectRoot) {
  const stale = findStaleDependencies(root);
  if (stale.length === 0) return false;
  console.log(`node_modules is out of date (${stale.join(", ")}); running npm install`);
  // `npm ci` would wipe node_modules; `install` only adds what is missing.
  execSync("npm install", { cwd: root, stdio: "inherit" });
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureDependencies();
}
