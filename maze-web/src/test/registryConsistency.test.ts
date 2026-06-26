import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { CheckDescriptor, StrategyDescriptor } from "../wasm/types";
import { checkI18n, strategyI18n, paramI18n } from "../components/features/qualityI18n";
import { resolveIssue } from "../components/issueRegistry";

// `src/wasm/pkg/` is gitignored build output produced by `wasm-rebuild.ps1` — absent on a
// fresh checkout until that script has been run at least once. Skip rather than fail so this
// suite doesn't block on a missing local build artifact; it still runs (and catches real
// drift) in any dev environment that has rebuilt wasm, which is the normal workflow here.
const wasmPath = resolve(dirname(__filename), "../wasm/pkg/maze_wasm_bg.wasm");
const describeIfWasmBuilt = existsSync(wasmPath) ? describe : describe.skip;

describeIfWasmBuilt("wasm registry vs web i18n consistency", () => {
  let checks: CheckDescriptor[];
  let strategies: StrategyDescriptor[];

  beforeAll(async () => {
    // wasm-bindgen's default `init()` fetches its .wasm by URL, which doesn't work under
    // vitest's node environment — load the bytes from disk instead and pass them directly.
    const wasm = await import("../wasm/pkg/maze_wasm");
    await wasm.default(readFileSync(wasmPath));
    checks = wasm.available_checks() as CheckDescriptor[];
    strategies = wasm.available_strategies() as StrategyDescriptor[];
  });

  it("every wasm check id has a checkI18n entry", () => {
    for (const check of checks) {
      expect(checkI18n[check.id], `missing checkI18n entry for "${check.id}"`).toBeDefined();
      expect(checkI18n[check.id].label().length).toBeGreaterThan(0);
      expect(checkI18n[check.id].description().length).toBeGreaterThan(0);
    }
  });

  it("every wasm check param id has a paramI18n entry", () => {
    for (const check of checks) {
      for (const param of check.params) {
        expect(paramI18n[param.id], `missing paramI18n entry for "${param.id}" (check "${check.id}")`).toBeDefined();
        expect(paramI18n[param.id]().length).toBeGreaterThan(0);
      }
    }
  });

  it("every wasm check issue kind resolves to a known issue", () => {
    for (const check of checks) {
      for (const kind of check.issue_kinds) {
        const info = resolveIssue(kind);
        expect(info.label, `issue kind "${kind}" (check "${check.id}") has no resolveIssue entry`).not.toBe(kind);
      }
    }
  });

  it("every wasm strategy id has a strategyI18n entry", () => {
    for (const strategy of strategies) {
      expect(strategyI18n[strategy.id], `missing strategyI18n entry for "${strategy.id}"`).toBeDefined();
      expect(strategyI18n[strategy.id].label().length).toBeGreaterThan(0);
      expect(strategyI18n[strategy.id].description().length).toBeGreaterThan(0);
    }
  });

  it("every wasm strategy param id has a paramI18n entry", () => {
    for (const strategy of strategies) {
      for (const param of strategy.params) {
        expect(paramI18n[param.id], `missing paramI18n entry for "${param.id}" (strategy "${strategy.id}")`).toBeDefined();
        expect(paramI18n[param.id]().length).toBeGreaterThan(0);
      }
    }
  });
});
