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

  it("instantiates a ready module without fetching", async () => {
    const { initWasm } = await import("../wasm/wasmLoader");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    wasmInit.mockResolvedValue(undefined);
    const module = {} as WebAssembly.Module;

    await initWasm(module);

    expect(fetch).not.toHaveBeenCalled();
    expect(wasmInit.mock.calls[0][0].module_or_path).toBe(module);
  });

  it("compiles the module once and shares it between callers", async () => {
    const { compileWasmModule } = await import("../wasm/wasmLoader");
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(new Uint8Array([1]), { headers: { "Content-Type": "application/octet-stream" } })));
    vi.stubGlobal("fetch", fetch);
    const compiled = {} as WebAssembly.Module;
    const compile = vi.spyOn(WebAssembly, "compile").mockResolvedValue(compiled);

    const [a, b] = await Promise.all([compileWasmModule(), compileWasmModule()]);

    expect(a).toBe(compiled);
    expect(b).toBe(compiled);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledTimes(1);
    compile.mockRestore();
  });

  it("allows a new compile attempt after a failed one", async () => {
    const { compileWasmModule } = await import("../wasm/wasmLoader");
    const compiled = {} as WebAssembly.Module;
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404, statusText: "Not Found" }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1])));
    vi.stubGlobal("fetch", fetch);
    const compile = vi.spyOn(WebAssembly, "compile").mockResolvedValue(compiled);

    await expect(compileWasmModule()).rejects.toThrow("Failed to load WASM: 404 Not Found");
    await expect(compileWasmModule()).resolves.toBe(compiled);
    expect(fetch).toHaveBeenCalledTimes(2);
    compile.mockRestore();
  });

  it("compiles an application/wasm response by streaming", async () => {
    const { compileWasmModule } = await import("../wasm/wasmLoader");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), { headers: { "Content-Type": "application/wasm" } })));
    const compiled = {} as WebAssembly.Module;
    const streaming = vi.spyOn(WebAssembly, "compileStreaming").mockResolvedValue(compiled);
    const buffered = vi.spyOn(WebAssembly, "compile");

    await expect(compileWasmModule()).resolves.toBe(compiled);

    expect(streaming).toHaveBeenCalledTimes(1);
    expect(buffered).not.toHaveBeenCalled();
    streaming.mockRestore();
    buffered.mockRestore();
  });

  it("reports streamed WASM download progress and instantiates the compiled module", async () => {
    const { initWasm } = await import("../wasm/wasmLoader");
    const fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4, 5, 6]));
        controller.close();
      },
    }), { headers: { "Content-Length": "6" } }));
    vi.stubGlobal("fetch", fetch);
    const compiled = {} as WebAssembly.Module;
    const compile = vi.spyOn(WebAssembly, "compile").mockImplementation(async (bytes) => {
      expect([...new Uint8Array(bytes as ArrayBuffer)]).toEqual([1, 2, 3, 4, 5, 6]);
      return compiled;
    });
    wasmInit.mockResolvedValue(undefined);
    const progress: Array<[number, number | null]> = [];

    await initWasm(undefined, (loaded, total) => progress.push([loaded, total]));

    expect(progress).toEqual([[2, 6], [6, 6]]);
    expect(wasmInit.mock.calls[0][0].module_or_path).toBe(compiled);
    compile.mockRestore();
  });

  it("fetches the binary once for the main thread and the workers", async () => {
    const { initWasm, compileWasmModule } = await import("../wasm/wasmLoader");
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(new Uint8Array([1]))));
    vi.stubGlobal("fetch", fetch);
    const compiled = {} as WebAssembly.Module;
    const compile = vi.spyOn(WebAssembly, "compile").mockResolvedValue(compiled);
    wasmInit.mockResolvedValue(undefined);

    await initWasm();
    await expect(compileWasmModule()).resolves.toBe(compiled);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledTimes(1);
    compile.mockRestore();
  });

  it("reports an unknown total when the response has no content length", async () => {
    const { initWasm } = await import("../wasm/wasmLoader");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2]))));
    const compile = vi.spyOn(WebAssembly, "compile").mockResolvedValue({} as WebAssembly.Module);
    wasmInit.mockResolvedValue(undefined);
    const progress: Array<[number, number | null]> = [];

    await initWasm(undefined, (loaded, total) => progress.push([loaded, total]));

    expect(progress).toEqual([[2, null]]);
    compile.mockRestore();
  });
});
