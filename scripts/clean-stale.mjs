#!/usr/bin/env node
// Prune stale Cargo artifacts from `<repo>/target`.
//
// Cargo never deletes outputs of old toolchains, changed dependencies/features or old
// profiles: each variant lives next to the current one under a different hash suffix
// (`serde-1a2b3c4d5e6f7a8b.rlib`). For every `<stem>-<hash>` group in `deps`,
// `.fingerprint`, `build` and `incremental` this keeps the newest `--keep` variants
// (by mtime) and removes the rest. Throwaway dirs (`flycheck*`, `tmp`) are removed
// when untouched for `--max-age` days. Removing a still-needed file only costs a rebuild.
// Safe to run during a build: variants modified within the last hour are kept, and files
// locked by a running process are skipped.
//
// Usage: node clean-stale.mjs [--dry-run] [--keep N] [--max-age DAYS]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const numArg = (name, fallback) => {
  const i = args.indexOf(name);
  const v = i >= 0 ? Number(args[i + 1]) : fallback;
  if (!Number.isFinite(v) || v < 0) throw new Error(`${name} needs a non-negative number`);
  return v;
};
const keep = Math.max(1, numArg('--keep', 2));
const maxAgeMs = numArg('--max-age', 14) * 24 * 60 * 60 * 1000;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = path.join(root, 'target');

const VARIANT_DIRS = ['deps', '.fingerprint', 'build', 'incremental'];
// Variants touched this recently may belong to a build in progress: never removed.
const RECENT_MS = 60 * 60 * 1000;
const now = Date.now();
const THROWAWAY_DIRS = /^(flycheck\d*|tmp)$/;
const VARIANT_NAME = /^(.+)-([0-9a-z]{8,16})$/;

let removedBytes = 0;
let removedEntries = 0;

function sizeOf(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return { size: 0, mtime: 0 };
  }
  if (!st.isDirectory()) return { size: st.size, mtime: st.mtimeMs };
  let size = 0;
  let mtime = st.mtimeMs;
  for (const e of fs.readdirSync(p)) {
    const child = sizeOf(path.join(p, e));
    size += child.size;
    mtime = Math.max(mtime, child.mtime);
  }
  return { size, mtime };
}

function remove(p, size) {
  if (!dryRun) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch (e) {
      // Locked by a running process (EBUSY/EPERM on Windows): leave it for the next run.
      console.log(`clean-stale: skipped ${path.relative(root, p)} (${e.code ?? e.message})`);
      return;
    }
  }
  removedBytes += size;
  removedEntries += 1;
}

// Group entries of `dir` by stem, then by hash; drop all but the newest `keep` hashes per stem.
function sweepVariants(dir) {
  const groups = new Map(); // stem -> Map(hash -> { mtime, entries: [{ p, size }] })
  for (const name of fs.readdirSync(dir)) {
    const base = name.split('.')[0];
    const m = VARIANT_NAME.exec(base);
    if (!m) continue;
    const [, stem, hash] = m;
    const p = path.join(dir, name);
    const { size, mtime } = sizeOf(p);
    const variants = groups.get(stem) ?? new Map();
    const v = variants.get(hash) ?? { mtime: 0, entries: [] };
    v.mtime = Math.max(v.mtime, mtime);
    v.entries.push({ p, size });
    variants.set(hash, v);
    groups.set(stem, variants);
  }
  for (const variants of groups.values()) {
    const stale = [...variants.values()]
      .sort((a, b) => b.mtime - a.mtime)
      .slice(keep)
      .filter((v) => now - v.mtime > RECENT_MS);
    for (const v of stale) for (const e of v.entries) remove(e.p, e.size);
  }
}

// A profile dir is any dir that directly contains one of VARIANT_DIRS.
function sweepProfiles(dir, depth = 0) {
  if (depth > 3) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (VARIANT_DIRS.includes(e.name)) sweepVariants(p);
    else sweepProfiles(p, depth + 1);
  }
}

if (!fs.existsSync(targetDir)) {
  console.log('clean-stale: no target dir, nothing to do');
  process.exit(0);
}

for (const name of fs.readdirSync(targetDir)) {
  const p = path.join(targetDir, name);
  if (!THROWAWAY_DIRS.test(name) || !fs.statSync(p).isDirectory()) continue;
  const { size, mtime } = sizeOf(p);
  if (now - mtime > maxAgeMs) remove(p, size);
}
sweepProfiles(targetDir);

const mb = (removedBytes / (1024 * 1024)).toFixed(1);
console.log(`clean-stale: ${dryRun ? 'would remove' : 'removed'} ${removedEntries} entries, ${mb} MB`);
