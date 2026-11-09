import { describe, expect, it } from "vitest";
import { computePrintSizing, printSizingFailure } from "../pixi/printSizingJob";
import type { PredefinedFieldConfig } from "../pixi/fieldPrintSizing";
import { fieldOf } from "./fieldConfigFixtures";

const input = {
  paperSize: "a4" as const,
  customWidthMm: 210,
  customHeightMm: 297,
  orientation: "portrait" as const,
  cellSizeMm: 10,
  marginHMm: 5,
  marginVMm: 5,
};

describe("computePrintSizing", () => {
  it("sizes the field and every floor and counts their cells", () => {
    const config = fieldOf("square", { shape: "rect", cols: 3, rows: 3 }) as PredefinedFieldConfig;
    const answer = computePrintSizing({
      config,
      input,
      floors: [{ id: "a", config }, { id: "b", cells: [[0, 0], [1, 0]] }],
    });
    expect(answer.result).not.toBeNull();
    const [standard, custom] = answer.floors;
    expect(standard.standard).toBe(true);
    expect(standard.cellCount).toBe(20 * 28);
    expect(custom).toMatchObject({ id: "b", standard: false, result: null, cellCount: 2 });
  });

  it("marks a standard floor that does not fit", () => {
    const config = fieldOf("square", { shape: "rect", cols: 3, rows: 3 }) as PredefinedFieldConfig;
    const answer = computePrintSizing({ config, input: { ...input, cellSizeMm: 500 }, floors: [{ id: "a", config }] });
    expect(answer.result).toBeNull();
    expect(answer.floors[0]).toMatchObject({ standard: true, result: null, cellCount: 0 });
  });
});

describe("printSizingFailure", () => {
  it("tells unreadable input, margins and a too large cell apart", () => {
    expect(printSizingFailure({ ...input, cellSizeMm: Number.NaN })).toBe("invalid_input");
    expect(printSizingFailure({ ...input, marginHMm: 200 })).toBe("margins");
    expect(printSizingFailure({ ...input, cellSizeMm: 500 })).toBe("cell_too_large");
  });
});
