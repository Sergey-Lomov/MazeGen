import { describe, expect, it, vi } from "vitest";
import { boundsInCellSides, calculatePrintFieldConfig, largestFitting, resolvePrintPaperSizeMm } from "../pixi/fieldPrintSizing";
import { TESSELLATION_UI } from "../pixi/geometry/tessellationUi";
import type { TessellationKind } from "../fieldConfig";
import * as mazeService from "../wasm/mazeService";
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
  it("never picks a size core refuses to build", () => {
    // A 0.05 mm cell would need a field far above core's size limit on A4.
    const result = calculatePrintFieldConfig(fieldOf("hex", { shape: "circle", radius: 3 }, "flat_top"), { ...printInput, cellSizeMm: 0.05 });
    if (result) {
      expect(result.fieldWidthMm).toBeLessThanOrEqual(result.usableWidthMm + 1e-9);
      expect(Number.isFinite(result.fieldHeightMm)).toBe(true);
    }
  });

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

  describe("strategy contracts", () => {
    const representatives = [
      ["axis-aligned", fieldOf("square", { shape: "rect", cols: 1, rows: 1 })],
      ["Cairo", fieldOf("cairo", { shape: "rect", cols: 1, rows: 1 })],
      ["rectangular", fieldOf("hex", { shape: "rect", cols: 1, rows: 1 }, "flat_top")],
      ["radial", fieldOf("hex", { shape: "circle", radius: 1 }, "flat_top")],
    ] as const;

    it.each(representatives)("%s returns a field inside the printable area", (_name, config) => {
      const result = calculatePrintFieldConfig(config, printInput);
      expect(result).not.toBeNull();
      expect(result!.fieldWidthMm).toBeLessThanOrEqual(result!.usableWidthMm + 1e-9);
      expect(result!.fieldHeightMm).toBeLessThanOrEqual(result!.usableHeightMm + 1e-9);
    });

    it.each(representatives)("%s dimensions are monotonic as printable area grows", (_name, config) => {
      const small = calculatePrintFieldConfig(config, { ...printInput, paperSize: "custom", customWidthMm: 80, customHeightMm: 100 });
      const large = calculatePrintFieldConfig(config, { ...printInput, paperSize: "custom", customWidthMm: 120, customHeightMm: 150 });
      expect(small).not.toBeNull();
      expect(large).not.toBeNull();
      expect(shapeCapacity(large!.config)).toBeGreaterThanOrEqual(shapeCapacity(small!.config));
      expect(large!.fieldWidthMm).toBeGreaterThanOrEqual(small!.fieldWidthMm);
      expect(large!.fieldHeightMm).toBeGreaterThanOrEqual(small!.fieldHeightMm);
    });

    it("Cairo sizing never materializes a field while searching", () => {
      const materialize = vi.spyOn(mazeService, "getFieldPreset");
      try {
        calculatePrintFieldConfig(fieldOf("cairo", { shape: "rect", cols: 1, rows: 1 }), { ...printInput, cellSizeMm: 1.25 });
        expect(materialize).not.toHaveBeenCalled();
      } finally {
        materialize.mockRestore();
      }
    });
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

  it.each([
    ["non-positive cell size", { cellSizeMm: 0 }],
    ["non-finite cell size", { cellSizeMm: NaN }],
    ["negative margin", { marginHMm: -1 }],
    ["non-finite margin", { marginVMm: NaN }],
    ["margins that leave no usable width", { marginHMm: 105 }],
    ["margins that leave no usable height", { marginVMm: 149 }],
    ["non-positive custom paper", { paperSize: "custom" as const, customWidthMm: 0 }],
    ["non-finite custom paper", { paperSize: "custom" as const, customHeightMm: NaN }],
  ])("rejects %s", (_name, override) => {
    expect(calculatePrintFieldConfig(fieldOf("cairo", { shape: "rect", cols: 1, rows: 1 }), { ...printInput, ...override })).toBeNull();
  });

  it("answers floors of one shape kind from the same calculation", () => {
    const first = calculatePrintFieldConfig(fieldOf("cairo", { shape: "rect", cols: 3, rows: 3 }), printInput);
    const second = calculatePrintFieldConfig(fieldOf("cairo", { shape: "rect", cols: 9, rows: 4 }), printInput);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second!.config).not.toBe(first!.config);
    expect(calculatePrintFieldConfig(fieldOf("cairo", { shape: "rect", cols: 3, rows: 3 }), { ...printInput, cellSizeMm: 11 })).not.toBe(first);
  });

  it.each([
    { limit: 37, hint: 1 },
    { limit: 37, hint: 37 },
    { limit: 37, hint: 500 },
    { limit: 1, hint: 900 },
    { limit: 0, hint: 5 },
    { limit: 1000, hint: 1 },
    { limit: 5000, hint: 10 },
    { limit: 4, hint: 1, min: 3 },
    { limit: 2, hint: 9, min: 3 },
  ])("finds the largest fitting value from any hint: %o", ({ limit, hint, min = 1 }) => {
    // 0 when even the smallest allowed value does not fit.
    const expected = limit < min ? 0 : Math.min(limit, 1000);
    expect(largestFitting((value) => value <= limit, hint, min, 1000)).toBe(expected);
  });

  describe("rect search matches a full scan", () => {
    const smallSheet = { ...printInput, paperSize: "custom" as const, customWidthMm: 45, customHeightMm: 55 };
    // Core has no parallelogram preset, and the radial and voronoi kinds have no rect.
    const kinds = (Object.keys(TESSELLATION_UI) as TessellationKind[])
      .filter((kind) => kind !== "radial" && kind !== "voronoi" && !TESSELLATION_UI[kind].editor.axisAlignedGrid);
    const shape = "rect" as const;

    it.each(kinds)(
      "%s", (kind) => {
        const orientation = TESSELLATION_UI[kind].orientations[0];
        for (const cellSizeMm of [4, 6]) {
          const input = { ...smallSheet, cellSizeMm };
          const start = fieldOf(kind, { shape, cols: 2, rows: 2 }, orientation);
          const result = calculatePrintFieldConfig(start, input);

          // Reference: every cols x rows pair, the most cells then the fullest sheet.
          expect(result).not.toBeNull();
          const cellSideMm = result!.fieldWidthMm / boundsInCellSides(result!.config).width;
          const usableW = result!.usableWidthMm;
          const usableH = result!.usableHeightMm;
          // "refused": core rejects a block below the lattice's minimum (3.12.12 needs two rows).
          const fitsSize = (cols: number, rows: number): { fill: number } | "refused" | null => {
            const b = boundsInCellSides(fieldOf(kind, { shape, cols, rows }, orientation));
            if (!Number.isFinite(b.width)) return "refused";
            const w = b.width * cellSideMm;
            const h = b.height * cellSideMm;
            return w <= usableW + 1e-9 && h <= usableH + 1e-9 ? { fill: w / usableW + h / usableH } : null;
          };
          let expected = { count: 0, fill: -Infinity };
          for (let cols = 1; cols <= 60; cols++) {
            let anyFits = false;
            for (let rows = 1; rows <= 60; rows++) {
              const fit = fitsSize(cols, rows);
              if (fit === "refused") continue;
              if (!fit) break;
              anyFits = true;
              const count = cols * rows;
              if (count > expected.count || (count === expected.count && fit.fill > expected.fill)) expected = { count, fill: fit.fill };
            }
            if (!anyFits && cols > 4) break;
          }

          const chosen = result!.config.shape as { cols: number; rows: number };
          expect(chosen.cols * chosen.rows).toBe(expected.count);
          expect((fitsSize(chosen.cols, chosen.rows) as { fill: number }).fill).toBeCloseTo(expected.fill, 9);
        }
      },
    );
  });
});

function shapeCapacity(config: { shape: { shape: string } & Record<string, number | string> }): number {
  const { shape } = config;
  if ("cols" in shape && "rows" in shape) return Number(shape.cols) * Number(shape.rows);
  if ("radius" in shape) return Number(shape.radius);
  return Number(shape.side);
}
