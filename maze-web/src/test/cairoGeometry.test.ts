import { describe, expect, it, vi } from "vitest";
import { TILE_SIZE } from "../pixi/constants";
import { CAIRO_VERTEX_SCALE, cairoCenter, cairoTileKind, isCairoPoint } from "../pixi/cairoGeometry";
import { getCellVertices, getNeighborData, getSharedEdgeSegment, exactCellBounds, getTileDiagram, splitFaceIndexToCore, splitFaceIndexToWeb } from "../pixi/tessellationGeometry";
import { configAllCells } from "../pixi/tessellationCells";
import { makeProjection } from "../pixi/tessellationProjection";
import { cellsInsideShape, type ShapeDefinition } from "../pixi/shapeSelection";
import { pickEdgeAtPosition } from "../pixi/edgeHitTesting";
import { selectionBoundarySegments } from "../pixi/fieldSelectionGeometry";

vi.mock("../pixi/cartesianCache", () => ({
  getCartesian: (x: number, y: number): [number, number] => [x, y],
}));

const cfg = { type: "cairo", cols: 3, rows: 3 } as const;

function expectSameSegment(a: { x: number; y: number }, b: { x: number; y: number }): void {
  expect(a.x).toBeCloseTo(b.x);
  expect(a.y).toBeCloseTo(b.y);
}

describe("Cairo coordinate classes", () => {
  it("matches core's Euclidean negative-coordinate classification", () => {
    expect(cairoTileKind(-3, 2)).toBe("L");
    expect(cairoTileKind(-1, 2)).toBe("R");
    expect(cairoTileKind(-6, -5)).toBe("U");
    expect(cairoTileKind(-6, -7)).toBe("D");
    expect(cairoTileKind(0, 0)).toBeNull();
    expect(isCairoPoint(-2, -1)).toBe(true);
  });
});

describe("Cairo geometry", () => {
  it("uses a valid five-face tile for split diagrams", () => {
    expect(getTileDiagram(2, 1, cfg)?.sides).toHaveLength(5);
    expect(getNeighborData(cfg, 2, 1).offsets).toHaveLength(5);
  });

  it("keeps Cairo split-pattern face indices aligned with core", () => {
    for (let face = 0; face < 5; face++) {
      expect(splitFaceIndexToCore(cfg, face)).toBe(face);
      expect(splitFaceIndexToWeb(cfg, face)).toBe(face);
    }
  });

  it("builds every standard form around the grid origin", () => {
    const configs = [
      { type: "cairo", cols: 5, rows: 5 },
      { type: "cairo_circle", radius: 8 },
      { type: "cairo_hexagon", radius: 6 },
      { type: "cairo_triangle", side: 10 },
    ] as const;

    for (const config of configs) {
      const cells = configAllCells(config);
      expect(cells.length).toBeGreaterThan(0);
      if (config.type === "cairo") expect(cells).toHaveLength(config.cols * config.rows * 2);
      expect(cells.every(([x, y]) => isCairoPoint(x, y))).toBe(true);
      const bounds = exactCellBounds(cells.map(([x, y], id) => ({ x, y, id })), config);
      const center = cells.reduce((sum, [x, y]) => {
        const point = cairoCenter(x, y);
        return { x: sum.x + point.x, y: sum.y + point.y };
      }, { x: 0, y: 0 });
      if (config.type !== "cairo_triangle") {
        expect(Math.abs((bounds.minX + bounds.maxX) / 2)).toBeLessThanOrEqual(TILE_SIZE);
        expect(Math.abs((bounds.minY + bounds.maxY) / 2)).toBeLessThanOrEqual(TILE_SIZE);
      }
      expect(Math.abs(center.x / cells.length)).toBeLessThanOrEqual(TILE_SIZE);
      expect(Math.abs(center.y / cells.length)).toBeLessThanOrEqual(TILE_SIZE);
    }
  });

  it("round-trips every valid tile centre through projection and inverse projection", () => {
    const projection = makeProjection(cfg);
    for (const [x, y] of [[-6, -7], [-3, 2], [-1, 2], [2, 1], [2, 3]] as [number, number][]) {
      const screen = projection.gridToScreen(x, y);
      expect(projection.screenToGrid(screen.x, screen.y)).toEqual({ x, y });
    }
  });

  it("matches every direct neighbor with exactly one shared pentagon edge", () => {
    const point: [number, number] = [2, 1];
    const configs = [
      cfg,
      { type: "cairo_circle", radius: 12 },
      { type: "cairo_triangle", side: 20 },
      { type: "cairo_hexagon", radius: 12 },
    ] as const;

    for (const config of configs) {
      const vertices = getCellVertices(point[0], point[1], config)!;
      const { offsets, edgeVerts } = getNeighborData(config, point[0], point[1]);
      expect(offsets).toHaveLength(5);
      expect(edgeVerts).toHaveLength(5);

      for (let i = 0; i < offsets.length; i++) {
        const neighbor: [number, number] = [point[0] + offsets[i][0], point[1] + offsets[i][1]];
        const shared = getSharedEdgeSegment(point, neighbor, config);
        expect(shared).not.toBeNull();
        const [a, b] = edgeVerts[i];
        const expected = [vertices[a], vertices[b]];
        const sameDirection = shared!.v0.x === expected[0].x && shared!.v0.y === expected[0].y;
        if (sameDirection) {
          expectSameSegment(shared!.v1, expected[1]);
        } else {
          expectSameSegment(shared!.v0, expected[1]);
          expectSameSegment(shared!.v1, expected[0]);
        }
      }
    }
  });

  it("returns exact finite bounds for Cairo polygons", () => {
    const nodes = [[2, 1], [2, 3], [-1, 2]].map(([x, y], id) => ({ x, y, id }));
    const bounds = exactCellBounds(nodes, cfg);
    expect(bounds.minX).toBeCloseTo(-TILE_SIZE * 3 / 4);
    expect(bounds.minY).toBeCloseTo(-TILE_SIZE * 7 / 4);
    expect(bounds.maxX).toBeCloseTo(TILE_SIZE * 3 / 2);
    expect(bounds.maxY).toBeCloseTo(TILE_SIZE / 4);
  });

  it("keeps the long pentagon edge at one tile size", () => {
    const vertices = getCellVertices(2, 1, cfg)!;
    const longEdge = Math.hypot(vertices[0].x - vertices[4].x, vertices[0].y - vertices[4].y);
    expect(longEdge).toBeCloseTo(TILE_SIZE);
    expect(CAIRO_VERTEX_SCALE).toBeCloseTo(1 / 4);
  });

  it("removes the shared edge from a selected twin pair", () => {
    expect(selectionBoundarySegments([[2, 1], [2, 3]], "cairo", cfg)).toHaveLength(8);
  });

  it("hits a Cairo shared edge at its midpoint", () => {
    const shared = getSharedEdgeSegment([2, 1], [2, 3], cfg)!;
    const midpoint = { x: (shared.v0.x + shared.v1.x) / 2, y: (shared.v0.y + shared.v1.y) / 2 };
    const hit = pickEdgeAtPosition(midpoint.x, midpoint.y, cfg, [[2, 1], [2, 3]]);
    expect(hit).not.toBeNull();
    expect(hit!.from).toEqual([2, 1]);
    expect(hit!.to).toEqual([2, 3]);
  });

  it("includes only valid Cairo points when selecting a shape", () => {
    const shape: ShapeDefinition = { kind: "rectangle", width: 12, height: 12 };
    const cells = cellsInsideShape(cfg, shape);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every(([x, y]) => isCairoPoint(x, y))).toBe(true);
  });
});
