import { describe, expect, it, vi } from "vitest";

const { getCartesianCoords } = vi.hoisted(() => ({
  getCartesianCoords: vi.fn(),
}));

vi.mock("../wasm/mazeService", () => ({ getCartesianCoords }));

import { getCartesian, warmCartesianCache } from "../pixi/cartesianCache";

const cfg = { type: "cairo", cols: 1, rows: 1 } as const;

describe("Cairo Cartesian cache", () => {
  it("uses Cairo's identity projection without an old WASM enum", () => {
    warmCartesianCache(cfg);

    expect(getCartesianCoords).not.toHaveBeenCalled();
    expect(getCartesian(2, 1, cfg)).toEqual([2, 1]);
  });
});
