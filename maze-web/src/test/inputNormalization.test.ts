import { describe, expect, it } from "vitest";
import { normalizeNumberCommit } from "../components/inputNormalization";

describe("normalizeNumberCommit", () => {
  it("returns no reason for valid unchanged input", () => {
    expect(normalizeNumberCommit("7", "5", { min: 1, max: 10, integer: true }))
      .toEqual({ raw: "7", value: "7", reason: null });
  });

  it("reports rounding", () => {
    expect(normalizeNumberCommit("7.6", "5", { integer: true }).reason)
      .toEqual({ kind: "rounded", value: "8" });
  });

  it("reports minimum and maximum clamps", () => {
    expect(normalizeNumberCommit("-1", "5", { min: 0 }).reason)
      .toEqual({ kind: "clamped_min", min: "0", max: "∞", value: "0" });
    expect(normalizeNumberCommit("11", "5", { max: 10 }).reason)
      .toEqual({ kind: "clamped_max", min: "−∞", max: "10", value: "10" });
  });

  it("reports invalid-draft restoration", () => {
    expect(normalizeNumberCommit("", "5").reason)
      .toEqual({ kind: "restored", value: "5" });
  });
});
