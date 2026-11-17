import { describe, expect, it } from "vitest";
import { sameTessellationSettings } from "../store/storeHelpers";
import type { TessellationKind, HexOrientation, TriOrientation } from "../store/mazeStore";

function settings(kind: TessellationKind, params: Record<string, unknown> = {}, hex: HexOrientation = "flat_top", tri: TriOrientation = "r0") {
  return { tessellation: { kind, params }, hexOrientation: hex, triOrientation: tri };
}

describe("sameTessellationSettings", () => {
  it("is true for identical settings", () => {
    expect(sameTessellationSettings(settings("hex"), settings("hex"))).toBe(true);
  });

  it("differs by kind", () => {
    expect(sameTessellationSettings(settings("hex"), settings("square"))).toBe(false);
  });

  it("differs by any param value and ignores param key order", () => {
    const a = settings("radial", { first_ring_cells: 12, max_cells: 3000 });
    expect(sameTessellationSettings(a, settings("radial", { max_cells: 3000, first_ring_cells: 12 }))).toBe(true);
    expect(sameTessellationSettings(a, settings("radial", { first_ring_cells: 13, max_cells: 3000 }))).toBe(false);
  });

  it("differs by the orientation of the slot the kind uses", () => {
    expect(sameTessellationSettings(settings("hex", {}, "flat_top"), settings("hex", {}, "pointy_top"))).toBe(false);
    expect(sameTessellationSettings(settings("tri", {}, "flat_top", "r0"), settings("tri", {}, "flat_top", "r90"))).toBe(false);
  });

  it("ignores the orientation of a slot the kind does not use", () => {
    expect(sameTessellationSettings(settings("square", {}, "flat_top", "r0"), settings("square", {}, "pointy_top", "r90"))).toBe(true);
    expect(sameTessellationSettings(settings("hex", {}, "flat_top", "r0"), settings("hex", {}, "flat_top", "r90"))).toBe(true);
  });
});
