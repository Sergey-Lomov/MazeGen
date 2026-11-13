import { describe, expect, it, vi } from "vitest";
import { warmCartesianCache } from "../pixi/cartesianCache";
import { WallRenderer } from "../pixi/renderers/WallRenderer";
import { buildCorridorSegments, buildMazeWalls } from "../pixi/selectors/mazeSelectors";
import { buildCorridorLineTiles } from "../pixi/imageExport/vectorByCorridorsLineTiles";
import { buildCorridorContour, contourToPolyline } from "../pixi/imageExport/vectorByCorridorsContour";
import { getSeamModel } from "../pixi/selectors/seams";
import { getCellCenter, getCellVertices, getFaceEdgeSegment, getNeighborData } from "../pixi/tessellationGeometry";
import { trimMaskPolygons } from "../pixi/imageExport/VectorByWallsRenderer";
import type { EdgeDto, NodeDto, WireFold, WireTopology } from "../wasm/types";
import { range } from "./seamFixtures";
import { fieldOf } from "./fieldConfigFixtures";
import { TESSELLATION_UI } from "../pixi/geometry/tessellationUi";
import type { TessellationKind } from "../fieldConfig";

// Seam export (GitHub issue #842, `Specs/image-export.md`, "Seams in export"): both vector export
// modes draw a passage toward a seam as one half per side, from the cell to its own glued face. They
// read the shared seam model through `buildMazeWalls` / `buildCorridorSegments`, so these tests drive
// the real selectors into the real geometry each mode draws, on the same 6x5 square field as
// `seamRendering.test.ts` (face 0 is east, 1 north, 2 west, 3 south). Expected points come from the
// display helpers, never from hand-written numbers.

type Cell = [number, number];
type FoldInput = Omit<WireFold, "group">;

vi.mock("pixi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pixi.js")>();
  const Graphics = vi.fn().mockImplementation(function () {
    const g: object = new Proxy({}, {
      get: (_target, name: string) => (...args: unknown[]) => {
        if (name === "moveTo" || name === "lineTo") recorder.path.push([args[0] as number, args[1] as number]);
        if (name === "stroke" || name === "fill") {
          if (recorder.path.length > 0) recorder.strokes.push(recorder.path);
          recorder.path = [];
        }
        return g;
      },
    });
    return g;
  });
  return { ...actual, Graphics };
});

const recorder: { path: [number, number][]; strokes: [number, number][][] } = { path: [], strokes: [] };

const COLUMNS = 6;
const ROWS = 5;
const cells: Cell[] = [];
for (let x = 0; x < COLUMNS; x++) for (let y = 0; y < ROWS; y++) cells.push([x, y]);
const field = fieldOf("square", { shape: "custom", points: cells });
const singleCellField = fieldOf("square", { shape: "custom", points: [[0, 0]] });

const nodes: NodeDto[] = cells.map(([x, y], id) => ({ id, x, y, i: 0 }));
const idOf = ([x, y]: Cell): number => nodes.find((node) => node.x === x && node.y === y)!.id;
const passage = (a: Cell, b: Cell): EdgeDto[] => [
  { from: idOf(a), to: idOf(b), kind: "basic" },
  { from: idOf(b), to: idOf(a), kind: "basic" },
];

const topologyOf = (lists: FoldInput[][]): WireTopology => {
  const folds: WireFold[] = [];
  const groups: WireTopology["groups"] = [];
  lists.forEach((list, group) => {
    groups.push({ id: group, folds: list.map((_, i) => folds.length + i) });
    folds.push(...list.map((fold) => ({ ...fold, group })));
  });
  return { fingerprint: "square{}", folds, groups };
};
const cylinderFolds = range(ROWS).map((y): FoldInput => ({ a: { cell: [COLUMNS - 1, y], face_idx: 0 }, b: { cell: [0, y], face_idx: 2 }, twist: false }));
const wrapFolds = range(COLUMNS).map((x): FoldInput => ({ a: { cell: [x, ROWS - 1], face_idx: 1 }, b: { cell: [x, 0], face_idx: 3 }, twist: false }));
const mobiusFolds = range(ROWS).map((y): FoldInput => ({ a: { cell: [COLUMNS - 1, y], face_idx: 0 }, b: { cell: [0, ROWS - 1 - y], face_idx: 2 }, twist: true }));

/// One open passage through a seam: the two cells and the face each sees the seam on.
interface SeamCase {
  name: string;
  topology: WireTopology;
  sides: [{ cell: Cell; face: number }, { cell: Cell; face: number }];
}
const cases: SeamCase[] = [
  { name: "cylinder", topology: topologyOf([cylinderFolds]), sides: [{ cell: [COLUMNS - 1, 2], face: 0 }, { cell: [0, 2], face: 2 }] },
  { name: "torus (horizontal seam)", topology: topologyOf([cylinderFolds, wrapFolds]), sides: [{ cell: [COLUMNS - 1, 2], face: 0 }, { cell: [0, 2], face: 2 }] },
  { name: "torus (vertical seam)", topology: topologyOf([cylinderFolds, wrapFolds]), sides: [{ cell: [3, ROWS - 1], face: 1 }, { cell: [3, 0], face: 3 }] },
  { name: "mobius", topology: topologyOf([mobiusFolds]), sides: [{ cell: [COLUMNS - 1, 0], face: 0 }, { cell: [0, ROWS - 1], face: 2 }] },
];

const near = (p: { x: number; y: number }, q: { x: number; y: number }, tolerance = 1e-6): boolean => Math.hypot(p.x - q.x, p.y - q.y) <= tolerance;

/// Whether a point lies inside any of the flat `[x0, y0, x1, y1, …]` polygons (even-odd ray casting).
const boundsOf = new WeakMap<number[], [number, number, number, number]>();
const insideAny = (polygons: number[][], px: number, py: number): boolean => polygons.some((polygon) => {
  let bounds = boundsOf.get(polygon);
  if (!bounds) {
    const xs = polygon.filter((_, i) => i % 2 === 0);
    const ys = polygon.filter((_, i) => i % 2 === 1);
    bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    boundsOf.set(polygon, bounds);
  }
  if (px < bounds[0] || px > bounds[2] || py < bounds[1] || py > bounds[3]) return false;
  let hit = false;
  for (let i = 0, j = polygon.length - 2; i < polygon.length; j = i, i += 2) {
    if ((polygon[i + 1] > py) !== (polygon[j + 1] > py) && px < ((polygon[j] - polygon[i]) * (py - polygon[i + 1])) / (polygon[j + 1] - polygon[i + 1]) + polygon[i]) hit = !hit;
  }
  return hit;
});
const faceOf = (cell: Cell, face: number) => getFaceEdgeSegment(cell, face, field)!;
const centerOf = (cell: Cell) => getCellCenter(cell[0], cell[1], field);

describe.each(cases)("seam export: $name", ({ name, topology, sides }) => {
  const isTorus = name.startsWith("torus");
  const [first, second] = sides;
  const open = passage(first.cell, second.cell);
  const prepare = () => warmCartesianCache(field, topology);

  it("extends the clipping mask only through unglued field faces", () => {
    prepare();
    const model = getSeamModel(field);
    const cellSet = new Set(cells.map(([x, y]) => `${x},${y}`));
    const ordinaryBoundaryFaces = cells.flatMap(([x, y]) => getNeighborData(field, x, y).offsets.filter(([dx, dy], face) =>
      !model.halfEdgeAt([x, y], face) && ((dx === 0 && dy === 0) || !cellSet.has(`${x + dx},${y + dy}`)),
    ));
    // One cell polygon per cell, plus one straight outward strip per ordinary square-field face
    // and convex corner wedges. No strip is produced for either side of an active seam.
    expect(trimMaskPolygons(cells, field, 100).length).toBeGreaterThanOrEqual(cells.length + ordinaryBoundaryFaces.length);
  });

  it("keeps the mask over every ordinary edge and cuts it exactly at each glued face", () => {
    prepare();
    const model = getSeamModel(field);
    const polygons = trimMaskPolygons(cells, field, 100);
    let ordinary = 0, glued = 0;
    for (const cell of cells) {
      const center = centerOf(cell);
      for (const [face, [dx, dy]] of getNeighborData(field, ...cell).offsets.entries()) {
        const isGlued = Boolean(model.halfEdgeAt(cell, face));
        if (!isGlued && !((dx === 0 && dy === 0) || !cells.some(([x, y]) => x === cell[0] + dx && y === cell[1] + dy))) continue;
        const { v0, v1 } = faceOf(cell, face);
        const length = Math.hypot(v1.x - v0.x, v1.y - v0.y);
        const sign = (v1.y - v0.y) * ((v0.x + v1.x) / 2 - center.x) - (v1.x - v0.x) * ((v0.y + v1.y) / 2 - center.y) < 0 ? -1 : 1;
        const [nx, ny] = [(sign * (v1.y - v0.y)) / length, (-sign * (v1.x - v0.x)) / length];
        // Over the middle of the face, from the wall outward.
        for (const along of [0.25, 0.5, 0.75]) {
          for (const away of [3, 25]) {
            const covered = insideAny(polygons, v0.x + (v1.x - v0.x) * along + nx * away, v0.y + (v1.y - v0.y) * along + ny * away);
            expect(covered, `${cell} face ${face} ${isGlued ? "glued" : "ordinary"} along ${along} away ${away}`).toBe(!isGlued);
          }
        }
        if (isGlued) glued++; else ordinary++;
      }
    }
    // A torus has no ordinary edge at all.
    expect(glued).toBeGreaterThan(0);
    expect(ordinary > 0).toBe(!isTorus);
  });

  describe("vector by corridors", () => {
    const segments = () => {
      prepare();
      return buildCorridorSegments(nodes, open, field);
    };

    it("line tiles (miter and round) give each side one port from its own centre to its own face", () => {
      for (const join of ["miter", "round"] as const) {
        const tiles = buildCorridorLineTiles(segments(), 10, join);
        // Only the two glued cells carry a corridor: nothing runs across the field between them.
        expect(tiles).toHaveLength(2);
        for (const side of sides) {
          const center = centerOf(side.cell);
          const contact = faceOf(side.cell, side.face).contact;
          const tile = tiles.find((candidate) => near(candidate.offset, center))!;
          expect(tile).toBeDefined();
          expect(tile.ports).toHaveLength(1);
          expect(near(tile.ports[0], { x: contact.x - center.x, y: contact.y - center.y })).toBe(true);
        }
      }
    });

    it("contour reaches both faces and stays inside the two glued cells", () => {
      const input = segments();
      const width = input[0].faceLength! * 0.4;
      const paths = buildCorridorContour(input, width, 2);
      expect(paths.length).toBeGreaterThan(0);
      const points = paths.flatMap((path) => contourToPolyline(path));
      const boxes = sides.map((side) => {
        const vertices = getCellVertices(side.cell[0], side.cell[1], field);
        return {
          minX: Math.min(...vertices.map((v) => v.x)), maxX: Math.max(...vertices.map((v) => v.x)),
          minY: Math.min(...vertices.map((v) => v.y)), maxY: Math.max(...vertices.map((v) => v.y)),
        };
      });
      const eps = 1e-6;
      for (const point of points) {
        expect(boxes.some((b) => point.x >= b.minX - eps && point.x <= b.maxX + eps && point.y >= b.minY - eps && point.y <= b.maxY + eps)).toBe(true);
      }
      // The mouth of each half lies on that side's own face.
      for (const side of sides) {
        const face = faceOf(side.cell, side.face);
        expect(points.some((point) => near(point, face.contact, width))).toBe(true);
      }
    });
  });

  describe("vector by walls", () => {
    const strokedWalls = (edges: EdgeDto[]) => {
      prepare();
      recorder.path = [];
      recorder.strokes = [];
      new WallRenderer({ addChild: () => {} } as never).render({ edges: buildMazeWalls(nodes, edges, field) }, field);
      return recorder.strokes;
    };
    /// A stroke that runs along the whole glued face, from one end to the other.
    const onFace = (stroke: [number, number][], side: { cell: Cell; face: number }): boolean => {
      const face = faceOf(side.cell, side.face);
      const ends = [face.v0, face.v1];
      return ends.every((end) => stroke.some(([x, y]) => near({ x, y }, end))) && stroke.every(([x, y]) => ends.some((end) => near({ x, y }, end)));
    };

    it("walls off each side's own copy of a closed seam face", () => {
      const strokes = strokedWalls([]);
      for (const side of sides) expect(strokes.filter((stroke) => onFace(stroke, side))).toHaveLength(1);
    });

    it("draws no wall on either side of an open seam passage and keeps the neighbouring walls", () => {
      const strokes = strokedWalls(open);
      for (const side of sides) expect(strokes.some((stroke) => onFace(stroke, side))).toBe(false);
      const closed = strokedWalls([]);
      // Only the two faces of the passage were taken out.
      expect(strokes).toHaveLength(closed.length - 2);
    });
  });
});

describe("Vector-by-walls trim mask", () => {
  it("fills every convex outer corner beyond its two face strips", () => {
    // Its three ordinary face strips meet in two convex corners, each requiring one extra wedge.
    expect(trimMaskPolygons([[0, 0]], singleCellField, 100)).toHaveLength(6);
  });

  // Every point within a few wall widths of an ordinary field edge must stay under the mask: the walls
  // are drawn across the edge, so a sliver in the mask cuts them (GitHub issue #999). Corners between
  // faces of different cells (3.3.4.3.4, hexagons) and curved edges are the cases that opened one.
  // `radial` and `voronoi` have cells only inside a generated field instance, so a blob grown from the
  // origin cell is not available for them.
  const BLOB_KINDS = (Object.keys(TESSELLATION_UI) as TessellationKind[]).filter((kind) => kind !== "radial" && kind !== "voronoi");
  it.each(BLOB_KINDS)("covers the outer edge of a %s blob with the trim mask", (kind) => {
    const cfg = fieldOf(kind, { shape: "rect", cols: 4, rows: 4 });
    // The geometry cache is shared by the whole file: rewarm it for this field, not an earlier test's.
    warmCartesianCache(cfg);
    // A connected blob of cells from the tessellation's origin cell, walked over real neighbors.
    const [ox, oy] = TESSELLATION_UI[kind].originCell;
    const blob = new Map<string, Cell>([[`${ox},${oy}`, [ox, oy]]]);
    const queue: Cell[] = [[ox, oy]];
    for (let cell = queue.shift(); cell && blob.size < 60; cell = queue.shift()) {
      for (const [dx, dy] of getNeighborData(cfg, ...cell).offsets) {
        const next: Cell = [cell[0] + dx, cell[1] + dy];
        if (blob.has(`${next}`) || (dx === 0 && dy === 0) || blob.size >= 60) continue;
        blob.set(`${next}`, next);
        queue.push(next);
      }
    }
    const cells = [...blob.values()];
    const polygons = trimMaskPolygons(cells, cfg, 100);
    const cellPolygons = cells.map((cell) => getCellVertices(...cell, cfg).flatMap(({ x, y }) => [x, y]));
    let checked = 0;
    for (const cell of cells) {
      for (const [face, [dx, dy]] of getNeighborData(cfg, ...cell).offsets.entries()) {
        if ((dx !== 0 || dy !== 0) && blob.has(`${cell[0] + dx},${cell[1] + dy}`)) continue;
        for (const [vx, vy] of getFaceEdgeSegment(cell, face, cfg)!.polyline) {
          // Off-axis angles keep the samples off the cells' own straight edges.
          for (let angle = 1.7; angle < 360; angle += 11) {
            for (const distance of [3, 25]) {
              const px = vx + Math.cos((angle * Math.PI) / 180) * distance;
              const py = vy + Math.sin((angle * Math.PI) / 180) * distance;
              if (insideAny(cellPolygons, px, py)) continue;
              checked++;
              expect(insideAny(polygons, px, py), `${cell} face ${face} at ${vx.toFixed(1)},${vy.toFixed(1)} angle ${angle} distance ${distance}`).toBe(true);
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
