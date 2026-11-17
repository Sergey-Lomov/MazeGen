import { describe, expect, it } from "vitest";
import { warmCartesianCache } from "../pixi/cartesianCache";
import { configAllCells } from "../pixi/tessellationCells";
import { getFaceEdgeSegment } from "../pixi/tessellationGeometry";
import { BRACE_OFFSET, buildSeamArrows } from "../pixi/selectors/seamArrows";
import { distance } from "../pixi/selectors/seamRouting";
import { fieldOf } from "./fieldConfigFixtures";
import { oneGlue } from "./seamFixtures";

// A triangular field glued half of one side to the other half of the same side (GitHub issue #841): on every one of
// its three sides, flat and slanted, the contours of the two halves stay apart and the innermost pair, whose faces
// touch, is a stand-off route like the others.
const field = fieldOf("tri", { shape: "triangle", side: 12 });

function sides() {
  const key = (p: { x: number; y: number }) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
  const faces: { cell: [number, number]; face: number; key: string; angle: number; x: number; y: number }[] = [];
  for (const cell of configAllCells(field) as [number, number][]) {
    for (let face = 0; face < 3; face++) {
      const edge = getFaceEdgeSegment(cell, face, field);
      if (!edge) continue;
      const angle = ((Math.atan2(edge.v1.y - edge.v0.y, edge.v1.x - edge.v0.x) * 180) / Math.PI % 180 + 180) % 180;
      faces.push({ cell, face, key: [key(edge.v0), key(edge.v1)].sort().join("|"), angle: Math.round(angle), x: (edge.v0.x + edge.v1.x) / 2, y: (edge.v0.y + edge.v1.y) / 2 });
    }
  }
  const count = new Map<string, number>();
  for (const face of faces) count.set(face.key, (count.get(face.key) ?? 0) + 1);
  const unpaired = faces.filter((face) => count.get(face.key) === 1);
  return [...new Set(unpaired.map((face) => face.angle))].map((angle) => unpaired.filter((face) => face.angle === angle).sort((p, q) => p.x - q.x || p.y - q.y));
}

describe("triangular field glued half of a side to the other half", () => {
  sides().forEach((side, index) => {
    it(`keeps the contours apart and routes the touching pair round the wall (side ${index})`, () => {
      const half = side.length / 2;
      const a = side.slice(0, half);
      const b = side.slice(half);
      const folds = a.map((face, i) => ({ a: { cell: face.cell, face_idx: face.face }, b: { cell: b[half - 1 - i].cell, face_idx: b[half - 1 - i].face }, twist: false, group: 0 }));
      const topology = oneGlue("tri{}", folds);
      warmCartesianCache(field, topology);
      const [arrow] = buildSeamArrows(field, topology);
      const [first, second] = arrow.braces;
      const gap = Math.min(...[first[0], first[first.length - 1]].flatMap((p) => [second[0], second[second.length - 1]].map((q) => distance(p, q))));
      expect(gap).toBeGreaterThanOrEqual(BRACE_OFFSET);
      // The pair of the two faces next to each other: a step out, a run along the wall, a step back.
      const touching = arrow.pairs[half - 1];
      expect(touching.path).toHaveLength(4);
      // Every head stands on the start of its route with its tip on the body, however slanted the wall.
      for (const pair of arrow.pairs) {
        for (const [head, from, next] of [[pair.headA, pair.path[0], pair.path[1]], [pair.headB, pair.path[pair.path.length - 1], pair.path[pair.path.length - 2]]] as const) {
          const [tip, left, right] = head;
          expect(distance([(left[0] + right[0]) / 2, (left[1] + right[1]) / 2], from)).toBeCloseTo(0, 6);
          const cross = (tip[0] - from[0]) * (next[1] - from[1]) - (tip[1] - from[1]) * (next[0] - from[0]);
          expect(Math.abs(cross)).toBeLessThan(1e-6);
        }
      }
    });
  });
});
