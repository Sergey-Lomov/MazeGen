import { describe, expect, it } from "vitest";
import { normalizePrimitiveCells, primitiveCells, primitiveWorldGeometry } from "../pixi/primitiveGeometry";
import { configAllCells } from "../pixi/tessellationCells";
import { regularHexagonDimensions } from "../pixi/shapeSelection";
import { triCenterOffset, triHexagonRaw, triTriangleRaw } from "../pixi/triShapeHelpers";
import { fieldOf } from "./fieldConfigFixtures";

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

  it("removes isolated cells before and after smoothing", () => {
    const cells: [number, number][] = [[0, 0], [1, 0], [1, 1], [2, 0], [10, 10]];
    expect(normalizePrimitiveCells(cells, "square", false)).toEqual([[0, 0], [1, 0], [1, 1], [2, 0]]);
    expect(normalizePrimitiveCells(cells, "square", true)).toEqual([[1, 0]]);
  });

  it("preserves primitives smaller than the normalization threshold", () => {
    const cells: [number, number][] = [[0, 0]];
    expect(normalizePrimitiveCells(cells, "square", false)).toEqual(cells);
    expect(normalizePrimitiveCells(cells, "square", true)).toEqual(cells);

    const twoCellLine: [number, number][] = [[0, 0], [1, 0]];
    expect(normalizePrimitiveCells(twoCellLine, "square", true)).toEqual(twoCellLine);
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
      return raw.map(([x, y]) => [x - ox, y - oy]);
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

  it("keeps the hex parallelogram inside the shared frame", () => {
    const ctx = {
      ...gesture,
      kind: "hex" as const,
      config: fieldOf("hex", { shape: "hexagon", radius: 3 }, "flat_top"),
      endGrid: { x: 3, y: 2 },
      startWorld: { x: 0, y: 0 },
      endWorld: { x: 120, y: 80 },
    };
    const rectangle = primitiveWorldGeometry("rectangle", ctx);
    const parallelogram = primitiveWorldGeometry("parallelogram", ctx);
    if (rectangle.kind !== "polygon" || parallelogram.kind !== "polygon") throw new Error("expected polygon geometry");
    const bounds = (points: { x: number; y: number }[]) => ({
      width: Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x)),
      height: Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y)),
    });
    expect(bounds(parallelogram.points)).toEqual(bounds(rectangle.points));
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

  it("uses equal parallelogram sides for Ctrl instead of a square bounding frame", () => {
    const geometry = primitiveWorldGeometry("parallelogram", {
      ...gesture,
      kind: "hex",
      config: fieldOf("hex", { shape: "hexagon", radius: 3 }, "flat_top"),
      endGrid: { x: 4, y: 1 },
      startWorld: { x: 0, y: 0 },
      endWorld: { x: 160, y: 40 },
      constrainSquare: true,
    });
    if (geometry.kind !== "polygon") throw new Error("expected polygon geometry");
    const length = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y);
    expect(length(geometry.points[0], geometry.points[1])).toBeCloseTo(length(geometry.points[1], geometry.points[2]), 6);
  });

  it("keeps the parallelogram drag start on a frame vertex in every direction", () => {
    for (const endWorld of [{ x: 120, y: 80 }, { x: 120, y: -80 }, { x: -120, y: 80 }, { x: -120, y: -80 }]) {
      const geometry = primitiveWorldGeometry("parallelogram", {
        ...gesture,
        kind: "hex",
        config: fieldOf("hex", { shape: "hexagon", radius: 3 }, "flat_top"),
        startWorld: { x: 0, y: 0 },
        endWorld,
      });
      if (geometry.kind !== "polygon") throw new Error("expected polygon geometry");
      expect(geometry.points).toContainEqual({ x: 0, y: 0 });
    }
  });

  it("matches the primitive hexagon orientation to the hex tessellation", () => {
    const flat = primitiveWorldGeometry("hexagon", {
      ...gesture,
      kind: "hex",
      config: fieldOf("hex", { shape: "hexagon", radius: 3 }, "flat_top"),
      startWorld: { x: 0, y: 0 },
      endWorld: { x: 120, y: 80 },
    });
    const pointy = primitiveWorldGeometry("hexagon", {
      ...gesture,
      kind: "hex",
      config: fieldOf("hex", { shape: "hexagon", radius: 3 }, "pointy_top"),
      startWorld: { x: 0, y: 0 },
      endWorld: { x: 120, y: 80 },
    });
    if (flat.kind !== "polygon" || pointy.kind !== "polygon") throw new Error("expected polygon geometry");
    expect(flat.points).toContainEqual({ x: 0, y: 0 });
    expect(pointy.points.some((point) => Math.abs(point.x) < 1e-6 && Math.abs(point.y) < 1e-6)).toBe(true);
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

  it("matches a centered hexagon primitive to the standard hexagon frame", () => {
    const config = fieldOf("hex", { shape: "hexagon", radius: 0 }, "flat_top");
    const radius = 7;
    const frameSide = radius * 4;
    const dragDistance = (frameSide - 1) * 40 / 2;
    const standard = configAllCells(fieldOf("hex", { shape: "hexagon", radius }, "flat_top"));
    const manual = primitiveCells("hexagon", {
      ...gesture,
      kind: "hex",
      config,
      startWorld: { x: 0, y: 0 },
      endWorld: { x: dragDistance, y: dragDistance },
      symmetric: true,
      constrainSquare: true,
    });
    expect(manual).toEqual(standard);
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

  it("matches a centered hexagon primitive on the triangle grid", () => {
    const config = fieldOf("tri", { shape: "rect", cols: 0, rows: 0 }, "r0");
    const radius = 7;
    const frameSide = radius * 4;
    const dragDistance = (frameSide - 1) * 40 / 2;
    const standard = configAllCells(fieldOf("tri", { shape: "hexagon", radius }, "r0"));
    const manual = primitiveCells("hexagon", {
      ...gesture,
      kind: "tri",
      config,
      startWorld: { x: 0, y: 0 },
      endWorld: { x: dragDistance, y: dragDistance },
      symmetric: true,
      constrainSquare: true,
    });
    expect(manual).toEqual(standard);
    expect(standard).toHaveLength(6 * radius * radius);
    const raw = triHexagonRaw(radius);
    const { ox, oy } = triCenterOffset(raw);
    expect(standard).toEqual(raw.map(([x, y]) => [x - ox, y - oy]));
  });

  it("supports the same primitive set on every tessellation", () => {
    for (const kind of ["square", "hex", "tri"] as const) {
      for (const primitive of ["rectangle", "circle", "triangle", "hexagon", "parallelogram"] as const) {
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
        for (const primitive of ["rectangle", "circle", "triangle", "hexagon", "parallelogram"] as const) {
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
