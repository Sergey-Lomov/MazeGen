import { describe, expect, it } from "vitest";
import { calculatePrintFieldConfig, resolvePrintPaperSizeMm } from "../pixi/fieldPrintSizing";

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
    const result = calculatePrintFieldConfig({ type: "square", width: 11, height: 11 }, printInput);

    expect(result?.config).toEqual({ type: "square", width: 20, height: 28 });
    expect(result?.fieldWidthMm).toBe(200);
    expect(result?.fieldHeightMm).toBe(280);
    expect(result?.usableWidthMm).toBe(200);
    expect(result?.usableHeightMm).toBe(287);
  });

  it("uses the selected paper orientation when calculating a square field", () => {
    const result = calculatePrintFieldConfig({ type: "square", width: 11, height: 11 }, {
      ...printInput,
      orientation: "landscape",
    });

    expect(result?.config).toEqual({ type: "square", width: 28, height: 20 });
  });

  it("calculates a radial field that fits both printable axes", () => {
    const result = calculatePrintFieldConfig({ type: "hex_hexagon", radius: 5, orientation: "flat_top" }, printInput);

    expect(result?.config.type).toBe("hex_hexagon");
    expect((result?.config as { radius: number }).radius).toBeGreaterThan(0);
    expect(result!.fieldWidthMm).toBeLessThanOrEqual(result!.usableWidthMm + 1e-9);
    expect(result!.fieldHeightMm).toBeLessThanOrEqual(result!.usableHeightMm + 1e-9);
  });

  it.each([
    [{ type: "square_circle", radius: 5 }, "square_circle"],
    [{ type: "hex_circle", radius: 5, orientation: "flat_top" }, "hex_circle"],
    [{ type: "triangle_circle", radius: 4, orientation: "r0" }, "triangle_circle"],
  ] as const)("keeps the new circle config type when fitting %s", (config, type) => {
    const result = calculatePrintFieldConfig(config, printInput);
    expect(result?.config.type).toBe(type);
    expect(result?.fieldWidthMm).toBeLessThanOrEqual(result!.usableWidthMm + 1e-9);
    expect(result?.fieldHeightMm).toBeLessThanOrEqual(result!.usableHeightMm + 1e-9);
  });

  it("calculates the new hex rectangle shape", () => {
    const result = calculatePrintFieldConfig({ type: "hex_rectangle", cols: 5, rows: 5, orientation: "flat_top" }, printInput);
    expect(result?.config.type).toBe("hex_rectangle");
    expect((result?.config as { cols: number; rows: number }).cols).toBeGreaterThan(0);
    expect((result?.config as { cols: number; rows: number }).rows).toBeGreaterThan(0);
  });

  it("rejects a cell size that cannot fit inside the printable area", () => {
    expect(calculatePrintFieldConfig({ type: "square", width: 1, height: 1 }, {
      ...printInput,
      cellSizeMm: 300,
    })).toBeNull();
  });
});
