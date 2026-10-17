import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { FAMILIES, cellSize, faceLength, labCellGeometry, prepareFamily, scaleCell, type LabCell } from "../components/CorridorGeometryTestPage";
import { buildCorridorSegments } from "../pixi/selectors/mazeSelectors/corridors";
import { getCellCenter, getNeighborData, getSharedEdgeSegment } from "../pixi/tessellationGeometry";
import {
  buildCorridorGeometryDebug,
  contourToPolyline,
  corridorSegmentsToGeometryInput,
  type ContourPath,
  type CorridorPoint,
} from "../pixi/imageExport/vectorByCorridorsContour";
import type { EdgeDto, NodeDto } from "../wasm/types";
import { convexPolygonOutsideDistance } from "./polygonTestHelpers";

// Cell geometry comes from the real wasm build (`src/wasm/pkg/`, gitignored build output that
// `npm test` requires). wasm-bindgen's default `init()` fetches its .wasm by URL, which does not
// work under node — load the bytes from disk and hand the module to the loader.
const wasmPath = resolve(dirname(__filename), "../wasm/pkg/maze_wasm_bg.wasm");
const wasmHolder = vi.hoisted(() => ({ module: null as unknown }));
vi.mock("../wasm/wasmLoader", async (importActual) => ({
  ...(await importActual<typeof import("../wasm/wasmLoader")>()),
  initWasm: () => Promise.resolve(),
  getWasm: () => {
    if (!wasmHolder.module) throw new Error("WASM not initialized");
    return wasmHolder.module;
  },
}));

beforeAll(async () => {
  const wasm = await import("../wasm/pkg/maze_wasm");
  await wasm.default(readFileSync(wasmPath));
  wasmHolder.module = wasm;
});

describe("lab geometry matches the production pipeline", () => {
  const translate = (paths: ContourPath[], offset: CorridorPoint) => paths.flatMap((path) => contourToPolyline(path, 2))
    .map((point) => ({ x: point.x + offset.x, y: point.y + offset.y }));

  // Every combination of every lab tessellation, drawn by the lab and by a real maze run through
  // `buildCorridorSegments` and the production adapter. Thicknesses stay within the shortest face,
  // where the lab's whole-maze width clamp and this small maze's clamp agree.
  it.each(FAMILIES.map((family) => [family.label, family] as const))("%s: every combination matches", (_label, family) => {
    const cell = prepareFamily(family)!;
    const cfg = family.config;
    const [cx, cy] = family.coordinate;
    const centre = getCellCenter(cx, cy, cfg);
    const { offsets } = getNeighborData(cfg, cx, cy);
    const neighbourOfPort = cell.ports.map((port) => offsets.find(([dx, dy]) => {
      const face = getSharedEdgeSegment([cx, cy], [cx + dx, cy + dy], cfg);
      if (!face) return false;
      return Math.hypot((face.v0.x + face.v1.x) / 2 - centre.x - port.midpoint.x, (face.v0.y + face.v1.y) / 2 - centre.y - port.midpoint.y) < 1e-6;
    })!);
    expect(neighbourOfPort.every(Boolean)).toBe(true);
    const shortestFace = Math.min(...cell.ports.map(faceLength));

    for (let mask = 1; mask < 1 << cell.ports.length; mask++) {
      const nodes: NodeDto[] = [{ id: 0, x: cx, y: cy, i: 0 }];
      const edges: EdgeDto[] = [];
      cell.ports.forEach((_, index) => {
        if ((mask & (1 << index)) === 0) return;
        const [dx, dy] = neighbourOfPort[index];
        const id = nodes.length;
        nodes.push({ id, x: cx + dx, y: cy + dy, i: id });
        edges.push({ from: 0, to: id, kind: "basic" }, { from: id, to: 0, kind: "basic" });
      });
      for (const thickness of [shortestFace / 4, shortestFace / 2, shortestFace]) {
        const { cells, ports } = corridorSegmentsToGeometryInput(buildCorridorSegments(nodes, edges, cfg), thickness);
        const ownCells = cells.filter((candidate) => Math.hypot(candidate.center.x - centre.x, candidate.center.y - centre.y) < 1e-6);
        const [production] = buildCorridorGeometryDebug(ownCells, ports, thickness, 4);
        const { geometry: lab } = labCellGeometry(cell, mask, thickness, 4);
        const expected = translate(production.contour, { x: 0, y: 0 });
        const actual = translate(lab!.contour, centre);
        expect(actual.length, `mask ${mask}, thickness ${thickness}`).toBe(expected.length);
        const delta = Math.max(...actual.map((point, index) => Math.hypot(point.x - expected[index].x, point.y - expected[index].y)));
        expect(delta, `mask ${mask}, thickness ${thickness}`).toBeLessThan(1e-6);
      }
    }
  });
});

/** Signed distance from `point` to the nearest face of a convex polygon (positive inside). */
const insideDistance = (point: CorridorPoint, polygon: readonly CorridorPoint[]) => -convexPolygonOutsideDistance(point, polygon);

// A triangle cell with 40px faces (half the native size) covers every dead-end cap case within the
// lab's thickness range. The cell centre is one inradius (11.5px) from the other faces; a cap
// centred on the port would have 17.3px of room.
describe("40px triangle dead end", () => {
  const deadEnd = 0b001;
  let triangle: LabCell;
  beforeAll(() => {
    const native = prepareFamily(FAMILIES.find((family) => family.id === "triangle")!)!;
    triangle = scaleCell(native, 40 / cellSize(native)); // the lab's "Cell size" set to 40px
  });
  const geometry = (thickness: number) => labCellGeometry(triangle, deadEnd, thickness, 0).geometry!;
  const contourOverflow = (thickness: number) =>
    -Math.min(...contourToPolyline(geometry(thickness).contour[0], 0.5).map((point) => insideDistance(point, triangle.polygon)));
  const targetDistanceFromCentre = (thickness: number) => Math.hypot(geometry(thickness).target.x, geometry(thickness).target.y);

  it("has 40px faces, which also clamp the corridor thickness", () => {
    expect(labCellGeometry(triangle, deadEnd, 500, 4).thickness).toBeCloseTo(40, 6);
  });

  it("keeps the cap on the cell centre while it fits there (thickness up to 23.1)", () => {
    expect(targetDistanceFromCentre(22)).toBeLessThan(1e-9);
    expect(contourOverflow(22)).toBeLessThan(1e-6);
  });

  it("moves the cap back toward the port until it fits (thickness 23.1 to 34.6)", () => {
    expect(targetDistanceFromCentre(30)).toBeGreaterThan(1);
    expect(contourOverflow(30)).toBeLessThan(1e-6);
  });

  it("bends the cap into the deepest arc through the mouth ends when it does not fit even at the port (above 34.6)", () => {
    const cmds = geometry(40).contour[0].cmds;
    expect(cmds.map((command) => command.kind)).toEqual(["move", "arc", "line"]);
    const deepest = Math.min(...contourToPolyline(geometry(40).contour[0], 0.5).map((point) => insideDistance(point, triangle.polygon)));
    // Inside, and touching a face (up to the polyline's 0.2 rad arc sampling): no deeper arc would fit.
    expect(deepest).toBeGreaterThan(-1e-6);
    expect(deepest).toBeLessThan(0.05);
    expect(geometry(40).target).toEqual(triangle.ports[0].midpoint);
  });
});
