import { range } from "./seamFixtures";
import { describe, expect, it } from "vitest";
import { warmCartesianCache } from "../pixi/cartesianCache";
import { buildCorridorSegments, buildHoveredEntityHighlight, buildMazeWalls, buildOneWayWallIndicatorPositions, buildSplitPassages } from "../pixi/selectors/mazeSelectors";
import { buildHoverEdgeHighlight } from "../pixi/selectors/presetSelectors";
import { insidePolygon } from "../pixi/selectors/seamRouting";
import { arrowContains, buildSeamArrows, headPolygon, pairAt, seamFocusOf, BRACE_OFFSET, BRACE_WIDTH } from "../pixi/selectors/seamArrows";
import { glueColor } from "../pixi/renderers/SeamArrowRenderer";
import { boundsOf, portAxes, routeAll, routePair, type Point } from "../pixi/selectors/seamRouting";
import { logicalEdgeSegments } from "../pixi/selectors/seamEdges";
import { getSeamModel } from "../pixi/selectors/seams";
import { pickEdgeAtPosition } from "../pixi/edgeHitTesting";
import { hopPieces, seamHopPieces, type SeamHopContext } from "../pixi/graphSeams";
import { buildPairedRenderEdges, buildPathRenderEdges } from "../pixi/BaseGraphRenderer";
import { drawCellBoundaryHighlight } from "../pixi/renderers/wallUtils";
import type { Graphics } from "pixi.js";
import { getCellCenter, getCellVertices, getFaceEdgeSegment } from "../pixi/tessellationGeometry";
import type { EdgeDto, NodeDto, WireFold, WireTopology } from "../wasm/types";
import { fieldOf } from "./fieldConfigFixtures";

// Seam drawing (GitHub issue #841) against the real `maze-core` module loaded by `setup.ts`. A 6x5
// square field; face 0 is east, 1 north, 2 west, 3 south. Expected coordinates come from the display
// helpers the renderers use, never from hand-written numbers, so a display transform cannot hide a bug.
const COLUMNS = 6;
const ROWS = 5;
const cells: [number, number][] = [];
for (let x = 0; x < COLUMNS; x++) for (let y = 0; y < ROWS; y++) cells.push([x, y]);
const field = fieldOf("square", { shape: "custom", points: cells });

const topologyOf = (folds: Omit<WireFold, "group">[]): WireTopology => ({
  fingerprint: "square{}",
  folds: folds.map((fold) => ({ ...fold, group: 0 })),
  groups: [{ id: 0, folds: folds.map((_, i) => i) }],
});
type FoldInput = Omit<WireFold, "group">;
/// One group per list of folds.
const groupedTopology = (lists: FoldInput[][]): WireTopology => {
  const folds: WireFold[] = [];
  const groups: WireTopology["groups"] = [];
  lists.forEach((list, group) => {
    groups.push({ id: group, folds: list.map((_, i) => folds.length + i) });
    folds.push(...list.map((fold) => ({ ...fold, group })));
  });
  return { fingerprint: "square{}", folds, groups };
};
const cylinderFolds = range(ROWS).map((y) => ({ a: { cell: [COLUMNS - 1, y] as [number, number], face_idx: 0 }, b: { cell: [0, y] as [number, number], face_idx: 2 }, twist: false }));
const wrapFolds = range(COLUMNS).map((x) => ({ a: { cell: [x, ROWS - 1] as [number, number], face_idx: 1 }, b: { cell: [x, 0] as [number, number], face_idx: 3 }, twist: false }));
const mobiusFolds = range(ROWS).map((y) => ({ a: { cell: [COLUMNS - 1, y] as [number, number], face_idx: 0 }, b: { cell: [0, ROWS - 1 - y] as [number, number], face_idx: 2 }, twist: true }));
const cylinder = topologyOf(cylinderFolds);
const torus = groupedTopology([cylinderFolds, wrapFolds]);
const mobius = topologyOf(mobiusFolds);
const eachFoldAlone = (folds: FoldInput[]): WireTopology => groupedTopology(folds.map((fold) => [fold]));

const nodes: NodeDto[] = cells.map(([x, y], id) => ({ id, x, y, i: 0 }));
const idOf = ([x, y]: [number, number]): number => nodes.find((node) => node.x === x && node.y === y)!.id;
const edge = (from: [number, number], to: [number, number]): EdgeDto => ({ from: idOf(from), to: idOf(to), kind: "basic" });

function warm(topology: WireTopology | null) {
  warmCartesianCache(field, topology);
  return getSeamModel(field);
}

const close = (actual: readonly number[], expected: readonly number[]) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 6));
};

const faceOf = (cell: [number, number], faceIdx: number) => getFaceEdgeSegment(cell, faceIdx, field)!;

/** Unit vector from a cell's center to its face's contact point (out of the cell). */
function outOf(cell: [number, number], faceIdx: number): [number, number] {
  const face = getFaceEdgeSegment(cell, faceIdx, field)!;
  const center = getCellCenter(cell[0], cell[1], field);
  const length = Math.hypot(face.contact.x - center.x, face.contact.y - center.y);
  return [(face.contact.x - center.x) / length, (face.contact.y - center.y) / length];
}

describe("seam walls", () => {
  it("draws the whole glued face on each side, from that side's own face", () => {
    warm(cylinder);
    const walls = buildMazeWalls(nodes, [], field).filter((wall) => wall.face !== undefined && (wall.b[0] !== wall.a[0] || wall.b[1] !== wall.a[1]));
    expect(walls).toHaveLength(2 * ROWS);
    for (let y = 0; y < ROWS; y++) {
      const east = walls.find((wall) => wall.a[0] === COLUMNS - 1 && wall.a[1] === y)!;
      const west = walls.find((wall) => wall.a[0] === 0 && wall.a[1] === y)!;
      expect(east.face).toBe(0);
      expect(east.b).toEqual([0, y]);
      expect(west.face).toBe(2);
      expect(west.b).toEqual([COLUMNS - 1, y]);
      expect(east.kind).toBe("none");
      expect(west.kind).toBe("none");
    }
    // The outer faces of the two border columns are no longer field edges: no boundary wall repeats them.
    const boundary = buildMazeWalls(nodes, [], field).filter((wall) => wall.face !== undefined && wall.b[0] === wall.a[0] && wall.b[1] === wall.a[1]);
    expect(boundary.filter((wall) => wall.a[0] === 0 && wall.face === 2)).toHaveLength(0);
    expect(boundary.filter((wall) => wall.a[0] === COLUMNS - 1 && wall.face === 0)).toHaveLength(0);
  });

  it("draws no wall on either side of an open seam passage", () => {
    warm(cylinder);
    const edges = [edge([COLUMNS - 1, 2], [0, 2]), edge([0, 2], [COLUMNS - 1, 2])];
    const walls = buildMazeWalls(nodes, edges, field);
    expect(walls.filter((wall) => wall.a[1] === 2 && wall.face !== undefined && ((wall.a[0] === 0 && wall.face === 2) || (wall.a[0] === COLUMNS - 1 && wall.face === 0)))).toHaveLength(0);
    expect(walls.filter((wall) => wall.a[1] === 1 && wall.a[0] === 0 && wall.face === 2)).toHaveLength(1);
  });

  it("draws a one-way indicator on each side, out of the source cell and into the target cell", () => {
    warm(cylinder);
    const walls = buildMazeWalls(nodes, [edge([COLUMNS - 1, 2], [0, 2])], field);
    const east = walls.find((wall) => wall.a[0] === COLUMNS - 1 && wall.a[1] === 2 && wall.face === 0)!;
    const west = walls.find((wall) => wall.a[0] === 0 && wall.a[1] === 2 && wall.face === 2)!;
    expect(east.kind).toBe("forward");
    expect(west.kind).toBe("backward");
    const out = outOf([COLUMNS - 1, 2], 0);
    const outWest = outOf([0, 2], 2);
    close([east.oneWayDir!.dx, east.oneWayDir!.dy], out);
    close([west.oneWayDir!.dx, west.oneWayDir!.dy], [-outWest[0], -outWest[1]]);
    // On a cylinder both indicators point the same way on screen: the flow continues across the seam.
    close([east.oneWayDir!.dx, east.oneWayDir!.dy], [west.oneWayDir!.dx, west.oneWayDir!.dy]);
    // Each indicator sits on its own copy of the face.
    const positions = buildOneWayWallIndicatorPositions([east, west], field);
    close(positions[0], [getFaceEdgeSegment([COLUMNS - 1, 2], 0, field)!.contact.x, getFaceEdgeSegment([COLUMNS - 1, 2], 0, field)!.contact.y]);
    close(positions[1], [getFaceEdgeSegment([0, 2], 2, field)!.contact.x, getFaceEdgeSegment([0, 2], 2, field)!.contact.y]);
  });

  it("matches a twisted seam: the partner row is mirrored, each side keeps its own face", () => {
    warm(mobius);
    const walls = buildMazeWalls(nodes, [], field).filter((wall) => wall.face !== undefined && (wall.b[0] !== wall.a[0] || wall.b[1] !== wall.a[1]));
    expect(walls).toHaveLength(2 * ROWS);
    for (let y = 0; y < ROWS; y++) {
      const west = walls.find((wall) => wall.a[0] === 0 && wall.a[1] === y)!;
      expect(west.b).toEqual([COLUMNS - 1, ROWS - 1 - y]);
      const east = walls.find((wall) => wall.a[0] === COLUMNS - 1 && wall.a[1] === ROWS - 1 - y)!;
      expect(east.b).toEqual([0, y]);
    }
  });

  it("is unchanged without folds", () => {
    warm(null);
    const walls = buildMazeWalls(nodes, [], field);
    expect(walls.some((wall) => wall.face !== undefined && (wall.b[0] !== wall.a[0] || wall.b[1] !== wall.a[1]))).toBe(false);
    expect(walls.filter((wall) => wall.b[0] < 0 || wall.b[1] < 0 || wall.b[0] >= COLUMNS || wall.b[1] >= ROWS)).toHaveLength(2 * ROWS + 2 * COLUMNS);
  });
});

describe("seam corridors", () => {
  it("splits a passage across a seam into one segment per side, each ending on its own face", () => {
    warm(cylinder);
    const edges = [edge([COLUMNS - 1, 2], [0, 2]), edge([0, 2], [COLUMNS - 1, 2])];
    const segments = buildCorridorSegments(nodes, edges, field);
    expect(segments).toHaveLength(2);
    const east = segments.find((segment) => segment.fromNode === idOf([COLUMNS - 1, 2]))!;
    const west = segments.find((segment) => segment.fromNode === idOf([0, 2]))!;
    expect(east.toNode).toBe(idOf([0, 2]));
    expect(west.toNode).toBe(idOf([COLUMNS - 1, 2]));
    const eastFace = getFaceEdgeSegment([COLUMNS - 1, 2], 0, field)!;
    const westFace = getFaceEdgeSegment([0, 2], 2, field)!;
    const eastCenter = getCellCenter(COLUMNS - 1, 2, field);
    const westCenter = getCellCenter(0, 2, field);
    close([east.v0.x, east.v0.y, east.v1.x, east.v1.y], [eastCenter.x, eastCenter.y, eastFace.contact.x, eastFace.contact.y]);
    close([west.v0.x, west.v0.y, west.v1.x, west.v1.y], [westCenter.x, westCenter.y, westFace.contact.x, westFace.contact.y]);
    // No segment runs between the two centers, and each segment belongs to its cell alone.
    for (const segment of segments) {
      expect(segment.v1TouchesSplit).toBe(true);
      expect(segment.cellVertices1).toBeUndefined();
      expect(segment.faceLength).toBeCloseTo(Math.hypot(eastFace.v1.x - eastFace.v0.x, eastFace.v1.y - eastFace.v0.y), 6);
    }
    // The face normal points out of the segment's own cell.
    for (const segment of segments) {
      expect(segment.faceNormal!.x * (segment.v1.x - segment.v0.x) + segment.faceNormal!.y * (segment.v1.y - segment.v0.y)).toBeGreaterThan(0);
    }
  });

  it("gives a one-way passage the same direction on both copies: out of the source, into the target", () => {
    warm(cylinder);
    const segments = buildCorridorSegments(nodes, [edge([COLUMNS - 1, 1], [0, 1])], field);
    expect(segments).toHaveLength(2);
    const east = segments.find((segment) => segment.fromNode === idOf([COLUMNS - 1, 1]))!;
    const west = segments.find((segment) => segment.fromNode === idOf([0, 1]))!;
    close([east.oneWayDir!.dx, east.oneWayDir!.dy], outOf([COLUMNS - 1, 1], 0));
    const outWest = outOf([0, 1], 2);
    close([west.oneWayDir!.dx, west.oneWayDir!.dy], [-outWest[0], -outWest[1]]);
  });

  it("keeps the directions consistent on a twisted seam and on a torus corner", () => {
    warm(mobius);
    const segments = buildCorridorSegments(nodes, [edge([COLUMNS - 1, 0], [0, ROWS - 1])], field);
    expect(segments).toHaveLength(2);
    const source = segments.find((segment) => segment.fromNode === idOf([COLUMNS - 1, 0]))!;
    const target = segments.find((segment) => segment.fromNode === idOf([0, ROWS - 1]))!;
    close([source.oneWayDir!.dx, source.oneWayDir!.dy], outOf([COLUMNS - 1, 0], 0));
    const into = outOf([0, ROWS - 1], 2);
    close([target.oneWayDir!.dx, target.oneWayDir!.dy], [-into[0], -into[1]]);

    warm(torus);
    const corner = buildCorridorSegments(nodes, [edge([COLUMNS - 1, ROWS - 1], [0, ROWS - 1]), edge([COLUMNS - 1, ROWS - 1], [COLUMNS - 1, 0])], field);
    // The corner cell has two seams and each gives its own side a segment, plus the far cells' sides.
    expect(corner.filter((segment) => segment.fromNode === idOf([COLUMNS - 1, ROWS - 1]))).toHaveLength(2);
  });

  it("is unchanged without folds", () => {
    warm(null);
    expect(buildCorridorSegments(nodes, [edge([0, 0], [1, 0])], field)).toHaveLength(1);
  });
});

describe("seam hit-testing and edge highlight", () => {
  it("resolves a hit on either copy to the same logical edge", () => {
    for (const [topology, east, west] of [
      [cylinder, [COLUMNS - 1, 2], [0, 2]],
      [mobius, [COLUMNS - 1, 1], [0, ROWS - 2]],
    ] as const) {
      warm(topology);
      const eastFace = faceOf(east as [number, number], 0);
      const westFace = faceOf(west as [number, number], 2);
      const fromEast = pickEdgeAtPosition(eastFace.contact.x, eastFace.contact.y, field, cells);
      const fromWest = pickEdgeAtPosition(westFace.contact.x, westFace.contact.y, field, cells);
      expect(fromEast).not.toBeNull();
      expect(fromWest).not.toBeNull();
      expect(fromEast).toEqual(fromWest);
      expect([fromEast!.from, fromEast!.to].map(String).sort()).toEqual([String(east), String(west)].sort());
    }
  });

  it("resolves a hit near the torus corner copy of each seam", () => {
    warm(torus);
    const top = faceOf([3, ROWS - 1], 1);
    const bottom = faceOf([3, 0], 3);
    const fromTop = pickEdgeAtPosition(top.contact.x, top.contact.y, field, cells);
    const fromBottom = pickEdgeAtPosition(bottom.contact.x, bottom.contact.y, field, cells);
    expect(fromTop).toEqual(fromBottom);
    expect(fromTop!.key).toBe("3,0-3,4");
  });

  it("still picks ordinary edges", () => {
    warm(cylinder);
    const shared = getFaceEdgeSegment([2, 2], 0, field)!;
    expect(pickEdgeAtPosition(shared.contact.x, shared.contact.y, field, cells)!.key).toBe("2,2-3,2");
  });

  it("highlights both copies of a seam edge and one segment of an ordinary edge", () => {
    warm(cylinder);
    const seam = buildHoverEdgeHighlight({ key: "0,2-5,2", from: [0, 2], to: [COLUMNS - 1, 2] }, field);
    expect(seam).toHaveLength(2);
    const segments = logicalEdgeSegments([0, 2], [COLUMNS - 1, 2], field);
    expect(segments).toHaveLength(2);
    close(segments[0].contact ? [segments[0].contact.x, segments[0].contact.y] : [], [faceOf([0, 2], 2).contact.x, faceOf([0, 2], 2).contact.y]);
    close([segments[1].contact.x, segments[1].contact.y], [faceOf([COLUMNS - 1, 2], 0).contact.x, faceOf([COLUMNS - 1, 2], 0).contact.y]);
    expect(buildHoverEdgeHighlight({ key: "1,2-2,2", from: [1, 2], to: [2, 2] }, field)).toHaveLength(1);
    expect(logicalEdgeSegments([0, 0], [3, 3], field)).toEqual([]);
  });
});

describe("seam arrows", () => {
  type P = [number, number];
  const polygons = cells.map(([x, y]) => getCellVertices(x, y, field).map((v): P => [v.x, v.y]));
  /// Points along a path.
  const samples = (path: P[]): P[] => {
    const points: P[] = [];
    for (let i = 1; i < path.length; i++) {
      for (let t = 0.05; t < 1; t += 0.05) points.push([path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t]);
    }
    return points;
  };
  const cross = (p: P[], q: P[]): boolean => {
    const orient = (a: P, b: P, c: P) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    for (let i = 1; i < p.length; i++) {
      for (let j = 1; j < q.length; j++) {
        if (orient(p[i - 1], p[i], q[j - 1]) * orient(p[i - 1], p[i], q[j]) < 0 && orient(q[j - 1], q[j], p[i - 1]) * orient(q[j - 1], q[j], p[i]) < 0) return true;
      }
    }
    return false;
  };
  const along = (point: P, origin: P, dir: P): number => (point[0] - origin[0]) * dir[0] + (point[1] - origin[1]) * dir[1];

  it("is empty without folds", () => {
    warm(null);
    expect(buildSeamArrows(field)).toEqual([]);
  });

  it("draws one arrow per glue, not one per glued pair", () => {
    warm(cylinder);
    const arrows = buildSeamArrows(field, cylinder);
    expect(arrows).toHaveLength(1);
    expect(arrows[0].seams).toHaveLength(ROWS);
    expect(arrows[0].braces).toHaveLength(2);
    // Without the topology there is no grouping: every glued pair is its own arrow.
    expect(buildSeamArrows(field)).toHaveLength(ROWS);
  });

  it("draws a plain contour parallel to all the faces of each run", () => {
    const model = warm(cylinder);
    const [arrow] = buildSeamArrows(field, cylinder);
    const runs = [
      { cell: (y: number): [number, number] => model.seams[0].a.cell[0] === 0 ? [0, y] : [COLUMNS - 1, y], faceIdx: 2 },
      { cell: (y: number): [number, number] => model.seams[0].a.cell[0] === 0 ? [COLUMNS - 1, y] : [0, y], faceIdx: 0 },
    ];
    for (const run of runs) {
      const out = outOf(run.cell(0), run.faceIdx);
      const contacts = range(ROWS).map((y) => faceOf(run.cell(y), run.faceIdx).contact).map((c): P => [c.x, c.y]);
      // The bracket of this run is the one on its outer side.
      const brace = arrow.braces.find((candidate) => along(candidate[0], contacts[0], out) > 0)!;
      expect(brace).toBeDefined();
      // Every point lies on one line parallel to the faces, outside them: no bend in the middle.
      const offsets = brace.map((point) => along(point, contacts[0], out));
      for (const offset of offsets) {
        expect(offset).toBeGreaterThan(0);
        expect(offset).toBeCloseTo(offsets[0], 6);
      }
      expect(arrow.braceWidth).toBe(BRACE_WIDTH);
      // The run is covered end to end.
      const tangent: P = [out[1], -out[0]];
      const spans = contacts.map((c) => along(c, contacts[0], tangent));
      const lo = Math.min(...spans);
      const hi = Math.max(...spans);
      const braceSpans = brace.map((point) => along(point, contacts[0], tangent));
      expect(Math.min(...braceSpans)).toBeLessThan(lo);
      expect(Math.max(...braceSpans)).toBeGreaterThan(hi);
    }
  });

  it("leaves the stem from the middle of the contours, round the field, with a head at each end", () => {
    warm(cylinder);
    const [arrow] = buildSeamArrows(field, cylinder);
    expect(arrow.path.length).toBeGreaterThan(2);
    // The stem starts on the contour of one run, in its middle, and ends on the contour of the other.
    expect(arrow.braces).toHaveLength(2);
    for (const end of [arrow.path[0], arrow.path[arrow.path.length - 1]]) {
      const brace = arrow.braces.find((candidate) => {
        for (let i = 1; i < candidate.length; i++) {
          const [x0, y0] = candidate[i - 1];
          const [x1, y1] = candidate[i];
          const cross = (x1 - x0) * (end[1] - y0) - (y1 - y0) * (end[0] - x0);
          const dot = (end[0] - x0) * (x1 - x0) + (end[1] - y0) * (y1 - y0);
          if (Math.abs(cross) < 1e-6 * Math.hypot(x1 - x0, y1 - y0) && dot >= -1e-6 && dot <= (x1 - x0) ** 2 + (y1 - y0) ** 2 + 1e-6) return true;
        }
        return false;
      });
      expect(brace).toBeDefined();
    }
    for (const point of [...samples(arrow.path), ...arrow.braces.flat()]) expect(polygons.some((polygon) => insidePolygon(point, polygon))).toBe(false);
  });

  it("stands the contour off the faces by its own offset", () => {
    warm(cylinder);
    const [arrow] = buildSeamArrows(field, cylinder);
    const contact = faceOf([0, 0], 2).contact;
    const brace = arrow.braces.find((candidate) => Math.abs(candidate[0][0] - contact.x) < 2 * BRACE_OFFSET)!;
    expect(Math.abs(brace[0][0] - contact.x)).toBeCloseTo(BRACE_OFFSET, 6);
  });

  it("stops the contour short of the walls at its free ends by its own offset", () => {
    warm(cylinder);
    const [arrow] = buildSeamArrows(field, cylinder);
    const ys = cells.flatMap(([x, y]) => getCellVertices(x, y, field).map((vertex) => vertex.y));
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    for (const brace of arrow.braces) {
      const braceYs = brace.map((point) => point[1]);
      expect(Math.min(...braceYs) - top).toBeCloseTo(BRACE_OFFSET, 6);
      expect(bottom - Math.max(...braceYs)).toBeCloseTo(BRACE_OFFSET, 6);
    }
  });

  it("goes straight through a cell instead of looping when the way out to a ring is blocked by one anyway", () => {
    const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    const axes = [{ ux: 1, uy: 0 }, { ux: 0, uy: 1 }];
    const ports: [{ contact: Point; out: Point }, { contact: Point; out: Point }] = [
      { contact: [0, 0], out: [-1, 0] },
      { contact: [10, 0], out: [1, 0] },
    ];
    const field = rect(0, -1, 10, 1);
    // Clear outside both faces: the route loops round the field.
    const [looped] = routeAll([ports], [field], 1, axes);
    expect(looped.length).toBeGreaterThan(2);
    // A cell on the way out of the first face: the loop would cross it too, so the route is the plain line.
    const [direct] = routeAll([ports], [field, rect(-3, -1, -2, 1)], 1, axes);
    expect(direct).toEqual([ports[0].contact, ports[1].contact]);
  });

  it("takes the axes of a connector from the glued faces: across each and along it", () => {
    const axes = portAxes([{ contact: [0, 0], out: [1, 0] }, { contact: [0, 3], out: [1, 0] }, { contact: [4, 4], out: [0, 2] }]);
    expect(axes).toHaveLength(2);
    const hexOut: [number, number] = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
    const hex = portAxes([{ contact: [0, 0], out: hexOut }]);
    expect(hex).toHaveLength(2);
    expect(Math.abs(hex[0].ux * hex[1].ux + hex[0].uy * hex[1].uy)).toBeLessThan(1e-9);
  });

  it("keeps a connector at least a cell away from the contours instead of lying along them", () => {
    const axes = [{ ux: 1, uy: 0 }, { ux: 0, uy: 1 }];
    // Two faces one cell apart on the same wall: the straight line between them would run along the wall and its contour.
    const ports: [{ contact: Point; out: Point }, { contact: Point; out: Point }] = [
      { contact: [0, 0], out: [1, 0] },
      { contact: [0, 3], out: [1, 0] },
    ];
    const contour: Point[] = [[0.2, -0.5], [0.2, 3.5]];
    const [route] = routeAll([ports], [[[-2, -1], [0, -1], [0, 4], [-2, 4]]], 1, axes, [contour]);
    // A short step out across the faces, a run parallel to the wall, and a step back; not a loop round the field.
    expect(route).toHaveLength(4);
    expect(route[1][0]).toBeCloseTo(route[2][0], 9);
    expect(route[1][1]).toBeCloseTo(route[0][1], 9);
    expect(route[2][1]).toBeCloseTo(route[3][1], 9);
    for (let i = 1; i < route.length; i++) {
      const parallel = Math.abs(route[i][0] - route[i - 1][0]) < 1e-9;
      if (parallel) expect(Math.abs(route[i][0] - contour[0][0])).toBeGreaterThanOrEqual(1);
    }
  });

  it("gives every glued pair its own route between the contours", () => {
    warm(cylinder);
    const [arrow] = buildSeamArrows(field, cylinder);
    expect(arrow.pairs).toHaveLength(ROWS);
    for (const pair of arrow.pairs) {
      // The pair's route runs from its own anchor on one contour to its partner's anchor on the other.
      expect(Math.hypot(pair.path[0][0] - pair.anchors[0][0], pair.path[0][1] - pair.anchors[0][1])).toBeLessThan(arrow.headLength * 2);
      const end = pair.path[pair.path.length - 1];
      expect(Math.hypot(end[0] - pair.anchors[1][0], end[1] - pair.anchors[1][1])).toBeLessThan(arrow.headLength * 2);
    }
    // Hovering the contour at one face picks the pair of that face; off the contour picks none.
    const side = arrow.braceSides[0];
    for (let k = 0; k < arrow.pairs.length; k++) {
      expect(pairAt(arrow, arrow.pairs[k].anchors[side], 1)).toBe(k);
    }
    expect(pairAt(arrow, [-1e6, -1e6], 1)).toBeNull();
  });

  it("centres the hover zone of a face on its contour", () => {
    warm(cylinder);
    const [arrow] = buildSeamArrows(field, cylinder);
    const west = faceOf([0, 2], 2).contact;
    const east = faceOf([COLUMNS - 1, 2], 0).contact;
    const pair = arrow.pairs[2];
    const xs = (zone: [number, number][]) => [Math.min(...zone.map((p) => p[0])), Math.max(...zone.map((p) => p[0]))];
    // The contour lies BRACE_OFFSET out of the face, the zone reaches from the face to twice that.
    const [westMin, westMax] = xs(pair.zones[arrow.braceSides[0] === 0 ? 1 : 0] as [number, number][]);
    const [eastMin, eastMax] = xs(pair.zones[arrow.braceSides[0]] as [number, number][]);
    const spans = [[westMin, westMax], [eastMin, eastMax]];
    const faces = [west.x, east.x];
    for (const face of faces) {
      const centred = spans.some(([lo, hi]) => Math.abs((lo + hi) / 2 - face) > 0 && Math.abs(hi - lo - 2 * BRACE_OFFSET) < 1e-6
        && (Math.abs((lo + hi) / 2 - (face - BRACE_OFFSET)) < 1e-6 || Math.abs((lo + hi) / 2 - (face + BRACE_OFFSET)) < 1e-6));
      expect(centred).toBe(true);
    }
  });

  it("colours every glue differently by hue", () => {
    const colors = [0, 1, 2, 3].map((i) => glueColor(i, 4, false));
    expect(new Set(colors).size).toBe(4);
    expect(glueColor(0, 1, false)).toBe(glueColor(0, 1, false));
    expect(glueColor(1, 4, true)).not.toBe(glueColor(1, 4, false));
  });

  it("keeps the arrows of separate glues from crossing each other", () => {
    const topology = groupedTopology([cylinderFolds.slice(0, 2), cylinderFolds.slice(2)]);
    warm(topology);
    const arrows = buildSeamArrows(field, topology);
    expect(arrows).toHaveLength(2);
    expect(cross(arrows[0].path, arrows[1].path)).toBe(false);
  });

  it("keeps the arrows of a cylinder glued pair by pair from crossing each other", () => {
    const topology = eachFoldAlone(cylinderFolds);
    warm(topology);
    const arrows = buildSeamArrows(field, topology);
    expect(arrows).toHaveLength(ROWS);
    for (let i = 0; i < arrows.length; i++) {
      for (let j = i + 1; j < arrows.length; j++) expect(cross(arrows[i].path, arrows[j].path)).toBe(false);
    }
  });

  it("goes straight, with no brackets, when the way between single faces is clear", () => {
    // Two cells with nothing between them: the straight line crosses no cell.
    const gapField = fieldOf("square", { shape: "custom", points: [[0, 0], [3, 0]] });
    const topology = topologyOf([{ a: { cell: [0, 0], face_idx: 0 }, b: { cell: [3, 0], face_idx: 2 }, twist: false }]);
    warmCartesianCache(gapField, topology);
    const arrows = buildSeamArrows(gapField, topology);
    expect(arrows).toHaveLength(1);
    expect(arrows[0].path).toHaveLength(2);
    expect(arrows[0].braces).toHaveLength(0);
  });

  it("marks a twisted glue and puts its middle on the route", () => {
    warm(mobius);
    const arrows = buildSeamArrows(field, mobius);
    expect(arrows).toHaveLength(1);
    const [arrow] = arrows;
    expect(arrow.twist).toBe(true);
    expect(Math.hypot(arrow.midDir[0], arrow.midDir[1])).toBeCloseTo(1, 6);
    const onRoute = arrow.path.slice(1).some((point, i) => {
      const from = arrow.path[i];
      return Math.abs(Math.hypot(from[0] - arrow.mid[0], from[1] - arrow.mid[1]) + Math.hypot(arrow.mid[0] - point[0], arrow.mid[1] - point[1]) - Math.hypot(from[0] - point[0], from[1] - point[1])) < 1e-6;
    });
    expect(onRoute).toBe(true);
  });

  it("draws one arrow for each glue of a torus", () => {
    warm(torus);
    const arrows = buildSeamArrows(field, torus);
    expect(arrows).toHaveLength(2);
    expect(arrows.map((arrow) => arrow.seams.length).sort()).toEqual([ROWS, COLUMNS].sort());
    expect(new Set(arrows.map((arrow) => arrow.group)).size).toBe(2);
  });

  it("draws every body whole, with no gaps", () => {
    const topology = eachFoldAlone([...cylinderFolds, ...wrapFolds]);
    warm(topology);
    for (const arrow of buildSeamArrows(field, topology)) expect(arrow.bodies).toEqual([arrow.path]);
  });

  it("puts overlapping runs on different rings, so no two bodies run along each other", () => {
    for (const topology of [eachFoldAlone(cylinderFolds), eachFoldAlone([...cylinderFolds, ...wrapFolds]), eachFoldAlone(mobiusFolds)]) {
      warm(topology);
      const arrows = buildSeamArrows(field, topology);
      const collinearOverlap = (p: P[], q: P[]): boolean => {
        for (let i = 1; i < p.length; i++) {
          for (let j = 1; j < q.length; j++) {
            const horizontal = Math.abs(p[i][1] - p[i - 1][1]) < 1e-9 && Math.abs(q[j][1] - q[j - 1][1]) < 1e-9 && Math.abs(p[i][1] - q[j][1]) < 1e-9;
            const vertical = Math.abs(p[i][0] - p[i - 1][0]) < 1e-9 && Math.abs(q[j][0] - q[j - 1][0]) < 1e-9 && Math.abs(p[i][0] - q[j][0]) < 1e-9;
            if (!horizontal && !vertical) continue;
            const axis: 0 | 1 = horizontal ? 0 : 1;
            const lo = Math.max(Math.min(p[i][axis], p[i - 1][axis]), Math.min(q[j][axis], q[j - 1][axis]));
            const hi = Math.min(Math.max(p[i][axis], p[i - 1][axis]), Math.max(q[j][axis], q[j - 1][axis]));
            if (hi - lo > 1e-6) return true;
          }
        }
        return false;
      };
      for (let i = 0; i < arrows.length; i++) {
        for (let j = i + 1; j < arrows.length; j++) expect(collinearOverlap(arrows[i].path, arrows[j].path)).toBe(false);
      }
    }
  });

  it("stands a head at each end of the route, pointing away from the run along the body", () => {
    warm(cylinder);
    const [arrow] = buildSeamArrows(field, cylinder);
    const ends: [P, P, P[]][] = [
      [arrow.path[0], arrow.path[1], arrow.headA],
      [arrow.path[arrow.path.length - 1], arrow.path[arrow.path.length - 2], arrow.headB],
    ];
    for (const [end, next, head] of ends) {
      const length = Math.hypot(next[0] - end[0], next[1] - end[1]);
      const dir: P = [(next[0] - end[0]) / length, (next[1] - end[1]) / length];
      // The base sits at the end of the route, the tip further along the body.
      expect(along(head[1], end, dir)).toBeCloseTo(0, 6);
      expect(along(head[2], end, dir)).toBeCloseTo(0, 6);
      expect(along(head[0], end, dir)).toBeCloseTo(arrow.headLength, 6);
    }
  });

  it("hits an arrow on its body, brackets and heads and nowhere else", () => {
    warm(cylinder);
    const [arrow] = buildSeamArrows(field, cylinder);
    expect(arrowContains(arrow, arrow.mid)).toBe(true);
    expect(arrowContains(arrow, arrow.headA[0])).toBe(true);
    expect(arrowContains(arrow, arrow.headB[0])).toBe(true);
    expect(arrowContains(arrow, arrow.braces[0][0])).toBe(true);
    expect(arrowContains(arrow, [arrow.mid[0] + 1000, arrow.mid[1] + 1000])).toBe(false);
  });

  it("builds a head with its tip ahead and its base across the flow behind", () => {
    const head = headPolygon([10, 20], [0, 1], 8, 6);
    expect(head).toHaveLength(3);
    close(head[0], [10, 20]);
    close([(head[1][0] + head[2][0]) / 2, (head[1][1] + head[2][1]) / 2], [10, 12]);
    expect(Math.abs(head[1][0] - head[2][0])).toBeCloseTo(6, 6);
  });
});

describe("seam graph hops", () => {
  const posOf = (cell: [number, number]) => {
    const center = getCellCenter(cell[0], cell[1], field);
    return { x: center.x, y: center.y };
  };
  const nodePos = new Map(nodes.map((node) => [node.id, posOf([node.x, node.y])]));

  const seamContext = (): SeamHopContext => {
    const cells = new Map(nodes.map((node) => [node.id, [node.x, node.y] as [number, number]]));
    const pairs = buildSeamArrows(field, null).flatMap((arrow) => arrow.pairs);
    return { cfg: field, cellOf: (id) => cells.get(id), pairs: new Map(pairs.map((pair) => [pair.seam, pair])) };
  };

  it("draws a hop through a seam as two stubs that end at the slots of the glue", () => {
    warm(cylinder);
    const ctx = seamContext();
    const from: [number, number] = [COLUMNS - 1, 2];
    const to: [number, number] = [0, 2];
    const pieces = seamHopPieces(idOf(from), idOf(to), nodePos, ctx)!;
    expect(pieces).toHaveLength(2);
    const [out, into] = pieces;
    const pair = ctx.pairs.get(getSeamModel(field).halfEdgeBetween(from, to)!.seam)!;
    const slotOf = (cell: [number, number]) => pair.slots.find((slot) => slot.cell[0] === cell[0] && slot.cell[1] === cell[1])!;
    const fromNode = nodePos.get(idOf(from))!;
    const toNode = nodePos.get(idOf(to))!;
    close([out.path[0].x, out.path[0].y], [fromNode.x, fromNode.y]);
    close([out.path[1].x, out.path[1].y], slotOf(from).at);
    close([into.path[0].x, into.path[0].y], slotOf(to).at);
    close([into.path[1].x, into.path[1].y], [toNode.x, toNode.y]);
    expect(out.path).toHaveLength(2);
    expect(into.path).toHaveLength(2);
    // Open at the slot, trimmed at the node.
    expect([out.trimStart, out.trimEnd]).toEqual([true, false]);
    expect([into.trimStart, into.trimEnd]).toEqual([false, true]);
  });

  it("breaks a hovered link across a glue into two stubs without markers at the contour, and focuses its pair", () => {
    warm(cylinder);
    const ctx = seamContext();
    const from: [number, number] = [COLUMNS - 1, 2];
    const to: [number, number] = [0, 2];
    const entity = { kind: "link" as const, from: { point: from }, to: { point: to } };
    const { link } = buildHoveredEntityHighlight(entity, nodes, 0, field, ctx);
    expect(link).toHaveLength(2);
    expect(link[0].toMarker).toBe(false);
    expect(link[1].fromMarker).toBe(false);
    // Without the context the link stays one line across.
    expect(buildHoveredEntityHighlight(entity, nodes, 0, field).link).toHaveLength(1);
    const seam = getSeamModel(field).halfEdgeBetween(from, to)!.seam;
    const arrows = buildSeamArrows(field, null);
    const focus = seamFocusOf(arrows, seam)!;
    expect(arrows[focus.arrow].pairs[focus.pair].seam).toBe(seam);
    expect(seamFocusOf(arrows, 9999)).toBeNull();
  });

  it("gives each face of a pair a slot on its anchor", () => {
    warm(cylinder);
    for (const arrow of buildSeamArrows(field, null)) {
      for (const pair of arrow.pairs) {
        pair.slots.forEach((slot, side) => {
          close(slot.at, pair.anchors[side]);
        });
      }
    }
  });

  it("keeps an ordinary hop a single straight line", () => {
    warm(cylinder);
    const ctx = seamContext();
    const a = idOf([1, 1]);
    const b = idOf([2, 1]);
    expect(seamHopPieces(a, b, nodePos, ctx)).toBeNull();
    const pieces = hopPieces(a, b, nodePos, ctx);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].trimStart && pieces[0].trimEnd).toBe(true);
  });

  it("draws every hop as one straight line without a seam context", () => {
    warm(cylinder);
    expect(hopPieces(idOf([COLUMNS - 1, 0]), idOf([0, 0]), nodePos, undefined)).toHaveLength(1);
  });

  it("emits the two stubs instead of a straight cross-field line for a paired seam edge", () => {
    warm(cylinder);
    const ctx = seamContext();
    const east = idOf([COLUMNS - 1, 3]);
    const west = idOf([0, 3]);
    const rendered = buildPairedRenderEdges([{ from: east, to: west }, { from: west, to: east }], nodePos, ctx);
    // Each direction is two short stubs; none of them spans from a centre to the other centre.
    expect(rendered).toHaveLength(4);
    for (const renderEdge of rendered) expect(renderEdge.path).toHaveLength(2);
  });

  it("splits a nav path at a seam into a line to the slot and a line from the partner slot", () => {
    warm(cylinder);
    const ctx = seamContext();
    const ids = [idOf([COLUMNS - 2, 3]), idOf([COLUMNS - 1, 3]), idOf([0, 3]), idOf([1, 3])];
    const rendered = buildPathRenderEdges([{ path: ids }], nodePos, undefined, ctx);
    expect(rendered).toHaveLength(2);
    expect([rendered[0].trimStart, rendered[0].trimEnd]).toEqual([true, false]);
    expect([rendered[1].trimStart, rendered[1].trimEnd]).toEqual([false, true]);
    expect(rendered[0].path).toHaveLength(3);
    expect(rendered[1].path).toHaveLength(3);
  });
});

describe("seam boundary highlight", () => {
  const recorder = () => {
    const calls: string[] = [];
    const g: Graphics = new Proxy({} as Graphics, {
      get: (_target, name: string) => (..._args: unknown[]) => {
        calls.push(name);
        return g;
      },
    });
    return { g, fills: () => calls.filter((name) => name === "fill").length };
  };

  it("draws one band across an ordinary boundary", () => {
    warm(cylinder);
    const { g, fills } = recorder();
    expect(drawCellBoundaryHighlight(g, [1, 1], [2, 1], field, 0xff0000)).toBe(true);
    expect(fills()).toBe(1);
  });

  it("draws a band on each side of a seam", () => {
    warm(cylinder);
    const { g, fills } = recorder();
    expect(drawCellBoundaryHighlight(g, [COLUMNS - 1, 2], [0, 2], field, 0xff0000)).toBe(true);
    expect(fills()).toBe(2);
  });

  it("draws a band on each side of a twisted seam", () => {
    warm(mobius);
    const half = getSeamModel(field).halfEdgesOf([COLUMNS - 1, 1])[0];
    const { g, fills } = recorder();
    expect(drawCellBoundaryHighlight(g, [COLUMNS - 1, 1], half ? getSeamModel(field).partnerOf(half).cell : [0, 0], field, 0xff0000)).toBe(true);
    expect(fills()).toBe(2);
  });
});

describe("seam split passages", () => {
  // Both border cells of one row are split in two; slot 0 of each is joined across the seam.
  const east: [number, number] = [COLUMNS - 1, 2];
  const west: [number, number] = [0, 2];
  const base = nodes.length;
  const splitNodes: NodeDto[] = [
    ...nodes,
    { id: base, x: east[0], y: east[1], i: 1 },
    { id: base + 1, x: west[0], y: west[1], i: 1 },
  ];
  const passage: EdgeDto[] = [
    { from: idOf(east), to: idOf(west), kind: "basic" },
    { from: idOf(west), to: idOf(east), kind: "basic" },
  ];

  it("divides each side's own copy of the glued face", () => {
    warm(cylinder);
    const { passages } = buildSplitPassages(splitNodes, passage, field);
    for (const [cell, faceIdx] of [[east, 0], [west, 2]] as const) {
      const own = passages.find((p) => p.pointKey === `${cell[0]},${cell[1]}` && p.nodeIndex === 0)!;
      expect(own.wallSegments).toHaveLength(1);
      const face = faceOf(cell, faceIdx);
      const segment = own.wallSegments[0];
      // The segment lies on this side's own face, not on the partner's copy across the field.
      for (const point of [segment.v0, segment.v1]) {
        const onFace = [face.v0, face.v1].some((end) => Math.hypot(end.x - point.x, end.y - point.y) < 1e-6)
          || face.polyline.some(([x, y]) => Math.hypot(x - point.x, y - point.y) < 1e-6);
        expect(onFace).toBe(true);
      }
    }
  });

  it("draws no passage across the face of a field without folds", () => {
    warm(null);
    const { passages } = buildSplitPassages(splitNodes, passage, field);
    expect(passages.filter((p) => p.nodeIndex === 0 && p.wallSegments.length > 0)).toHaveLength(0);
  });
});

describe("seam route axes", () => {
  const square: Point[][] = [];
  const box = boundsOf(square, [[0, 0], [100, 40]]);
  const axes = [{ ux: 1, uy: 0 }, { ux: 0, uy: 1 }];
  const port = (x: number, y: number, ox: number, oy: number) => ({ contact: [x, y] as Point, out: [ox, oy] as Point });

  it("goes straight only along an axis", () => {
    const along = routePair([port(0, 0, 0, -1), port(100, 0, 0, -1)], [], square, box, 10, axes);
    expect(along).toEqual([[0, 0], [100, 0]]);
    const slanted = routePair([port(0, 0, 0, -1), port(100, 40, 0, -1)], [], square, box, 10, axes);
    expect(slanted.length).toBeGreaterThan(2);
  });
});
