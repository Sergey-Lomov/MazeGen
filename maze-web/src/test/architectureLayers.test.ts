import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";

/// Layer direction (maze-web/Specs/architecture.md): `domain/` (pure logic) <- `store/` <- `pixi/` <- `components/`.
/// The store and the domain never import the canvas layer, the domain never imports UI, and the domain reaches into
/// the store for types only. Keeps the store <-> pixi import cycle (#1047) from returning.

const src = resolve(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

interface Import {
  from: string;
  /** Layer folder of the target (first segment under `src/`), or `null` for a package / non-layer module. */
  layer: string | null;
  typeOnly: boolean;
  /** Absolute path of the target without extension resolution. */
  path: string;
  /** Erased or lazy at module-load time: `import type`, `import("x")`, `import("x").Type`. Never part of a load-order cycle. */
  deferred: boolean;
}

const IMPORT = /(import|export)\s+(type\s+)?(\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+(?:\s*,\s*\{[^}]*\})?)?\s*(?:from\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function importsOf(file: string): Import[] {
  const text = readFileSync(file, "utf8");
  const found: Import[] = [];
  for (const m of text.matchAll(IMPORT)) {
    const spec = m[4] ?? m[5];
    if (!spec?.startsWith(".")) continue;
    const clause = m[3] ?? "";
    const names = clause.startsWith("{") ? clause.slice(1, -1).split(",").map((n) => n.trim()).filter(Boolean) : [];
    const typeOnly = m[5] === undefined && (m[2] !== undefined || (names.length > 0 && names.every((n) => n.startsWith("type "))));
    const path = resolve(dirname(file), spec);
    const target = relative(src, path).replace(/\\/g, "/");
    const typeExpression = m[5] !== undefined && text[(m.index ?? 0) + m[0].length] === ".";
    found.push({
      from: relative(src, file).replace(/\\/g, "/"),
      layer: target.startsWith("..") ? null : target.split("/")[0],
      typeOnly,
      path,
      deferred: typeOnly || m[5] !== undefined || typeExpression,
    });
  }
  return found;
}

/** Strongly connected components of size > 1 (Tarjan), each sorted. */
function findCycles(graph: Map<string, string[]>): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter++);
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) !== index.get(v)) return;
    const scc: string[] = [];
    let w: string;
    do {
      w = stack.pop()!;
      onStack.delete(w);
      scc.push(w);
    } while (w !== v);
    if (scc.length > 1) cycles.push(scc.sort());
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return cycles;
}

function violations(layer: string, forbidden: string[], allowTypeOnly: string[] = []): string[] {
  return sourceFiles(join(src, layer)).flatMap((file) =>
    importsOf(file)
      .filter((i) => i.layer !== null && forbidden.includes(i.layer) && !(i.typeOnly && allowTypeOnly.includes(i.layer)))
      .map((i) => `${i.from} -> ${i.layer}/`),
  );
}

describe("layer boundaries", () => {
  it("scanner sees the layers it guards (a broken parser would pass every rule vacuously)", () => {
    const storeImports = sourceFiles(join(src, "store")).flatMap(importsOf);
    expect(storeImports.some((i) => i.layer === "domain")).toBe(true);
    const domainImports = sourceFiles(join(src, "domain")).flatMap(importsOf);
    expect(domainImports.some((i) => i.layer === "store" && i.typeOnly)).toBe(true);
    expect(sourceFiles(join(src, "pixi")).flatMap(importsOf).some((i) => i.layer === "store" && !i.typeOnly)).toBe(true);
  });

  it("store does not import pixi", () => {
    expect(violations("store", ["pixi"])).toEqual([]);
  });

  it("domain does not import pixi or UI layers", () => {
    expect(violations("domain", ["pixi", "components", "debug", "activity", "notifications"])).toEqual([]);
  });

  it("domain imports store types only", () => {
    expect(violations("domain", ["store"], ["store"])).toEqual([]);
  });

  it("pixi does not import components", () => {
    expect(violations("pixi", ["components"])).toEqual([]);
  });

  it("has no value-import cycles", () => {
    const files = new Set(sourceFiles(src));
    const resolveTarget = (base: string): string | undefined =>
      [base + ".ts", base + ".tsx", join(base, "index.ts"), join(base, "index.tsx"), base].find((c) => files.has(c));
    const graph = new Map<string, string[]>();
    for (const file of files) {
      const targets = importsOf(file).filter((i) => !i.deferred).flatMap((i) => resolveTarget(i.path) ?? []);
      graph.set(file, targets);
    }
    const cycles = findCycles(graph).map((scc) => scc.map((f) => relative(src, f).replace(/\\/g, "/")));
    expect(cycles).toEqual([]);
  });

  it("cycle detector reports a load-order cycle and ignores acyclic chains", () => {
    const graph = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", ["a", "d"]],
      ["d", []],
    ]);
    expect(findCycles(graph)).toEqual([["a", "b", "c"]]);
    expect(findCycles(new Map([["a", ["b"]], ["b", []]]))).toEqual([]);
  });
});
