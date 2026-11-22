import { describe, it, expect } from "vitest";
import { parseAndValidate, serializeProject } from "../store/projectExport";
import type { Zone } from "../wasm/mazeService";
import { makeState, reparse, toJson } from "./projectExportKit";

const zone = (id: number, cells: Zone["cells"] = [[0, 1, 2]], kind: Zone["kind"] = "manual"): Zone => ({ id, name: `Z${id}`, kind, cells });

describe("zones and zone groups (GitHub issue #1048)", () => {
  it("round-trips zones, groups, counters and colour overrides", () => {
    const state = makeState({
      zones: [zone(1), zone(4, [[0, 0, 0], [1, 3, 3]])],
      nextZoneId: 9,
      zoneGroups: [{ id: 2, name: "G", zoneIds: [4, 1] }],
      nextZoneGroupId: 6,
      zoneColorOverrides: { 4: 0xff0000 },
    });
    const file = reparse(state);
    expect(file.zones).toEqual({
      zones: state.zones, nextZoneId: 9, groups: state.zoneGroups, nextGroupId: 6, colorOverrides: { "4": 0xff0000 },
    });
  });

  it("does not save automatic zones but keeps the groups and colours that name them (GitHub issue #1033)", () => {
    const autoId = 2 ** 30 + 5;
    const state = makeState({
      zones: [zone(autoId, [[0, 0, 0]], "auto"), zone(1)],
      nextZoneId: 2,
      zoneGroups: [{ id: 1, name: "G", zoneIds: [autoId, 1] }],
      nextZoneGroupId: 2,
      zoneColorOverrides: { [autoId]: 0x00ff00 },
    });
    const file = reparse(state);
    expect(file.zones?.zones).toEqual([zone(1)]);
    expect(file.zones?.groups).toEqual([{ id: 1, name: "G", zoneIds: [autoId, 1] }]);
    expect(file.zones?.colorOverrides).toEqual({ [String(autoId)]: 0x00ff00 });
  });

  it("does not save automatic groups (GitHub issue #1037), nor a section holding only them, and drops one on load", () => {
    const autoGroup = { id: 2 ** 30 + 2 * 2 ** 22, name: "", zoneIds: [2 ** 30 + 2 * 2 ** 22] };
    expect(serializeProject(makeState({ zoneGroups: [autoGroup] })).zones).toBeUndefined();
    const state = makeState({ zones: [zone(1)], nextZoneId: 2, zoneGroups: [autoGroup, { id: 1, name: "G", zoneIds: [1] }], nextZoneGroupId: 2 });
    expect(reparse(state).zones?.groups).toEqual([{ id: 1, name: "G", zoneIds: [1] }]);
    const raw = toJson(makeState({ zones: [zone(1)], nextZoneId: 2 }));
    raw.zones.groups = [autoGroup, { id: 1, name: "G", zoneIds: [1] }];
    expect(parseAndValidate(raw).zones?.groups).toEqual([{ id: 1, name: "G", zoneIds: [1] }]);
  });

  it("round-trips an empty group and an empty zone", () => {
    const state = makeState({ zones: [zone(1, [])], nextZoneId: 2, zoneGroups: [{ id: 1, name: "", zoneIds: [] }], nextZoneGroupId: 2 });
    const file = reparse(state);
    expect(file.zones?.zones).toEqual([zone(1, [])]);
    expect(file.zones?.groups).toEqual([{ id: 1, name: "", zoneIds: [] }]);
  });

  it("writes no section for a project without zones and groups", () => {
    expect(serializeProject(makeState()).zones).toBeUndefined();
  });

  it("loads a file without the section as no zones", () => {
    const raw = toJson(makeState());
    delete raw.zones;
    expect(parseAndValidate(raw).zones).toBeUndefined();
  });

  it("keeps cells of floors or points that no longer exist", () => {
    const state = makeState({ zones: [zone(1, [[7, 999, 999]])], nextZoneId: 2 });
    expect(reparse(state).zones?.zones[0].cells).toEqual([[7, 999, 999]]);
  });

  it("drops group members of unknown zones and overrides of unknown zones", () => {
    const state = makeState({
      zones: [zone(1)], nextZoneId: 2, zoneGroups: [{ id: 1, name: "G", zoneIds: [1, 5] }], nextZoneGroupId: 2,
      zoneColorOverrides: { 1: 1, 5: 2 },
    });
    const file = reparse(state);
    expect(file.zones?.groups[0].zoneIds).toEqual([1]);
    expect(file.zones?.colorOverrides).toEqual({ "1": 1 });
  });

  it("never lets a counter fall to or below an existing id", () => {
    const raw = toJson(makeState({ zones: [zone(5)], nextZoneId: 6, zoneGroups: [{ id: 3, name: "", zoneIds: [] }], nextZoneGroupId: 4 }));
    raw.zones.nextZoneId = 1;
    raw.zones.nextGroupId = 0;
    const file = parseAndValidate(raw);
    expect(file.zones?.nextZoneId).toBe(6);
    expect(file.zones?.nextGroupId).toBe(4);
  });

  it("accepts a minimal section with only zones", () => {
    const raw = toJson(makeState());
    raw.zones = { zones: [zone(2)] };
    expect(parseAndValidate(raw).zones).toEqual({ zones: [zone(2)], nextZoneId: 3, groups: [], nextGroupId: 0, colorOverrides: {} });
  });

  it("rejects malformed zones naming the path", () => {
    const bad = (mutate: (zones: any) => void) => {
      const raw = toJson(makeState({ zones: [zone(1), zone(2)], nextZoneId: 3 }));
      mutate(raw.zones);
      return raw;
    };
    expect(() => parseAndValidate(bad((z) => { z.zones[1].id = 1; }))).toThrow(/duplicate zone id 1/);
    expect(() => parseAndValidate(bad((z) => { z.zones[0].kind = "x"; }))).toThrow(/zones\.zones\[0\]\.kind/);
    expect(() => parseAndValidate(bad((z) => { z.zones[0].cells = [[1, 2]]; }))).toThrow(/zones\.zones\[0\]\.cells\[0\]/);
    expect(() => parseAndValidate(bad((z) => { z.zones[0].id = -1; }))).toThrow(/zones\.zones\[0\]\.id/);
    expect(() => parseAndValidate(bad((z) => { z.groups = [{ id: 1, name: "", zoneIds: [] }, { id: 1, name: "", zoneIds: [] }]; }))).toThrow(/duplicate group id 1/);
  });
});
