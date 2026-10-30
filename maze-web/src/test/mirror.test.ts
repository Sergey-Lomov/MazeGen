import { describe, expect, it } from "vitest";
import { decodePoint, encodePoint } from "../pixi/tessellationProjection";
import {
  computeMirrorPreview,
  snapMirrorPoint,
  mirrorStatus,
  type MirrorOptions,
} from "../pixi/mirror";
import { fieldOf } from "./fieldConfigFixtures";

const cfg = fieldOf("square", { shape: "custom", points: [[0, 0], [1, 0], [2, 0], [1, 1]] as [number, number][] });

function options(overrides: Partial<MirrorOptions> = {}): MirrorOptions {
  return {
    scope: "everything",
    sourceSide: 1,
    axis: [{ x: 20, y: -100 }, { x: 20, y: 100 }],
    polygon: [],
    ...overrides,
  };
}

describe("mirror geometry", () => {
  it("mirrors filled cells and ignores cells on the axis", () => {
    const filled = new Set([encodePoint(0, 0), encodePoint(1, 0)]);
    const preview = computeMirrorPreview(
      filled,
      cfg,
      options({ axis: [{ x: 20, y: -100 }, { x: 20, y: 100 }] }),
      encodePoint,
      decodePoint,
    );
    expect(preview.sourceCells).toEqual([[1, 0]]);
    expect(preview.mirroredCells).toEqual([[-1, 0]]);
  });

  it("ignores inactive candidate cells", () => {
    const filled = new Set([encodePoint(1, 0)]);
    const preview = computeMirrorPreview(
      filled,
      cfg,
      options({ axis: [{ x: 20, y: -100 }, { x: 20, y: 100 }] }),
      encodePoint,
      decodePoint,
    );
    expect(preview.sourceCells).toEqual([[1, 0]]);
  });

  it("limits one-side processing to the selected source side", () => {
    const filled = new Set([encodePoint(0, 0), encodePoint(2, 0)]);
    const preview = computeMirrorPreview(
      filled,
      cfg,
      options({ scope: "one_side", sourceSide: -1 }),
      encodePoint,
      decodePoint,
    );
    expect(preview.sourceCells).toEqual([[2, 0]]);
    expect(preview.mirroredCells).toEqual([[-2, 0]]);
  });

  it("reports the core error for an axis that is not a mirror of the tessellation", () => {
    const preview = computeMirrorPreview(
      new Set([encodePoint(1, 0)]),
      cfg,
      options({ axis: [{ x: -100, y: -100 }, { x: 100, y: -60 }] }),
      encodePoint,
      decodePoint,
    );
    expect(preview.sourceCells).toEqual([[1, 0]]);
    expect(preview.mirroredCells).toEqual([]);
    expect(preview.error).toMatchObject({ kind: "not_a_symmetry" });
  });

  it("mirrors source cells that form several disconnected pieces", () => {
    const preview = computeMirrorPreview(new Set([encodePoint(1, 0), encodePoint(3, 0)]), cfg, options(), encodePoint, decodePoint);
    expect(preview.error).toBeNull();
    expect(preview.mirroredCells).toEqual([[-3, 0], [-1, 0]]);
  });

  it("has no error when the mirror image is computed", () => {
    const preview = computeMirrorPreview(new Set([encodePoint(1, 0)]), cfg, options(), encodePoint, decodePoint);
    expect(preview.error).toBeNull();
  });

  it("uses the processing polygon as a source filter", () => {
    const filled = new Set([encodePoint(1, 0), encodePoint(1, 1)]);
    const preview = computeMirrorPreview(
      filled,
      cfg,
      options({ scope: "polygon", polygon: [{ x: 45, y: 0 }, { x: 75, y: 0 }, { x: 75, y: 40 }, { x: 45, y: 40 }] }),
      encodePoint,
      decodePoint,
    );
    expect(preview.sourceCells).toEqual([[1, 0]]);
  });

  it("snaps square axes to cell corners", () => {
    const snapped = snapMirrorPoint({ x: 17, y: 15 }, "corners", cfg);
    expect(snapped.x).toBeCloseTo(0);
    expect(snapped.y).toBeCloseTo(0);
    expect(snapMirrorPoint({ x: 17, y: 15 }, "free", cfg)).toEqual({ x: 17, y: 15 });
  });

  it("reports the current geometry status", () => {
    expect(mirrorStatus({ axisPoints: [], scope: "everything", polygon: [] })).toBe("axis");
    expect(mirrorStatus({ axisPoints: [{ x: 0, y: 0 }, { x: 0, y: 0 }], scope: "everything", polygon: [] })).toBe("axis");
    expect(mirrorStatus({ axisPoints: [{ x: 0, y: 0 }, { x: 0, y: 10 }], scope: "polygon", polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }], polygonFinished: true })).toBe("polygon");
    expect(mirrorStatus({ axisPoints: [{ x: 0, y: 0 }, { x: 0, y: 10 }], scope: "polygon", polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], polygonFinished: false })).toBe("polygon");
    expect(mirrorStatus({ axisPoints: [{ x: 0, y: 0 }, { x: 0, y: 10 }], scope: "polygon", polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], polygonFinished: true })).toBe("ready");
  });
});
