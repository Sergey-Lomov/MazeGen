import { describe, expect, it } from "vitest";
import { calculatePrintFieldConfig, resolvePrintPaperSizeMm } from "../pixi/fieldPrintSizing";
import { fieldOf } from "./fieldConfigFixtures";

const printInput = {
  paperSize: "a4" as const,
  customWidthMm: 210,
  customHeightMm: 297,
  orientation: "portrait" as const,
  cellSizeMm: 10,
  marginHMm: 5,
  marginVMm: 5,
};

describe("field print sizing", () => {
  it("resolves paper orientation", () => {
    expect(resolvePrintPaperSizeMm(printInput)).toEqual({ widthMm: 210, heightMm: 297 });
    expect(resolvePrintPaperSizeMm({ ...printInput, orientation: "landscape" })).toEqual({ widthMm: 297, heightMm: 210 });
  });

  it("calculates a square field from printable A4 area", () => {
    const result = calculatePrintFieldConfig(fieldOf("square", { shape: "rect", cols: 11, rows: 11 }), printInput);

    expect(result?.config).toEqual(fieldOf("square", { shape: "rect", cols: 20, rows: 28 }));
    expect(result?.fieldWidthMm).toBe(200);
    expect(result?.fieldHeightMm).toBe(280);
    expect(result?.usableWidthMm).toBe(200);
    expect(result?.usableHeightMm).toBe(287);
  });

  it("uses the selected paper orientation when calculating a square field", () => {
    const result = calculatePrintFieldConfig(fieldOf("square", { shape: "rect", cols: 11, rows: 11 }), {
      ...printInput,
      orientation: "landscape",
    });

    expect(result?.config).toEqual(fieldOf("square", { shape: "rect", cols: 28, rows: 20 }));
  });

  it("calculates a radial field that fits both printable axes", () => {
    const result = calculatePrintFieldConfig(fieldOf("hex", { shape: "hexagon", radius: 5 }, "flat_top"), printInput);

    expect([result?.config.tessellation.kind, result?.config.shape.shape]).toEqual(["hex", "hexagon"]);
    expect((result?.config.shape as { radius: number }).radius).toBeGreaterThan(0);
    expect(result!.fieldWidthMm).toBeLessThanOrEqual(result!.usableWidthMm + 1e-9);
    expect(result!.fieldHeightMm).toBeLessThanOrEqual(result!.usableHeightMm + 1e-9);
  });

  it("fits a Cairo rectangle from its pentagon bounds", () => {
    const result = calculatePrintFieldConfig(fieldOf("cairo", { shape: "rect", cols: 1, rows: 1 }), printInput);
    expect([result?.config.tessellation.kind, result?.config.shape.shape]).toEqual(["cairo", "rect"]);
    expect(result?.config).toEqual(fieldOf("cairo", { shape: "rect", cols: 13, rows: 19 }));
    expect(result?.fieldWidthMm).toBeCloseTo(188.5618, 3);
    expect(result?.fieldHeightMm).toBeCloseTo(273.4146, 3);
    expect(result!.fieldWidthMm).toBeLessThanOrEqual(result!.usableWidthMm + 1e-9);
    expect(result!.fieldHeightMm).toBeLessThanOrEqual(result!.usableHeightMm + 1e-9);
  });

  it("keeps small Cairo print cells responsive while fitting the paper", () => {
    const result = calculatePrintFieldConfig(fieldOf("cairo", { shape: "rect", cols: 1, rows: 1 }), { ...printInput, cellSizeMm: 1 });
    expect([result?.config.tessellation.kind, result?.config.shape.shape]).toEqual(["cairo", "rect"]);
    expect(result!.fieldWidthMm).toBeLessThanOrEqual(result!.usableWidthMm + 1e-9);
    expect(result!.fieldHeightMm).toBeLessThanOrEqual(result!.usableHeightMm + 1e-9);
  });

  it.each([
    [fieldOf("square", { shape: "circle", radius: 5 })],
    [fieldOf("hex", { shape: "circle", radius: 5 }, "flat_top")],
    [fieldOf("tri", { shape: "circle", radius: 4 }, "r0")],
  ])("keeps the circle shape and tessellation when fitting %o", (config) => {
    const result = calculatePrintFieldConfig(config, printInput);
    expect(result?.config.tessellation).toEqual(config.tessellation);
    expect(result?.config.shape.shape).toBe("circle");
    expect(result?.fieldWidthMm).toBeLessThanOrEqual(result!.usableWidthMm + 1e-9);
    expect(result?.fieldHeightMm).toBeLessThanOrEqual(result!.usableHeightMm + 1e-9);
  });

  it("calculates the new hex rectangle shape", () => {
    const result = calculatePrintFieldConfig(fieldOf("hex", { shape: "rect", cols: 5, rows: 5 }, "flat_top"), printInput);
    expect([result?.config.tessellation.kind, result?.config.shape.shape]).toEqual(["hex", "rect"]);
    expect((result?.config.shape as { cols: number; rows: number }).cols).toBeGreaterThan(0);
    expect((result?.config.shape as { cols: number; rows: number }).rows).toBeGreaterThan(0);
  });

  it("rejects a cell size that cannot fit inside the printable area", () => {
    expect(calculatePrintFieldConfig(fieldOf("square", { shape: "rect", cols: 1, rows: 1 }), {
      ...printInput,
      cellSizeMm: 300,
    })).toBeNull();
  });
});
