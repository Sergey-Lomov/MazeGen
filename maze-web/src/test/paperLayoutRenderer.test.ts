import { describe, expect, it } from "vitest";
import type { PrintExportSettings } from "../store/storeTypes";
import { paperLayoutWorldGeometry } from "../pixi/PaperLayoutRenderer";

const settings: PrintExportSettings = {
  density: "print_300",
  paperSize: "a4",
  customWidthMm: 210,
  customHeightMm: 297,
  orientation: "portrait",
  marginHMm: 10,
  marginVMm: 12,
  scale: 1,
  scaleAutoFit: false,
  anchor: "center",
  offsetXMm: 0,
  offsetYMm: 0,
};

describe("paperLayoutWorldGeometry", () => {
  it("uses the shared paper dimensions and margins", () => {
    const geometry = paperLayoutWorldGeometry({ type: "square" }, settings);
    expect(geometry).not.toBeNull();
    expect(geometry?.cellSizeMm).toBeCloseTo(40 * 25.4 / 300);
    expect(geometry?.marginHorizontal).toBeCloseTo(10 * 40 / geometry!.cellSizeMm);
    expect(geometry?.marginVertical).toBeCloseTo(12 * 40 / geometry!.cellSizeMm);
  });

  it("uses the automatic 10 mm cell measure", () => {
    expect(paperLayoutWorldGeometry({ type: "square" }, { ...settings, scaleAutoFit: true })?.cellSizeMm).toBe(10);
  });

  it("rejects invalid margins", () => {
    expect(paperLayoutWorldGeometry({ type: "square" }, { ...settings, marginHMm: -1 })).toBeNull();
  });
});
