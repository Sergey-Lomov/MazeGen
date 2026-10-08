import { describe, it, expect } from "vitest";
import { VECTOR_BY_WALLS_PARAM_REGISTRY, VECTOR_BY_CORRIDORS_PARAM_REGISTRY } from "../store/parameterLinksRegistry";
import { WALLS_PLAIN_PATHS, CORRIDORS_PLAIN_PATHS } from "../store/slices/imageExportSlice";
import type { Linked } from "../store/slices/parameterLinksEngine";
import type { VectorByWallsSettings } from "../store/imageExportTypes";

// GitHub issue #704 — registry fields (potential link sources/targets) must be written through the
// link-aware helpers. The compile-time half is the `Linked` brand on `set`'s `vectorBy*Settings`
// in `imageExportSlice.ts` (enforced by `tsc`); this file pins the brand and the plain-path lists.
describe("imageExportSlice linked-field setters (GitHub issue #704)", () => {
  it("plain (non-linkable) path lists never contain a registry field", () => {
    expect(WALLS_PLAIN_PATHS.filter((p) => p in VECTOR_BY_WALLS_PARAM_REGISTRY)).toEqual([]);
    expect(CORRIDORS_PLAIN_PATHS.filter((p) => p in VECTOR_BY_CORRIDORS_PARAM_REGISTRY)).toEqual([]);
  });

  it("raw settings are not assignable to Linked (compile-time check)", () => {
    // @ts-expect-error a plain settings object lacks the `Linked` brand
    const bad: Linked<VectorByWallsSettings> | null = {} as VectorByWallsSettings;
    expect(bad).toBeDefined();
  });
});
