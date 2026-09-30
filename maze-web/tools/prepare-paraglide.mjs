import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedDir = join(projectRoot, "generated", "paraglide");
const generatedEntry = join(generatedDir, "messages.js");
const viteCacheDir = join(projectRoot, "node_modules", ".vite");
const cacheFile = join(projectRoot, "node_modules", ".cache", "mazegen-paraglide.json");

const compileArgs = [
  "compile",
  "--project",
  "./project.inlang",
  "--outdir",
  "./generated/paraglide",
  "--output-structure",
  "locale-modules",
];

function listFiles(directory) {
  if (!existsSync(directory)) return [];

  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export function getInputFiles(root = projectRoot) {
  const messagesDir = join(root, "messages");
  return [
    ...listFiles(messagesDir),
    join(root, "project.inlang", "settings.json"),
    join(root, "package.json"),
    join(root, "package-lock.json"),
    join(root, "node_modules", "@inlang", "paraglide-js", "package.json"),
  ].sort();
}

export function getInputFingerprint(root = projectRoot) {
  const hash = createHash("sha256");

  for (const file of getInputFiles(root)) {
    const relativePath = relative(root, file).replaceAll("\\", "/");
    hash.update(relativePath);
    hash.update("\0");
    if (existsSync(file)) hash.update(readFileSync(file));
    hash.update("\0");
  }

  return hash.digest("hex");
}

export function needsPreparation({ cachedFingerprint, fingerprint, generatedOutputExists }) {
  return cachedFingerprint !== fingerprint || !generatedOutputExists;
}

function readCachedFingerprint() {
  if (!existsSync(cacheFile)) return undefined;

  try {
    return JSON.parse(readFileSync(cacheFile, "utf8")).fingerprint;
  } catch {
    return undefined;
  }
}

function compileParaglide() {
  const cli = join(projectRoot, "node_modules", "@inlang", "paraglide-js", "bin", "run.js");
  execFileSync(process.execPath, [cli, ...compileArgs], {
    cwd: projectRoot,
    stdio: "inherit",
  });
}

export function prepareParaglide() {
  const fingerprint = getInputFingerprint();
  const cachedFingerprint = readCachedFingerprint();
  const generatedOutputExists = existsSync(generatedEntry);

  if (!needsPreparation({ cachedFingerprint, fingerprint, generatedOutputExists })) return false;

  rmSync(viteCacheDir, { recursive: true, force: true });
  compileParaglide();

  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, `${JSON.stringify({ fingerprint }, null, 2)}\n`);
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareParaglide();
}
