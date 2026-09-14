import { describe, it, expect } from "vitest";
import { defaultParamsFor, buildDefaultNestedStrategies } from "../store/slices/generationSliceHelpers";
import type { CheckDescriptor, StrategyDescriptor } from "../wasm/types";

describe("defaultParamsFor", () => {
  it("returns an empty object for a descriptor with no params", () => {
    expect(defaultParamsFor({ params: [] })).toEqual({});
  });

  it("stringifies a float param's default", () => {
    const params: CheckDescriptor["params"] = [
      { id: "p1", label: "P1", kind: { type: "float", default: 3.5, min: 0, max: 10 } },
    ];
    expect(defaultParamsFor({ params })).toEqual({ p1: "3.5" });
  });

  it("stringifies an integer param's default", () => {
    const params: CheckDescriptor["params"] = [
      { id: "p1", label: "P1", kind: { type: "integer", default: 7, min: 0, max: 10 } },
    ];
    expect(defaultParamsFor({ params })).toEqual({ p1: "7" });
  });

  it("encodes a bool param's default as \"true\"/\"false\"", () => {
    const params: CheckDescriptor["params"] = [
      { id: "on", label: "On", kind: { type: "bool", default: true } },
      { id: "off", label: "Off", kind: { type: "bool", default: false } },
    ];
    expect(defaultParamsFor({ params })).toEqual({ on: "true", off: "false" });
  });

  it("uses an enum param's default option string directly", () => {
    const params: CheckDescriptor["params"] = [
      { id: "mode", label: "Mode", kind: { type: "enum", options: ["a", "b"], default: "b" } },
    ];
    expect(defaultParamsFor({ params })).toEqual({ mode: "b" });
  });

  it("encodes an interval param's default as \"default_min,default_max\"", () => {
    const params: CheckDescriptor["params"] = [
      { id: "range", label: "Range", kind: { type: "interval", default_min: 2, default_max: 8, min: 0, max: 100 } },
    ];
    expect(defaultParamsFor({ params })).toEqual({ range: "2,8" });
  });

  it("builds one entry per param, in order, for a mixed set of kinds", () => {
    const params: CheckDescriptor["params"] = [
      { id: "f", label: "F", kind: { type: "float", default: 1, min: 0, max: 10 } },
      { id: "b", label: "B", kind: { type: "bool", default: false } },
      { id: "r", label: "R", kind: { type: "interval", default_min: 0, default_max: 5, min: 0, max: 5 } },
    ];
    expect(defaultParamsFor({ params })).toEqual({ f: "1", b: "false", r: "0,5" });
  });
});

describe("buildDefaultNestedStrategies", () => {
  // GitHub issue #486: dispatcher-owned params must not be seeded into a nested strategy's
  // stored default config -- the dispatcher resolves and injects them at apply() time, and the
  // UI hides them on the nested node, so a seeded value would be a dead, invisible key.
  it("omits nested_suppressed_params from the seeded default params of an auto-filled nested strategy", () => {
    const dispatcher: StrategyDescriptor = {
      id: "priority_missing_loops", handles: "missing_loops_dispatch",
      params: [], experimental: false,
      nested_slots: [{ slot_id: "loop_seed_target", kind: "missing_loops", min: 1, max: null, dispatch_kind: "priority" }],
      nested_suppressed_params: [],
    };
    const nestedCandidate: StrategyDescriptor = {
      id: "missing_loops_random", handles: "missing_loops",
      params: [
        { id: "loop_one_way_chance", label: "One-way chance", kind: { type: "float", default: 0, min: 0, max: 100 } },
        { id: "reserve_percent", label: "Reserve percent", kind: { type: "float", default: 0, min: 0, max: 500 } },
        { id: "src_mode", label: "Source mode", kind: { type: "enum", options: ["random", "dead_end_priority"], default: "random" } },
        { id: "attempts_limit", label: "Attempts limit", kind: { type: "float", default: 25, min: 1, max: 10000 } },
      ],
      experimental: false, nested_slots: [],
      nested_suppressed_params: ["reserve_percent", "attempts_limit"],
    };

    const nested = buildDefaultNestedStrategies("priority_missing_loops", [dispatcher, nestedCandidate]);

    expect(nested).toHaveLength(1);
    expect(nested[0].params).toEqual({ loop_one_way_chance: "0", src_mode: "random" });
    expect(nested[0].params).not.toHaveProperty("reserve_percent");
    expect(nested[0].params).not.toHaveProperty("attempts_limit");
  });

  it("seeds every default param when the candidate suppresses none", () => {
    const dispatcher: StrategyDescriptor = {
      id: "d", handles: "kind_a_dispatch", params: [], experimental: false,
      nested_slots: [{ slot_id: "s", kind: "kind_a", min: 1, max: null, dispatch_kind: "priority" }],
      nested_suppressed_params: [],
    };
    const candidate: StrategyDescriptor = {
      id: "c", handles: "kind_a",
      params: [{ id: "p", label: "P", kind: { type: "float", default: 5, min: 0, max: 10 } }],
      experimental: false, nested_slots: [],
      nested_suppressed_params: [],
    };

    const nested = buildDefaultNestedStrategies("d", [dispatcher, candidate]);

    expect(nested[0].params).toEqual({ p: "5" });
  });
});
