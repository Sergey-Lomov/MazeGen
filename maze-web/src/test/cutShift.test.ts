import { describe, expect, it } from "vitest";
import { formatCutShift } from "../pixi/imageExport/cutShift";
import { DPI_BY_DENSITY, pxToMm } from "../pixi/imageExport/printFit";

describe("formatCutShift", () => {
  const digital = { mode: "digital", digital: { scale: 2 } } as const;

  it("shows a digital shift in whole pixels of the image, signed", () => {
    expect(formatCutShift(0.1, 100, digital)).toBe("+20 px");
    expect(formatCutShift(-0.1, 100, digital)).toBe("-20 px");
    expect(formatCutShift(0, 100, digital)).toBe("0 px");
    expect(formatCutShift(-0.0001, 100, digital)).toBe("0 px");
  });

  it("shows a print shift in millimetres with the print scale and density", () => {
    const print = { mode: "print", print: { scale: 1.5, density: "print_300" } } as const;
    const expected = Number(pxToMm(0.1 * 100 * 1.5, DPI_BY_DENSITY.print_300).toFixed(1));
    expect(formatCutShift(0.1, 100, print)).toBe(`+${expected} mm`);
    expect(formatCutShift(-0.1, 100, print)).toBe(`-${expected} mm`);
  });
});
