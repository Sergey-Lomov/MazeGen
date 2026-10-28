import { describe, expect, it } from "vitest";
import { EMPTY_FIELD_SIZE_READOUT, formatCellsSize, measureCells, mergeFieldSizeReadout } from "../pixi/fieldSizeReadout";

describe("measureCells", () => {
  it("returns null for no cells", () => {
    expect(measureCells([])).toBeNull();
  });

  it("measures inclusive grid span and cell count", () => {
    const size = measureCells([[2, 3], [4, 3], [2, 6]]);
    expect(size).toEqual({ width: 3, height: 4, count: 3 });
  });

  it("formats size as WxH (count)", () => {
    expect(formatCellsSize({ width: 3, height: 4, count: 7 })).toBe("3×4 (7)");
  });
});

describe("mergeFieldSizeReadout", () => {
  const a = { width: 2, height: 1, count: 2 };

  it("keeps untouched fields and returns prev when nothing changed", () => {
    const prev = mergeFieldSizeReadout(EMPTY_FIELD_SIZE_READOUT, { selection: a });
    expect(prev).toEqual({ selection: a, shape: null });
    expect(mergeFieldSizeReadout(prev, { shape: null })).toBe(prev);
    expect(mergeFieldSizeReadout(prev, { selection: { ...a } })).toBe(prev);
  });

  it("applies an explicit null and a full reset", () => {
    const prev = { selection: a, shape: { ...a, primitive: "rectangle" as const } };
    expect(mergeFieldSizeReadout(prev, { shape: null })).toEqual({ selection: a, shape: null });
    expect(mergeFieldSizeReadout(prev, EMPTY_FIELD_SIZE_READOUT)).toEqual(EMPTY_FIELD_SIZE_READOUT);
  });

  it("treats a different primitive with the same size as a change", () => {
    const rect = { ...a, primitive: "rectangle" as const };
    const prev = { selection: null, shape: rect };
    expect(mergeFieldSizeReadout(prev, { shape: { ...rect } })).toBe(prev);
    expect(mergeFieldSizeReadout(prev, { shape: { ...rect, primitive: "circle" } }).shape?.primitive).toBe("circle");
  });
});
