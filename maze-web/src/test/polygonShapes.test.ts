import { describe, expect, it } from "vitest";
import { roundedContourCorners } from "../pixi/imageExport/roundedContour";
import { bufferPolyline } from "../pixi/selectors/teleportConnectorWarnings";

// GitHub issue #945 — shapes behind the connector warning highlights.

const square: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];

describe("roundedContourCorners", () => {
  it("yields no corners for fewer than 3 points", () => {
    expect(roundedContourCorners([[0, 0], [1, 1]], 3)).toEqual([]);
  });

  it("cuts each corner `radius` back along both neighbouring edges", () => {
    const [first] = roundedContourCorners(square, 3);
    expect(first.corner).toEqual([0, 0]);
    expect(first.entry).toEqual([0, 3]);
    expect(first.exit).toEqual([3, 0]);
  });

  it("caps the cut-in at half of the shorter neighbouring edge", () => {
    const thin: [number, number][] = [[0, 0], [2, 0], [2, 20], [0, 20]];
    const [first] = roundedContourCorners(thin, 5);
    expect(first.exit).toEqual([1, 0]);
    expect(first.entry).toEqual([0, 1]);
  });
});

describe("bufferPolyline", () => {
  it("is empty for no points and a disc for a single point", () => {
    expect(bufferPolyline([], 2)).toEqual([]);
    const disc = bufferPolyline([[5, 5]], 2);
    expect(disc.length).toBeGreaterThanOrEqual(3);
    expect(disc.every(([x, y]) => Math.abs(Math.hypot(x - 5, y - 5) - 2) < 1e-6)).toBe(true);
  });

  it("offsets a straight segment by the half-width to both sides", () => {
    const outline = bufferPolyline([[0, 0], [10, 0]], 2);
    expect(outline.map(([x, y]) => [x, Math.abs(y)])).toEqual(expect.arrayContaining([[0, 2], [10, 2]]));
    expect(outline.every(([x, y]) => x >= 0 && x <= 10 && Math.abs(y) === 2)).toBe(true);
  });

  it("keeps every outline point within half-width of the line around a bend (round outer join, no spikes)", () => {
    const line: [number, number][] = [[0, 0], [10, 0], [10, 10]];
    const outline = bufferPolyline(line, 2);
    const distance = (p: [number, number]) => Math.min(...[[line[0], line[1]], [line[1], line[2]]].map(([a, b]) => {
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2)));
      return Math.hypot(p[0] - a[0] - t * (b[0] - a[0]), p[1] - a[1] - t * (b[1] - a[1]));
    }));
    // The inner side is mitered, so its point sits at 2 x sqrt(2) from the bend vertex but still 2 from each segment's line.
    expect(outline.filter((p) => distance(p) > 2 + 1e-6)).toEqual([]);
  });
});
