import { describe, it, expect } from "vitest";

import { emptyManualGroups, emptyManualZones, invalidCellFloors, invalidCellTargets, invalidManualZones, unusedManualZones, withoutCells } from "../domain/zoneProblems";
import type { ResolveFieldAt } from "../domain/fieldEditUtils";
import type { Zone } from "../wasm/mazeService";
import type { ZoneGroup } from "../store/zonesTypes";
import { fieldOf } from "./fieldConfigFixtures";

// 3x3 square grid: cells (-1,-1)..(1,1); floors 0 and 1 exist.
const squareCfg = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
const resolveTwoFloors: ResolveFieldAt = (level) => ((level ?? 0) === 0 || level === 1 ? { cfg: squareCfg } : undefined);

const zone = (id: number, cells: Zone["cells"], kind: Zone["kind"] = "manual"): Zone => ({ id, name: `z${id}`, kind, cells });
const noTargets = { zoneIds: [], groupIds: [] };

describe("invalidManualZones", () => {
  it("lists the manual zones with cells outside the field, with those cells, on every floor", () => {
    const invalid = invalidManualZones(
      [zone(1, [[0, 0, 0], [0, 5, 5], [1, 7, 7]]), zone(2, [[0, 0, 0]]), zone(3, [[2, 0, 0]])],
      resolveTwoFloors,
    );
    expect(invalid.map(({ zone: z, cells }) => [z.id, cells])).toEqual([
      [1, [[0, 5, 5], [1, 7, 7]]],
      [3, [[2, 0, 0]]],
    ]);
  });

  it("ignores automatic zones", () => {
    expect(invalidManualZones([zone(1, [[0, 9, 9]], "auto")], resolveTwoFloors)).toEqual([]);
  });
});

describe("invalid cell targets", () => {
  const invalid = invalidManualZones([zone(1, [[0, 5, 5], [1, 7, 7]]), zone(2, [[0, 5, 5]])], resolveTwoFloors);

  it("gives one target per distinct cell, the floor as its level", () => {
    expect(invalidCellTargets(invalid).map((t) => [t.point, t.level])).toEqual([[[5, 5], 0], [[7, 7], 1]]);
  });

  it("names every floor that has invalid cells", () => {
    expect(invalidCellFloors(invalid)).toEqual([0, 1]);
  });
});

describe("withoutCells", () => {
  it("removes only the given cells of the given zones", () => {
    const zones = [zone(1, [[0, 0, 0], [0, 5, 5]]), zone(2, [[0, 5, 5]])];
    const result = withoutCells(zones, new Map([[1, [[0, 5, 5]]]]));
    expect(result.map((z) => z.cells)).toEqual([[[0, 0, 0]], [[0, 5, 5]]]);
    expect(result[1]).toBe(zones[1]);
  });
});

describe("empty zones and groups", () => {
  it("lists manual zones with no cell, not automatic ones", () => {
    expect(emptyManualZones([zone(1, []), zone(2, [[0, 0, 0]]), zone(3, [], "auto")]).map((z) => z.id)).toEqual([1]);
  });

  it("lists manual groups with no zone, not automatic ones", () => {
    const groups: ZoneGroup[] = [{ id: 1, name: "A", zoneIds: [] }, { id: 2, name: "B", zoneIds: [4] }, { id: 2 ** 30, name: "", zoneIds: [] }];
    expect(emptyManualGroups(groups).map((g) => g.id)).toEqual([1]);
  });
});

describe("unusedManualZones", () => {
  const zones = [zone(1, []), zone(2, []), zone(3, []), zone(4, []), zone(5, [], "auto")];
  const groups: ZoneGroup[] = [{ id: 10, name: "G", zoneIds: [3] }, { id: 11, name: "H", zoneIds: [4] }];
  const ids = (list: Zone[]) => list.map((z) => z.id);

  it("reports every manual zone nothing refers to, and no automatic zone", () => {
    expect(ids(unusedManualZones(zones, groups, [], []))).toEqual([1, 2, 3, 4]);
  });

  it("counts an override naming the zone, either directly or through a group", () => {
    const overrides = [{ zoneIds: [1], groupIds: [] }, { zoneIds: [], groupIds: [10] }];
    expect(ids(unusedManualZones(zones, groups, overrides, []))).toEqual([2, 4]);
  });

  it("counts a QC rule scope on the zone or on a group", () => {
    const rules = [{ zoneScope: { kind: "zone" as const, id: 2 } }, { zoneScope: { kind: "group" as const, id: 11, mode: "union" as const } }, {}];
    expect(ids(unusedManualZones(zones, groups, [noTargets], rules))).toEqual([1, 3]);
  });

  it("does not count membership in a group nothing uses", () => {
    expect(ids(unusedManualZones(zones, groups, [{ zoneIds: [], groupIds: [] }], []))).toContain(3);
  });
});
