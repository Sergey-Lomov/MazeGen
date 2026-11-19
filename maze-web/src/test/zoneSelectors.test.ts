import { describe, it, expect } from "vitest";
import type { Zone } from "../wasm/mazeService";
import {
  buildZoneHoverRegion, buildZoneRegions, buildZonesCellInspection, countManualZones, countZonesOfKind, zoneDisplayName, zoneFloors, zonesOfCell,
} from "../pixi/selectors/zoneSelectors";
import { useMazeStore } from "../store/mazeStore";

const zones: Zone[] = [
  { id: 1, name: "Auto A", kind: "auto", cells: [[0, 0, 0], [0, 1, 0], [1, 5, 5]] },
  { id: 2, name: "Manual B", kind: "manual", cells: [[0, 1, 0], [0, 2, 0]] },
  { id: 3, name: "", kind: "manual", cells: [] },
];

describe("zones list", () => {
  it("counts zones per kind and names unnamed ones by id", () => {
    expect(countZonesOfKind(zones, "auto")).toBe(1);
    expect(countZonesOfKind(zones, "manual")).toBe(2);
    expect(zoneDisplayName(zones[0])).toBe("Auto A");
    expect(zoneDisplayName(zones[2])).toBe("Zone #3");
  });

  it("lists the floors a zone occupies, ascending and distinct", () => {
    expect(zoneFloors({ id: 9, name: "", kind: "auto", cells: [[2, 0, 0], [0, 0, 0], [2, 1, 1]] })).toEqual([0, 2]);
    expect(zoneFloors(zones[2])).toEqual([]);
  });

  it("leaves hidden zones out of the regions but keeps the colours", () => {
    const all = buildZoneRegions(zones, 0, true, true);
    const withoutFirst = buildZoneRegions(zones, 0, true, true, [1]);
    expect(withoutFirst.groups).toHaveLength(1);
    expect(withoutFirst.groups[0].color).toBe(all.groups[1].color);
  });

  it("builds the hover region regardless of kind filters and visibility, null off the floor", () => {
    const region = buildZoneHoverRegion(zones, 1, 0);
    expect(region?.nodes.map((n) => [n.x, n.y])).toEqual([[0, 0], [1, 0]]);
    expect(region?.groups[0].color).toBe(buildZoneRegions(zones, 0, true, true).groups[0].color);
    expect(buildZoneHoverRegion(zones, 2, 1)).toBeNull();
    expect(buildZoneHoverRegion(zones, 3, 0)).toBeNull();
    expect(buildZoneHoverRegion(zones, 99, 0)).toBeNull();
  });
});

describe("zones slice list state", () => {
  it("toggles visibility, adds a manual zone and cleans up on delete", () => {
    const s = () => useMazeStore.getState();
    s().addManualZone();
    const added = s().zones[s().zones.length - 1];
    expect(added.kind).toBe("manual");
    s().toggleZoneVisibility(added.id);
    expect(s().hiddenZoneIds).toContain(added.id);
    s().toggleZoneVisibility(added.id);
    expect(s().hiddenZoneIds).not.toContain(added.id);
    s().toggleZoneVisibility(added.id);
    s().setHoveredZone(added.id);
    s().removeZone(added.id);
    expect(s().zones.some((zone) => zone.id === added.id)).toBe(false);
    expect(s().hiddenZoneIds).not.toContain(added.id);
    expect(s().hoveredZoneId).toBeNull();
  });

  it("never reuses the id of a deleted zone", () => {
    const s = () => useMazeStore.getState();
    useMazeStore.setState({ zones: [], nextZoneId: 1 });
    s().addManualZone();
    s().setZoneEditId(null);
    s().addManualZone();
    s().setZoneEditId(null);
    s().removeZone(2);
    s().addManualZone();
    expect(s().zones.map((zone) => zone.id)).toEqual([1, 3]);
  });

  it("clears the hover when the panel closes or the section switches", () => {
    const s = () => useMazeStore.getState();
    s().setZonesPanelOpen(true);
    s().setHoveredZone(1);
    s().setZonesListMode("manual");
    expect(s().hoveredZoneId).toBeNull();
    s().setHoveredZone(1);
    s().setZonesPanelOpen(false);
    expect(s().hoveredZoneId).toBeNull();
  });
});

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
