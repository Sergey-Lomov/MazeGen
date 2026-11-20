import { describe, it, expect, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { zonesTransientUi } from "../store/slices/zonesSlice";
import { activeFieldCellKeys, cellsInActiveField, editFieldOf, fieldToolsActive, smoothingOf, zoneEditActive, zonePointsOnFloor, zoneToolReaches } from "../pixi/fieldEditTarget";
import { decodePoint, encodePoint } from "../pixi/tessellationProjection";
import type { Zone } from "../wasm/mazeService";
import { hidesOtherZones, zoneColors, zoneIntersections } from "../pixi/selectors/zoneSelectors";

const floors = [{ id: "floor_0", title: "Floor 1" }, { id: "floor_1", title: "Floor 2" }];
const FAR = 900;

function setup(zones: Zone[], overrides: Partial<ReturnType<typeof useMazeStore.getState>> = {}) {
  const base = useMazeStore.getState().floorFields.floor_0 ?? useMazeStore.getState().floorFields[useMazeStore.getState().activeFloorId];
  useMazeStore.setState({
    ...zonesTransientUi,
    openCard: "zones",
    floors,
    activeFloorId: "floor_0",
    floorFields: { floor_0: base, floor_1: base },
    zones,
    nextZoneId: 10,
    zoneEditId: 1,
    ...overrides,
  });
}

const zone = (cells: Zone["cells"]): Zone => ({ id: 1, name: "", kind: "manual", cells });

describe("zone editing target", () => {
  beforeEach(() => useMazeStore.setState({ ...zonesTransientUi, openCard: "zones" }));

  it("is active only on the zones card with an existing zone", () => {
    setup([zone([])]);
    expect(zoneEditActive(useMazeStore.getState())).toBe(true);
    expect(fieldToolsActive(useMazeStore.getState())).toBe(true);
    useMazeStore.setState({ zoneEditId: 99 });
    expect(zoneEditActive(useMazeStore.getState())).toBe(false);
    useMazeStore.setState({ zoneEditId: 1, openCard: "generation" });
    expect(zoneEditActive(useMazeStore.getState())).toBe(false);
  });

  it("shows the zone's cells of the active floor as the tools' field points", () => {
    setup([zone([[0, 0, 0], [0, 1, 0], [1, 5, 5]])]);
    const view = editFieldOf(useMazeStore.getState());
    expect([...view.fieldPoints].sort()).toEqual([encodePoint(0, 0), encodePoint(1, 0)].sort());
    expect(view.fieldEditMode).toBe("custom");
    expect(editFieldOf(useMazeStore.getState())).toBe(view);
  });

  it("returns the floor's own field outside the zone editor", () => {
    setup([zone([])], { openCard: "field_setup" });
    const state = useMazeStore.getState();
    expect(editFieldOf(state)).toBe(state.floorFields[state.activeFloorId]);
  });

  it("drops cells that are not part of the field", () => {
    setup([zone([])]);
    const state = useMazeStore.getState();
    expect(activeFieldCellKeys(state).has(encodePoint(0, 0))).toBe(true);
    expect(cellsInActiveField(state, [[0, 0], [FAR, FAR]])).toEqual([[0, 0]]);
  });

  it("adds, dedupes and removes cells on the active floor only", () => {
    setup([zone([[1, 7, 7]])]);
    const store = useMazeStore.getState();
    store.addZoneCells([[0, 0], [1, 0], [0, 0]]);
    const added = useMazeStore.getState().zones[0].cells;
    expect(added).toContainEqual([1, 7, 7]);
    expect(added.filter(([f]) => f === 0)).toEqual([[0, 0, 0], [0, 1, 0]]);
    useMazeStore.getState().removeZoneCells([[0, 0], [3, 3]]);
    expect(useMazeStore.getState().zones[0].cells.filter(([f]) => f === 0)).toEqual([[0, 1, 0]]);
    expect(useMazeStore.getState().zones[0].cells).toContainEqual([1, 7, 7]);
  });

  it("keeps the zones array when an edit changes nothing", () => {
    setup([zone([[0, 0, 0]])]);
    const before = useMazeStore.getState().zones;
    useMazeStore.getState().addZoneCells([[0, 0]]);
    useMazeStore.getState().removeZoneCells([[4, 4]]);
    expect(useMazeStore.getState().zones).toBe(before);
  });

  it("caches the zone's floor points per cells array", () => {
    const z = zone([[0, 0, 0]]);
    expect(zonePointsOnFloor(z, 0)).toBe(zonePointsOnFloor(z, 0));
    expect(zonePointsOnFloor(z, 1).size).toBe(0);
  });
});

describe("zone editor lifecycle", () => {
  beforeEach(() => useMazeStore.setState({ ...zonesTransientUi }));

  it("opens a newly added zone for editing", () => {
    useMazeStore.getState().addManualZone();
    const state = useMazeStore.getState();
    expect(state.zoneEditId).toBe(state.zones[0].id);
  });

  it("stops editing when the zone is deleted or the panel closes", () => {
    useMazeStore.getState().addManualZone();
    const id = useMazeStore.getState().zones[0].id;
    useMazeStore.getState().removeZone(id);
    expect(useMazeStore.getState().zoneEditId).toBeNull();
    useMazeStore.getState().addManualZone();
    useMazeStore.getState().setZonesPanelOpen(false);
    expect(useMazeStore.getState().zoneEditId).toBeNull();
  });

  it("cancel deletes a zone added in this session but keeps an existing one", () => {
    useMazeStore.getState().addManualZone();
    useMazeStore.getState().cancelZoneEdit();
    expect(useMazeStore.getState().zones).toHaveLength(0);
    expect(useMazeStore.getState().zoneEditId).toBeNull();

    useMazeStore.getState().addManualZone();
    const id = useMazeStore.getState().zones[0].id;
    useMazeStore.getState().setZoneEditId(null);
    useMazeStore.getState().setZoneEditId(id);
    useMazeStore.getState().cancelZoneEdit();
    expect(useMazeStore.getState().zones).toHaveLength(1);
    expect(useMazeStore.getState().zoneEditId).toBeNull();
  });

  it("discards an unconfirmed new zone when the editor is left any way but Done", () => {
    const s = () => useMazeStore.getState();
    s().addManualZone();
    s().setZoneColor(s().zones[0].id, 0x123456);
    s().addManualZone();
    expect(s().zones.map((z) => z.id)).toEqual([2]);
    expect(s().zoneColorOverrides).toEqual({});

    s().setZonesPanelOpen(false);
    expect(s().zones).toHaveLength(0);

    s().addManualZone();
    s().setZoneEditId(null);
    expect(s().zones).toHaveLength(1);
    s().setZoneEditId(s().zones[0].id);
    s().setZonesPanelOpen(false);
    expect(s().zones).toHaveLength(1);
  });

  it("renames a zone and keeps colour overrides out of the other zones' slots", () => {
    useMazeStore.getState().addManualZone();
    useMazeStore.getState().setZoneEditId(null);
    useMazeStore.getState().addManualZone();
    useMazeStore.getState().setZoneEditId(null);
    const [a, b] = useMazeStore.getState().zones;
    useMazeStore.getState().setZoneName(a.id, "Hall");
    expect(useMazeStore.getState().zones[0].name).toBe("Hall");

    const before = zoneColors(useMazeStore.getState().zones);
    useMazeStore.getState().addManualZone();
    useMazeStore.getState().setZoneEditId(null);
    expect(zoneColors(useMazeStore.getState().zones).slice(0, 2)).toEqual(before);
    useMazeStore.getState().removeZone(useMazeStore.getState().zones[2].id);
    useMazeStore.getState().setZoneColor(a.id, 0x123456);
    const after = zoneColors(useMazeStore.getState().zones, useMazeStore.getState().zoneColorOverrides);
    expect(after[0]).toBe(0x123456);
    expect(after[1]).toBe(before[1]);

    useMazeStore.getState().setZoneColor(a.id, null);
    expect(useMazeStore.getState().zoneColorOverrides).toEqual({});
    useMazeStore.getState().setZoneColor(b.id, 0xabcdef);
    useMazeStore.getState().removeZone(b.id);
    expect(useMazeStore.getState().zoneColorOverrides).toEqual({});
  });
});

describe("zone intersections", () => {
  const zone = (id: number, cells: [number, number, number][]): Zone => ({ id, name: "", kind: "manual", cells });
  it("lists the other zones sharing a cell on the floor", () => {
    const zones = [zone(1, [[0, 0, 0], [0, 1, 0]]), zone(2, [[0, 1, 0]]), zone(3, [[1, 0, 0]]), zone(4, [[0, 5, 5]])];
    expect(zoneIntersections(zones, zones[0]).map((e) => e.zone.id)).toEqual([2]);
    expect(zoneIntersections(zones, zones[3])).toEqual([]);
  });
});

describe("zone smoothing", () => {
  it("is off by default and separate from the field's switch", () => {
    useMazeStore.setState({ ...zonesTransientUi, openCard: "zones", smoothPrimitives: true });
    useMazeStore.getState().addManualZone();
    const state = useMazeStore.getState();
    expect(state.zoneSmoothing).toBe(false);
    expect(smoothingOf(state)).toBe(false);
    expect(smoothingOf({ ...state, zoneEditId: null })).toBe(true);
  });
});

describe("zone hover reach and visibility", () => {
  it("lets Add reach field cells only and Remove the zone's own cells", () => {
    const zone: Zone = { id: 1, name: "", kind: "manual", cells: [[0, 0, 0]] };
    useMazeStore.setState({ ...zonesTransientUi, openCard: "zones", zones: [zone], zoneEditId: 1 });
    const state = useMazeStore.getState();
    const inField = [...activeFieldCellKeys(state)].map(decodePoint)[0];
    expect(zoneToolReaches(state, "add", inField[0], inField[1])).toBe(true);
    expect(zoneToolReaches(state, "add", 9999, 9999)).toBe(false);
    expect(zoneToolReaches(state, "remove", 0, 0)).toBe(true);
    expect(zoneToolReaches(state, "remove", 9999, 9999)).toBe(false);
  });

  it("hides the other zones only while a zone is edited with the switch off", () => {
    expect(hidesOtherZones({ zoneEditId: 1, showOtherZones: false })).toBe(true);
    expect(hidesOtherZones({ zoneEditId: 1, showOtherZones: true })).toBe(false);
    expect(hidesOtherZones({ zoneEditId: null, showOtherZones: false })).toBe(false);
  });
});
