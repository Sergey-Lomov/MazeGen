import { describe, expect, it } from "vitest";
import {
  getFieldCapabilities,
  getFieldPreset,
  reflectFieldCells,
  translateFieldCells,
} from "../wasm/mazeService";
import { tessellationConfigOf } from "../fieldConfig";
import { fieldOperationAvailable } from "../pixi/fieldOps";
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

  it("publishes the radial circle radius limit from the tessellation params", () => {
    const radius = (params: Record<string, number | string>) =>
      getFieldCapabilities({ ...tessellationConfigOf("radial"), params }).presets[0].params[0].max;
    const classic = radius({ first_ring_cells: 9, ring_layout: "classic", max_cells: 3000 });
    expect(classic).toBeGreaterThan(19);
    expect(radius({ first_ring_cells: 24, ring_layout: "smooth", max_cells: 3000 })).toBeLessThan(classic!);
    expect(radius({ first_ring_cells: 9, ring_layout: "classic", max_cells: 500 })).toBeLessThan(classic!);
    expect(getFieldCapabilities(square).presets[0].params[0].max).toBeUndefined();
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

  it("builds snub hexagonal presets, translates by lattice vectors and has no reflection", () => {
    const snub = tessellationConfigOf("snub_hexagonal");
    // Wire cells are `[9q + kind, r]` with kind 0 hexagon, 1..6 edge triangles, 7 and 8 inner triangles.
    const hexagons = getFieldPreset(snub, "rect", { cols: 3, rows: 3 }).filter(([x]) => x % 9 === 0);
    expect(hexagons.length).toBeGreaterThan(0);
    expect(getFieldPreset(snub, "triangle", { side: 4 }).length).toBeGreaterThan(0);
    // The lattice vector (5/2, sqrt(3)/2) moves the hexagon at q = 0 to q = 1.
    expect(translateFieldCells(snub, [[0, 0]], [2.5, Math.sqrt(3) / 2])).toEqual([[9, 0]]);
    try {
      translateFieldCells(snub, [[0, 0]], [1, 0]);
      expect.unreachable();
    } catch (error) {
      expect(error).toEqual({ kind: "not_a_symmetry" });
    }
    // The tiling is chiral: reflection is not offered at all.
    expect(fieldOperationAvailable(snub, "reflect")).toBe(false);
    try {
      reflectFieldCells(snub, [[0, 0]], [[0, 0], [1, 0]]);
      expect.unreachable();
    } catch (error) {
      expect(error).toEqual({ kind: "unavailable" });
    }
  });

  it("builds rhombitrihexagonal presets and translates and reflects on its symmetries", () => {
    const rhombi = tessellationConfigOf("rhombitrihexagonal");
    // Wire cells are `[6q + kind, r]` with kind 0 hexagon, 1..3 squares, 4 and 5 triangles.
    const preset = getFieldPreset(rhombi, "rect", { cols: 3, rows: 3 });
    for (const kind of [0, 1, 4]) {
      expect(preset.some(([x]) => ((x % 6) + 6) % 6 === kind)).toBe(true);
    }
    expect(getFieldPreset(rhombi, "triangle", { side: 4 }).length).toBeGreaterThan(0);
    // The lattice vector (1 + sqrt(3)) * (cos 30deg, sin 30deg) moves the hexagon at q = 0 to q = 1.
    expect(translateFieldCells(rhombi, [[0, 0]], [(3 + Math.sqrt(3)) / 2, (1 + Math.sqrt(3)) / 2])).toEqual([[6, 0]]);
    try {
      translateFieldCells(rhombi, [[0, 0]], [1, 0]);
      expect.unreachable();
    } catch (error) {
      expect(error).toEqual({ kind: "not_a_symmetry" });
    }
    // The vertical axis through the origin hexagon maps the square at 30 degrees onto the one at 150 degrees.
    expect(fieldOperationAvailable(rhombi, "reflect")).toBe(true);
    expect(reflectFieldCells(rhombi, [[1, 0]], [[0, 0], [0, 1]])).toEqual([[3, 0]]);
  });

  it("builds truncated hexagonal presets and translates and reflects on its symmetries", () => {
    const truncated = tessellationConfigOf("truncated_hexagonal");
    // Wire cells are `[3q + kind, r]` with kind 0 dodecagon, 1 and 2 triangles.
    const preset = getFieldPreset(truncated, "rect", { cols: 5, rows: 4 });
    for (const kind of [0, 1, 2]) {
      expect(preset.some(([x]) => ((x % 3) + 3) % 3 === kind)).toBe(true);
    }
    expect(getFieldPreset(truncated, "triangle", { side: 6 }).length).toBeGreaterThan(0);
    // The lattice vector (2 + sqrt(3)) * (1, 0) moves the dodecagon at q = 0 to q = 1.
    expect(translateFieldCells(truncated, [[0, 0]], [2 + Math.sqrt(3), 0])).toEqual([[3, 0]]);
    try {
      translateFieldCells(truncated, [[0, 0]], [1, 0]);
      expect.unreachable();
    } catch (error) {
      expect(error).toEqual({ kind: "not_a_symmetry" });
    }
    expect(fieldOperationAvailable(truncated, "reflect")).toBe(true);
  });

  it("builds truncated trihexagonal presets and translates and reflects on its symmetries", () => {
    const truncated = tessellationConfigOf("truncated_trihexagonal");
    // Wire cells are `[6q + kind, r]` with kind 0 dodecagon, 1-3 squares and 4-5 hexagons.
    const preset = getFieldPreset(truncated, "rect", { cols: 5, rows: 4 });
    for (const kind of [0, 1, 2, 3, 4, 5]) {
      expect(preset.some(([x]) => ((x % 6) + 6) % 6 === kind)).toBe(true);
    }
    expect(getFieldPreset(truncated, "triangle", { side: 6 }).length).toBeGreaterThan(0);
    // The lattice vector (3 + sqrt(3)) * (1, 0) moves the dodecagon at q = 0 to q = 1.
    expect(translateFieldCells(truncated, [[0, 0]], [3 + Math.sqrt(3), 0])).toEqual([[6, 0]]);
    try {
      translateFieldCells(truncated, [[0, 0]], [1, 0]);
      expect.unreachable();
    } catch (error) {
      expect(error).toEqual({ kind: "not_a_symmetry" });
    }
    expect(fieldOperationAvailable(truncated, "reflect")).toBe(true);
  });

  it("builds elongated triangular presets and translates and reflects on its symmetries", () => {
    const elongated = tessellationConfigOf("elongated_triangular");
    // Wire cells are `[3x + kind, y]` with kind 0 square, 1 and 2 triangles.
    const preset = getFieldPreset(elongated, "rect", { cols: 5, rows: 4 });
    for (const kind of [0, 1, 2]) {
      expect(preset.some(([x]) => ((x % 3) + 3) % 3 === kind)).toBe(true);
    }
    expect(getFieldPreset(elongated, "triangle", { side: 6 }).length).toBeGreaterThan(0);
    // One square right keeps the band, one band up (half a square right) keeps the column.
    expect(translateFieldCells(elongated, [[0, 0]], [1, 0])).toEqual([[3, 0]]);
    expect(translateFieldCells(elongated, [[0, 0]], [0.5, 1 + Math.sqrt(3) / 2])).toEqual([[0, 1]]);
    try {
      translateFieldCells(elongated, [[0, 0]], [0.5, 0]);
      expect.unreachable();
    } catch (error) {
      expect(error).toEqual({ kind: "not_a_symmetry" });
    }
    expect(fieldOperationAvailable(elongated, "reflect")).toBe(true);
  });

  it("builds snub square presets and translates only on lattice vectors", () => {
    const snub = tessellationConfigOf("snub_square");
    // Wire cells are `[6q + kind, r]` with kind 0 and 1 squares, 2-5 triangles.
    const preset = getFieldPreset(snub, "rect", { cols: 5, rows: 4 });
    for (const kind of [0, 1, 2, 3, 4, 5]) {
      expect(preset.some(([x]) => ((x % 6) + 6) % 6 === kind)).toBe(true);
    }
    expect(getFieldPreset(snub, "triangle", { side: 6 }).length).toBeGreaterThan(0);
    // The lattice vector ((2 + sqrt(3)) / 2, -1/2) moves the anchor at q = 0 to q = 1.
    expect(translateFieldCells(snub, [[0, 0]], [(2 + Math.sqrt(3)) / 2, -0.5])).toEqual([[6, 0]]);
    try {
      translateFieldCells(snub, [[0, 0]], [1, 0]);
      expect.unreachable();
    } catch (error) {
      expect(error).toEqual({ kind: "not_a_symmetry" });
    }
    // The tiling is chiral: no mirror symmetry.
    expect(fieldOperationAvailable(snub, "reflect")).toBe(false);
  });

  it("builds curved quadrilateral presets and translates only on parity-preserving vectors", () => {
    const curved = tessellationConfigOf("curved_quadrilateral");
    expect(getFieldPreset(curved, "rect", { cols: 3, rows: 3 })).toHaveLength(9);
    expect(getFieldPreset(curved, "triangle", { side: 4 }).length).toBeGreaterThan(0);
    expect(translateFieldCells(curved, [[0, 0]], [1, 1])).toEqual([[1, 1]]);
    try {
      translateFieldCells(curved, [[0, 0]], [1, 0]);
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
