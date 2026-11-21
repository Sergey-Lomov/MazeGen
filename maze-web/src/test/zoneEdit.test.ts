import { describe, it, expect, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { zonesInitialState } from "../store/slices/zonesSlice";
import { activeFieldCellKeys, cellsInActiveField, editFieldOf, fieldToolsActive, smoothingOf, zoneEditActive, zonePointsOnFloor, zoneToolReaches } from "../store/fieldEditTarget";
import { decodePoint, encodePoint } from "../domain/tessellationProjection";
import type { Zone } from "../wasm/mazeService";
import { hidesOtherZones, zoneColors, zoneIntersections } from "../domain/selectors/zoneSelectors";

const floors = [{ id: "floor_0", title: "Floor 1" }, { id: "floor_1", title: "Floor 2" }];
const FAR = 900;

function setup(zones: Zone[], overrides: Partial<ReturnType<typeof useMazeStore.getState>> = {}) {
  const base = useMazeStore.getState().floorFields.floor_0 ?? useMazeStore.getState().floorFields[useMazeStore.getState().activeFloorId];
  useMazeStore.setState({
    ...zonesInitialState,
    openCard: "zones",
    floors,
    activeFloorId: "floor_0",
    floorFields: { floor_0: base, floor_1: base },
    zones,
    nextZoneId: 10,
    zoneEditDraft: zones.find((z) => z.id === 1) ?? null,
    ...overrides,
  });
}

const zone = (cells: Zone["cells"]): Zone => ({ id: 1, name: "", kind: "manual", cells });

describe("zone editing target", () => {
  beforeEach(() => useMazeStore.setState({ ...zonesInitialState, openCard: "zones" }));

  it("is active only on the zones card with an existing zone", () => {
    setup([zone([])]);
    expect(zoneEditActive(useMazeStore.getState())).toBe(true);
    expect(fieldToolsActive(useMazeStore.getState())).toBe(true);
    useMazeStore.setState({ zoneEditDraft: null });
    expect(zoneEditActive(useMazeStore.getState())).toBe(false);
    useMazeStore.setState({ zoneEditDraft: zone([]), openCard: "generation" });
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
    const added = useMazeStore.getState().zoneEditDraft!.cells;
    expect(added).toContainEqual([1, 7, 7]);
    expect(added.filter(([f]) => f === 0)).toEqual([[0, 0, 0], [0, 1, 0]]);
    useMazeStore.getState().removeZoneCells([[0, 0], [3, 3]]);
    expect(useMazeStore.getState().zoneEditDraft!.cells.filter(([f]) => f === 0)).toEqual([[0, 1, 0]]);
    expect(useMazeStore.getState().zoneEditDraft!.cells).toContainEqual([1, 7, 7]);
  });

  it("keeps the draft when an edit changes nothing, and never touches the zones list", () => {
    setup([zone([[0, 0, 0]])]);
    const before = useMazeStore.getState().zoneEditDraft;
    const zonesBefore = useMazeStore.getState().zones;
    useMazeStore.getState().addZoneCells([[0, 0]]);
    useMazeStore.getState().removeZoneCells([[4, 4]]);
    expect(useMazeStore.getState().zoneEditDraft).toBe(before);
    expect(useMazeStore.getState().zones).toBe(zonesBefore);
  });

  it("caches the zone's floor points per cells array", () => {
    const z = zone([[0, 0, 0]]);
    expect(zonePointsOnFloor(z, 0)).toBe(zonePointsOnFloor(z, 0));
    expect(zonePointsOnFloor(z, 1).size).toBe(0);
  });
});

describe("zone editor lifecycle", () => {
  const s = () => useMazeStore.getState();
  beforeEach(() => useMazeStore.setState({ ...zonesInitialState }));

  it("opens a newly added zone as a draft without touching the zones list", () => {
    s().addManualZone();
    expect(s().zones).toHaveLength(0);
    expect(s().zoneEditDraft).toEqual({ id: 1, name: "", kind: "manual", cells: [] });
    expect(s().zoneEditDraft?.id).toBe(1);
    expect(s().zoneEditIsNew).toBe(true);
  });

  it("Done commits a new draft with its colour; an edit of a stored zone only lands on Done", () => {
    s().addManualZone();
    s().setZoneName("Hall");
    s().setZoneColor(0x123456);
    expect(s().zones).toHaveLength(0);
    expect(s().zoneColorOverrides).toEqual({});
    s().commitZoneEdit();
    expect(s().zones.map((z) => z.name)).toEqual(["Hall"]);
    expect(s().zoneColorOverrides).toEqual({ 1: 0x123456 });
    expect(s().zoneEditDraft).toBeNull();

    s().setZoneEditId(1);
    s().setZoneName("Yard");
    s().setZoneColor(null);
    expect(s().zones[0].name).toBe("Hall");
    expect(s().zoneColorOverrides).toEqual({ 1: 0x123456 });
    s().setZoneEditId(null);
    expect(s().zones[0].name).toBe("Yard");
    expect(s().zoneColorOverrides).toEqual({});
  });

  it("cancel drops a new draft and restores a stored zone", () => {
    s().addManualZone();
    s().cancelZoneEdit();
    expect(s().zones).toHaveLength(0);
    expect(s().zoneEditDraft).toBeNull();
    expect(s().zoneEditDraft).toBeNull();

    s().addManualZone();
    s().commitZoneEdit();
    s().setZoneEditId(1);
    s().setZoneName("Changed");
    s().cancelZoneEdit();
    expect(s().zones).toHaveLength(1);
    expect(s().zones[0].name).toBe("");
    expect(s().zoneEditDraft).toBeNull();
  });

  it("adding again while a new zone is edited changes nothing", () => {
    s().addManualZone();
    s().setZoneColor(0x123456);
    s().addManualZone();
    expect(s().zoneEditDraft?.id).toBe(1);
    expect(s().zoneEditIsNew).toBe(true);
    expect(s().zoneEditDraftColor).toBe(0x123456);
    expect(s().nextZoneId).toBe(2);
  });

  it("leaving the editor any way but Done discards the draft", () => {
    s().addManualZone();
    s().addZoneEditNewGroup("G");
    s().setZonesPanelOpen(false);
    expect(s().zones).toHaveLength(0);
    expect(s().zoneGroups).toEqual([]);
    expect(s().zoneEditDraft).toBeNull();
    expect(s().zoneEditDraftNewGroups).toEqual([]);

    s().addManualZone();
    s().commitZoneEdit();
    const id = s().zones[0].id;
    s().addManualZone();
    s().setZoneEditId(id);
    expect(s().zones).toHaveLength(1);
    expect(s().zoneEditDraft?.id).toBe(id);
    s().setZonesPanelOpen(false);
    expect(s().zones).toHaveLength(1);
    expect(s().zoneEditDraft).toBeNull();
  });

  it("group links go into the draft and reach the groups only on Done", () => {
    useMazeStore.setState({ zoneGroups: [{ id: 7, name: "Has", zoneIds: [] }, { id: 8, name: "Other", zoneIds: [] }], nextZoneGroupId: 9 });
    s().addManualZone();
    s().addZoneEditGroup(7);
    s().addZoneEditGroup(7);
    s().addZoneEditGroup(99);
    s().addZoneEditNewGroup("Fresh");
    s().addZoneEditNewGroup("Gone");
    s().removeZoneEditNewGroup(1);
    expect(s().zoneEditDraftGroupIds).toEqual([7]);
    expect(s().zoneGroups.every((g) => g.zoneIds.length === 0)).toBe(true);
    s().commitZoneEdit();
    expect(s().zoneGroups).toEqual([
      { id: 7, name: "Has", zoneIds: [1] },
      { id: 8, name: "Other", zoneIds: [] },
      { id: 9, name: "Fresh", zoneIds: [1] },
    ]);
    expect(s().nextZoneGroupId).toBe(10);

    s().setZoneEditId(1);
    expect(s().zoneEditDraftGroupIds).toEqual([7, 9]);
    s().removeZoneEditGroup(7);
    expect(s().zoneGroups[0].zoneIds).toEqual([1]);
    s().commitZoneEdit();
    expect(s().zoneGroups[0].zoneIds).toEqual([]);
  });

  it("Done of the zone editor also relinks an open group draft, so the group's Done keeps the zone", () => {
    useMazeStore.setState({ zoneGroups: [{ id: 7, name: "G", zoneIds: [] }], nextZoneGroupId: 8 });
    s().addManualZone();
    s().addZoneEditGroup(7);
    s().setZoneGroupEditId(7);
    s().commitZoneEdit();
    expect(s().zoneGroupEditDraft?.zoneIds).toEqual([1]);
    s().commitZoneGroupEdit();
    expect(s().zoneGroups[0].zoneIds).toEqual([1]);
  });

  it("deleting the edited zone closes the editor", () => {
    s().addManualZone();
    s().commitZoneEdit();
    s().setZoneEditId(1);
    s().removeZone(1);
    expect(s().zoneEditDraft).toBeNull();
    expect(s().zoneEditDraft).toBeNull();
  });

  it("renames a zone and keeps colour overrides out of the other zones' slots", () => {
    s().addManualZone();
    s().commitZoneEdit();
    s().addManualZone();
    s().commitZoneEdit();
    const [a, b] = s().zones;
    s().setZoneEditId(a.id);
    s().setZoneName("Hall");
    s().commitZoneEdit();
    expect(s().zones[0].name).toBe("Hall");

    const before = zoneColors(s().zones);
    s().addManualZone();
    s().commitZoneEdit();
    expect(zoneColors(s().zones).slice(0, 2)).toEqual(before);
    s().removeZone(s().zones[2].id);
    s().setZoneEditId(a.id);
    s().setZoneColor(0x123456);
    s().commitZoneEdit();
    const after = zoneColors(s().zones, s().zoneColorOverrides);
    expect(after[0]).toBe(0x123456);
    expect(after[1]).toBe(before[1]);

    s().setZoneEditId(a.id);
    s().setZoneColor(null);
    s().commitZoneEdit();
    expect(s().zoneColorOverrides).toEqual({});
    s().setZoneEditId(b.id);
    s().setZoneColor(0xabcdef);
    s().commitZoneEdit();
    s().removeZone(b.id);
    expect(s().zoneColorOverrides).toEqual({});
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
    useMazeStore.setState({ ...zonesInitialState, openCard: "zones", smoothPrimitives: true });
    useMazeStore.getState().addManualZone();
    const state = useMazeStore.getState();
    expect(state.zoneSmoothing).toBe(false);
    expect(smoothingOf(state)).toBe(false);
    expect(smoothingOf({ ...state, zoneEditDraft: null })).toBe(true);
  });
});

describe("zone hover reach and visibility", () => {
  it("lets Add reach field cells only and Remove the zone's own cells", () => {
    const zone: Zone = { id: 1, name: "", kind: "manual", cells: [[0, 0, 0]] };
    useMazeStore.setState({ ...zonesInitialState, openCard: "zones", zones: [zone], zoneEditDraft: zone });
    const state = useMazeStore.getState();
    const inField = [...activeFieldCellKeys(state)].map(decodePoint)[0];
    expect(zoneToolReaches(state, "add", inField[0], inField[1])).toBe(true);
    expect(zoneToolReaches(state, "add", 9999, 9999)).toBe(false);
    expect(zoneToolReaches(state, "remove", 0, 0)).toBe(true);
    expect(zoneToolReaches(state, "remove", 9999, 9999)).toBe(false);
  });

  it("hides the other zones only while a zone is edited with the switch off", () => {
    expect(hidesOtherZones({ zoneEditDraft: zone([]), showOtherZones: false })).toBe(true);
    expect(hidesOtherZones({ zoneEditDraft: zone([]), showOtherZones: true })).toBe(false);
    expect(hidesOtherZones({ zoneEditDraft: null, showOtherZones: false })).toBe(false);
  });
});
