import { describe, it, expect } from "vitest";
import type { Zone } from "../wasm/mazeService";
import { buildZoneRegions, buildZonesCellInspection, countManualZones, zonesOfCell } from "../pixi/selectors/zoneSelectors";

const zones: Zone[] = [
  { id: 1, name: "Auto A", kind: "auto", cells: [[0, 0, 0], [0, 1, 0], [1, 5, 5]] },
  { id: 2, name: "Manual B", kind: "manual", cells: [[0, 1, 0], [0, 2, 0]] },
  { id: 3, name: "", kind: "manual", cells: [] },
];

describe("zoneSelectors", () => {
  it("counts only manual zones, empty ones included", () => {
    expect(countManualZones(zones)).toBe(2);
    expect(countManualZones([])).toBe(0);
  });

  it("builds regions of the floor, skipping zones left empty on it", () => {
    const { nodes, groups } = buildZoneRegions(zones, 0, true, true);
    expect(groups).toHaveLength(2);
    expect(nodes.map((n) => [n.x, n.y])).toEqual([[0, 0], [1, 0], [1, 0], [2, 0]]);
    expect(buildZoneRegions(zones, 1, true, true).groups).toHaveLength(1);
  });

  it("applies the kind filters without recolouring the remaining zones", () => {
    const all = buildZoneRegions(zones, 0, true, true);
    const manualOnly = buildZoneRegions(zones, 0, false, true);
    expect(manualOnly.groups).toHaveLength(1);
    expect(manualOnly.groups[0].color).toBe(all.groups[1].color);
    expect(buildZoneRegions(zones, 0, false, false).groups).toEqual([]);
  });

  it("lists every zone holding a cell on a floor regardless of the filters", () => {
    expect(zonesOfCell(zones, 0, 1, 0).map((z) => z.id)).toEqual([1, 2]);
    expect(zonesOfCell(zones, 0, 5, 5)).toEqual([]);
    expect(zonesOfCell(zones, 1, 5, 5).map((z) => z.id)).toEqual([1]);
  });

  it("appends zone names to the cell inspection", () => {
    expect(buildZonesCellInspection(zones, 0, 1, 0)).toBe("x:1, y:0 | Auto A, Manual B");
    expect(buildZonesCellInspection(zones, 0, 9, 9)).toBe("x:9, y:9");
  });
});
