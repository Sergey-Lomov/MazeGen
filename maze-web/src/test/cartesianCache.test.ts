import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCellCenters } = vi.hoisted(() => ({
  getCellCenters: vi.fn(),
}));

vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset, getCellCenters }));

import { getCartesian, warmCartesianCache } from "../pixi/cartesianCache";
import { fieldOf } from "./fieldConfigFixtures";

beforeEach(() => {
  getCellCenters.mockReset();
});

describe("cell center cache", () => {
  it("serves prewarmed cells without another wasm round-trip", () => {
    getCellCenters.mockImplementation(({ points }: { points: [number, number][] }) =>
      points.map(([x, y]) => [x + 0.5, y + 0.5]));
    const square = fieldOf("square", { shape: "custom", points: [[0, 0], [2, 1]] });
    warmCartesianCache(square);
    expect(getCellCenters).toHaveBeenCalledTimes(1);
    expect(getCartesian(2, 1, square)).toEqual([2.5, 1.5]);
    expect(getCellCenters).toHaveBeenCalledTimes(1);
  });

  it("re-projects when the tessellation config changes, even with the same kind", () => {
    getCellCenters.mockImplementation(({ points }: { points: [number, number][] }) =>
      points.map(([x, y]) => [x * 10, y * 10]));
    const hex = fieldOf("hex", { shape: "custom", points: [[1, 2]] });
    warmCartesianCache(hex);
    expect(getCartesian(1, 2, hex)).toEqual([10, 20]);
    expect(getCellCenters).toHaveBeenCalledTimes(1);

    getCellCenters.mockImplementation(({ points }: { points: [number, number][] }) =>
      points.map(([x, y]) => [x * 100, y * 100]));
    const reparameterized = { ...hex, tessellation: { kind: "hex" as const, params: { scale: 2 } } };
    expect(getCartesian(1, 2, reparameterized)).toEqual([100, 200]);
    expect(getCellCenters).toHaveBeenCalledTimes(2);
  });
});
