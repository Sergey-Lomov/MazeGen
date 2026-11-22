import { describe, expect, it } from "vitest";
import type { Zone } from "../wasm/mazeService";
import { autoZoneIdOf } from "../domain/autoZones";
import { groupZones, sortZones } from "../store/zoneListSort";

const auto = (key: string, floors: number[]): Zone => ({
  id: autoZoneIdOf(key)!,
  name: key,
  kind: "auto",
  cells: floors.map((floor) => [floor, 0, 0]),
});

const names = (zones: Zone[]) => zones.map((zone) => zone.name);

describe("sortZones", () => {
  const zones = [
    auto("region:1:0", [1]),
    auto("maze", [0, 1, 2]),
    auto("edge:2", [2]),
    auto("face:0:0", [0]),
    auto("edge:0", [0]),
    auto("floor:1", [1]),
  ];

  it("orders by ascending lowest floor, ties keep the given order", () => {
    expect(names(sortZones(zones))).toEqual(["maze", "face:0:0", "edge:0", "region:1:0", "floor:1", "edge:2"]);
  });

  it("puts a zone without cells last", () => {
    const empty: Zone = { id: 7, name: "empty", kind: "manual", cells: [] };
    expect(names(sortZones([empty, ...zones])).at(-1)).toBe("empty");
  });

  it("does not change the given array", () => {
    const copy = [...zones];
    sortZones(zones);
    expect(zones).toEqual(copy);
  });
});

describe("groupZones", () => {
  const zones = [
    auto("maze", [0, 1]),
    auto("edge:0", [0]),
    auto("floor:1", [1]),
    auto("region:1:0", [1]),
  ];
  const floors = [
    { title: "Floor 1", titleCustomized: false },
    { title: "Attic", titleCustomized: true },
  ];

  it("makes no sections without grouping", () => {
    expect(groupZones(zones, "none", floors)).toEqual([]);
  });

  it("by floor: a zone is in the section of every floor it has cells on, sections ascend", () => {
    const sections = groupZones(zones, "floor", floors);
    expect(sections.map((s) => s.key)).toEqual(["floor:0", "floor:1"]);
    expect(sections.map((s) => s.zones.map((z) => z.name))).toEqual([["maze", "edge:0"], ["maze", "floor:1", "region:1:0"]]);
    expect(sections[1].label).toBe("Attic");
  });

  it("by floor: zones without cells share a last section", () => {
    const empty: Zone = { id: 7, name: "empty", kind: "manual", cells: [] };
    const sections = groupZones([empty, ...zones], "floor", floors);
    expect(sections.at(-1)?.zones).toEqual([empty]);
  });

  it("by type: sections in alphabetical order of the type names", () => {
    expect(groupZones(zones, "type", floors).map((s) => s.zones.map((z) => z.name))).toEqual([["edge:0"], ["floor:1"], ["maze"], ["region:1:0"]]);
  });

  it("by group: a section per group in the groups' order, a zone in every group it is in, the rest last", () => {
    const groups = [
      { id: 5, name: "B", zoneIds: [zones[1].id, zones[2].id] },
      { id: 2, name: "A", zoneIds: [zones[2].id] },
      { id: 9, name: "Empty", zoneIds: [] },
    ];
    const sections = groupZones(zones, "group", floors, groups);
    expect(sections.map((s) => s.key)).toEqual(["group:5", "group:2", "group:none"]);
    expect(sections.map((s) => s.zones.map((z) => z.name))).toEqual([["edge:0", "floor:1"], ["floor:1"], ["maze", "region:1:0"]]);
  });
});
