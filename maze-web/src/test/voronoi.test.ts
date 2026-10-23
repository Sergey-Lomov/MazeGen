import { describe, it, expect } from "vitest";
import { TESSELLATION_UI } from "../pixi/geometry/tessellationUi";
import { getConnectorAxes } from "../pixi/renderers/teleportConnectorAxes";
import { tessellationConfigOf, type FieldConfig } from "../fieldConfig";

const { getCellPath, getCellCenter, nearestCellCoord } = await import("../pixi/tessellationGeometry");

const cfg: FieldConfig = { tessellation: tessellationConfigOf("voronoi"), shape: { shape: "circle", radius: 4 } };

describe("voronoi registry", () => {
  it("is registered with jitter, seed and cell limit params and no orientations", () => {
    const ui = TESSELLATION_UI.voronoi;
    expect(ui.orientations).toEqual([]);
    expect(ui.orientationSlot).toBeNull();
    expect(ui.paramSpecs.map((spec) => spec.name)).toEqual(["jitter", "seed", "max_cells"]);
    expect(Object.keys(ui.defaultParams)).toEqual(ui.paramSpecs.map((spec) => spec.name));
    for (const spec of ui.paramSpecs) {
      const value = ui.defaultParams[spec.name];
      expect(spec.type === "choice" ? spec.options.includes(value as string) : (value as number) >= spec.min && (value as number) <= spec.max, spec.name).toBe(true);
    }
  });

  it("has connector axes", () => {
    expect(getConnectorAxes(cfg).length).toBeGreaterThan(0);
  });
});

describe("voronoi cell geometry", () => {
  it("draws straight-sided polygons whose center hit-tests to the cell itself", () => {
    for (const cell of [[0, 0], [1, 0], [-1, 2], [2, -2]] as [number, number][]) {
      const path = getCellPath(cell[0], cell[1], cfg);
      expect(path.length, `${cell}`).toBeGreaterThanOrEqual(4);
      expect(path.every((command) => command.op !== "arc_to"), `${cell}`).toBe(true);
      const center = getCellCenter(cell[0], cell[1], cfg);
      expect(nearestCellCoord(center.x, center.y, cfg), `${cell}`).toEqual(cell);
    }
  });
});
