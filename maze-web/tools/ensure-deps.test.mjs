import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findStaleDependencies } from "./ensure-deps.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createProject({ installed }) {
  const root = mkdtempSync(join(tmpdir(), "mazegen-deps-"));
  temporaryDirectories.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({
    dependencies: { "@scope/runtime": "1.0.0" },
    devDependencies: { tool: "^2.0.0" },
  }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({
    packages: { "node_modules/@scope/runtime": { version: "1.0.0" }, "node_modules/tool": { version: "2.1.0" } },
  }));
  for (const [name, version] of Object.entries(installed)) {
    mkdirSync(join(root, "node_modules", name), { recursive: true });
    writeFileSync(join(root, "node_modules", name, "package.json"), JSON.stringify({ version }));
  }
  return root;
}

describe("findStaleDependencies", () => {
  it("is empty when every declared package is installed in the locked version", () => {
    const root = createProject({ installed: { "@scope/runtime": "1.0.0", tool: "2.1.0" } });
    expect(findStaleDependencies(root)).toEqual([]);
  });

  it("names a declared package that is not installed, scoped and dev ones included", () => {
    const root = createProject({ installed: { tool: "2.1.0" } });
    expect(findStaleDependencies(root)).toEqual(["@scope/runtime"]);
    expect(findStaleDependencies(createProject({ installed: {} }))).toEqual(["@scope/runtime", "tool"]);
  });

  it("names a package installed in another version than the lock file pins", () => {
    const root = createProject({ installed: { "@scope/runtime": "1.0.0", tool: "2.0.0" } });
    expect(findStaleDependencies(root)).toEqual(["tool"]);
  });
});
