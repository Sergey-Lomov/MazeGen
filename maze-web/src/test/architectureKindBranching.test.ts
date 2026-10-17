import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/// A tessellation kind may be branched on only in factories, registries and serialization
/// (Specs/space.md). Renderers read everything kind-specific from `TESSELLATION_UI`/core geometry.

const KIND_BRANCH = /[kK]ind\s*(===|!==|==|!=)\s*"(square|hex|tri|cairo|test)"|TessellationKind::/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|rs)$/.test(name) ? [path] : [];
  });
}

function branches(dir: string): string[] {
  return sourceFiles(dir).filter((file) => KIND_BRANCH.test(readFileSync(file, "utf8")));
}

const web = resolve(__dirname, "..");
const workspace = resolve(web, "../..");

/// Registries and serialization: the only web files allowed to name a kind.
const WEB_ALLOWED = ["pixi/geometry/tessellationUi.ts", "fieldConfig.ts", "store/projectExport/"];

describe("no tessellation-kind branching outside factories and registries", () => {
  it("web (editor, renderers, export, store)", () => {
    const offenders = branches(join(web))
      .map((file) => file.slice(web.length + 1))
      .filter((file) => !file.startsWith("test/") && !WEB_ALLOWED.some((allowed) => file.startsWith(allowed)));
    expect(offenders).toEqual([]);
  });

  it.each(["generation", "quality_control", "repair"])("maze-core %s", (dir) => {
    const path = join(workspace, "maze-core/src", dir);
    expect(statSync(path).isDirectory()).toBe(true);
    expect(branches(path)).toEqual([]);
  });
});
