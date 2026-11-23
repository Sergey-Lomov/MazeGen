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
    await expect(initWasm(source)).rejects.toMatchObject({ failure: "initialization" });
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

    await expect(compileWasmModule()).rejects.toMatchObject({ failure: "binaryMissing" });
    await expect(compileWasmModule()).resolves.toBe(compiled);
    expect(fetch).toHaveBeenCalledTimes(2);
    compile.mockRestore();
  });

  it("classifies unavailable, denied, and invalid engine binaries", async () => {
    const { compileWasmModule } = await import("../wasm/wasmLoader");
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response(null, { status: 403, statusText: "Forbidden" }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1])));
    vi.stubGlobal("fetch", fetch);
    const compile = vi.spyOn(WebAssembly, "compile").mockRejectedValueOnce(new WebAssembly.CompileError("bad binary"));

    await expect(compileWasmModule()).rejects.toMatchObject({ failure: "network" });
    await expect(compileWasmModule()).rejects.toMatchObject({ failure: "accessDenied" });
    await expect(compileWasmModule()).rejects.toMatchObject({ failure: "invalidBinary" });

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

  it("reuses a cached engine when the server validator is unchanged", async () => {
    const { compileWasmModule } = await import("../wasm/wasmLoader");
    const cache = {
      match: vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), { headers: { ETag: "engine-v1" } })),
      put: vi.fn(),
      delete: vi.fn(),
    };
    vi.stubGlobal("caches", { open: vi.fn().mockResolvedValue(cache) });
    const fetch = vi.fn().mockResolvedValue(new Response(null, { headers: { ETag: "engine-v1" } }));
    vi.stubGlobal("fetch", fetch);
    const compiled = {} as WebAssembly.Module;
    const compile = vi.spyOn(WebAssembly, "compile").mockResolvedValue(compiled);

    await expect(compileWasmModule()).resolves.toBe(compiled);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "HEAD", cache: "no-cache" });
    expect(cache.put).not.toHaveBeenCalled();
    compile.mockRestore();
  });

  it("replaces a cached engine when its validator has changed", async () => {
    const { compileWasmModule } = await import("../wasm/wasmLoader");
    const cached = new Response(new Uint8Array([1]), { headers: { ETag: "engine-v1" } });
    let staged: Response | undefined;
    let committed: Response | undefined;
    const cache = {
      match: vi.fn(async (request: URL) => request.searchParams.has("__maze_engine_staging") ? staged : cached),
      put: vi.fn(async (request: URL, response: Response) => {
        if (request.searchParams.has("__maze_engine_staging")) staged = response;
        else committed = response;
      }),
      delete: vi.fn(),
    };
    vi.stubGlobal("caches", { open: vi.fn().mockResolvedValue(cache) });
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { headers: { ETag: "engine-v2" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([2]), { headers: { ETag: "engine-v2" } }));
    vi.stubGlobal("fetch", fetch);
    const compiled = {} as WebAssembly.Module;
    const compile = vi.spyOn(WebAssembly, "compile").mockImplementation(async (bytes) => {
      expect([...new Uint8Array(bytes as ArrayBuffer)]).toEqual([2]);
      return compiled;
    });

    await expect(compileWasmModule()).resolves.toBe(compiled);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "HEAD", cache: "no-cache" });
    expect(fetch.mock.calls[1][1]).toMatchObject({ cache: "no-cache" });
    expect(cache.put).toHaveBeenCalledTimes(2);
    expect(cache.delete).toHaveBeenCalledTimes(1);
    expect([...new Uint8Array(await committed!.arrayBuffer())]).toEqual([2]);
    compile.mockRestore();
  });

  it("discards a staged engine when compilation fails", async () => {
    const { compileWasmModule } = await import("../wasm/wasmLoader");
    const cache = {
      match: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(true),
    };
    vi.stubGlobal("caches", { open: vi.fn().mockResolvedValue(cache) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([1]))));
    const compile = vi.spyOn(WebAssembly, "compile").mockRejectedValue(new WebAssembly.CompileError("bad binary"));

    await expect(compileWasmModule()).rejects.toMatchObject({ failure: "invalidBinary" });

    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(cache.delete).toHaveBeenCalledTimes(1);
    compile.mockRestore();
  });

  it("uses the last successful engine when the validator cannot be reached", async () => {
    const { compileWasmModule } = await import("../wasm/wasmLoader");
    const cache = {
      match: vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), { headers: { ETag: "engine-v1" } })),
      put: vi.fn(),
      delete: vi.fn(),
    };
    vi.stubGlobal("caches", { open: vi.fn().mockResolvedValue(cache) });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Offline")));
    const compiled = {} as WebAssembly.Module;
    const compile = vi.spyOn(WebAssembly, "compile").mockResolvedValue(compiled);

    await expect(compileWasmModule()).resolves.toBe(compiled);

    expect(cache.put).not.toHaveBeenCalled();
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
