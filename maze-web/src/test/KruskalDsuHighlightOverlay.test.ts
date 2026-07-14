import { describe, it, expect } from "vitest";
import { groupNonSingletonsByRoot, colorForRoot } from "../pixi/KruskalDsuHighlightOverlay";

describe("groupNonSingletonsByRoot", () => {
  it("groups ids by their shared root", () => {
    const dsuGroups = new Map([[1, 1], [2, 1], [3, 1], [4, 4], [5, 4]]);
    const groups = groupNonSingletonsByRoot(dsuGroups);
    expect(groups.get(1)).toEqual([1, 2, 3]);
    expect(groups.get(4)).toEqual([4, 5]);
    expect(groups.size).toBe(2);
  });

  it("drops singleton groups (a node not yet merged into anything)", () => {
    const dsuGroups = new Map([[1, 1], [2, 2], [3, 3]]); // every node its own root
    const groups = groupNonSingletonsByRoot(dsuGroups);
    expect(groups.size).toBe(0);
  });

  it("keeps only the non-singleton groups when mixed with singletons", () => {
    const dsuGroups = new Map([[1, 1], [2, 1], [3, 3]]); // {1,2} merged, 3 alone
    const groups = groupNonSingletonsByRoot(dsuGroups);
    expect(groups.size).toBe(1);
    expect(groups.get(1)).toEqual([1, 2]);
    expect(groups.has(3)).toBe(false);
  });

  it("returns an empty map for an empty input", () => {
    expect(groupNonSingletonsByRoot(new Map()).size).toBe(0);
  });

  it("preserves each group's id insertion order", () => {
    // Insertion order into dsuGroups is 3, 1, 2 for root 1's members — the group array must
    // preserve that order, not resort it.
    const dsuGroups = new Map([[3, 1], [1, 1], [2, 1]]);
    const groups = groupNonSingletonsByRoot(dsuGroups);
    expect(groups.get(1)).toEqual([3, 1, 2]);
  });
});

describe("colorForRoot", () => {
  it("is deterministic — the same root always maps to the same color", () => {
    expect(colorForRoot(42)).toBe(colorForRoot(42));
    expect(colorForRoot(0)).toBe(colorForRoot(0));
  });

  it("returns a value from the fixed palette (a valid RGB integer)", () => {
    const color = colorForRoot(123);
    expect(Number.isInteger(color)).toBe(true);
    expect(color).toBeGreaterThanOrEqual(0);
    expect(color).toBeLessThanOrEqual(0xffffff);
  });

  it("spreads adjacent-id roots across visually distinct palette entries, not a plain modulo", () => {
    // A plain `root % PALETTE.length` would cluster spatially-adjacent ids (e.g. row-major node
    // ids 100, 101, 102) into adjacent, visually-similar palette slots — the hash exists
    // specifically to avoid this. Assert the hashed outputs aren't just `root` itself modulo a
    // small constant, i.e. consecutive roots don't produce consecutive colors.
    const colors = [100, 101, 102, 103].map(colorForRoot);
    const distinctColors = new Set(colors);
    expect(distinctColors.size).toBeGreaterThan(1);
  });
});
