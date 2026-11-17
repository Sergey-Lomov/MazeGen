import { range } from "./seamFixtures";
import { describe, expect, it } from "vitest";
import { warmCartesianCache } from "../pixi/cartesianCache";
import { buildSeamArrows } from "../pixi/selectors/seamArrows";
import type { WireFold, WireTopology } from "../wasm/types";
import { fieldOf } from "./fieldConfigFixtures";

// A cross-shaped cube net (6 squares of n x n cells): its 14 boundary edges are glued in 7 pairs, n faces each.
const EDGE = 11;

function cubeNet(n: number) {
  const squares: [number, number][] = [[1, 2], [0, 1], [1, 1], [2, 1], [3, 1], [1, 0]];
  const cells: [number, number][] = [];
  for (const [col, row] of squares) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cells.push([col * n + i, row * n + j]);
  type End = { cell: [number, number]; face_idx: number };
  const run = (face_idx: number, at: (k: number) => [number, number]): End[] => range(n).map((k) => ({ cell: at(k), face_idx }));
  const pairs: [End[], End[]][] = [
    [run(2, (k) => [n, 2 * n + k]), run(1, (k) => [k, 2 * n - 1])],
    [run(0, (k) => [2 * n - 1, 2 * n + k]), run(1, (k) => [2 * n + k, 2 * n - 1])],
    [run(1, (k) => [n + k, 3 * n - 1]), run(1, (k) => [3 * n + k, 2 * n - 1])],
    [run(2, (k) => [0, n + k]), run(0, (k) => [4 * n - 1, n + k])],
    [run(3, (k) => [k, n]), run(2, (k) => [n, k])],
    [run(3, (k) => [2 * n + k, n]), run(0, (k) => [2 * n - 1, k])],
    [run(3, (k) => [n + k, 0]), run(3, (k) => [3 * n + k, n])],
  ];
  const folds: WireFold[] = [];
  const groups: WireTopology["groups"] = [];
  pairs.forEach(([a, b], group) => {
    groups.push({ id: group, folds: range(n).map((k) => folds.length + k) });
    range(n).forEach((k) => folds.push({ a: a[k], b: b[n - 1 - k], twist: false, group }));
  });
  return { cells, topology: { fingerprint: "square{}", folds, groups } as WireTopology };
}

describe("cube net", () => {
  it("builds the seam arrows in good time", () => {
    const { cells, topology } = cubeNet(EDGE);
    const field = fieldOf("square", { shape: "custom", points: cells });
    warmCartesianCache(field, topology);
    const started = performance.now();
    const arrows = buildSeamArrows(field, topology);
    const pairs = arrows.flatMap((arrow) => arrow.pairs);
    for (const pair of pairs) expect(pair.slots).toHaveLength(2);
    const total = performance.now() - started;
    expect(total).toBeLessThan(5000);
    expect(pairs).toHaveLength(7 * EDGE);
  }, 120000);

  it("joins two runs meeting at a corner with a single bend", () => {
    const { cells, topology } = cubeNet(EDGE);
    const field = fieldOf("square", { shape: "custom", points: cells });
    warmCartesianCache(field, topology);
    // Glue 0 pairs the west side of the top square with the north side of the left square: both end in the
    // notch of the cross, so each pair is one bend, and so is the arrow.
    const corner = buildSeamArrows(field, topology).find((arrow) => arrow.group === 0)!;
    expect(corner.path).toHaveLength(3);
    for (const pair of corner.pairs) {
      expect(pair.path).toHaveLength(3);
    }
  });

  it("cuts the contours of two runs meeting at a corner where they cross", () => {
    const { cells, topology } = cubeNet(EDGE);
    const field = fieldOf("square", { shape: "custom", points: cells });
    warmCartesianCache(field, topology);
    const corner = buildSeamArrows(field, topology).find((arrow) => arrow.group === 0)!;
    expect(corner.braces).toHaveLength(2);
    const [first, second] = corner.braces;
    // One end of each contour is the shared corner point: no overshoot past the other contour.
    const ends = (line: [number, number][]) => [line[0], line[line.length - 1]];
    const gap = Math.min(...ends(first).flatMap((p) => ends(second).map((q) => Math.hypot(p[0] - q[0], p[1] - q[1]))));
    expect(gap).toBeLessThan(1e-6);
  });

  it("keeps the heads of a short corner pair on the route, apart from each other", () => {
    const { cells, topology } = cubeNet(EDGE);
    const field = fieldOf("square", { shape: "custom", points: cells });
    warmCartesianCache(field, topology);
    const corner = buildSeamArrows(field, topology).find((arrow) => arrow.group === 0)!;
    const headLength = (head: [number, number][]) => Math.hypot(head[0][0] - (head[1][0] + head[2][0]) / 2, head[0][1] - (head[1][1] + head[2][1]) / 2);
    for (const pair of corner.pairs) {
      let length = 0;
      for (let i = 1; i < pair.path.length; i++) length += Math.hypot(pair.path[i][0] - pair.path[i - 1][0], pair.path[i][1] - pair.path[i - 1][1]);
      expect(headLength(pair.headA) + headLength(pair.headB)).toBeLessThanOrEqual(length + 1e-6);
    }
  });
});
