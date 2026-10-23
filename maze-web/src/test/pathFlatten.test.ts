import { describe, expect, it } from "vitest";
import type { PathCommand, SegmentDto } from "../wasm/mazeService";
import { flattenCommands, flattenSegments, segmentsToCommands } from "../pixi/geometry/pathFlatten";
import { fractionAlong, pointAtFraction, polylineLength, trimPolyline, closestPointOnPolyline } from "../pixi/geometry/polylineOps";

const SQUARE: PathCommand[] = [
  { op: "move_to", to: [0, 0] },
  { op: "line_to", to: [1, 0] },
  { op: "line_to", to: [1, 1] },
  { op: "line_to", to: [0, 1] },
  { op: "line_to", to: [0, 0] },
];

describe("flattenCommands", () => {
  it("drops the repeated closing point of a closed boundary", () => {
    expect(flattenCommands(SQUARE, 1e-3)).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
  });

  it("flattens a half circle within the tolerance and keeps both end points", () => {
    const half: PathCommand[] = [
      { op: "move_to", to: [1, 0] },
      { op: "arc_to", center: [0, 0], radius: 1, start_angle: 0, end_angle: Math.PI, ccw: true },
    ];
    const points = flattenCommands(half, 1e-3);
    expect(points[0]).toEqual([1, 0]);
    expect(points[points.length - 1][0]).toBeCloseTo(-1, 9);
    expect(points.length).toBeGreaterThan(4);
    for (const [x, y] of points) expect(Math.hypot(x, y)).toBeCloseTo(1, 9);
  });
});

describe("segment conversion", () => {
  const segments: SegmentDto[] = [
    { kind: "line", from: [0, 0], to: [2, 0] },
    { kind: "line", from: [2, 0], to: [2, 2] },
  ];

  it("turns a chain of lines into commands and an open polyline", () => {
    expect(segmentsToCommands(segments)).toEqual([
      { op: "move_to", to: [0, 0] },
      { op: "line_to", to: [2, 0] },
      { op: "line_to", to: [2, 2] },
    ]);
    expect(flattenSegments(segments, 1e-3)).toEqual([[0, 0], [2, 0], [2, 2]]);
  });
});

describe("polyline helpers", () => {
  const line: [number, number][] = [[0, 0], [2, 0], [2, 2]];

  it("measures and samples by arc length", () => {
    expect(polylineLength(line)).toBe(4);
    expect(pointAtFraction(line, 0.5)).toEqual([2, 0]);
    expect(pointAtFraction(line, 0.75)).toEqual([2, 1]);
    expect(pointAtFraction([], 0.5)).toBeNull();
  });

  it("maps a closest-point hit back to its fraction", () => {
    const hit = closestPointOnPolyline(line, [2.5, 1])!;
    expect(fractionAlong(line, hit)).toBeCloseTo(0.75, 9);
  });

  it("trims between two arc-length distances", () => {
    expect(trimPolyline(line, 1, 3)).toEqual([[1, 0], [2, 0], [2, 1]]);
    expect(trimPolyline(line, 3, 1)).toEqual([]);
    expect(trimPolyline(line, -5, 99)).toEqual([[0, 0], [2, 0], [2, 2]]);
  });
});
