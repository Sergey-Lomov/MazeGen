import { beforeEach, describe, expect, it } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { zonesInitialState } from "../store/slices/zonesSlice";
import { autoZoneIdOf, autoZoneKindOf, autoZoneName, floorName } from "../domain/autoZones";
import { autoZonesFromWire, sameAutoZones, withAutoZones } from "../store/autoZones";
import { zoneDisplayName } from "../domain/selectors/zoneSelectors";
import { zoneTypeLabel } from "../store/zoneListSort";
import { cellTypeLabel } from "../i18n/cellTypeLabel";
import type { Zone } from "../wasm/mazeService";

const auto = (key: string, cells: Zone["cells"] = [[0, 0, 0]]): Zone => ({ id: autoZoneIdOf(key)!, name: "", kind: "auto", cells });
const manual = (id: number): Zone => ({ id, name: `m${id}`, kind: "manual", cells: [] });
const floors = [{ title: "Ground", titleCustomized: true }, { title: "Floor 2", titleCustomized: false }];

describe("auto zone ids", () => {
  it("are stable, distinct per key, and read back as the zone's kind", () => {
    const keys = { maze: "maze", type: "type:1:1", floor: "floor:1", edge: "edge:0", face: "face:1:3", region: "region:0:2" } as const;
    const ids = Object.values(keys).map((key) => autoZoneIdOf(key)!);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.values(keys).map((key) => autoZoneIdOf(key))).toEqual(ids);
    for (const [kind, key] of Object.entries(keys)) expect(autoZoneKindOf(autoZoneIdOf(key)!)).toBe(kind);
  });

  it("tell a cell type zone by its floor and type index", () => {
    expect(autoZoneIdOf("type:1:0")).not.toBe(autoZoneIdOf("type:0:1"));
    expect(autoZoneIdOf("type:0:1")).not.toBe(autoZoneIdOf("region:0:1"));
    expect(autoZoneIdOf("type:0:20000")).toBeNull();
  });

  it("are refused for a key core never produces, and a manual id has no kind", () => {
    expect(autoZoneIdOf("bogus:0")).toBeNull();
    expect(autoZoneIdOf("edge:256")).toBeNull();
    expect(autoZoneIdOf("region:0:16384")).toBeNull();
    expect(autoZoneKindOf(7)).toBeNull();
  });
});

describe("autoZonesFromWire", () => {
  it("names a cell type zone by the tessellation's type key", () => {
    const zones = autoZonesFromWire([{ key: "type:0:1", cells: [[0, 1, 1]] }, { key: "type:0:7", cells: [] }], ["octagon", "square"]);
    expect(zones.map((zone) => zone.name)).toEqual(["square", ""]);
    expect(autoZonesFromWire([{ key: "type:1:0", cells: [] }], ["octagon", "square"])[0].name).toBe("octagon");
  });

  it("keeps the cells, stores no name and drops a key without an id", () => {
    const zones = autoZonesFromWire([
      { key: "edge:0", cells: [[0, 1, 1]] },
      { key: "bogus:0", cells: [] },
    ]);
    expect(zones).toEqual([{ id: autoZoneIdOf("edge:0"), name: "", kind: "auto", cells: [[0, 1, 1]] }]);
  });
});

describe("auto zone names", () => {
  it("are built from the id when shown, with the floor the user titled", () => {
    expect(autoZoneName(auto("edge:0"), floors)).toContain("Ground");
    expect(autoZoneName(auto("edge:0"), floors.slice(0, 1))).not.toContain("Ground");
    expect(autoZoneName(auto("region:1:2"), floors)).toContain("3");
    expect(autoZoneName(manual(7), floors)).toBeNull();
  });

  it("name a floor's cell type zone by the type and the floor", () => {
    const name = autoZoneName({ ...auto("type:0:1"), name: "square" }, floors);
    expect(name).toContain(cellTypeLabel("square"));
    expect(name).toContain("Ground");
    expect(autoZoneName({ ...auto("type:0:1"), name: "square" }, floors.slice(0, 1))).toBe(cellTypeLabel("square"));
  });

  it("show for a zone through zoneDisplayName, while a manual zone keeps its own name", () => {
    expect(zoneDisplayName(auto("floor:0"), floors)).toBe("Ground");
    expect(zoneDisplayName(manual(4), floors)).toBe("m4");
  });

  it("show a floor's own title or a localized default", () => {
    expect(floorName(floors, 0)).toBe("Ground");
    expect(floorName([{ title: "Stored", titleCustomized: false }], 0)).not.toBe("Stored");
    expect(floorName(floors, 5)).toBe("");
  });
});

describe("withAutoZones", () => {
  it("puts the new automatic zones first and keeps the manual ones in their order", () => {
    const result = withAutoZones([auto("maze"), manual(2), auto("edge:0"), manual(1)], [auto("floor:0")]);
    expect(result.map((zone) => zone.id)).toEqual([autoZoneIdOf("floor:0"), 2, 1]);
  });
});

describe("sameAutoZones", () => {
  it("compares the automatic zones only, by id and cells", () => {
    const a = [auto("maze", [[0, 0, 0], [0, 1, 0]]), manual(1)];
    expect(sameAutoZones(a, [auto("maze", [[0, 0, 0], [0, 1, 0]]), manual(9)])).toBe(true);
    expect(sameAutoZones(a, [auto("maze", [[0, 0, 0], [0, 2, 0]])])).toBe(false);
    expect(sameAutoZones(a, [])).toBe(false);
  });

  it("tells a renamed cell type zone from the same one", () => {
    const named = (name: string): Zone => ({ ...auto("type:0:0"), name });
    expect(sameAutoZones([named("octagon")], [named("square")])).toBe(false);
  });
});

describe("zoneTypeLabel", () => {
  it("is one label per automatic kind, and one of its own for manual zones", () => {
    const labels = ["maze", "type:0:0", "floor:0", "edge:0", "face:0:0", "region:0:0"].map((key) => zoneTypeLabel(auto(key)));
    expect(new Set([...labels, zoneTypeLabel(manual(1))]).size).toBe(7);
  });
});

describe("setZonesVisible", () => {
  beforeEach(() => useMazeStore.setState({ ...zonesInitialState, zones: [] }));

  it("hides every given zone once and shows them again", () => {
    useMazeStore.setState({ hiddenZoneIds: [5] });
    useMazeStore.getState().setZonesVisible([1, 2, 2, 5], false);
    expect(useMazeStore.getState().hiddenZoneIds).toEqual([5, 1, 2]);
    useMazeStore.getState().setZonesVisible([1, 5], true);
    expect(useMazeStore.getState().hiddenZoneIds).toEqual([2]);
  });
});
