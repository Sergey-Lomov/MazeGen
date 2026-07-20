import { describe, it, expect } from "vitest";
import { defaultParamsFor } from "../store/slices/generationSliceHelpers";
import type { CheckDescriptor } from "../wasm/types";

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
