import { describe, it, expect } from "vitest";
import { computeMixedCells } from "../pixi/renderers/TeleportRenderer";
import type { TeleportEdge } from "../pixi/renderers/types";

describe("computeMixedCells", () => {
  it("no edges — no mixed cells", () => {
    expect(computeMixedCells([]).size).toBe(0);
  });

  it("single two-way teleport — both ends filled, not mixed", () => {
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [1, 1], oneWay: false }];
    expect(computeMixedCells(edges).size).toBe(0);
  });

  it("single one-way teleport — origin filled, destination outline, not mixed", () => {
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [1, 1], oneWay: true }];
    expect(computeMixedCells(edges).size).toBe(0);
  });

  it("two one-way teleports whose destinations both land on the same cell — not mixed (both outline)", () => {
    const edges: TeleportEdge[] = [
      { from: [0, 0], to: [5, 5], oneWay: true },
      { from: [1, 1], to: [5, 5], oneWay: true },
    ];
    expect(computeMixedCells(edges).size).toBe(0);
  });

  it("one-way origin coincides with another one-way's destination on the same cell — mixed", () => {
    const edges: TeleportEdge[] = [
      { from: [5, 5], to: [9, 9], oneWay: true },
      { from: [1, 1], to: [5, 5], oneWay: true },
    ];
    const mixed = computeMixedCells(edges);
    expect(mixed.size).toBe(1);
    expect(mixed.has("5000,5000")).toBe(true);
  });

  it("one-way destination coincides with a two-way endpoint on the same cell — mixed", () => {
    const edges: TeleportEdge[] = [
      { from: [9, 9], to: [2, 2], oneWay: true },
      { from: [0, 0], to: [2, 2], oneWay: false },
    ];
    const mixed = computeMixedCells(edges);
    expect(mixed.size).toBe(1);
    expect(mixed.has("2000,2000")).toBe(true);
  });

  it("cell only ever wanted filled by multiple edges — not mixed", () => {
    const edges: TeleportEdge[] = [
      { from: [0, 0], to: [3, 3], oneWay: false },
      { from: [0, 0], to: [4, 4], oneWay: false },
    ];
    expect(computeMixedCells(edges).size).toBe(0);
  });
});
