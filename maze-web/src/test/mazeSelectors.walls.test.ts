import { describe, it, expect, vi } from "vitest";
import { buildClosedCells, buildMazeWalls, buildCorridorSegments, buildOneWayWallIndicatorPositions, buildOneWayCorridorIndicatorPositions } from "../pixi/selectors/mazeSelectors";
import { getCellCenter, getCellVertices, getSharedEdgeSegment } from "../pixi/tessellationGeometry";
import type { EdgeDto } from "../wasm/types";
import type { FieldConfig } from "../fieldConfig";
import { fieldOf } from "./fieldConfigFixtures";
import { n, e, squareCfg, twoWay } from "./mazeSelectorsKit";

vi.mock("pixi.js", async () => (await import("./mazeSelectorsMocks")).pixiMock());
vi.mock("../store/mazeStore", async () => (await import("./mazeSelectorsMocks")).mazeStoreMock());
// getCellCenter (via cartesianCache's getCartesian) delegates to wasm, unavailable in this
// unit-test environment, so only the real preset/geometry entry points are kept.
vi.mock("../wasm/mazeService", async (importActual) =>
  (await import("./postEditSliceMocks")).mazeServiceMock(await importActual<typeof import("../wasm/mazeService")>()));


// --- buildClosedCells ---


describe("buildClosedCells", () => {
  it("no edges — all nodes are closed", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const result = buildClosedCells(nodes, []);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual([0, 0]);
    expect(result).toContainEqual([1, 0]);
  });

  it("connected node not in result", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 2, 0)];
    const result = buildClosedCells(nodes, [e(0, 1)]);
    expect(result).not.toContainEqual([0, 0]);
    expect(result).not.toContainEqual([1, 0]);
    expect(result).toContainEqual([2, 0]);
  });

  it("all connected — empty result", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const result = buildClosedCells(nodes, [...twoWay(0, 1)]);
    expect(result).toEqual([]);
  });

  it("empty nodes returns empty", () => {
    expect(buildClosedCells([], [])).toEqual([]);
  });

  it("single node with no edges is closed", () => {
    const result = buildClosedCells([n(0, 3, 5)], []);
    expect(result).toEqual([[3, 5]]);
  });

  it("edge referencing unknown node id still marks known node as connected", () => {
    const nodes = [n(0, 0, 0)];
    const result = buildClosedCells(nodes, [e(0, 99)]);
    expect(result).toEqual([]);
  });

  it("teleport-only edge counts as a connection — cell is not closed even with no geometric passage", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const teleportEdge: EdgeDto = { from: 0, to: 1, kind: "teleport" };
    const result = buildClosedCells(nodes, [teleportEdge]);
    expect(result).not.toContainEqual([0, 0]);
    expect(result).not.toContainEqual([1, 0]);
  });

  it("a split point's cell is not closed when only its non-original node has a connection", () => {
    // Two nodes at the same cell (0,0) — a split point (GitHub issue #221): node 0 is the
    // original (walled off, no edges), node 2 is an extra split node with a passage to node 1.
    // The cell as a whole is open via node 2, even though node 0 alone has none.
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const result = buildClosedCells(nodes, [e(2, 1)]);
    expect(result).not.toContainEqual([0, 0]);
    expect(result).not.toContainEqual([1, 0]);
  });

  it("a split point's cell IS closed when none of its nodes have any connection", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const result = buildClosedCells(nodes, []);
    expect(result).toContainEqual([0, 0]);
    expect(result).toContainEqual([1, 0]);
  });

  // --- allEdges (GitHub issue #337 follow-up: one-way VerticalPassage arrival end) ---

  it("without allEdges, a one-way VerticalPassage's arrival-only cell (edge absent from the floor-scoped edges list) is wrongly closed", () => {
    // Mirrors what a floor-aware caller's own `edges` looks like on the arrival floor:
    // `selectFloorScopedMaze` drops a vertical_passage edge whose `from` isn't on this floor, so
    // `edges` here has nothing at all for node 0.
    const nodes = [n(0, 0, 0)];
    const result = buildClosedCells(nodes, []);
    expect(result).toContainEqual([0, 0]);
  });

  it("allEdges recovers a one-way VerticalPassage's arrival-only cell as connected", () => {
    const nodes = [n(0, 0, 0)];
    const verticalEdge: EdgeDto = { from: 99, to: 0, kind: "vertical_passage" };
    const result = buildClosedCells(nodes, [], [verticalEdge]);
    expect(result).not.toContainEqual([0, 0]);
  });

  it("allEdges does not treat an unrelated edge kind as a vertical arrival", () => {
    const nodes = [n(0, 0, 0)];
    const teleportEdge: EdgeDto = { from: 99, to: 0, kind: "teleport" };
    const result = buildClosedCells(nodes, [], [teleportEdge]);
    expect(result).toContainEqual([0, 0]);
  });

  // GitHub issue #359 follow-up: an Elevator arrival-only cell was still wrongly closed even with
  // allEdges — the allEdges pass only ever checked `kind === "vertical_passage"`, never "elevator".
  it("allEdges recovers an Elevator's arrival-only cell as connected", () => {
    const nodes = [n(0, 0, 0)];
    const elevatorEdge: EdgeDto = { from: 99, to: 0, kind: "elevator" };
    const result = buildClosedCells(nodes, [], [elevatorEdge]);
    expect(result).not.toContainEqual([0, 0]);
  });

  // GitHub issue #359 follow-up: a one-way VerticalPassage's own *departure* cell (its `from`, on
  // this floor) was still wrongly closed on PostEdit — vertical passage/elevator edges are never
  // post-edit-editable, so neither end is in `edges`/`activeEdges`, but the allEdges pass only ever
  // checked `e.to`, never `e.from`.
  it("allEdges recovers a one-way VerticalPassage's own departure cell as connected", () => {
    const nodes = [n(0, 0, 0)];
    const verticalEdge: EdgeDto = { from: 0, to: 99, kind: "vertical_passage" };
    const result = buildClosedCells(nodes, [], [verticalEdge]);
    expect(result).not.toContainEqual([0, 0]);
  });
});

// --- buildMazeWalls ---

describe("buildMazeWalls", () => {
  it("unsplit pair renders exactly as before", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const walls = buildMazeWalls(nodes, [], squareCfg);
    expect(walls.some(w => w.a[0] === 0 && w.a[1] === 0 && w.b[0] === 1 && w.b[1] === 0 && w.kind === "none")).toBe(true);
  });

  it("a split point's shared-with-neighbor face renders no WallEdge (GitHub issue #223), but its field-boundary faces still do (bug fix)", () => {
    // Point (0,0) split into node 0 (original) and node 2 (extra split node, wired to node 1).
    // The face shared with (1,0) is rendered exclusively via buildSplitPassages, so it must be
    // absent here -- but (0,0)'s other faces have no field neighbor at all, so buildSplitPassages
    // never draws them either; buildMazeWalls must still supply their outer wall.
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const edges: EdgeDto[] = [...twoWay(2, 1)];
    const walls = buildMazeWalls(nodes, edges, squareCfg);
    const touchingSplitPoint = walls.filter(w =>
      (w.a[0] === 0 && w.a[1] === 0) || (w.b[0] === 0 && w.b[1] === 0));
    expect(touchingSplitPoint.some(w => w.b[0] === 1 && w.b[1] === 0)).toBe(false);
    expect(touchingSplitPoint.every(w => w.kind === "none")).toBe(true);
    expect(touchingSplitPoint.length).toBe(3);
  });

  it("a split point's neighbor still renders its own boundary walls on faces not shared with the split point", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const walls = buildMazeWalls(nodes, [], squareCfg);
    // Node 1 at (1,0) has a boundary wall to (2,0) (not in the field) — unaffected by (0,0) being split.
    expect(walls.some(w => w.a[0] === 1 && w.a[1] === 0 && w.b[0] === 2 && w.b[1] === 0)).toBe(true);
  });

  it("treats hex_triangle as a hex grid when finding shared walls", () => {
    const cfg: FieldConfig = fieldOf("hex", { shape: "triangle", side: 20 }, "flat_top");
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const walls = buildMazeWalls(nodes, [], cfg);
    expect(walls.some(w =>
      w.a[0] === 0 && w.a[1] === 0 && w.b[0] === 1 && w.b[1] === 0 && w.kind === "none",
    )).toBe(true);
  });
});

// --- buildOneWayWallIndicatorPositions (GitHub issue #518) ---

describe("buildOneWayWallIndicatorPositions", () => {
  it("a one-way wall edge's indicator lands on its shared face's own midpoint", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const walls = buildMazeWalls(nodes, [e(0, 1)], squareCfg);
    const oneWayWall = walls.find(w => w.oneWayDir);
    expect(oneWayWall).toBeDefined();
    const positions = buildOneWayWallIndicatorPositions(walls, squareCfg);
    expect(positions).toHaveLength(1);
    // The shared face between (0,0) and (1,0) runs vertically at their boundary — its own midpoint,
    // not either cell's center.
    const cx = (getCellCenter(0, 0, squareCfg).x + getCellCenter(1, 0, squareCfg).x) / 2;
    expect(positions[0][0]).toBeCloseTo(cx);
  });

  it("a bidirectional wall edge contributes no indicator position", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const walls = buildMazeWalls(nodes, [...twoWay(0, 1)], squareCfg);
    expect(walls.every(w => !w.oneWayDir)).toBe(true);
    expect(buildOneWayWallIndicatorPositions(walls, squareCfg)).toEqual([]);
  });
});

// --- buildCorridorSegments ---

describe("buildCorridorSegments", () => {
  it("no edges — no segments", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    expect(buildCorridorSegments(nodes, [], squareCfg)).toEqual([]);
  });

  it("a connected pair draws a center-to-center segment", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const segments = buildCorridorSegments(nodes, [...twoWay(0, 1)], squareCfg);
    expect(segments).toHaveLength(1);
    expect(segments[0].v0).toEqual(getCellCenter(0, 0, squareCfg));
    expect(segments[0].v1).toEqual(getCellCenter(1, 0, squareCfg));
  });

  it("curved-quadrilateral segments carry the shared face's curve; straight faces carry none", () => {
    const curvedCfg: FieldConfig = fieldOf("curved_quadrilateral", { shape: "rect", cols: 4, rows: 4 });
    const curved = buildCorridorSegments([n(0, 0, 0), n(1, 1, 0)], [...twoWay(0, 1)], curvedCfg);
    expect(curved).toHaveLength(1);
    const face = getSharedEdgeSegment([0, 0], [1, 0], curvedCfg)!;
    expect(face.polyline.length).toBeGreaterThanOrEqual(3);
    expect(curved[0].facePolyline).toEqual(face.polyline.map(([x, y]) => ({ x, y })));
    const straight = buildCorridorSegments([n(0, 0, 0), n(1, 1, 0)], [...twoWay(0, 1)], squareCfg);
    expect(straight[0].facePolyline).toBeUndefined();
  });

  it("Cairo segments use the shared-face midpoint and its perpendicular outward normal", () => {
    const cfg: FieldConfig = fieldOf("cairo", { shape: "rect", cols: 3, rows: 3 });
    const a: [number, number] = [2, 1];
    const b: [number, number] = [-1, 2];
    const nodes = [n(0, ...a), n(1, ...b)];
    const segments = buildCorridorSegments(nodes, [...twoWay(0, 1)], cfg);
    expect(segments).toHaveLength(1);
    const face = getSharedEdgeSegment(a, b, cfg);
    expect(face).not.toBeNull();
    const faceMidpoint = {
      x: (face!.v0.x + face!.v1.x) / 2,
      y: (face!.v0.y + face!.v1.y) / 2,
    };
    expect(segments[0].faceMidpoint).toEqual(faceMidpoint);
    expect(segments[0].faceNormal).toBeDefined();
    const edgeDx = face!.v1.x - face!.v0.x;
    const edgeDy = face!.v1.y - face!.v0.y;
    const normal = segments[0].faceNormal!;
    expect(normal.x * edgeDx + normal.y * edgeDy).toBeCloseTo(0);
    const center = segments[0].v0;
    expect(normal.x * (faceMidpoint.x - center.x) + normal.y * (faceMidpoint.y - center.y)).toBeGreaterThan(0);
    expect(segments[0].faceLength).toBeCloseTo(Math.hypot(edgeDx, edgeDy));
  });

  it("a one-way passage draws the same v0/v1 as a bidirectional one, but carries its own oneWayDir (GitHub issue #312)", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const oneWay = buildCorridorSegments(nodes, [e(0, 1)], squareCfg);
    const both = buildCorridorSegments(nodes, [...twoWay(0, 1)], squareCfg);
    expect(oneWay).toHaveLength(1);
    expect(oneWay[0].v0).toEqual(both[0].v0);
    expect(oneWay[0].v1).toEqual(both[0].v1);
    expect(oneWay[0].oneWayDir).toEqual({ dx: 1, dy: 0 });
    expect(both[0].oneWayDir).toBeUndefined();
  });

  it("a backward-only one-way passage's oneWayDir points from v1 toward v0", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const backward = buildCorridorSegments(nodes, [e(1, 0)], squareCfg);
    expect(backward).toHaveLength(1);
    expect(backward[0].oneWayDir).toEqual({ dx: -1, dy: 0 });
  });

  it("does not draw a segment for an unconnected neighbor pair", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    expect(buildCorridorSegments(nodes, [], squareCfg)).toEqual([]);
  });

  it("does not draw a segment for a teleport-only edge", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const teleportEdge: EdgeDto = { from: 0, to: 1, kind: "teleport" };
    expect(buildCorridorSegments(nodes, [teleportEdge], squareCfg)).toEqual([]);
  });

  it("skips a split-to-split edge entirely (drawn by buildSplitPassages instead)", () => {
    // Point (0,0) split into node 0 (original) and node 2 (extra split node); node 0 <-> node 2
    // is an inter-split edge at the same point, drawn by buildSplitPassages, never a corridor
    // segment.
    const nodes = [n(0, 0, 0), n(2, 0, 0)];
    const edges: EdgeDto[] = [...twoWay(0, 2)];
    expect(buildCorridorSegments(nodes, edges, squareCfg)).toEqual([]);
  });

  it("a plain cell neighboring a split point still draws its own stub, shortened to the shared face's own midpoint (GitHub issue #314)", () => {
    // Point (0,0) split into node 0 (original) and node 2 (extra split node, wired to node 1).
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const edges: EdgeDto[] = [...twoWay(2, 1)];
    const segments = buildCorridorSegments(nodes, edges, squareCfg);
    expect(segments).toHaveLength(1);
    expect(segments[0].fromNode).toBe(1);
    expect(segments[0].toNode).toBe(2);
    expect(segments[0].v0).toEqual(getCellCenter(1, 0, squareCfg));
    // Shortened to the face midpoint between (1,0) and (0,0), not all the way to (0,0)'s own center.
    expect(segments[0].v1).not.toEqual(getCellCenter(0, 0, squareCfg));
  });

  it("a split point's unrelated neighbor still draws its own ordinary corridor segments", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0), n(3, 2, 0)];
    const edges: EdgeDto[] = [...twoWay(1, 3)];
    const segments = buildCorridorSegments(nodes, edges, squareCfg);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual(expect.objectContaining({
      v0: getCellCenter(1, 0, squareCfg), v1: getCellCenter(2, 0, squareCfg),
      fromNode: 1, toNode: 3, v1TouchesSplit: false,
    }));
    expect(segments[0].faceMidpoint).toBeDefined();
    expect(segments[0].faceNormal).toBeDefined();
    expect(segments[0].faceLength).toBeGreaterThan(0);
    expect(segments[0].cellVertices0).toEqual(getCellVertices(1, 0, squareCfg));
    expect(segments[0].cellVertices1).toEqual(getCellVertices(2, 0, squareCfg));
  });

  it("emits each connected pair's segment only once, not once per direction", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const segments = buildCorridorSegments(nodes, [...twoWay(0, 1)], squareCfg);
    expect(segments).toHaveLength(1);
  });
});

// --- buildOneWayCorridorIndicatorPositions (GitHub issue #518) ---

describe("buildOneWayCorridorIndicatorPositions", () => {
  it("a one-way corridor segment's indicator lands on the segment's own midpoint", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const segments = buildCorridorSegments(nodes, [e(0, 1)], squareCfg);
    const positions = buildOneWayCorridorIndicatorPositions(segments);
    expect(positions).toHaveLength(1);
    expect(positions[0]).toEqual([
      (segments[0].v0.x + segments[0].v1.x) / 2,
      (segments[0].v0.y + segments[0].v1.y) / 2,
    ]);
  });

  it("a bidirectional corridor segment contributes no indicator position", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const segments = buildCorridorSegments(nodes, [...twoWay(0, 1)], squareCfg);
    expect(buildOneWayCorridorIndicatorPositions(segments)).toEqual([]);
  });
});