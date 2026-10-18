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

  it("builds square-octagon presets and accepts only octagon-pitch translations", () => {
    const octagons = tessellationConfigOf("square_octagon");
    // 2x2 octagons around the origin octagon plus the one square between them.
    expect(getFieldPreset(octagons, "rect", { cols: 2, rows: 2 })).toEqual([[-2, -2], [-2, 0], [-1, -1], [0, -2], [0, 0]]);
    const pitch = 1 + Math.SQRT2;
    expect(translateFieldCells(octagons, [[0, 0], [1, 1]], [pitch, 0])).toEqual([[2, 0], [3, 1]]);
    try {
      // Half a pitch along both axes maps octagons onto squares.
      translateFieldCells(octagons, [[0, 0]], [pitch / 2, pitch / 2]);
      expect.unreachable();
    } catch (error) {
      expect(error).toEqual({ kind: "not_a_symmetry" });
    }
  });

  it("builds brick presets and accepts only translations that keep the row shift", () => {
    const brick = tessellationConfigOf("brick");
    expect(getFieldPreset(brick, "rect", { cols: 2, rows: 2 })).toEqual([[-1, -1], [-1, 0], [0, -1], [0, 0]]);
    // Rows of 3, 2 and 1 bricks: each row rests on two bricks of the one below.
    expect(getFieldPreset(brick, "triangle", { side: 3 })).toHaveLength(6);
    // Half a cell right and one row up lands on the neighboring row's shifted cell.
    expect(translateFieldCells(brick, [[0, 0], [1, 0]], [0.5, 1])).toEqual([[0, 1], [1, 1]]);
    expect(translateFieldCells(brick, [[0, 0]], [1, 2])).toEqual([[1, 2]]);
    try {
      // One row up without the half-cell shift maps even-row cells off the lattice.
      translateFieldCells(brick, [[0, 0]], [0, 1]);
      expect.unreachable();
    } catch (error) {
      expect(error).toEqual({ kind: "not_a_symmetry" });
    }
  });

  it("builds trihexagonal presets and translates only by lattice vectors", () => {
    const kagome = tessellationConfigOf("trihexagonal");
    // Wire cells are `[3q + kind, r]` with kind 0 hexagon, 1 up triangle, 2 down triangle.
    const hexagons = getFieldPreset(kagome, "rect", { cols: 3, rows: 3 }).filter(([x]) => x % 3 === 0);
    expect(hexagons).toHaveLength(9);
    expect(getFieldPreset(kagome, "triangle", { side: 4 }).length).toBeGreaterThan(0);
    // One hexagon pitch along x moves the hexagon at q = 0 to q = 1.
    expect(translateFieldCells(kagome, [[0, 0]], [2, 0])).toEqual([[3, 0]]);
    try {
      // Half a pitch lands on a triangle vertex, not on a lattice translation.
      translateFieldCells(kagome, [[0, 0]], [1, 0]);
      expect.unreachable();
    } catch (error) {
      expect(error).toEqual({ kind: "not_a_symmetry" });
    }
  });

  it("translates and reflects cells on symmetric vectors and axes", () => {
    expect(translateFieldCells(square, [[0, 0], [1, 0]], [2, 1])).toEqual([[2, 1], [3, 1]]);
    expect(reflectFieldCells(square, [[0, 0], [1, 0]], [[2, 0], [2, 1]])).toEqual([[2, 0], [3, 0]]);
  });
});
