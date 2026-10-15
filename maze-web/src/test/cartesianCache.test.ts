import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCartesianCoords } = vi.hoisted(() => ({
  getCartesianCoords: vi.fn(),
}));

vi.mock("../wasm/mazeService", () => ({ getCartesianCoords }));

import { getCartesian, warmCartesianCache } from "../pixi/cartesianCache";
import { fieldOf } from "./fieldConfigFixtures";

const cfg = fieldOf("cairo", { shape: "rect", cols: 1, rows: 1 });

beforeEach(() => {
  getCartesianCoords.mockReset();
});

describe("Cairo Cartesian cache", () => {
  it("serves Cairo's identity projection without a wasm round-trip", () => {
    warmCartesianCache(cfg);

    expect(getCartesianCoords).not.toHaveBeenCalled();
    expect(getCartesian(2, 1, cfg)).toEqual([2, 1]);
  });
});

describe("Cartesian cache invalidation", () => {
  it("re-projects when the tessellation config changes, even with the same kind", () => {
    getCartesianCoords.mockImplementation(({ points }: { points: [number, number][] }) =>
      points.map(([x, y]) => [x * 10, y * 10]));
    const hex = fieldOf("hex", { shape: "custom", points: [[1, 2]] });
    warmCartesianCache(hex);
    expect(getCartesian(1, 2, hex)).toEqual([10, 20]);
    expect(getCartesianCoords).toHaveBeenCalledTimes(1);

    getCartesianCoords.mockImplementation(({ points }: { points: [number, number][] }) =>
      points.map(([x, y]) => [x * 100, y * 100]));
    const reparameterized = { ...hex, tessellation: { kind: "hex" as const, params: { scale: 2 } } };
    expect(getCartesian(1, 2, reparameterized)).toEqual([100, 200]);
    expect(getCartesianCoords).toHaveBeenCalledTimes(2);
  });
});
