import { describe, expect, it } from "vitest";
import { tessellationFamily, type FieldConfig } from "../fieldConfig";
import { configAllCells, resolveFieldConfig } from "../pixi/tessellationCells";
import { buildActiveCells } from "../pixi/selectors/fieldSelectors";

describe("resolveFieldConfig", () => {
  const cases: [string, FieldConfig, "square" | "hex" | "triangle", string | undefined][] = [
    ["square preset", { type: "square_circle", radius: 3 }, "square", undefined],
    ["square custom", { type: "square_custom", points: [[1, 2]] }, "square", undefined],
    ["hex preset / flat", { type: "hex_triangle", side: 4, orientation: "flat_top" }, "hex", "flat_top"],
    ["hex preset / pointy", { type: "hex_circle", radius: 3, orientation: "pointy_top" }, "hex", "pointy_top"],
    ["hex custom", { type: "hex_custom", points: [[1, 2]], orientation: "pointy_top" }, "hex", "pointy_top"],
    ["triangle preset / rotated", { type: "triangle_circle", radius: 3, orientation: "r90" }, "triangle", "r90"],
    ["triangle custom", { type: "tri_custom", points: [[1, 2]], orientation: "r270" }, "triangle", "r270"],
  ];

  it.each(cases)("normalizes %s without changing its resolved cells", (_label, config, kind, orientation) => {
    const resolved = resolveFieldConfig(config);
    expect(resolved.kind).toBe(kind);
    expect(resolved.cells).toEqual(configAllCells(config));
    if ("orientation" in resolved) expect(resolved.orientation).toBe(orientation);
  });

  it.each(cases)("gets the family for %s without resolving cells", (_label, config, kind) => {
    expect(tessellationFamily(config)).toBe(kind);
  });

  it.each(cases)("uses resolved cells for a standard runtime field: %s", (_label, config) => {
    const resolved = resolveFieldConfig(config);
    expect(buildActiveCells(new Set(), "default", resolved)).toEqual(resolved.cells);
  });
});
