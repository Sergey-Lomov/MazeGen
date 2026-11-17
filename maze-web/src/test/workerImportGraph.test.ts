import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const WASM_DIR = path.resolve(__dirname, "../wasm");
const IMPORT_RE = /^\s*(?:import|export)\s+(?!type\b)[^;"']*?from\s*"([^"]+)"|^\s*import\s*"([^"]+)"/gm;

function resolveSpec(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Runtime (non-type) import closure of `entry`, as the worker bundle would contain it. */
function importsParaglide(entry: string): string | null {
  const seen = new Set<string>();
  const parents = new Map<string, string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of fs.readFileSync(file, "utf8").matchAll(IMPORT_RE)) {
      const spec = match[1] ?? match[2];
      if (spec.includes("paraglide")) {
        const chain = [path.basename(file)];
        for (let c = parents.get(file); c; c = parents.get(c)) chain.unshift(path.basename(c));
        return chain.join(" -> ");
      }
      const resolved = resolveSpec(file, spec);
      if (resolved && !seen.has(resolved)) {
        parents.set(resolved, file);
        stack.push(resolved);
      }
    }
  }
  return null;
}

describe("worker import graph (GitHub issue #951)", () => {
  // Paraglide's message bundle is large; a worker that reaches it downloads and parses it again
  // every time a worker is created.
  it.each(["generationWorker.ts", "analyticsWorker.ts", "printSizingWorker.ts"])("%s does not bundle Paraglide messages", (worker) => {
    expect(importsParaglide(path.join(WASM_DIR, worker))).toBeNull();
  });
});
