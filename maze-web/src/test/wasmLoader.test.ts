import { beforeEach, describe, expect, it, vi } from "vitest";

const wasmInit = vi.hoisted(() => vi.fn());

vi.mock("../wasm/pkg/maze_wasm", () => ({ default: wasmInit }));

beforeEach(() => {
  wasmInit.mockReset();
  // The shared test setup already initialized the real loader; start from a fresh module state.
  vi.resetModules();
});

describe("initWasm", () => {
  it("allows a new attempt after a failed initialization", async () => {
    const { initWasm } = await import("../wasm/wasmLoader");
    wasmInit
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(undefined);

    await expect(initWasm()).rejects.toThrow("fetch failed");
    await expect(initWasm()).resolves.toBeUndefined();
    expect(wasmInit).toHaveBeenCalledTimes(2);
  });
});
