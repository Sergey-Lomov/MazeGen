import { describe, expect, it, vi } from "vitest";
import { TILE_SIZE } from "../pixi/constants";
import { CAIRO_VERTEX_SCALE, cairoCanonicalFaceOrder, cairoCenter, cairoEdgeVerts, cairoTileKind, isCairoPoint } from "../pixi/cairoGeometry";
import { getCellCenter, getCellVertices, getNeighborData, getSharedEdgeSegment, exactCellBounds, cellBounds, getTileDiagram, splitFaceIndexToCore, splitFaceIndexToWeb, pointInPolygon } from "../pixi/tessellationGeometry";
import { cairoRectangleBoundaryCells, configAllCells } from "../pixi/tessellationCells";
import { makeProjection } from "../pixi/tessellationProjection";
import { cellsInsideShape, type ShapeDefinition } from "../pixi/shapeSelection";
import { pickEdgeAtPosition } from "../pixi/edgeHitTesting";
import { selectionBoundarySegments } from "../pixi/fieldSelectionGeometry";
import { fieldOf } from "./fieldConfigFixtures";

vi.mock("../pixi/cartesianCache", () => ({
  getCartesian: (x: number, y: number): [number, number] => [x, y],
}));

const cfg = fieldOf("cairo", { shape: "rect", cols: 3, rows: 3 });

function expectSameSegment(a: { x: number; y: number }, b: { x: number; y: number }): void {
  expect(a.x).toBeCloseTo(b.x);
  expect(a.y).toBeCloseTo(b.y);
}

function polygonCentroid(vertices: { x: number; y: number }[]): { x: number; y: number } {
  let twiceArea = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    const cross = a.x * b.y - b.x * a.y;
    twiceArea += cross;
    x += (a.x + b.x) * cross;
    y += (a.y + b.y) * cross;
  }
  return { x: x / (3 * twiceArea), y: y / (3 * twiceArea) };
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
  it("returns a complete cyclic canonical face order for every Cairo tile orientation", () => {
    for (const point of [[2, 1], [2, 3], [5, 2], [7, 2], [-3, 2], [-1, 2]] as [number, number][]) {
      const order = cairoCanonicalFaceOrder(...point);
      const edgeVerts = cairoEdgeVerts(...point);
      expect(order).toHaveLength(5);
      expect(new Set(order).size).toBe(5);
      for (let i = 0; i < order.length; i++) {
        const current = edgeVerts[order[i]];
        const next = edgeVerts[order[(i + 1) % order.length]];
        expect(current[0] === next[0] || current[0] === next[1] || current[1] === next[0] || current[1] === next[1]).toBe(true);
      }
    }
  });

  it("uses a valid five-face tile for split diagrams", () => {
    expect(getTileDiagram(2, 1, cfg)?.sides).toHaveLength(5);
    expect(getNeighborData(cfg, 2, 1).offsets).toHaveLength(5);
  });

  it("maps Cairo face slots to the anchor (D) cell's canonical template faces and back", () => {
    expect([0, 1, 2, 3, 4].map((face) => splitFaceIndexToCore(cfg, face))).toEqual([0, 1, 3, 4, 2]);
    for (let face = 0; face < 5; face++) {
      expect(splitFaceIndexToWeb(cfg, splitFaceIndexToCore(cfg, face))).toBe(face);
    }
  });

  it("builds every standard form around the grid origin", () => {
    const configs = [
      fieldOf("cairo", { shape: "rect", cols: 5, rows: 5 }),
      fieldOf("cairo", { shape: "circle", radius: 8 }),
      fieldOf("cairo", { shape: "hexagon", radius: 6 }),
      fieldOf("cairo", { shape: "triangle", side: 10 }),
    ] as const;

    for (const config of configs) {
      const cells = configAllCells(config);
      expect(cells.length).toBeGreaterThan(0);
      if (config.shape.shape === "rect") expect(cells).toHaveLength(config.shape.cols * config.shape.rows * 2);
      expect(cells.every(([x, y]) => isCairoPoint(x, y))).toBe(true);
      const bounds = exactCellBounds(cells.map(([x, y], id) => ({ x, y, id })), config);
      const center = cells.reduce((sum, [x, y]) => {
        const point = cairoCenter(x, y);
        return { x: sum.x + point.x, y: sum.y + point.y };
      }, { x: 0, y: 0 });
      if (config.shape.shape !== "triangle") {
        expect(Math.abs((bounds.minX + bounds.maxX) / 2)).toBeLessThanOrEqual(TILE_SIZE);
        expect(Math.abs((bounds.minY + bounds.maxY) / 2)).toBeLessThanOrEqual(TILE_SIZE);
      }
      expect(Math.abs(center.x / cells.length)).toBeLessThanOrEqual(TILE_SIZE);
      expect(Math.abs(center.y / cells.length)).toBeLessThanOrEqual(TILE_SIZE);
    }
  });

  it("uses the pentagon's geometric centroid for cell-centered markers", () => {
    for (const [x, y] of [[2, 1], [2, 3], [5, 2], [7, 2]] as [number, number][]) {
      const vertices = getCellVertices(x, y, cfg)!;
      const center = getCellCenter(x, y, cfg);
      const centroid = polygonCentroid(vertices);
      expect(center.x).toBeCloseTo(centroid.x);
      expect(center.y).toBeCloseTo(centroid.y);
    }
  });

  it("round-trips every valid tile centre through projection and inverse projection", () => {
    const projection = makeProjection(cfg);
    for (const [x, y] of [[-6, -7], [-3, 2], [-1, 2], [2, 1], [2, 3], [5, 2], [7, 2]] as [number, number][]) {
      const screen = projection.gridToScreen(x, y);
      expect(projection.screenToGrid(screen.x, screen.y)).toEqual({ x, y });
    }
  });

  it("matches every direct neighbor with exactly one shared pentagon edge", () => {
    const point: [number, number] = [2, 1];
    const configs = [
      cfg,
      fieldOf("cairo", { shape: "circle", radius: 12 }),
      fieldOf("cairo", { shape: "triangle", side: 20 }),
      fieldOf("cairo", { shape: "hexagon", radius: 12 }),
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

  it("keeps the bounded Cairo rectangle boundary exact", () => {
    for (const [cols, rows] of [[1, 1], [2, 3], [6, 5]] as const) {
      const config = fieldOf("cairo", { shape: "rect", cols, rows });
      const allBounds = cellBounds(configAllCells(config), config);
      const boundaryBounds = cellBounds(cairoRectangleBoundaryCells(cols, rows), config);
      expect(boundaryBounds).toEqual(allBounds);
    }
  });

  it("uses the same polygon bounds for a raw cell set and node content", () => {
    const cells: [number, number][] = [[2, 1], [2, 3], [-1, 2]];
    expect(cellBounds(cells, cfg)).toEqual(exactCellBounds(cells.map(([x, y], id) => ({ x, y, id })), cfg));
  });

  it("treats points on a pentagon edge as inside", () => {
    const vertices = getCellVertices(2, 1, cfg)!;
    const edgePoint = {
      x: (vertices[0].x + vertices[1].x) / 2,
      y: (vertices[0].y + vertices[1].y) / 2,
    };
    expect(pointInPolygon(edgePoint, vertices)).toBe(true);
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
