import { beforeEach, describe, expect, it, vi } from "vitest";

const wasmInit = vi.hoisted(() => vi.fn());

vi.mock("../wasm/pkg/maze_wasm", () => ({ default: wasmInit }));

beforeEach(() => {
  wasmInit.mockReset();
  vi.unstubAllGlobals();
  // The shared test setup already initialized the real loader; start from a fresh module state.
  vi.resetModules();
});

describe("initWasm", () => {
  it("allows a new attempt after a failed initialization", async () => {
    const { initWasm } = await import("../wasm/wasmLoader");
    wasmInit
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(undefined);

    const source = new Uint8Array();
    await expect(initWasm(source)).rejects.toThrow("fetch failed");
    await expect(initWasm(source)).resolves.toBeUndefined();
    expect(wasmInit).toHaveBeenCalledTimes(2);
  });

  it("reports streamed WASM download progress", async () => {
    const { initWasm } = await import("../wasm/wasmLoader");
    const fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4, 5, 6]));
        controller.close();
      },
    }), { headers: { "Content-Length": "6" } }));
    vi.stubGlobal("fetch", fetch);
    wasmInit.mockResolvedValue(undefined);
    const progress: Array<[number, number | null]> = [];

    await initWasm(undefined, (loaded, total) => progress.push([loaded, total]));

    expect(progress).toEqual([[2, 6], [6, 6]]);
    const input = wasmInit.mock.calls[0][0].module_or_path as Response;
    expect(input).toBeInstanceOf(Response);
    expect([...new Uint8Array(await input.arrayBuffer())]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("reports an unknown total when the response has no content length", async () => {
    const { initWasm } = await import("../wasm/wasmLoader");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2]))));
    wasmInit.mockResolvedValue(undefined);
    const progress: Array<[number, number | null]> = [];

    await initWasm(undefined, (loaded, total) => progress.push([loaded, total]));

    expect(progress).toEqual([[2, null]]);
  });
});
