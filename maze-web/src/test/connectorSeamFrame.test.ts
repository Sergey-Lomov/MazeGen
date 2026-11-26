import { describe, expect, it } from "vitest";
import { CUBIC_SAMPLE_STEPS } from "../domain/renderers/teleportConnectorManual";
import { isFarPoint, placedPoints, segmentPieces, toEditFrame } from "../pixi/imageExport/connectorSeamFrame";
import type { UnfoldedPath } from "../pixi/renderers/teleportConnectorRouting";

// GitHub issue #1094: where the editor draws the points of a connector that goes through a seam. The
// partner side is the unfolded frame shifted by +10 on x.
const seam = (firstFar: number, cutAt?: [number, number]): UnfoldedPath => ({
  points: [], firstFar, cutAt,
  toPartner: ([x, y]) => [x + 10, y],
  fromPartner: ([x, y]) => [x - 10, y],
});

describe("isFarPoint", () => {
  it("is never far without a seam or before the cut", () => {
    expect(isFarPoint(undefined, 5, 6, false)).toBe(false);
    expect(isFarPoint(seam(Infinity), 5, 6, false)).toBe(false);
  });

  it("judges polyline points by their position against the cut", () => {
    const s = seam(2);
    expect([0, 1, 2, 3].map((i) => isFarPoint(s, i, 4, false))).toEqual([false, false, true, true]);
  });

  it("judges a curve anchor by its sample index and a handle by its anchor", () => {
    const s = seam(CUBIC_SAMPLE_STEPS); // the cut lies in the first span: the second anchor is the first far point
    // anchor, handle, handle, anchor, handle, handle, anchor
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => isFarPoint(s, i, 7, true))).toEqual([false, false, true, true, true, true, true]);
  });
});

describe("placedPoints", () => {
  it("moves only the far points to the partner side", () => {
    expect(placedPoints(seam(1), [0, 0, 5, 5, 6, 6], false)).toEqual([[0, 0], [15, 5], [16, 6]]);
  });

  it("leaves a path without a seam untouched", () => {
    expect(placedPoints(undefined, [1, 2, 3, 4], false)).toEqual([[1, 2], [3, 4]]);
  });
});

describe("segmentPieces", () => {
  const a: [number, number] = [0, 0], b: [number, number] = [4, 0];

  it("keeps a segment before the cut as it is", () => {
    expect(segmentPieces(seam(3), 0, a, b)).toEqual([{ from: a, to: b, far: false }]);
  });

  it("maps a segment after the cut to the partner side", () => {
    expect(segmentPieces(seam(1), 1, a, b)).toEqual([{ from: [10, 0], to: [14, 0], far: true }]);
  });

  it("splits the segment that crosses the seam at the cut", () => {
    expect(segmentPieces(seam(1, [2, 0]), 0, a, b)).toEqual([
      { from: a, to: [2, 0], far: false },
      { from: [12, 0], to: [14, 0], far: true },
    ]);
  });
});

describe("toEditFrame", () => {
  it("maps a far point back through its seam and leaves a near one", () => {
    expect(toEditFrame(seam(1), [12, 3])).toEqual([2, 3]);
    expect(toEditFrame(null, [12, 3])).toEqual([12, 3]);
  });
});
