import { describe, it, expect, vi } from "vitest";
import { TILE_SIZE } from "../pixi/constants";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import type { ExportMargin } from "../pixi/imageExport/exportMargins";
import type { DigitalExportSettings } from "../store/storeTypes";

// getCartesian (cartesianCache.ts) delegates to wasm, unavailable in this unit-test environment —
// same square-tessellation mock as hexGeometry.test.ts.
vi.mock("../pixi/cartesianCache", () => ({
  getCartesian: (x: number, y: number): [number, number] => [x, y],
}));

const { computeDigitalExportFit, placeInBox } = await import("../pixi/imageExport/exportFit");

const cfg: TessellationConfig = { type: "square", width: 10, height: 10 };
const zeroMargin: ExportMargin = { left: 0, right: 0, top: 0, bottom: 0 };
const uniformMargin = (v: number): ExportMargin => ({ left: v, right: v, top: v, bottom: v });

function edgeToEdgeSettings(scale: number): DigitalExportSettings {
  return { scale, canvasMode: "edge_to_edge", marginValue: 0, fixedWidth: 0, fixedHeight: 0 };
}

describe("computeDigitalExportFit — edge_to_edge", () => {
  it("scales the canvas size with the scale multiplier for the same maze", () => {
    const nodes = [{ id: 0, x: 0, y: 0 }, { id: 1, x: 1, y: 0 }];
    const margin = uniformMargin(TILE_SIZE / 2);
    const fit1 = computeDigitalExportFit(cfg, nodes, margin, edgeToEdgeSettings(1));
    const fit2 = computeDigitalExportFit(cfg, nodes, margin, edgeToEdgeSettings(2));
    expect(fit2.width).toBeCloseTo(fit1.width * 2);
    expect(fit2.height).toBeCloseTo(fit1.height * 2);
  });

  it("grows the canvas size with the maze's own bounding box", () => {
    const margin = uniformMargin(TILE_SIZE / 2);
    const small = computeDigitalExportFit(cfg, [{ id: 0, x: 0, y: 0 }], margin, edgeToEdgeSettings(1));
    const big = computeDigitalExportFit(cfg, [{ id: 0, x: 0, y: 0 }, { id: 1, x: 5, y: 5 }], margin, edgeToEdgeSettings(1));
    expect(big.width).toBeGreaterThan(small.width);
    expect(big.height).toBeGreaterThan(small.height);
  });

  it("returns a positive-size canvas for a single node when margin > 0", () => {
    const fit = computeDigitalExportFit(cfg, [{ id: 0, x: 0, y: 0 }], uniformMargin(TILE_SIZE / 2), edgeToEdgeSettings(1));
    expect(fit.width).toBeGreaterThan(0);
    expect(fit.height).toBeGreaterThan(0);
  });

  it("returned scale equals the input scale", () => {
    const fit = computeDigitalExportFit(cfg, [{ id: 0, x: 0, y: 0 }], uniformMargin(TILE_SIZE / 2), edgeToEdgeSettings(3));
    expect(fit.scale).toBe(3);
  });

  it("x/y offset shifts the maze's own min bound (minus margin) to sit at screen 0", () => {
    const nodes = [{ id: 0, x: 2, y: 2 }];
    const margin = uniformMargin(TILE_SIZE / 2);
    const fit = computeDigitalExportFit(cfg, nodes, margin, edgeToEdgeSettings(1));
    // A single node's exact cell-vertex bounding box minX is its own center x (2.5 * TILE_SIZE)
    // minus the square tile's own half-extent (TILE_SIZE / 2), then minus the margin on top.
    const worldMinX = 2.5 * TILE_SIZE - TILE_SIZE / 2 - TILE_SIZE / 2;
    expect(worldMinX * fit.scale + fit.x).toBeCloseTo(0);
  });

  it("overflow is always false (canvas always fits the content)", () => {
    const fit = computeDigitalExportFit(cfg, [{ id: 0, x: 0, y: 0 }], zeroMargin, edgeToEdgeSettings(1));
    expect(fit.overflow).toBe(false);
  });

  it("contentWidth/contentHeight equal the canvas width/height (no fixed canvas to differ from)", () => {
    const fit = computeDigitalExportFit(cfg, [{ id: 0, x: 0, y: 0 }], uniformMargin(TILE_SIZE / 2), edgeToEdgeSettings(1));
    expect(fit.contentWidth).toBeCloseTo(fit.width);
    expect(fit.contentHeight).toBeCloseTo(fit.height);
  });

  it("a smaller margin produces a smaller canvas than a larger one for the same content", () => {
    const smallMargin = uniformMargin(1);
    const bigMargin = uniformMargin(TILE_SIZE);
    const fitSmall = computeDigitalExportFit(cfg, [{ id: 0, x: 0, y: 0 }], smallMargin, edgeToEdgeSettings(1));
    const fitBig = computeDigitalExportFit(cfg, [{ id: 0, x: 0, y: 0 }], bigMargin, edgeToEdgeSettings(1));
    expect(fitSmall.width).toBeLessThan(fitBig.width);
    expect(fitSmall.width).toBeCloseTo(TILE_SIZE + 2); // tile width + 1px margin each side
  });
});

describe("computeDigitalExportFit — margin_px", () => {
  it("adds exactly marginValue px on top of the bounding box, independent of scale", () => {
    const nodes = [{ id: 0, x: 0, y: 0 }];
    const settings: DigitalExportSettings = { scale: 2, canvasMode: "margin_px", marginValue: 20, fixedWidth: 0, fixedHeight: 0 };
    const fitNoMargin = computeDigitalExportFit(cfg, nodes, zeroMargin, { ...settings, marginValue: 0 });
    const fit = computeDigitalExportFit(cfg, nodes, zeroMargin, settings);
    expect(fit.width).toBeCloseTo(fitNoMargin.width + 40); // 20px each side
    expect(fit.height).toBeCloseTo(fitNoMargin.height + 40);
  });

  it("at marginValue=0, matches edge_to_edge exactly (uses margin as its base, not the raw cell bound)", () => {
    const nodes = [{ id: 0, x: 0, y: 0 }];
    const margin = uniformMargin(2);
    const settings: DigitalExportSettings = { scale: 1, canvasMode: "margin_px", marginValue: 0, fixedWidth: 0, fixedHeight: 0 };
    const fitMarginPx = computeDigitalExportFit(cfg, nodes, margin, settings);
    const fitEdgeToEdge = computeDigitalExportFit(cfg, nodes, margin, edgeToEdgeSettings(1));
    expect(fitMarginPx.width).toBeCloseTo(fitEdgeToEdge.width);
    expect(fitMarginPx.height).toBeCloseTo(fitEdgeToEdge.height);
    expect(fitMarginPx.x).toBeCloseTo(fitEdgeToEdge.x);
    expect(fitMarginPx.y).toBeCloseTo(fitEdgeToEdge.y);
  });
});

describe("computeDigitalExportFit — margin_cells", () => {
  it("adds marginValue * TILE_SIZE world units, scaled with the canvas scale", () => {
    const nodes = [{ id: 0, x: 0, y: 0 }];
    const settings: DigitalExportSettings = { scale: 2, canvasMode: "margin_cells", marginValue: 1, fixedWidth: 0, fixedHeight: 0 };
    const fitNoMargin = computeDigitalExportFit(cfg, nodes, zeroMargin, { ...settings, marginValue: 0 });
    const fit = computeDigitalExportFit(cfg, nodes, zeroMargin, settings);
    expect(fit.width).toBeCloseTo(fitNoMargin.width + 2 * TILE_SIZE * settings.scale);
  });

  it("at marginValue=0, matches edge_to_edge exactly (uses margin as its base, not the raw cell bound)", () => {
    const nodes = [{ id: 0, x: 0, y: 0 }];
    const margin = uniformMargin(2);
    const settings: DigitalExportSettings = { scale: 1, canvasMode: "margin_cells", marginValue: 0, fixedWidth: 0, fixedHeight: 0 };
    const fitMarginCells = computeDigitalExportFit(cfg, nodes, margin, settings);
    const fitEdgeToEdge = computeDigitalExportFit(cfg, nodes, margin, edgeToEdgeSettings(1));
    expect(fitMarginCells.width).toBeCloseTo(fitEdgeToEdge.width);
    expect(fitMarginCells.height).toBeCloseTo(fitEdgeToEdge.height);
  });
});

describe("computeDigitalExportFit — fixed_size", () => {
  it("returns the fixed canvas size regardless of content size", () => {
    const settings: DigitalExportSettings = { scale: 1, canvasMode: "fixed_size", marginValue: 0, fixedWidth: 500, fixedHeight: 300 };
    const fit = computeDigitalExportFit(cfg, [{ id: 0, x: 0, y: 0 }], zeroMargin, settings);
    expect(fit.width).toBe(500);
    expect(fit.height).toBe(300);
  });

  it("flags overflow when content is bigger than the fixed canvas", () => {
    const settings: DigitalExportSettings = { scale: 100, canvasMode: "fixed_size", marginValue: 0, fixedWidth: 10, fixedHeight: 10 };
    const fit = computeDigitalExportFit(cfg, [{ id: 0, x: 0, y: 0 }], uniformMargin(TILE_SIZE / 2), settings);
    expect(fit.overflow).toBe(true);
    expect(fit.contentWidth).toBeGreaterThan(fit.width);
  });

  it("does not flag overflow when content fits", () => {
    const settings: DigitalExportSettings = { scale: 0.1, canvasMode: "fixed_size", marginValue: 0, fixedWidth: 5000, fixedHeight: 5000 };
    const fit = computeDigitalExportFit(cfg, [{ id: 0, x: 0, y: 0 }], uniformMargin(TILE_SIZE / 2), settings);
    expect(fit.overflow).toBe(false);
  });
});

describe("placeInBox", () => {
  it("center anchors content in the middle of the box", () => {
    const { x, y } = placeInBox(10, 10, 100, 100, 0, 0, "center");
    expect(x).toBeCloseTo(45);
    expect(y).toBeCloseTo(45);
  });

  it("top_left anchors content at the box origin plus offset", () => {
    const { x, y } = placeInBox(10, 10, 100, 100, 5, 5, "top_left");
    expect(x).toBe(5);
    expect(y).toBe(5);
  });

  it("bottom_right anchors content at the far corner", () => {
    const { x, y } = placeInBox(10, 10, 100, 100, 0, 0, "bottom_right");
    expect(x).toBeCloseTo(90);
    expect(y).toBeCloseTo(90);
  });
});

// GitHub issue #324 — "Vector by corridors" draws center-to-center lines that stop well short of a
// cell's own polygon boundary, so its tight/edge_to_edge fit must hug the cell *centers*
// (`basis: "center"`), not the cell polygon (`basis: "cell"`, the default every other mode uses).
describe("computeDigitalExportFit — edge_to_edge with basis: \"center\"", () => {
  it("produces a smaller canvas than the default cell-polygon basis for the same margin", () => {
    const nodes = [{ id: 0, x: 0, y: 0 }, { id: 1, x: 1, y: 0 }];
    const margin = uniformMargin(TILE_SIZE / 2);
    const cellFit = computeDigitalExportFit(cfg, nodes, margin, edgeToEdgeSettings(1));
    const centerFit = computeDigitalExportFit(cfg, nodes, margin, edgeToEdgeSettings(1), "center");
    expect(centerFit.width).toBeLessThan(cellFit.width);
    expect(centerFit.height).toBeLessThan(cellFit.height);
  });

  it("with zero margin, a single node's canvas collapses to zero size (bbox of one center point)", () => {
    const fit = computeDigitalExportFit(cfg, [{ id: 0, x: 0, y: 0 }], zeroMargin, edgeToEdgeSettings(1), "center");
    expect(fit.width).toBeCloseTo(0);
    expect(fit.height).toBeCloseTo(0);
  });
});
