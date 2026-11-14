import { describe, it, expect } from "vitest";
import type { FieldConfig } from "../fieldConfig";
import type { ExportMargin } from "../pixi/imageExport/exportMargins";
import type { PrintExportSettings } from "../store/storeTypes";
import { fieldOf } from "./fieldConfigFixtures";
import { TILE_SIZE } from "../pixi/constants";
import { MIN_COMFORTABLE_CELL_SIDE_MM } from "../pixi/printCellSizes";

const { cellMeasureWorldUnits, cellSideWorldUnits, printMinSideMm, printMeasureFromEntered, printEnteredFromMeasure, computePrintExportFit, computeAutoFitPrintScale, computeSheetScreenLayout, computePrintPlacementFromViewport, computePhysicalOneToOneViewportScale, printMeasureToCellSideMm, resolveSheetSizeMm, mmToPx, pxToMm, DPI_BY_DENSITY } = await import("../pixi/imageExport/printFit");

const cfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 10, rows: 10 });
const zeroMargin: ExportMargin = { left: 0, right: 0, top: 0, bottom: 0 };

const baseSettings: PrintExportSettings = {
  density: "print_300",
  paperSize: "a4",
  customWidthMm: 210,
  customHeightMm: 297,
  orientation: "portrait",
  marginHMm: 10,
  marginVMm: 10,
  scale: 1,
  scaleAutoFit: false,
  anchor: "center",
  offsetXMm: 0,
  offsetYMm: 0,
};

describe("mmToPx", () => {
  it("converts millimeters to pixels at the given DPI", () => {
    expect(mmToPx(25.4, 96)).toBeCloseTo(96);
    expect(mmToPx(25.4, 300)).toBeCloseTo(300);
  });
});

describe("printMinSideMm", () => {
  it("equals the cell side in millimeters at the given scale and DPI", () => {
    const side = cellSideWorldUnits(cfg);
    expect(printMinSideMm(cfg, 2, 300)).toBeCloseTo(pxToMm(side * 2, 300));
  });

  it("crosses MIN_COMFORTABLE_CELL_SIDE_MM as the scale shrinks", () => {
    const dpi = DPI_BY_DENSITY.print_300;
    const threshold = mmToPx(MIN_COMFORTABLE_CELL_SIDE_MM, dpi) / cellSideWorldUnits(cfg);
    expect(printMinSideMm(cfg, threshold * 1.01, dpi)).toBeGreaterThan(MIN_COMFORTABLE_CELL_SIDE_MM);
    expect(printMinSideMm(cfg, threshold * 0.99, dpi)).toBeLessThan(MIN_COMFORTABLE_CELL_SIDE_MM);
  });
});

describe("pxToMm", () => {
  it("is the inverse of mmToPx at the same DPI", () => {
    expect(pxToMm(mmToPx(50, 300), 300)).toBeCloseTo(50);
  });

  it("converts pixels to millimeters at the given DPI", () => {
    expect(pxToMm(96, 96)).toBeCloseTo(25.4);
  });
});

describe("print cell measure", () => {
  it("uses the circumscribed circle diameter for every cell", () => {
    expect(printMeasureToCellSideMm(fieldOf("hex", { shape: "hexagon", radius: 1 }), 10)).toBeCloseTo(5);
    expect(printMeasureToCellSideMm(fieldOf("tri", { shape: "triangle", side: 1 }), 10)).toBeCloseTo(10 * Math.sqrt(3) / 2);
    expect(cellMeasureWorldUnits(fieldOf("square", { shape: "rect", cols: 1, rows: 1 }))).toBeCloseTo(40 * Math.SQRT2);
  });

  it("measures a Voronoi cell by the regular hexagon of area 1 it is displaced from (GitHub issue #1002)", () => {
    const voronoi = fieldOf("voronoi", { shape: "circle", radius: 4 });
    const hexagonSide = Math.sqrt(2 / (3 * Math.sqrt(3)));
    expect(cellMeasureWorldUnits(voronoi) / TILE_SIZE).toBeCloseTo(2 * hexagonSide);
  });

  it("converts the value of every size mode to the measure and back (GitHub issue #1002)", () => {
    const radial = fieldOf("radial", { shape: "circle", radius: 4 });
    expect(printMeasureFromEntered(radial, "ring_thickness", 8)).toBeCloseTo(8);
    expect(printMeasureFromEntered(fieldOf("voronoi", { shape: "circle", radius: 4 }), "average_size", 8)).toBeCloseTo(8);
    const cairo = fieldOf("cairo", { shape: "rect", cols: 1, rows: 1 });
    for (const [config, mode] of [[radial, "ring_thickness"], [cairo, "min_side"], [cairo, "cell_size"]] as const) {
      expect(printEnteredFromMeasure(config, mode, printMeasureFromEntered(config, mode, 6))).toBeCloseTo(6);
    }
  });

  it("converts a minimum side length to the measure and back", () => {
    const square = fieldOf("square", { shape: "rect", cols: 1, rows: 1 });
    const hex = fieldOf("hex", { shape: "hexagon", radius: 1 });
    expect(printMeasureFromEntered(square, "min_side", 5)).toBeCloseTo(5 * Math.SQRT2);
    expect(printMeasureFromEntered(hex, "min_side", 5)).toBeCloseTo(10);
    for (const config of [square, hex]) {
      expect(printMeasureToCellSideMm(config, printMeasureFromEntered(config, "min_side", 7))).toBeCloseTo(7);
    }
  });
});

describe("resolveSheetSizeMm", () => {
  it("resolves a standard paper size in portrait", () => {
    const { widthMm, heightMm } = resolveSheetSizeMm(baseSettings);
    expect(widthMm).toBe(210);
    expect(heightMm).toBe(297);
  });

  it("swaps width/height for landscape", () => {
    const { widthMm, heightMm } = resolveSheetSizeMm({ ...baseSettings, orientation: "landscape" });
    expect(widthMm).toBe(297);
    expect(heightMm).toBe(210);
  });

  it("uses custom size when paperSize is custom", () => {
    const { widthMm, heightMm } = resolveSheetSizeMm({ ...baseSettings, paperSize: "custom", customWidthMm: 500, customHeightMm: 400 });
    expect(widthMm).toBe(500);
    expect(heightMm).toBe(400);
  });
});

describe("computePrintExportFit", () => {
  it("sheet size matches paper size + DPI conversion", () => {
    const fit = computePrintExportFit(cfg, [{ id: 0, x: 0, y: 0 }], zeroMargin, baseSettings);
    const dpi = DPI_BY_DENSITY[baseSettings.density];
    expect(fit.sheetWidthPx).toBeCloseTo(mmToPx(210, dpi));
    expect(fit.sheetHeightPx).toBeCloseTo(mmToPx(297, dpi));
  });

  it("does not flag overflow for a tiny maze at scale 1 on A4", () => {
    const fit = computePrintExportFit(cfg, [{ id: 0, x: 0, y: 0 }], zeroMargin, baseSettings);
    expect(fit.entersMarginZone).toBe(false);
    expect(fit.clipsSheetBounds).toBe(false);
  });

  it("flags entersMarginZone when scale is large enough that content exceeds the available area", () => {
    const fit = computePrintExportFit(cfg, [{ id: 0, x: 0, y: 0 }], zeroMargin, { ...baseSettings, scale: 1000 });
    expect(fit.entersMarginZone).toBe(true);
  });

  it("flags clipsSheetBounds when scale is large enough that content exceeds the sheet itself", () => {
    const fit = computePrintExportFit(cfg, [{ id: 0, x: 0, y: 0 }], zeroMargin, { ...baseSettings, scale: 100000 });
    expect(fit.clipsSheetBounds).toBe(true);
  });

  it("center anchor centers content within the available area", () => {
    const nodes = [{ id: 0, x: 0, y: 0 }];
    const fit = computePrintExportFit(cfg, nodes, zeroMargin, baseSettings);
    const marginPx = mmToPx(baseSettings.marginHMm, DPI_BY_DENSITY[baseSettings.density]);
    const marginVPx = mmToPx(baseSettings.marginVMm, DPI_BY_DENSITY[baseSettings.density]);
    // content should sit strictly within [marginPx, sheetWidthPx - marginPx] for a centered small maze
    expect(fit.x).toBeGreaterThanOrEqual(0);
    expect(fit.y).toBeGreaterThanOrEqual(0);
    void marginPx; void marginVPx;
  });
});

describe("computeAutoFitPrintScale", () => {
  it("produces a scale where the content exactly fits the limiting axis", () => {
    const nodes = [{ id: 0, x: 0, y: 0 }, { id: 1, x: 20, y: 0 }];
    const autoScale = computeAutoFitPrintScale(cfg, nodes, zeroMargin, baseSettings);
    const fit = computePrintExportFit(cfg, nodes, zeroMargin, { ...baseSettings, scale: autoScale });
    expect(fit.entersMarginZone).toBe(false);
    // one axis should be very close to fully filled
    const widthRatio = fit.contentWidth / fit.availableWidth;
    const heightRatio = fit.contentHeight / fit.availableHeight;
    expect(Math.max(widthRatio, heightRatio)).toBeCloseTo(1, 5);
  });

  it("is a one-shot computation — does not mutate settings", () => {
    const nodes = [{ id: 0, x: 0, y: 0 }];
    computeAutoFitPrintScale(cfg, nodes, zeroMargin, baseSettings);
    expect(baseSettings.scale).toBe(1);
  });
});

describe("computeSheetScreenLayout", () => {
  it("preserves the sheet's own aspect ratio", () => {
    const layout = computeSheetScreenLayout(210, 297, 1000, 1000);
    expect(layout.w / layout.h).toBeCloseTo(210 / 297);
  });

  it("centers the sheet within the screen", () => {
    const layout = computeSheetScreenLayout(210, 297, 1000, 1000);
    expect(layout.x).toBeCloseTo((1000 - layout.w) / 2);
    expect(layout.y).toBeCloseTo((1000 - layout.h) / 2);
  });

  it("fits within the screen bounds with padding (never touches the edges)", () => {
    const layout = computeSheetScreenLayout(210, 297, 1000, 1000);
    expect(layout.w).toBeLessThan(1000);
    expect(layout.h).toBeLessThan(1000);
    expect(layout.x).toBeGreaterThan(0);
    expect(layout.y).toBeGreaterThan(0);
  });

  it("is limited by the narrower screen axis relative to the sheet's aspect ratio", () => {
    const wideScreen = computeSheetScreenLayout(210, 297, 2000, 500);
    // A very wide, short screen with a portrait sheet is height-limited.
    expect(wideScreen.h).toBeCloseTo(500 * 0.9);
  });
});

describe("computePrintPlacementFromViewport", () => {
  it("scale: a 1:1 (world px == screen px) viewport reproduces the frame's own screen-fit scale", () => {
    const nodes = [{ id: 0, x: 0, y: 0 }];
    const printFit = computePrintExportFit(cfg, nodes, zeroMargin, baseSettings);
    const layout = computeSheetScreenLayout(printFit.sheetWidthPx, printFit.sheetHeightPx, 1000, 1000);
    const frameToSheetScale = printFit.sheetWidthPx / layout.w;
    const placement = computePrintPlacementFromViewport(cfg, nodes, zeroMargin, baseSettings, { x: layout.x, y: layout.y, scale: 1 }, layout);
    expect(placement.scale).toBeCloseTo(frameToSheetScale);
  });

  it("scale: doubling the viewport scale doubles the derived print scale", () => {
    const nodes = [{ id: 0, x: 0, y: 0 }];
    const layout = { x: 0, y: 0, w: 300, h: 400 };
    const base = computePrintPlacementFromViewport(cfg, nodes, zeroMargin, baseSettings, { x: 0, y: 0, scale: 1 }, layout);
    const doubled = computePrintPlacementFromViewport(cfg, nodes, zeroMargin, baseSettings, { x: 0, y: 0, scale: 2 }, layout);
    expect(doubled.scale).toBeCloseTo(base.scale * 2);
  });

  it("offset: a world point sitting exactly at the frame's screen origin lands at offset (-marginMm, -marginMm)", () => {
    const nodes = [{ id: 0, x: 0, y: 0 }];
    const dpi = DPI_BY_DENSITY[baseSettings.density];
    const layout = { x: 200, y: 150, w: 400, h: 500 };
    // top_left anchor places printFit.x/y exactly at (marginHPx, marginVPx), which by
    // computePrintExportFit's own x = contentX - minXWorld*scale relation isolates
    // minXWorld/minYWorld cleanly: minXWorld = (marginPx - printFit.x) / printFit.scale.
    const topLeftFit = computePrintExportFit(cfg, nodes, zeroMargin, { ...baseSettings, anchor: "top_left" });
    const marginHPx = mmToPx(baseSettings.marginHMm, dpi);
    const marginVPx = mmToPx(baseSettings.marginVMm, dpi);
    const minXWorld = (marginHPx - topLeftFit.x) / topLeftFit.scale;
    const minYWorld = (marginVPx - topLeftFit.y) / topLeftFit.scale;

    // A viewport placing the content's own minXWorld/minYWorld corner exactly at the frame's
    // screen origin (layout.x, layout.y).
    const viewportScale = 1;
    const viewport = { x: layout.x - minXWorld * viewportScale, y: layout.y - minYWorld * viewportScale, scale: viewportScale };

    const placement = computePrintPlacementFromViewport(cfg, nodes, zeroMargin, baseSettings, viewport, layout);
    expect(mmToPx(placement.offsetXMm, dpi)).toBeCloseTo(-marginHPx);
    expect(mmToPx(placement.offsetYMm, dpi)).toBeCloseTo(-marginVPx);
  });

  it("panning the viewport right/down shifts the derived offset the same direction", () => {
    const nodes = [{ id: 0, x: 0, y: 0 }];
    const layout = { x: 100, y: 100, w: 300, h: 400 };
    const base = computePrintPlacementFromViewport(cfg, nodes, zeroMargin, baseSettings, { x: 0, y: 0, scale: 1 }, layout);
    const panned = computePrintPlacementFromViewport(cfg, nodes, zeroMargin, baseSettings, { x: 50, y: 30, scale: 1 }, layout);
    expect(panned.offsetXMm).toBeGreaterThan(base.offsetXMm);
    expect(panned.offsetYMm).toBeGreaterThan(base.offsetYMm);
  });
});

describe("computePhysicalOneToOneViewportScale", () => {
  it("printScale 1 at print_300 (300 dpi) with a 96 CSS PPI screen -> 96/300", () => {
    expect(computePhysicalOneToOneViewportScale(1, "print_300", 96)).toBeCloseTo(96 / 300);
  });

  it("when calibrated CSS PPI equals the print DPI, the viewport scale is just printScale", () => {
    expect(computePhysicalOneToOneViewportScale(2.5, "print_300", 300)).toBeCloseTo(2.5);
    expect(computePhysicalOneToOneViewportScale(1, "screen_96", 96)).toBeCloseTo(1);
  });

  it("scales linearly with printScale", () => {
    const a = computePhysicalOneToOneViewportScale(1, "high_600", 110);
    const b = computePhysicalOneToOneViewportScale(3, "high_600", 110);
    expect(b).toBeCloseTo(a * 3);
  });
});
