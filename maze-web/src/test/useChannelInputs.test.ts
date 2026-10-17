import { describe, it, expect } from "vitest";
import { parseChannelInput } from "../components/useChannelInputs";

describe("parseChannelInput", () => {
  it("returns a structured no-commit result for empty / whitespace-only input", () => {
    expect(parseChannelInput("", 255)).toEqual({ raw: "", value: null, reason: null });
    expect(parseChannelInput("   ", 255)).toEqual({ raw: "   ", value: null, reason: null });
  });

  it("returns a structured no-commit result for non-numeric input", () => {
    expect(parseChannelInput("abc", 255)).toEqual({ raw: "abc", value: null, reason: null });
    expect(parseChannelInput("12px", 255).value).toBeNull();
    expect(parseChannelInput("NaN", 255).value).toBeNull();
  });

  it("returns clamp reasons for values outside 0..max", () => {
    expect(parseChannelInput("300", 255)).toEqual({
      raw: "300", value: 255, reason: { kind: "clamped_max", min: "0", max: "255", value: "255" },
    });
    expect(parseChannelInput("-5", 255)).toEqual({
      raw: "-5", value: 0, reason: { kind: "clamped_min", min: "0", max: "255", value: "0" },
    });
    expect(parseChannelInput("400", 360).value).toBe(360);
    expect(parseChannelInput("128", 255).reason).toBeNull();
  });

  it("passes through in-range values without a reason", () => {
    expect(parseChannelInput("42.5", 100)).toEqual({ raw: "42.5", value: 42.5, reason: null });
    expect(parseChannelInput("0", 100)).toEqual({ raw: "0", value: 0, reason: null });
  });
});
