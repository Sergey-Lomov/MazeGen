import { describe, it, expect, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { zonesInitialState } from "../store/slices/zonesSlice";
import type { Zone } from "../wasm/mazeService";
import { combineZoneCells, previewZoneCombine } from "../pixi/selectors/zoneCombine";

const zone = (id: number, cells: Zone["cells"]): Zone => ({ id, name: "", kind: "manual", cells });
const sorted = (cells: Zone["cells"]) => cells.map((c) => c.join(",")).sort();

const current = zone(1, [[0, 0, 0], [0, 1, 0], [1, 5, 5]]);
const other = zone(2, [[0, 1, 0], [0, 2, 0], [1, 6, 6]]);

describe("combineZoneCells", () => {
  it("union keeps the zone's cells and adds the other's new ones", () => {
    expect(sorted(combineZoneCells(current.cells, other.cells, "union"))).toEqual(["0,0,0", "0,1,0", "0,2,0", "1,5,5", "1,6,6"]);
  });

  it("intersection keeps the shared cells", () => {
    expect(combineZoneCells(current.cells, other.cells, "intersection")).toEqual([[0, 1, 0]]);
  });

  it("subtraction drops the other's cells", () => {
    expect(sorted(combineZoneCells(current.cells, other.cells, "subtraction"))).toEqual(["0,0,0", "1,5,5"]);
  });

  it("treats the same point on another floor as another cell", () => {
    expect(combineZoneCells([[0, 1, 1]], [[1, 1, 1]], "intersection")).toEqual([]);
  });
});

describe("previewZoneCombine", () => {
  it("lists added and removed cells with per-floor counts", () => {
    const union = previewZoneCombine(current, other, "union");
    expect(sorted(union.added)).toEqual(["0,2,0", "1,6,6"]);
    expect(union.removed).toEqual([]);
    expect(union.floors).toEqual([{ floor: 0, added: 1, removed: 0, total: 3 }, { floor: 1, added: 1, removed: 0, total: 2 }]);

    const intersection = previewZoneCombine(current, other, "intersection");
    expect(intersection.added).toEqual([]);
    expect(sorted(intersection.removed)).toEqual(["0,0,0", "1,5,5"]);
    expect(intersection.floors).toEqual([{ floor: 0, added: 0, removed: 1, total: 1 }, { floor: 1, added: 0, removed: 1, total: 0 }]);
  });

  it("reports no change when the result equals the zone", () => {
    expect(previewZoneCombine(current, zone(3, []), "union").floors).toEqual([]);
  });
});

describe("zone combine store", () => {
  beforeEach(() => {
    useMazeStore.setState({ ...zonesInitialState, zones: [current, other], nextZoneId: 10, zoneEditDraft: current });
  });

  it("opens on union with no zone chosen, and a second toggle closes it", () => {
    const s = useMazeStore.getState();
    s.toggleZoneCombine();
    expect(useMazeStore.getState().zoneCombine).toEqual({ op: "union", otherId: null });
    s.toggleZoneCombine();
    expect(useMazeStore.getState().zoneCombine).toBeNull();
  });

  it("does not open without an edited zone", () => {
    useMazeStore.setState({ zoneEditDraft: null });
    useMazeStore.getState().toggleZoneCombine();
    expect(useMazeStore.getState().zoneCombine).toBeNull();
  });

  it("keeps the chosen zone when the operation changes", () => {
    const s = useMazeStore.getState();
    s.toggleZoneCombine();
    s.setZoneCombineOther(2);
    s.setZoneCombineOp("subtraction");
    expect(useMazeStore.getState().zoneCombine).toEqual({ op: "subtraction", otherId: 2 });
  });

  it("ignores the draft itself and unknown zones as the other zone", () => {
    const s = useMazeStore.getState();
    s.toggleZoneCombine();
    s.setZoneCombineOther(1);
    expect(useMazeStore.getState().zoneCombine?.otherId).toBeNull();
    s.setZoneCombineOther(99);
    expect(useMazeStore.getState().zoneCombine?.otherId).toBeNull();
  });

  it("applies the operation to the draft only, on every floor, and closes the panel", () => {
    const s = useMazeStore.getState();
    s.toggleZoneCombine();
    s.setZoneCombineOp("intersection");
    s.setZoneCombineOther(2);
    s.applyZoneCombine();
    const after = useMazeStore.getState();
    expect(after.zoneEditDraft?.cells).toEqual([[0, 1, 0]]);
    expect(after.zones[0]).toBe(current);
    expect(after.zoneCombine).toBeNull();
  });

  it("does nothing on apply while no zone is chosen", () => {
    const s = useMazeStore.getState();
    s.toggleZoneCombine();
    s.applyZoneCombine();
    expect(useMazeStore.getState().zoneEditDraft).toBe(current);
    expect(useMazeStore.getState().zoneCombine).not.toBeNull();
  });

  it("is dropped by cancel and when the editor ends", () => {
    const s = useMazeStore.getState();
    s.toggleZoneCombine();
    s.cancelZoneCombine();
    expect(useMazeStore.getState().zoneCombine).toBeNull();
    s.toggleZoneCombine();
    s.cancelZoneEdit();
    expect(useMazeStore.getState().zoneCombine).toBeNull();
  });

  it("forgets the chosen zone when it is deleted", () => {
    const s = useMazeStore.getState();
    s.toggleZoneCombine();
    s.setZoneCombineOther(2);
    s.removeZone(2);
    expect(useMazeStore.getState().zoneCombine).toEqual({ op: "union", otherId: null });
  });
});

describe("editing a zone starts on its floor", () => {
  const floors = [{ id: "floor_0", title: "1" }, { id: "floor_1", title: "2" }, { id: "floor_2", title: "3" }];
  const upper = zone(1, [[1, 0, 0], [2, 0, 0]]);
  const setup = (activeFloorId: string) => useMazeStore.setState({ ...zonesInitialState, floors, activeFloorId, zones: [upper] });

  it("goes to the zone's lowest floor when the active floor holds none of its cells", () => {
    setup("floor_0");
    useMazeStore.getState().setZoneEditId(1);
    expect(useMazeStore.getState().activeFloorId).toBe("floor_1");
  });

  it("stays when the active floor holds some of its cells", () => {
    setup("floor_2");
    useMazeStore.getState().setZoneEditId(1);
    expect(useMazeStore.getState().activeFloorId).toBe("floor_2");
  });

  it("stays for a zone with no cells", () => {
    useMazeStore.setState({ ...zonesInitialState, floors, activeFloorId: "floor_0", zones: [zone(1, [])] });
    useMazeStore.getState().setZoneEditId(1);
    expect(useMazeStore.getState().activeFloorId).toBe("floor_0");
  });
});

describe("clearZoneCells", () => {
  it("empties the draft on every floor and leaves the stored zone", () => {
    useMazeStore.setState({ ...zonesInitialState, zones: [current], zoneEditDraft: current });
    useMazeStore.getState().clearZoneCells();
    expect(useMazeStore.getState().zoneEditDraft?.cells).toEqual([]);
    expect(useMazeStore.getState().zones[0]).toBe(current);
  });
});
