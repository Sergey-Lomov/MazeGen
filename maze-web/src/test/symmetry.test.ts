import { describe, expect, it } from "vitest";
import { encodePoint } from "../pixi/tessellationProjection";
import {
  computeSymmetryPreview,
  reflectPointAcrossAxis,
  snapSymmetryPoint,
  symmetryStatus,
  type SymmetryOptions,
} from "../pixi/symmetry";

const cfg = { type: "square_custom" as const, points: [[0, 0], [1, 0], [2, 0], [1, 1]] as [number, number][] };

function options(overrides: Partial<SymmetryOptions> = {}): SymmetryOptions {
  return {
    scope: "everything",
    sourceSide: 1,
    axis: [{ x: 32, y: -100 }, { x: 32, y: 100 }],
    polygon: [],
    ...overrides,
  };
}

describe("symmetry geometry", () => {
  it("reflects a point across an arbitrary axis", () => {
    expect(reflectPointAcrossAxis({ x: 4, y: 1 }, [{ x: 0, y: 0 }, { x: 1, y: 1 }])).toEqual({ x: 1, y: 4 });
  });

  it("mirrors filled cells and ignores cells on the axis", () => {
    const filled = new Set([encodePoint(0, 0), encodePoint(1, 0)]);
    const preview = computeSymmetryPreview(
      filled,
      [[-1, 0], [0, 0], [1, 0]],
      cfg,
      options({ axis: [{ x: 20, y: -100 }, { x: 20, y: 100 }] }),
      encodePoint,
    );
    expect(preview.sourceCells).toEqual([[1, 0]]);
    expect(preview.mirroredCells).toEqual([[-1, 0]]);
  });

  it("ignores inactive candidate cells", () => {
    const filled = new Set([encodePoint(1, 0)]);
    const preview = computeSymmetryPreview(
      filled,
      [[-1, 0], [1, 0], [2, 0]],
      cfg,
      options({ axis: [{ x: 20, y: -100 }, { x: 20, y: 100 }] }),
      encodePoint,
    );
    expect(preview.sourceCells).toEqual([[1, 0]]);
  });

  it("limits one-side processing to the selected source side", () => {
    const filled = new Set([encodePoint(0, 0), encodePoint(2, 0)]);
    const preview = computeSymmetryPreview(
      filled,
      [[0, 0], [2, 0]],
      cfg,
      options({ scope: "one_side", sourceSide: -1 }),
    encodePoint,
    );
    expect(preview.sourceCells).toEqual([[2, 0]]);
    expect(preview.mirroredCells).toEqual([[-1, 0]]);
  });

  it("uses the processing polygon as a source filter", () => {
    const filled = new Set([encodePoint(1, 0), encodePoint(1, 1)]);
    const preview = computeSymmetryPreview(
      filled,
      [[1, 0], [1, 1]],
      cfg,
      options({ scope: "polygon", polygon: [{ x: 45, y: 0 }, { x: 75, y: 0 }, { x: 75, y: 40 }, { x: 45, y: 40 }] }),
      encodePoint,
    );
    expect(preview.sourceCells).toEqual([[1, 0]]);
  });

  it("snaps square axes to cell corners", () => {
    expect(snapSymmetryPoint({ x: 17, y: 15 }, "corners", cfg)).toEqual({ x: 0, y: 0 });
    expect(snapSymmetryPoint({ x: 17, y: 15 }, "free", cfg)).toEqual({ x: 17, y: 15 });
  });

  it("reports the current geometry status", () => {
    expect(symmetryStatus({ axisPoints: [], scope: "everything", polygon: [] })).toBe("axis");
    expect(symmetryStatus({ axisPoints: [{ x: 0, y: 0 }, { x: 0, y: 0 }], scope: "everything", polygon: [] })).toBe("axis");
    expect(symmetryStatus({ axisPoints: [{ x: 0, y: 0 }, { x: 0, y: 10 }], scope: "polygon", polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }], polygonFinished: true })).toBe("polygon");
    expect(symmetryStatus({ axisPoints: [{ x: 0, y: 0 }, { x: 0, y: 10 }], scope: "polygon", polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], polygonFinished: false })).toBe("polygon");
    expect(symmetryStatus({ axisPoints: [{ x: 0, y: 0 }, { x: 0, y: 10 }], scope: "polygon", polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], polygonFinished: true })).toBe("ready");
  });
});
