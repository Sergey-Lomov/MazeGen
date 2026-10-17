import { describe, it, expect } from "vitest";
import type { DisplayOrientation, FieldConfig } from "../fieldConfig";
import { TESSELLATION_UI } from "../pixi/geometry/tessellationUi";
import { getCellGeometry } from "../pixi/cartesianCache";
import { pathToSvg } from "../pixi/geometry/pathRenderer";
import { applyTransform } from "../pixi/geometry/worldTransform";
import { pickEdgeAtPosition } from "../pixi/edgeHitTesting";
import { buildCorridorSegments } from "../pixi/selectors/mazeSelectors/corridors";
import {
  cellsInDisplayRect,
  displayTransform,
  exactCellBounds,
  getCellCenter,
  getCellPath,
  getCellVertices,
  getSharedEdgeSegment,
  nearestCellCoord,
} from "../pixi/tessellationGeometry";
import type { EdgeDto, NodeDto } from "../wasm/types";
import { fieldOf } from "./fieldConfigFixtures";

/// The dev tessellation's cells G (5) and H (6) share a circular arc (`maze-core`'s
/// `test_tessellation`). Every check repeats under each display rotation.
const ROTATIONS: DisplayOrientation[] = ["r0", "r90", "r180", "r270"];
const G: [number, number] = [5, 0];
const H: [number, number] = [6, 0];
/// World-space arc: center (2, 0.5), radius sqrt(1.25), bulging into H.
const ARC_CENTER: [number, number] = [2, 0.5];
const ARC_RADIUS = Math.sqrt(1.25);

function configOf(orientation: DisplayOrientation): FieldConfig {
  return fieldOf("test", { shape: "custom", points: TESSELLATION_UI.test.finiteCells!.map(([x, y]) => [x, y]) }, orientation);
}

function display(cfg: FieldConfig, world: [number, number]) {
  const [x, y] = applyTransform(displayTransform(cfg), world);
  return { x, y };
}

// Needs wasm built with `test-tessellation` (`wasm-rebuild.sh` does that).
try {
  getCellGeometry(G[0], G[1], configOf("r0"));
} catch (error) {
  throw new Error(`wasm lacks the test tessellation; rebuild it with ./wasm-rebuild.sh (${String(error)})`);
}

describe.each(ROTATIONS)("curved shared face under display rotation %s", (orientation) => {
  const cfg = configOf(orientation);
  const scale = TESSELLATION_UI.test.pixelsPerUnit;

  it("renders the arc as an arc in both cells' paths, on one circle", () => {
    const arcs = [G, H].map(([x, y]) => getCellPath(x, y, cfg).filter((command) => command.op === "arc_to"));
    expect(arcs[0]).toHaveLength(1);
    expect(arcs[1]).toHaveLength(1);
    const [a, b] = arcs.map(([command]) => command as { center: [number, number]; radius: number });
    expect(a.center[0]).toBeCloseTo(b.center[0], 6);
    expect(a.center[1]).toBeCloseTo(b.center[1], 6);
    expect(a.radius).toBeCloseTo(ARC_RADIUS * scale, 6);
    expect(b.radius).toBeCloseTo(ARC_RADIUS * scale, 6);
    const center = display(cfg, ARC_CENTER);
    expect(a.center[0]).toBeCloseTo(center.x, 6);
    expect(a.center[1]).toBeCloseTo(center.y, 6);
  });

  it("serves one seamless shared edge from both sides", () => {
    const fromG = getSharedEdgeSegment(G, H, cfg)!;
    const fromH = getSharedEdgeSegment(H, G, cfg)!;
    expect(fromG).toBe(fromH);
    expect(fromG.path.some((command) => command.op === "arc_to")).toBe(true);
    // Both cells' boundaries contain the edge's end points.
    for (const cell of [G, H]) {
      const vertices = getCellVertices(cell[0], cell[1], cfg);
      for (const end of [fromG.v0, fromG.v1]) {
        expect(vertices.some((v) => Math.hypot(v.x - end.x, v.y - end.y) < 1e-6)).toBe(true);
      }
    }
    // Every flattened point lies on the circle.
    const center = display(cfg, ARC_CENTER);
    for (const [x, y] of fromG.polyline) {
      expect(Math.hypot(x - center.x, y - center.y)).toBeCloseTo(ARC_RADIUS * scale, 1);
    }
  });

  it("draws a corridor through the arc via the shared contact point", () => {
    const nodes = [G, H].map(([x, y], id) => ({ id, x, y }) as NodeDto);
    const edges = [
      { from: 0, to: 1, kind: "passage" },
      { from: 1, to: 0, kind: "passage" },
    ] as unknown as EdgeDto[];
    const segments = buildCorridorSegments(nodes, edges, cfg);
    expect(segments).toHaveLength(1);
    const [segment] = segments;
    const gCenter = getCellCenter(G[0], G[1], cfg);
    const hCenter = getCellCenter(H[0], H[1], cfg);
    expect(segment.v0).toEqual(gCenter);
    expect(segment.v1).toEqual(hCenter);
    const edge = getSharedEdgeSegment(G, H, cfg)!;
    // The contact point sits on the arc, so the corridor's face is the curved edge.
    const center = display(cfg, ARC_CENTER);
    expect(Math.hypot(edge.contact.x - center.x, edge.contact.y - center.y)).toBeCloseTo(ARC_RADIUS * scale, 6);
    expect(segment.faceLength).toBeGreaterThan(0);
  });

  it("hit-tests cells from both sides of the arc and on the boundary", () => {
    const edge = getSharedEdgeSegment(G, H, cfg)!;
    // World points on the cells' common axis y = 0.5: inside G, inside H, on the arc.
    const inG = display(cfg, [3, 0.5]);
    const inH = display(cfg, [3.2, 0.5]);
    const onArc = display(cfg, [2 + ARC_RADIUS, 0.5]);
    expect(nearestCellCoord(inG.x, inG.y, cfg)).toEqual(G);
    expect(nearestCellCoord(inH.x, inH.y, cfg)).toEqual(H);
    // A boundary point resolves to the smaller cell id, from every side.
    expect(nearestCellCoord(onArc.x, onArc.y, cfg)).toEqual(G);
    expect(Math.hypot(onArc.x - edge.contact.x, onArc.y - edge.contact.y)).toBeLessThan(1e-6 * scale + 1e-6);
    // Edge picking finds the curved edge from either side and on it.
    const cells = TESSELLATION_UI.test.finiteCells!.map(([x, y]) => [x, y] as [number, number]);
    for (const point of [onArc, display(cfg, [3.1, 0.5]), display(cfg, [3.13, 0.5])]) {
      const picked = pickEdgeAtPosition(point.x, point.y, cfg, cells);
      expect(picked).not.toBeNull();
      expect([picked!.from, picked!.to]).toEqual([G, H]);
    }
  });

  it("exports the arc as SVG arc data and fits its bounds", () => {
    const edge = getSharedEdgeSegment(G, H, cfg)!;
    expect(pathToSvg(edge.path)).toMatch(/ A /);
    expect(pathToSvg(getCellPath(H[0], H[1], cfg))).toMatch(/ A /);
    const bounds = exactCellBounds([{ id: 0, x: G[0], y: G[1] }, { id: 1, x: H[0], y: H[1] }], cfg);
    // The bulge of the arc past the chord stays inside the pair's bounds.
    const bulge = display(cfg, [2 + ARC_RADIUS, 0.5]);
    expect(bulge.x).toBeGreaterThanOrEqual(bounds.minX - 1e-6);
    expect(bulge.x).toBeLessThanOrEqual(bounds.maxX + 1e-6);
    expect(bulge.y).toBeGreaterThanOrEqual(bounds.minY - 1e-6);
    expect(bulge.y).toBeLessThanOrEqual(bounds.maxY + 1e-6);
  });

  it("selects both cells by region over the arc", () => {
    const edge = getSharedEdgeSegment(G, H, cfg)!;
    const r = scale * 0.01;
    const cells = cellsInDisplayRect(
      { minX: edge.contact.x - r, maxX: edge.contact.x + r, minY: edge.contact.y - r, maxY: edge.contact.y + r },
      "intersects",
      cfg,
    );
    expect(cells).toEqual([G, H]);
  });
});
