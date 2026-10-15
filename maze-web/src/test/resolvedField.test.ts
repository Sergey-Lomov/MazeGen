import { describe, expect, it } from "vitest";
import { tessellationFamily, type FieldConfig } from "../fieldConfig";
import { configAllCells, resolveFieldConfig } from "../pixi/tessellationCells";
import { buildActiveCells } from "../pixi/selectors/fieldSelectors";
import { fieldOf } from "./fieldConfigFixtures";

describe("resolveFieldConfig", () => {
  const cases: [string, FieldConfig, "square" | "hex" | "tri", string | undefined][] = [
    ["square preset", fieldOf("square", { shape: "circle", radius: 3 }), "square", undefined],
    ["square custom", fieldOf("square", { shape: "custom", points: [[1, 2]] }), "square", undefined],
    ["hex preset / flat", fieldOf("hex", { shape: "triangle", side: 4 }, "flat_top"), "hex", "flat_top"],
    ["hex preset / pointy", fieldOf("hex", { shape: "circle", radius: 3 }, "pointy_top"), "hex", "pointy_top"],
    ["hex custom", fieldOf("hex", { shape: "custom", points: [[1, 2]] }, "pointy_top"), "hex", "pointy_top"],
    ["triangle preset / rotated", fieldOf("tri", { shape: "circle", radius: 3 }, "r90"), "tri", "r90"],
    ["triangle custom", fieldOf("tri", { shape: "custom", points: [[1, 2]] }, "r270"), "tri", "r270"],
  ];

  it.each(cases)("normalizes %s without changing its resolved cells", (_label, config, kind, orientation) => {
    const resolved = resolveFieldConfig(config);
    expect(resolved.tessellation.kind).toBe(kind);
    expect(resolved.shape.points).toEqual(configAllCells(config));
    expect(resolved.orientation).toBe(orientation);
  });

  it.each(cases)("gets the family for %s without resolving cells", (_label, config, kind) => {
    expect(tessellationFamily(config)).toBe(kind);
  });

  it.each(cases)("uses resolved cells for a standard runtime field: %s", (_label, config) => {
    const resolved = resolveFieldConfig(config);
    expect(buildActiveCells(new Set(), "default", resolved)).toEqual(resolved.shape.points);
  });
});
