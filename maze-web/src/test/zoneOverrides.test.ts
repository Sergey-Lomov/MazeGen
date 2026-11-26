import { describe, it, expect, beforeEach } from "vitest";
import * as m from "~/paraglide/messages";
import { useMazeStore } from "../store/mazeStore";
import { zonesInitialState } from "../store/slices/zonesSlice";
import type { Zone } from "../wasm/mazeService";
import type { ZoneOverride } from "../store/zonesTypes";
import { buildZoneOverrideWire, emptyParamTargets, overrideHasNoZones, overrideProblem, overrideZoneIds, zoneOverrideConflicts, zoneOverrideWarningCount } from "../domain/zoneOverrides";
import { buildZonesHoverRegion } from "../domain/selectors/zoneSelectors";
import { computeGenerationCard } from "../components/FeaturesPanel";
import { parseAndValidate } from "../store/projectExport";
import { makeState, reparse, toJson } from "./projectExportKit";

const zone = (id: number, cells: Zone["cells"]): Zone => ({ id, name: `Z${id}`, kind: "manual", cells });
const override = (id: number, zoneIds: number[], params: ZoneOverride["params"], groupIds: number[] = []): ZoneOverride => ({ id, zoneIds, groupIds, params });

describe("zone override detection (GitHub issue #1038)", () => {
  const zones = [zone(1, [[0, 0, 0], [0, 1, 0]]), zone(2, [[0, 1, 0], [0, 2, 0]]), zone(3, [[0, 9, 9]])];
  const groups = [{ id: 7, name: "G", zoneIds: [2, 3] }];

  it("reaches own zones and group zones, ignoring ids of no zone", () => {
    expect(overrideZoneIds(override(1, [1, 99], {}, [7]), zones, groups)).toEqual([1, 2, 3]);
  });

  it("flags a shared parameter on a shared cell for both overrides", () => {
    const a = override(1, [1], { branching: 0.1, cyclicity: 0.2 });
    const b = override(2, [2], { branching: 0.9 });
    const conflicts = zoneOverrideConflicts([a, b], zones, groups);
    expect(conflicts.get(1)).toEqual([{ otherId: 2, params: ["branching"] }]);
    expect(conflicts.get(2)).toEqual([{ otherId: 1, params: ["branching"] }]);
  });

  it("does not flag overlapping zones with different parameters", () => {
    expect(zoneOverrideConflicts([override(1, [1], { branching: 0.1 }), override(2, [2], { cyclicity: 0.5 })], zones, groups).size).toBe(0);
  });

  it("does not flag the same parameter on disjoint cells", () => {
    expect(zoneOverrideConflicts([override(1, [1], { branching: 0.1 }), override(2, [3], { branching: 0.5 })], zones, groups).size).toBe(0);
  });

  it("detects an override with no zones left", () => {
    expect(overrideHasNoZones(override(1, [99], { branching: 0.1 }), zones, groups)).toBe(true);
    expect(overrideHasNoZones(override(1, [], { branching: 0.1 }, [7]), zones, groups)).toBe(false);
  });

  it("counts a zone with no cells, or a group of such zones, as nothing to act on", () => {
    const hollow = [{ id: 1, name: "", kind: "manual" as const, cells: [] }, { id: 2, name: "", kind: "manual" as const, cells: [[0, 0, 0]] as [number, number, number][] }];
    const hollowGroups = [{ id: 7, name: "", zoneIds: [1] }, { id: 8, name: "", zoneIds: [1, 2] }];
    expect(overrideHasNoZones(override(1, [1], { branching: 0.1 }), hollow, hollowGroups)).toBe(true);
    expect(overrideHasNoZones(override(1, [], { branching: 0.1 }, [7]), hollow, hollowGroups)).toBe(true);
    expect(overrideHasNoZones(override(1, [], { branching: 0.1 }, [8]), hollow, hollowGroups)).toBe(false);
    expect(zoneOverrideWarningCount([override(1, [99], {}), override(2, [1], {})], zones, groups)).toBe(1);
  });

  it("lists the parameters set on empty zones and groups, with those zones and groups only", () => {
    const hollow = [{ id: 1, name: "", kind: "manual" as const, cells: [] }, { id: 2, name: "", kind: "manual" as const, cells: [[0, 0, 0]] as [number, number, number][] }];
    const hollowGroups = [{ id: 7, name: "", zoneIds: [1] }];
    const overrides = [override(1, [1], { branching: 0.1, cyclicity: 0.2 }, [7]), override(2, [99], { branching: 0.5 }), override(3, [2], { branching: 0.3 })];
    const found = emptyParamTargets(overrides, hollow, hollowGroups, (_, path) => path);
    expect(found.map(({ key, path, zoneIds, groupIds }) => ({ key, path, zoneIds, groupIds }))).toEqual([
      { key: "branching", path: "branching", zoneIds: [1], groupIds: [7] },
      { key: "cyclicity", path: "cyclicity", zoneIds: [1], groupIds: [7] },
    ]);
    expect(found[0].sample).toBe(overrides[0]);
  });

  it("tells a deleted target from an empty one", () => {
    const hollow = [{ id: 1, name: "", kind: "manual" as const, cells: [] }, { id: 2, name: "", kind: "manual" as const, cells: [[0, 0, 0]] as [number, number, number][] }];
    const hollowGroups = [{ id: 7, name: "", zoneIds: [1] }];
    expect(overrideProblem(override(1, [99], {}), hollow, hollowGroups)).toBe("missing");
    expect(overrideProblem(override(1, [], {}, [99]), hollow, hollowGroups)).toBe("missing");
    expect(overrideProblem(override(1, [1], {}), hollow, hollowGroups)).toBe("empty");
    expect(overrideProblem(override(1, [], {}, [7]), hollow, hollowGroups)).toBe("empty");
    expect(overrideProblem(override(1, [2], {}), hollow, hollowGroups)).toBeNull();
  });
});

describe("zone override wire (GitHub issue #1038)", () => {
  it("emits one entry per reached zone and skips overrides that set nothing", () => {
    const zones = [zone(1, [[0, 0, 0]]), zone(2, [[1, 3, 4]]), zone(3, [])];
    const groups = [{ id: 7, name: "G", zoneIds: [2, 3] }];
    const wire = buildZoneOverrideWire([override(1, [1], { teleport_chance: 1 }, [7]), override(2, [1], {})], zones, groups);
    expect(wire).toEqual([
      { zone_id: 1, cells: [[0, 0, 0]], params: { teleport_chance: 1 } },
      { zone_id: 2, cells: [[1, 3, 4]], params: { teleport_chance: 1 } },
    ]);
  });

  it("sends the switch parameter as a boolean", () => {
    const zones = [zone(1, [[0, 0, 0]])];
    const on = buildZoneOverrideWire([override(1, [1], { allow_non_consecutive_elevator_floors: 1 })], zones, []);
    const off = buildZoneOverrideWire([override(1, [1], { allow_non_consecutive_elevator_floors: 0, teleport_chance: 0.5 })], zones, []);
    expect(on[0].params).toEqual({ allow_non_consecutive_elevator_floors: true });
    expect(off[0].params).toEqual({ allow_non_consecutive_elevator_floors: false, teleport_chance: 0.5 });
  });
});

describe("zone override actions", () => {
  beforeEach(() => {
    useMazeStore.setState({ ...zonesInitialState, zones: [zone(1, [[0, 0, 0]]), zone(2, [[0, 1, 1]])], zoneGroups: [{ id: 5, name: "G", zoneIds: [1] }] });
  });

  it("adds an override for a zone or group and ignores a target of nothing", () => {
    const s = () => useMazeStore.getState();
    s().addZoneOverride({ branching: 0.3 }, { kind: "zone", id: 2 });
    s().addZoneOverride({ branching: 0.3 }, { kind: "zone", id: 99 });
    expect(s().zoneOverrides).toEqual([{ id: 1, zoneIds: [2], groupIds: [], params: { branching: 0.3 } }]);
    s().setZoneOverrideTarget(1, { kind: "zone", id: 99 });
    expect(s().zoneOverrides[0].zoneIds).toEqual([2]);
    s().setZoneOverrideTarget(1, { kind: "group", id: 5 });
    expect(s().zoneOverrides[0]).toMatchObject({ zoneIds: [], groupIds: [5] });
  });

  it("keeps the elevator span ordered", () => {
    const s = () => useMazeStore.getState();
    s().addZoneOverride({ elevator_span_min: 2, elevator_span_max: 4 }, { kind: "zone", id: 1 });
    s().setZoneOverrideParam(1, "elevator_span_min", 6);
    expect(s().zoneOverrides[0].params).toMatchObject({ elevator_span_min: 6, elevator_span_max: 6 });
    s().setZoneOverrideParam(1, "elevator_span_max", 3);
    expect(s().zoneOverrides[0].params).toMatchObject({ elevator_span_min: 3, elevator_span_max: 3 });
  });

  it("drops a deleted zone and a deleted group from every override", () => {
    const s = () => useMazeStore.getState();
    s().addZoneOverride({ branching: 0.1 }, { kind: "zone", id: 1 });
    s().addZoneOverride({ branching: 0.2 }, { kind: "group", id: 5 });
    s().setHoveredZoneGroup(5);
    s().removeZone(1);
    expect(s().zoneOverrides[0].zoneIds).toEqual([]);
    s().removeZoneGroup(5);
    expect(s().zoneOverrides[1].groupIds).toEqual([]);
    expect(s().hoveredZoneGroupId).toBeNull();
    s().removeZoneOverride(1);
    expect(s().zoneOverrides.map((o) => o.id)).toEqual([2]);
  });
});

describe("zone hover region (GitHub issue #1038)", () => {
  it("takes each zone's own colour, or its override", () => {
    const zs = [zone(1, [[0, 0, 0]]), zone(2, [[0, 1, 0]])];
    expect(buildZonesHoverRegion(zs, [1, 2], 0, { 1: 0x123456 })?.groups[0].color).toBe(0x123456);
    const own = buildZonesHoverRegion(zs, [1, 2], 0)?.groups.map((g) => g.color);
    expect(own?.[0]).not.toBe(own?.[1]);
  });
});

describe("generation card (GitHub issue #1038)", () => {
  it("warns about overrides only for the custom generator", () => {
    expect(computeGenerationCard(true, "custom_vertex_based", false, 0, 0, 2).status).toBe("warning");
    expect(computeGenerationCard(true, "recursive_backtracker", false, 0, 0, 2).status).toBe("set");
    expect(computeGenerationCard(true, "custom_vertex_based", false, 0, 0, 0).status).toBe("set");
    expect(computeGenerationCard(true, "custom_vertex_based", false, 0, 0, 2).comment).toBe(m["status.warnings_count"]({ count: 2 }));
  });
});

describe("zone overrides in the project file", () => {
  it("round-trips and drops ids of zones and groups that do not exist", () => {
    const state = makeState({
      zones: [zone(1, [[0, 0, 0]])],
      nextZoneId: 2,
      zoneOverrides: [override(3, [1], { branching: 0.25 })],
      nextZoneOverrideId: 4,
    });
    expect(reparse(state).zones?.generationOverrides).toEqual([override(3, [1], { branching: 0.25 })]);
    expect(reparse(state).zones?.nextOverrideId).toBe(4);

    const json = toJson(state);
    json.zones.generationOverrides = [{ id: 1, zoneIds: [1, 50], groupIds: [60], params: { branching: 0.5 } }];
    expect(parseAndValidate(json).zones?.generationOverrides).toEqual([override(1, [1], { branching: 0.5 })]);
  });

  it("rejects an unknown parameter", () => {
    const json = toJson(makeState({ zones: [zone(1, [[0, 0, 0]])], nextZoneId: 2 }));
    json.zones.generationOverrides = [{ id: 1, zoneIds: [], groupIds: [], params: { depth_first: 0.5 } }];
    expect(() => parseAndValidate(json)).toThrow(/depth_first/);
  });

  it("accepts 0 or 1 for a switch parameter and rejects other values", () => {
    const json = toJson(makeState({ zones: [zone(1, [[0, 0, 0]])], nextZoneId: 2 }));
    json.zones.generationOverrides = [{ id: 1, zoneIds: [1], groupIds: [], params: { allow_non_consecutive_elevator_floors: 1 } }];
    expect(parseAndValidate(json).zones?.generationOverrides?.[0].params).toEqual({ allow_non_consecutive_elevator_floors: 1 });
    json.zones.generationOverrides = [{ id: 1, zoneIds: [1], groupIds: [], params: { allow_non_consecutive_elevator_floors: 0.5 } }];
    expect(() => parseAndValidate(json)).toThrow(/expected 0 or 1/);
  });
});
