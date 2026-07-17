import { describe, it, expect } from "vitest";
import { resolveDebugValueColor } from "../pixi/debugValueColors";

describe("resolveDebugValueColor", () => {
  it("returns a predefined color for a known (scope, name) pair", () => {
    const color = resolveDebugValueColor("recursive_backtracker", "visited", 0);
    expect(color).toBe(resolveDebugValueColor("recursive_backtracker", "visited", 0));
    expect(typeof color).toBe("number");
  });

  it("gives the same name a different color across different scopes", () => {
    const rb = resolveDebugValueColor("recursive_backtracker", "visited", 0);
    const wilson = resolveDebugValueColor("wilson", "visited", 0);
    expect(rb).not.toBe(wilson);
  });

  it("falls back to a stable palette slot for an unlisted scope", () => {
    const a = resolveDebugValueColor("kruskal", "some_value", 2);
    const b = resolveDebugValueColor("kruskal", "some_value", 2);
    expect(a).toBe(b);
  });

  it("falls back to a stable palette slot for an unlisted name within a known scope", () => {
    const a = resolveDebugValueColor("wilson", "not_a_real_value", 1);
    const b = resolveDebugValueColor("wilson", "not_a_real_value", 1);
    expect(a).toBe(b);
  });

  it("gives different fallback indices different colors within the fallback palette range", () => {
    const a = resolveDebugValueColor("kruskal", "x", 0);
    const b = resolveDebugValueColor("kruskal", "y", 1);
    expect(a).not.toBe(b);
  });

  it("strips a source-scope qualification prefix (e.g. \"generation:\") before the color lookup", () => {
    const qualified = resolveDebugValueColor("recursive_backtracker", "generation:visited", 0);
    const unqualified = resolveDebugValueColor("recursive_backtracker", "visited", 0);
    expect(qualified).toBe(unqualified);
  });

  it("still uses the unqualified name for the fallback lookup when qualified", () => {
    const qualified = resolveDebugValueColor("kruskal", "quality_control:mystery", 3);
    const unqualified = resolveDebugValueColor("kruskal", "mystery", 3);
    expect(qualified).toBe(unqualified);
  });
});
