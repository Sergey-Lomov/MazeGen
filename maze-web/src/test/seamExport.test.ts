import { describe, expect, it, vi } from "vitest";
import { warmCartesianCache } from "../pixi/cartesianCache";
import { WallRenderer } from "../pixi/renderers/WallRenderer";
import { buildCorridorSegments, buildMazeWalls } from "../pixi/selectors/mazeSelectors";
import { buildCorridorLineTiles } from "../pixi/imageExport/vectorByCorridorsLineTiles";
import { buildCorridorContour, contourToPolyline } from "../pixi/imageExport/vectorByCorridorsContour";
import { getCellCenter, getCellVertices, getFaceEdgeSegment } from "../pixi/tessellationGeometry";
import type { EdgeDto, NodeDto, WireFold, WireTopology } from "../wasm/types";
import { range } from "./seamFixtures";
import { fieldOf } from "./fieldConfigFixtures";

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
const faceOf = (cell: Cell, face: number) => getFaceEdgeSegment(cell, face, field)!;
const centerOf = (cell: Cell) => getCellCenter(cell[0], cell[1], field);

describe.each(cases)("seam export: $name", ({ topology, sides }) => {
  const [first, second] = sides;
  const open = passage(first.cell, second.cell);
  const prepare = () => warmCartesianCache(field, topology);

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
