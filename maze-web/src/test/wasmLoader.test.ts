import { beforeEach, describe, expect, it, vi } from "vitest";

const wasmInit = vi.hoisted(() => vi.fn());

vi.mock("../wasm/pkg/maze_wasm", () => ({ default: wasmInit }));

import { initWasm } from "../wasm/wasmLoader";

beforeEach(() => {
  wasmInit.mockReset();
});

describe("initWasm", () => {
  it("allows a new attempt after a failed initialization", async () => {
    wasmInit
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(undefined);

    await expect(initWasm()).rejects.toThrow("fetch failed");
    await expect(initWasm()).resolves.toBeUndefined();
    expect(wasmInit).toHaveBeenCalledTimes(2);
  });
});
