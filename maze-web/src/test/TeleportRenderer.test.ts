import { describe, it, expect } from "vitest";
import { computeMixedCells, clipDistance } from "../pixi/renderers/TeleportRenderer";
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

describe("clipDistance", () => {
  const half = 5.6;
  const strokeWidth = 3;

  it("axis-aligned direction — clips to flat side plus half stroke width", () => {
    expect(clipDistance(1, 0, half, strokeWidth)).toBeCloseTo(half + strokeWidth / 2);
    expect(clipDistance(0, 1, half, strokeWidth)).toBeCloseTo(half + strokeWidth / 2);
  });

  it("exact diagonal direction — clips to the square's corner distance plus half stroke width", () => {
    const u = Math.SQRT1_2;
    expect(clipDistance(u, u, half, strokeWidth)).toBeCloseTo(half * Math.SQRT2 + strokeWidth / 2);
  });

  it("shallow non-axis-aligned direction — geometric part of the clip lands exactly on the square's border", () => {
    const ux = 0.9486832980505138;
    const uy = -0.31622776601683794;
    const clip = clipDistance(ux, uy, half, strokeWidth);
    expect(clip).toBeGreaterThan(half + strokeWidth / 2);
    const geometricClip = clip - strokeWidth / 2;
    expect(Math.max(Math.abs(ux * geometricClip), Math.abs(uy * geometricClip))).toBeCloseTo(half);
  });
});
