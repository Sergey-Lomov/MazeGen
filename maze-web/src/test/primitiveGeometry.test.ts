import { describe, expect, it } from "vitest";
import { normalizeCells, primitiveCells, primitiveWorldGeometry, snapEquilateralAngle } from "../pixi/primitiveGeometry";
import { configAllCells } from "../pixi/tessellationCells";
import { regularHexagonDimensions } from "../pixi/shapeSelection";
import { triCenterOffset, triTriangleRaw } from "../pixi/triShapeHelpers";
import { fieldOf } from "./fieldConfigFixtures";

/** Core returns preset cells sorted by cell id (x, then y). */
const SQUARE_CFG = fieldOf("square", { shape: "rect", cols: 4, rows: 4 });

function sortedCells(cells: number[][]): number[][] {
  return [...cells].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

describe("field shape primitives", () => {
  const gesture = {
    startGrid: { x: 0, y: 0 },
    endGrid: { x: 3, y: 2 },
    gridRadius: 2,
    kind: "square" as const,
  };

  it("draws a square circle as a disk", () => {
    const cells = primitiveCells("circle", { ...gesture, endGrid: { x: 2, y: 2 }, symmetric: true });
    expect(cells.length).toBeGreaterThan(1);
    expect(cells).toContainEqual([0, 0]);
    expect(cells).not.toContainEqual([3, 3]);
  });

  it("draws hex rectangle and circle primitives", () => {
    const config = fieldOf("hex", { shape: "hexagon", radius: 3 }, "flat_top");
    expect(primitiveCells("rectangle", { ...gesture, kind: "hex", config }).length).toBeGreaterThan(0);
    expect(primitiveCells("circle", { ...gesture, kind: "hex", config }).length).toBeGreaterThan(0);
  });

  it("uses provided world drag positions instead of the snapped hex endpoint", () => {
    const config = fieldOf("hex", { shape: "hexagon", radius: 3 }, "flat_top");
    const snapped = primitiveCells("rectangle", {
      ...gesture,
      kind: "hex",
      config,
      endGrid: { x: 0, y: 0 },
      startWorld: { x: 0, y: 0 },
      endWorld: { x: 0, y: 0 },
    });
    const subCellDrag = primitiveCells("rectangle", {
      ...gesture,
      kind: "hex",
      config,
      endGrid: { x: 0, y: 0 },
      startWorld: { x: 0, y: 0 },
      endWorld: { x: 80, y: 80 },
    });
    expect(subCellDrag).not.toEqual(snapped);
  });

  it("draws a triangular circle around the gesture origin", () => {
    const cells = primitiveCells("circle", { ...gesture, kind: "tri", symmetric: true });
    expect(cells.length).toBeGreaterThan(1);
    expect(cells).toContainEqual([0, 0]);
  });

  describe("normalizeCells", () => {
    it("peels spikes repeatedly until every cell has two links", () => {
      const block: [number, number][] = [[0, 0], [1, 0], [0, 1], [1, 1]];
      const cells: [number, number][] = [...block, [2, 0], [3, 0]];
      expect(normalizeCells(cells, SQUARE_CFG, true)).toEqual(block);
      expect(normalizeCells(cells, SQUARE_CFG, false)).toEqual(cells);
    });

    it("removes a lone isolated cell", () => {
      expect(normalizeCells([[0, 0]], SQUARE_CFG, false)).toEqual([]);
      expect(normalizeCells([[0, 0]], SQUARE_CFG, true)).toEqual([]);
    });

    it("counts anchors as neighbors without returning them", () => {
      const anchors = new Set(["1,0", "2,0"]);
      const isAnchor = (x: number, y: number) => anchors.has(`${x},${y}`);
      expect(normalizeCells([[0, 0]], SQUARE_CFG, false, isAnchor)).toEqual([[0, 0]]);
      expect(normalizeCells([[0, 0]], SQUARE_CFG, true, isAnchor)).toEqual([[0, 0]]);
      expect(normalizeCells([[5, 5]], SQUARE_CFG, false, isAnchor)).toEqual([]);
    });
  });

  it("smooths terminal cells in predefined fields", () => {
    const config = fieldOf("square", { shape: "circle", radius: 5 });
    expect(configAllCells(config)).toContainEqual([5, 0]);
    expect(configAllCells(config, true)).not.toContainEqual([5, 0]);
  });

  it("keeps predefined circle and rectangle shapes geometrically distinct", () => {
    const squareCircle = configAllCells(fieldOf("square", { shape: "circle", radius: 5 }));
    const hexCircle = configAllCells(fieldOf("hex", { shape: "circle", radius: 1 }));
    const hexagon = configAllCells(fieldOf("hex", { shape: "hexagon", radius: 2 }));
    const hexRectangle = configAllCells(fieldOf("hex", { shape: "rect", cols: 4, rows: 4 }));
    const parallelogram = configAllCells(fieldOf("hex", { shape: "parallelogram", cols: 4, rows: 4 }));

    expect(squareCircle).toContainEqual([5, 0]);
    expect(hexCircle).not.toEqual(hexagon);
    expect(hexRectangle).not.toEqual(parallelogram);
  });

  it("builds triangular rectangles from complete opposite-orientation layers", () => {
    const cells = configAllCells(fieldOf("tri", { shape: "rect", cols: 2, rows: 3 }, "r0"));
    expect(cells).toHaveLength(2 * 2 * 3);
    expect(new Set(cells.map(([x]) => x))).toEqual(new Set([-2, -1, 0, 1]));
    expect(new Set(cells.map(([, y]) => y))).toEqual(new Set([-1, 0, 1]));
  });

  it("uses every integer side as the next complete triangular lattice state", () => {
    const centered = (side: number) => {
      const raw = triTriangleRaw(side);
      const { ox, oy } = triCenterOffset(raw);
      return sortedCells(raw.map(([x, y]) => [x - ox, y - oy]));
    };
    for (let side = 1; side <= 6; side++) {
      const cells = configAllCells(fieldOf("tri", { shape: "triangle", side }, "r0"));
      expect(cells).toEqual(centered(side));
      expect(cells).toHaveLength(side * side);
    }
  });

  it("provides an equilateral triangle primitive aligned to triangle tessellation orientation", () => {
    const r0 = primitiveCells("equilateral_triangle", {
      ...gesture,
      kind: "tri",
      config: fieldOf("tri", { shape: "rect", cols: 4, rows: 4 }, "r0"),
      symmetric: true,
    });
    const r90 = primitiveCells("equilateral_triangle", {
      ...gesture,
      kind: "tri",
      config: fieldOf("tri", { shape: "rect", cols: 4, rows: 4 }, "r90"),
      symmetric: true,
    });
    expect(r0.length).toBeGreaterThan(0);
    expect(r90.length).toBeGreaterThan(0);
    expect(r90).toContainEqual([0, 0]);
  });

  it("uses the drag start as the equilateral triangle base center and the pointer as its apex", () => {
    const geometry = primitiveWorldGeometry("equilateral_triangle", {
      ...gesture,
      kind: "square",
      config: fieldOf("square", { shape: "rect", cols: 3, rows: 3 }),
      startWorld: { x: 100, y: 200 },
      endWorld: { x: 160, y: 200 },
    });
    if (geometry.kind !== "polygon") throw new Error("expected polygon geometry");
    expect(geometry.points).toContainEqual({ x: 160, y: 200 });
    const baseCenter = {
      x: (geometry.points[0].x + geometry.points[1].x) / 2,
      y: (geometry.points[0].y + geometry.points[1].y) / 2,
    };
    expect(baseCenter).toEqual({ x: 100, y: 200 });
  });

  it("snaps equilateral triangles to six edge-normal directions on a triangular grid", () => {
    const config = fieldOf("tri", { shape: "rect", cols: 3, rows: 3 }, "r0");
    const start = { x: 100, y: 100 };
    const distance = 60;
    const probes = [
      { input: -Math.PI / 2 + 0.08, expected: -Math.PI / 2 },
      { input: -Math.PI / 6 - 0.08, expected: -Math.PI / 6 },
      { input: Math.PI / 6 + 0.08, expected: Math.PI / 6 },
      { input: Math.PI / 2 - 0.08, expected: Math.PI / 2 },
      { input: 5 * Math.PI / 6 + 0.08, expected: 5 * Math.PI / 6 },
      { input: 7 * Math.PI / 6 - 0.08, expected: 7 * Math.PI / 6 },
    ];

    for (const { input, expected } of probes) {
      const geometry = primitiveWorldGeometry("equilateral_triangle", {
        ...gesture,
        kind: "tri",
        config,
        startWorld: start,
        endWorld: {
          x: start.x + distance * Math.cos(input),
          y: start.y + distance * Math.sin(input),
        },
      });
      if (geometry.kind !== "polygon") throw new Error("expected polygon geometry");
      const expectedApex = {
        x: start.x + distance * Math.cos(expected),
        y: start.y + distance * Math.sin(expected),
      };
      expect(geometry.points.some((point) =>
        Math.abs(point.x - expectedApex.x) < 1e-6 && Math.abs(point.y - expectedApex.y) < 1e-6,
      )).toBe(true);
    }
  });

  it("keeps the equilateral triangle anchored to the drag start", () => {
    for (const kind of ["square", "hex", "tri"] as const) {
      const config = kind === "hex"
        ? fieldOf("hex", { shape: "hexagon", radius: 3 }, "flat_top")
        : kind === "tri"
          ? fieldOf("tri", { shape: "rect", cols: 3, rows: 3 }, "r0")
          : fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
      const cells = primitiveCells("equilateral_triangle", {
        ...gesture,
        kind,
        config,
        endGrid: { x: 4, y: 2 },
      });
      expect(cells, kind).toContainEqual([0, 0]);
    }
  });

  it("uses independent axial dimensions for the standard hex parallelogram", () => {
    const cells = configAllCells(fieldOf("hex", { shape: "parallelogram", cols: 3, rows: 2 }, "flat_top"));
    expect(cells).toHaveLength(6);
    expect(new Set(cells.map(([x]) => x))).toEqual(new Set([-1, 0, 1]));
    expect(new Set(cells.map(([, y]) => y))).toEqual(new Set([-1, 0]));
  });

  it("uses exact independent dimensions for the standard hex rectangle", () => {
    for (const orientation of ["flat_top", "pointy_top"] as const) {
      const small = configAllCells(fieldOf("hex", { shape: "rect", cols: 4, rows: 3 }, orientation));
      const wider = configAllCells(fieldOf("hex", { shape: "rect", cols: 5, rows: 3 }, orientation));
      const taller = configAllCells(fieldOf("hex", { shape: "rect", cols: 4, rows: 4 }, orientation));
      expect(small).toHaveLength(12);
      expect(wider).toHaveLength(15);
      expect(taller).toHaveLength(16);
      expect(wider).not.toEqual(small);
      expect(taller).not.toEqual(small);
    }
  });

  // The parallelogram tool is click-based; see parallelogramGeometry.test.ts.

  it("centers the hexagon on the drag start at any angle with shift", () => {
    const config = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
    for (const angle of [0.1, 0.7, 1.3, 2.9, -2]) {
      const hexagon = primitiveWorldGeometry("hexagon", {
        ...gesture,
        kind: "square",
        config,
        startWorld: { x: 10, y: 20 },
        endWorld: { x: 10 + 200 * Math.cos(angle), y: 20 + 200 * Math.sin(angle) },
        symmetric: true,
      });
      if (hexagon.kind !== "polygon") throw new Error("expected polygon geometry");
      expect(hexagon.points).toHaveLength(6);
      const cx = hexagon.points.reduce((sum, p) => sum + p.x, 0) / 6;
      const cy = hexagon.points.reduce((sum, p) => sum + p.y, 0) / 6;
      expect(cx).toBeCloseTo(10, 6);
      expect(cy).toBeCloseTo(20, 6);
      for (const p of hexagon.points) expect(Math.hypot(p.x - 10, p.y - 20)).toBeCloseTo(200, 6);
    }
  });

  it("grows the hexagon to one side of the drag start without shift", () => {
    const config = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
    const g = primitiveWorldGeometry("hexagon", { ...gesture, kind: "square", config, startWorld: { x: 0, y: 0 }, endWorld: { x: 0, y: 200 } });
    if (g.kind !== "polygon") throw new Error("expected polygon geometry");
    expect(g.points.some((p) => Math.abs(p.x) < 1e-6 && Math.abs(p.y) < 1e-6)).toBe(true);
    expect(g.points.some((p) => Math.abs(p.x) < 1e-6 && Math.abs(p.y - 200) < 1e-6)).toBe(true);
  });

  it("rotates the hexagon with the drag direction", () => {
    const config = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
    const at = (endWorld: { x: number; y: number }) => {
      const g = primitiveWorldGeometry("hexagon", { ...gesture, kind: "square", config, startWorld: { x: 0, y: 0 }, endWorld });
      if (g.kind !== "polygon") throw new Error("expected polygon geometry");
      return g.points;
    };
    expect(at({ x: 200, y: 0 })).toContainEqual({ x: 200, y: 0 });
    const turned = at({ x: 0, y: 200 });
    expect(turned.some((p) => Math.abs(p.x) < 1e-6 && Math.abs(p.y - 200) < 1e-6)).toBe(true);
  });

  it("centers the equilateral triangle centroid on the drag start with shift", () => {
    const config = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
    for (const angle of [0.3, 1.1, 2.5]) {
      const triangle = primitiveWorldGeometry("equilateral_triangle", {
        ...gesture,
        kind: "square",
        config,
        startWorld: { x: 5, y: -7 },
        endWorld: { x: 5 + 150 * Math.cos(angle), y: -7 + 150 * Math.sin(angle) },
        symmetric: true,
      });
      if (triangle.kind !== "polygon") throw new Error("expected polygon geometry");
      const cx = triangle.points.reduce((sum, p) => sum + p.x, 0) / 3;
      const cy = triangle.points.reduce((sum, p) => sum + p.y, 0) / 3;
      expect(cx).toBeCloseTo(5, 6);
      expect(cy).toBeCloseTo(-7, 6);
    }
  });

  it("snaps the hexagon and triangle direction to the lattice near a snap angle", () => {
    const configs = [
      { kind: "hex" as const, config: fieldOf("hex", { shape: "hexagon", radius: 3 }, "flat_top") },
      { kind: "tri" as const, config: fieldOf("tri", { shape: "rect", cols: 3, rows: 3 }, "r0") },
    ];
    for (const { kind, config } of configs) {
      let snapped = NaN;
      for (let a = 0; a < Math.PI / 3 && Number.isNaN(snapped); a += 0.001) {
        const candidate = snapEquilateralAngle(a, config);
        if (candidate !== a) snapped = candidate;
      }
      expect(Number.isNaN(snapped)).toBe(false);
      const nearby = snapped + 0.03;
      expect(snapEquilateralAngle(nearby, config)).toBeCloseTo(snapped, 9);
      const hexagon = primitiveWorldGeometry("hexagon", {
        ...gesture,
        kind,
        config,
        startWorld: { x: 0, y: 0 },
        endWorld: { x: 300 * Math.cos(nearby), y: 300 * Math.sin(nearby) },
      });
      if (hexagon.kind !== "polygon") throw new Error("expected polygon geometry");
      const far = hexagon.points.reduce((best, p) => (Math.hypot(p.x, p.y) > Math.hypot(best.x, best.y) ? p : best));
      expect(Math.atan2(far.y, far.x)).toBeCloseTo(Math.atan2(Math.sin(snapped), Math.cos(snapped)), 6);
    }
  });

  it("ignores control for the hexagon and equilateral triangle", () => {
    const config = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
    for (const primitive of ["hexagon", "equilateral_triangle"] as const) {
      const base = { ...gesture, kind: "square" as const, config, startWorld: { x: 0, y: 0 }, endWorld: { x: 180, y: 90 } };
      expect(primitiveWorldGeometry(primitive, { ...base, constrainSquare: true })).toEqual(primitiveWorldGeometry(primitive, base));
    }
  });

  it("selects the start cell and a symmetric set around it for a shifted hexagon", () => {
    const config = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
    const cells = primitiveCells("hexagon", {
      ...gesture,
      kind: "square",
      config,
      startGrid: { x: 0, y: 0 },
      endGrid: { x: 0, y: 3 },
      symmetric: true,
    });
    const keys = new Set(cells.map(([x, y]) => `${x},${y}`));
    expect(keys.has("0,0")).toBe(true);
    for (const [x, y] of cells) expect(keys.has(`${-x},${-y}`)).toBe(true);
  });

  it("selects cells on the pointer side for an unshifted hexagon on every tessellation", () => {
    const configs = [
      { kind: "square" as const, config: fieldOf("square", { shape: "rect", cols: 3, rows: 3 }) },
      { kind: "hex" as const, config: fieldOf("hex", { shape: "hexagon", radius: 3 }, "flat_top") },
      { kind: "tri" as const, config: fieldOf("tri", { shape: "rect", cols: 3, rows: 3 }, "r0") },
    ];
    for (const { kind, config } of configs) {
      const centered = primitiveCells("hexagon", { ...gesture, kind, config, startWorld: { x: 0, y: 0 }, endWorld: { x: 0, y: 320 }, symmetric: true });
      const grown = primitiveCells("hexagon", { ...gesture, kind, config, startWorld: { x: 0, y: 0 }, endWorld: { x: 0, y: 320 } });
      expect(grown.length).toBeGreaterThan(0);
      expect(grown.length).toBeLessThan(centered.length);
    }
  });

  it("builds a regular standard hexagon in both grid orientations", () => {
    const flat = configAllCells(fieldOf("hex", { shape: "hexagon", radius: 10 }, "flat_top"));
    const pointy = configAllCells(fieldOf("hex", { shape: "hexagon", radius: 10 }, "pointy_top"));
    expect(pointy.length).toBe(flat.length);
    expect(flat.length).toBeGreaterThan(0);
    expect(flat).toContainEqual([0, 0]);
    expect(pointy).toContainEqual([0, 0]);
    const flatSize = regularHexagonDimensions(10, "flat_top");
    const pointySize = regularHexagonDimensions(10, "pointy_top");
    expect(flatSize.width / flatSize.height).toBeCloseTo(2 / Math.sqrt(3), 6);
    expect(pointySize.width / pointySize.height).toBeCloseTo(Math.sqrt(3) / 2, 6);
  });

  it("keeps centered hexagon primitives on a non-origin drag start", () => {
    const startGrid = { x: 5, y: -3 };
    const cells = primitiveCells("hexagon", {
      ...gesture,
      kind: "hex",
      config: fieldOf("hex", { shape: "hexagon", radius: 0 }, "flat_top"),
      startGrid,
      endGrid: { x: 7, y: -1 },
      symmetric: true,
      constrainSquare: true,
    });
    expect(cells).toContainEqual([startGrid.x, startGrid.y]);
    expect(cells).not.toContainEqual([0, 0]);
  });

  it("supports the same primitive set on every tessellation", () => {
    for (const kind of ["square", "hex", "tri"] as const) {
      for (const primitive of ["rectangle", "circle", "triangle", "hexagon"] as const) {
        const cells = primitiveCells(primitive, { ...gesture, kind, config: kind === "hex"
          ? fieldOf("hex", { shape: "hexagon", radius: 3 }, "flat_top")
          : kind === "tri"
            ? fieldOf("tri", { shape: "rect", cols: 3, rows: 3 }, "r0")
            : fieldOf("square", { shape: "rect", cols: 3, rows: 3 }) });
        expect(cells.length, `${kind}/${primitive}`).toBeGreaterThan(0);
      }
    }
  });

  it("uses the drag box normally and keeps the start as the center with Shift", () => {
    const normal = primitiveCells("circle", { ...gesture, endGrid: { x: 4, y: 1 }, kind: "square", symmetric: false });
    const symmetric = primitiveCells("circle", { ...gesture, endGrid: { x: 4, y: 1 }, kind: "square", symmetric: true });
    expect(normal).not.toEqual(symmetric);
    expect(symmetric).toContainEqual([-1, 0]);
    expect(symmetric).toContainEqual([1, 0]);
  });

  it("uses the drag diagonal for a normal triangle and a symmetric rectangle for Shift", () => {
    const normalRectangle = primitiveCells("rectangle", { ...gesture, endGrid: { x: 3, y: 1 }, kind: "square" });
    const normalTriangle = primitiveCells("triangle", { ...gesture, endGrid: { x: 3, y: 1 }, kind: "square" });
    const symmetricRectangle = primitiveCells("rectangle", { ...gesture, endGrid: { x: 3, y: 1 }, kind: "square", symmetric: true });
    expect(normalTriangle.length).toBeLessThan(normalRectangle.length);
    const xs = symmetricRectangle.map(([x]) => x);
    const ys = symmetricRectangle.map(([, y]) => y);
    expect(Math.max(...xs) - Math.min(...xs)).toBe(6);
    expect(Math.max(...ys) - Math.min(...ys)).toBe(2);
  });

  it("uses the same normalized frame for a symmetric triangle as for a rectangle", () => {
    const normal = primitiveCells("triangle", { ...gesture, endGrid: { x: 3, y: 1 }, kind: "square" });
    const symmetric = primitiveCells("triangle", {
      ...gesture,
      endGrid: { x: 3, y: 1 },
      kind: "square",
      symmetric: true,
    });
    expect(symmetric.length).toBeGreaterThan(normal.length);
    expect(symmetric).toContainEqual([0, 0]);
  });

  it("orients the triangle from the drag direction", () => {
    const downRight = primitiveCells("triangle", { ...gesture, endGrid: { x: 3, y: 2 }, kind: "square" });
    const upLeft = primitiveCells("triangle", { ...gesture, startGrid: { x: 3, y: 2 }, endGrid: { x: 0, y: 0 }, kind: "square" });
    expect(downRight).toContainEqual([0, 0]);
    expect(downRight).not.toContainEqual([3, 2]);
    expect(upLeft).not.toEqual(downRight);
  });

  it("uses a square frame when Ctrl constrains proportions", () => {
    const constrained = primitiveCells("rectangle", { ...gesture, endGrid: { x: 3, y: 1 }, kind: "square", constrainSquare: true });
    const xs = constrained.map(([x]) => x);
    const ys = constrained.map(([, y]) => y);
    expect(Math.max(...xs) - Math.min(...xs)).toBe(Math.max(...ys) - Math.min(...ys));
    expect(Math.max(...xs) - Math.min(...xs)).toBe(1);
  });

  it("keeps a Ctrl-constrained triangle anchored to the drag start", () => {
    const cells = primitiveCells("triangle", { ...gesture, endGrid: { x: 3, y: 1 }, kind: "square", constrainSquare: true });
    expect(Math.min(...cells.map(([x]) => x))).toBeGreaterThanOrEqual(0);
    expect(Math.max(...cells.map(([x]) => x))).toBeLessThanOrEqual(1);
    expect(Math.min(...cells.map(([, y]) => y))).toBeGreaterThanOrEqual(0);
    expect(Math.max(...cells.map(([, y]) => y))).toBeLessThanOrEqual(1);
  });

  it("keeps the triangle start cell inside the shape on a hex grid", () => {
    const cells = primitiveCells("triangle", {
      ...gesture,
      kind: "hex",
      config: fieldOf("hex", { shape: "hexagon", radius: 3 }, "flat_top"),
      endGrid: { x: 3, y: 2 },
    });
    expect(cells).toContainEqual([0, 0]);
  });

  it("keeps the start cell inside every world-space primitive mode", () => {
    for (const kind of ["square", "hex", "tri"] as const) {
      const config = kind === "hex"
        ? fieldOf("hex", { shape: "hexagon", radius: 3 }, "flat_top")
        : kind === "tri"
          ? fieldOf("tri", { shape: "rect", cols: 3, rows: 3 }, "r0")
          : fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
      for (const symmetric of [false, true]) for (const constrainSquare of [false, true]) {
        for (const primitive of ["rectangle", "circle", "triangle", "hexagon"] as const) {
          const cells = primitiveCells(primitive, {
            ...gesture,
            kind,
            config,
            symmetric,
            constrainSquare,
          });
          expect(cells.length, `${kind}/${primitive}/${symmetric}/${constrainSquare}`).toBeGreaterThan(0);
          if (primitive === "triangle") expect(cells, `${kind}/${primitive}/${symmetric}/${constrainSquare}`).toContainEqual([0, 0]);
        }
      }
    }
  });

  it("keeps triangles non-degenerate when one or both drag coordinates match", () => {
    for (const kind of ["square", "hex", "tri"] as const) {
      const config = kind === "hex"
        ? fieldOf("hex", { shape: "hexagon", radius: 3 }, "flat_top")
        : kind === "tri"
          ? fieldOf("tri", { shape: "rect", cols: 3, rows: 3 }, "r0")
          : fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
      for (const endGrid of [{ x: 0, y: 2 }, { x: 2, y: 0 }, { x: 0, y: 0 }]) {
        const cells = primitiveCells("triangle", { ...gesture, kind, config, endGrid });
        expect(cells.length, `${kind}/${endGrid.x},${endGrid.y}`).toBeGreaterThan(0);
        expect(cells).toContainEqual([0, 0]);
        if (endGrid.x === 0 && endGrid.y === 0) expect(cells).toEqual([[0, 0]]);
      }
    }
  });
});
