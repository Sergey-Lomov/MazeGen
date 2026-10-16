import { describe, expect, it } from "vitest";
import {
  getFieldCapabilities,
  getFieldPreset,
  reflectFieldCells,
  translateFieldCells,
} from "../wasm/mazeService";
import { tessellationConfigOf } from "../fieldConfig";
import { configAllCells } from "../pixi/tessellationCells";
import { fieldOf } from "./fieldConfigFixtures";

// Runs against the real `maze-core` module loaded by `setup.ts`.
const square = tessellationConfigOf("square");
const cairo = tessellationConfigOf("cairo");

describe("field operations over wasm", () => {
  it("lists the operations and preset schemas of a tessellation", () => {
    const capabilities = getFieldCapabilities(square);
    expect(capabilities.operations).toEqual(["translate", "reflect"]);
    expect(capabilities.presets.map((preset) => preset.key)).toEqual(["rect", "circle", "triangle"]);
  });

  it("builds preset cells around the origin, sorted by cell id", () => {
    expect(getFieldPreset(square, "rect", { cols: 2, rows: 2 })).toEqual([[-1, -1], [-1, 0], [0, -1], [0, 0]]);
  });

  it("treats a shape core refuses as empty and reuses built presets", () => {
    expect(configAllCells(fieldOf("cairo", { shape: "triangle", side: 1 }))).toEqual([]);
    expect(configAllCells(fieldOf("square", { shape: "rect", cols: 4_000_000, rows: 4_000_000 }))).toEqual([]);
    const config = fieldOf("square", { shape: "circle", radius: 4 });
    const first = configAllCells(config);
    first[0][0] = 999;
    first.pop();
    expect(configAllCells(config)).toEqual(getFieldPreset(tessellationConfigOf("square"), "circle", { radius: 4 }));
  });

  it("throws the wire reason when core refuses", () => {
    expect(() => getFieldPreset(square, "hexagon", { radius: 2 })).toThrow();
    try {
      translateFieldCells(square, [[0, 0]], [0.5, 0]);
      expect.unreachable();
    } catch (error) {
      expect(error).toEqual({ kind: "not_a_symmetry" });
    }
    try {
      translateFieldCells(cairo, [[0, 0]], [0, 0]);
      expect.unreachable();
    } catch (error) {
      expect(error).toEqual({ kind: "outside_tessellation" });
    }
  });

  it("translates and reflects cells on symmetric vectors and axes", () => {
    expect(translateFieldCells(square, [[0, 0], [1, 0]], [2, 1])).toEqual([[2, 1], [3, 1]]);
    expect(reflectFieldCells(square, [[0, 0], [1, 0]], [[2, 0], [2, 1]])).toEqual([[2, 0], [3, 0]]);
  });
});
