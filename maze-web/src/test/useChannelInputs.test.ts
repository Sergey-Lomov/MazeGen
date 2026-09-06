import { describe, it, expect } from "vitest";
import { parseChannelInput } from "../components/useChannelInputs";

describe("parseChannelInput", () => {
  it("returns null for empty / whitespace-only input (keep buffering, don't commit)", () => {
    expect(parseChannelInput("", 255)).toBeNull();
    expect(parseChannelInput("   ", 255)).toBeNull();
  });

  it("returns null for non-numeric input", () => {
    expect(parseChannelInput("abc", 255)).toBeNull();
    expect(parseChannelInput("12px", 255)).toBeNull();
    expect(parseChannelInput("NaN", 255)).toBeNull();
  });

  it("clamps to 0..max", () => {
    expect(parseChannelInput("300", 255)).toBe(255);
    expect(parseChannelInput("-5", 255)).toBe(0);
    expect(parseChannelInput("400", 360)).toBe(360);
    expect(parseChannelInput("128", 255)).toBe(128);
  });

  it("passes through in-range values (including fractional)", () => {
    expect(parseChannelInput("42.5", 100)).toBe(42.5);
    expect(parseChannelInput("0", 100)).toBe(0);
  });
});
