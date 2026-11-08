import { describe, expect, it, vi } from "vitest";
import { cellSourceOf, hasTooSmallSide, measurePrintCells, type CellSource } from "../pixi/printCellSizes";
import { configAllCells } from "../pixi/tessellationCells";
import * as mazeService from "../wasm/mazeService";
import { fieldOf } from "./fieldConfigFixtures";

function typesOf(config: Parameters<typeof measurePrintCells>[0], sources: CellSource[], cellSizeMm: number) {
  return measurePrintCells(config, sources, cellSizeMm).types;
}

describe("measurePrintCells", () => {
  it("reports a square's side as the entered size", () => {
    const config = fieldOf("square", { shape: "rect", cols: 3, rows: 2 });
    const [square, ...rest] = typesOf(config, [cellSourceOf(config)], 10);
    expect(rest).toEqual([]);
    expect(square.count).toBe(6);
    expect(square.sidesMm).toHaveLength(1);
    expect(square.sidesMm[0]).toBeCloseTo(10);
    expect(square.diameterMm).toBeCloseTo(10 * Math.SQRT2);
  });

  it("reports a hexagon's diameter as the entered size", () => {
    const config = fieldOf("hex", { shape: "rect", cols: 3, rows: 3 });
    const [hexagon] = typesOf(config, [cellSourceOf(config)], 12);
    expect(hexagon.diameterMm).toBeCloseTo(12);
    expect(hexagon.sidesMm[0]).toBeCloseTo(6);
  });

  it("reports every type of a mixed tessellation with its own count and size", () => {
    const config = fieldOf("trihexagonal", { shape: "rect", cols: 4, rows: 4 });
    const types = typesOf(config, [cellSourceOf(config)], 12);
    expect(types).toHaveLength(2);
    expect(types.reduce((sum, type) => sum + type.count, 0)).toBe(configAllCells(config).length);
    expect(types[0].diameterMm).not.toBeCloseTo(types[1].diameterMm);
  });

  it("measures the cells of a custom field as given", () => {
    const config = fieldOf("square", { shape: "rect", cols: 3, rows: 2 });
    const [square] = typesOf(config, [{ cells: configAllCells(config) }], 10);
    expect(square.count).toBe(6);
    expect(square.sidesMm[0]).toBeCloseTo(10);
  });

  it("sums the cells of several floors and counts each floor", () => {
    const config = fieldOf("square", { shape: "rect", cols: 3, rows: 2 });
    const other = fieldOf("square", { shape: "rect", cols: 2, rows: 2 });
    const measure = measurePrintCells(
      config,
      [cellSourceOf(config), cellSourceOf(other), cellSourceOf(config), { cells: [[0, 0]] }],
      10,
    );
    expect(measure.types[0].count).toBe(6 + 4 + 6 + 1);
    expect(measure.sourceCounts).toEqual([6, 4, 6, 1]);
  });

  it("counts a refused preset as no cells", () => {
    const config = fieldOf("square", { shape: "rect", cols: 3, rows: 2 });
    const refused = fieldOf("square", { shape: "rect", cols: 0, rows: 0 });
    const measure = measurePrintCells(config, [cellSourceOf(refused), cellSourceOf(config)], 10);
    expect(measure.sourceCounts).toEqual([0, 6]);
  });

  it("is empty without cells, and has no sizes for an unusable size", () => {
    const config = fieldOf("square", { shape: "rect", cols: 3, rows: 2 });
    expect(measurePrintCells(config, [], 10)).toEqual({ types: [], sourceCounts: [] });
    const unusable = measurePrintCells(config, [cellSourceOf(config)], Number.NaN);
    expect(unusable.types).toEqual([]);
    expect(unusable.sourceCounts).toEqual([6]);
  });

  it("flags a type whose shortest side is under 5 mm", () => {
    const config = fieldOf("trihexagonal", { shape: "rect", cols: 4, rows: 4 });
    const sources = [cellSourceOf(config)];
    expect(typesOf(config, sources, 12).some(hasTooSmallSide)).toBe(false);
    expect(typesOf(config, sources, 6).some(hasTooSmallSide)).toBe(true);
  });

  it("asks core once for the same cells however the entered size changes", () => {
    const config = fieldOf("square", { shape: "rect", cols: 7, rows: 5 });
    const spy = vi.spyOn(mazeService, "getFieldCellSizes");
    const sources = [cellSourceOf(config)];
    const at10 = typesOf(config, sources, 10);
    const at20 = typesOf(config, sources, 20);
    typesOf(config, sources, 10);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(at10[0].sidesMm[0]).toBeCloseTo(10);
    expect(at20[0].sidesMm[0]).toBeCloseTo(20);
    spy.mockRestore();
  });

  it("sends floors of one shape once with their number", () => {
    const config = fieldOf("square", { shape: "rect", cols: 4, rows: 3 });
    const other = fieldOf("square", { shape: "rect", cols: 2, rows: 2 });
    const spy = vi.spyOn(mazeService, "getFieldCellSizes");
    const [square] = typesOf(config, [cellSourceOf(config), cellSourceOf(other), cellSourceOf(config)], 10);
    const presets = spy.mock.calls[0][1].presets;
    expect(presets).toHaveLength(2);
    expect(presets.map((p) => p.times).sort()).toEqual([1, 2]);
    expect(square.count).toBe(2 * 12 + 4);
    spy.mockRestore();
  });

  it("survives core failing and does not cache the failure", () => {
    const config = fieldOf("square", { shape: "rect", cols: 9, rows: 9 });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const spy = vi.spyOn(mazeService, "getFieldCellSizes").mockImplementationOnce(() => { throw new Error("boom"); });
    const sources = [cellSourceOf(config), { cells: [[0, 0]] as [number, number][] }];
    const failed = measurePrintCells(config, sources, 10);
    expect(failed.types).toEqual([]);
    expect(failed.sourceCounts).toEqual([0, 1]);
    expect(measurePrintCells(config, sources, 10).types[0].count).toBe(82);
    spy.mockRestore();
    error.mockRestore();
  });

  it("takes a custom field too large to spread into a call", () => {
    const config = fieldOf("square", { shape: "rect", cols: 2, rows: 2 });
    const cells: [number, number][] = Array.from({ length: 200_000 }, (_, i) => [i % 400, Math.floor(i / 400)]);
    const spy = vi.spyOn(mazeService, "getFieldCellSizes").mockReturnValue({
      types: [{ key: "cell", count: cells.length, sides: [1], diameter: 1.4, regular: true }],
      presetCounts: [],
    });
    expect(() => measurePrintCells(config, [{ cells }], 10)).not.toThrow();
    expect(spy.mock.calls[0][1].cells).toHaveLength(200_000);
    spy.mockRestore();
  });
});
