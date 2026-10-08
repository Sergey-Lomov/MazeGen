import { describe, it, expect } from "vitest";
import { sanitizeMarkerGlyph, isValidMarkerGlyph } from "../pixi/renderers/markerGlyph";

describe("sanitizeMarkerGlyph", () => {
  it("returns an empty string unchanged", () => {
    expect(sanitizeMarkerGlyph("")).toBe("");
  });

  it("uppercases a valid lowercase letter", () => {
    expect(sanitizeMarkerGlyph("s")).toBe("S");
  });

  it("keeps a valid digit as-is", () => {
    expect(sanitizeMarkerGlyph("7")).toBe("7");
  });

  it("keeps a valid uppercase Cyrillic letter", () => {
    expect(sanitizeMarkerGlyph("Ф")).toBe("Ф");
  });

  it("truncates multi-character input to its first character", () => {
    expect(sanitizeMarkerGlyph("start")).toBe("S");
  });

  it("drops a character outside the baked charset (punctuation) to empty", () => {
    expect(sanitizeMarkerGlyph(":")).toBe("");
  });

  it("drops a character outside the baked charset (space) to empty", () => {
    expect(sanitizeMarkerGlyph(" ")).toBe("");
  });
});

describe("isValidMarkerGlyph", () => {
  it("accepts an empty string", () => {
    expect(isValidMarkerGlyph("")).toBe(true);
  });

  it("accepts a single valid uppercase letter", () => {
    expect(isValidMarkerGlyph("S")).toBe(true);
  });

  it("rejects a lowercase letter (case-folding is sanitize's job, not validity's)", () => {
    expect(isValidMarkerGlyph("s")).toBe(false);
  });

  it("rejects a character outside the baked charset", () => {
    expect(isValidMarkerGlyph(":")).toBe(false);
  });

  it("rejects multi-character input", () => {
    expect(isValidMarkerGlyph("SF")).toBe(false);
  });
});
