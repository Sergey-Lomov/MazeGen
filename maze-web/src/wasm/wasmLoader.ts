type WasmModule = typeof import("./pkg/maze_wasm");
export type WasmLoadProgress = (loaded: number, total: number | null) => void;

let wasmModule: WasmModule | null = null;
let initPromise: Promise<void> | null = null;

let compilePromise: Promise<WebAssembly.Module> | null = null;

/** Fetches and compiles the WASM binary once per thread; later callers share the first attempt
 *  (and its `onProgress`). A `WebAssembly.Module` is structured-cloneable, so the main thread
 *  instantiates it itself and hands it to every worker, which then only instantiates it instead of
 *  fetching and compiling the binary again (GitHub issue #951). */
export function compileWasmModule(onProgress?: WasmLoadProgress): Promise<WebAssembly.Module> {
  if (!compilePromise) {
    compilePromise = (async () => {
      const { response, progress } = await fetchWasm(onProgress);
      const compiled = response.headers.get("Content-Type")?.startsWith("application/wasm")
        ? await WebAssembly.compileStreaming(response)
        : await WebAssembly.compile(await response.arrayBuffer());
      await progress;
      return compiled;
    })().catch((error: unknown) => {
      // A rejected attempt must not poison later retries.
      compilePromise = null;
      throw error;
    });
  }
  return compilePromise;
}

/** `source` overrides how the binary is obtained: the unit tests pass the file's bytes (there is no
 *  `fetch` of `import.meta.url` under Node), a worker passes the module compiled by the main thread. */
export function initWasm(source?: BufferSource | WebAssembly.Module, onProgress?: WasmLoadProgress): Promise<void> {
  if (!initPromise) {
    initPromise = import("./pkg/maze_wasm").then(async (pkg) => {
      await pkg.default({ module_or_path: source ?? await compileWasmModule(onProgress) });
      wasmModule = pkg;
    }).catch((error: unknown) => {
      // A rejected promise must not poison later user-initiated retries. Concurrent callers
      // still share this attempt until it settles.
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

async function fetchWasm(onProgress?: WasmLoadProgress): Promise<{ response: Response; progress: Promise<void> }> {
  const response = await fetch(new URL("./pkg/maze_wasm_bg.wasm", import.meta.url));
  if (!response.ok) throw new Error(`Failed to load WASM: ${response.status} ${response.statusText}`);

  const contentLength = Number(response.headers.get("Content-Length"));
  const total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null;
  if (!onProgress || !response.body) return { response, progress: Promise.resolve() };

  // Preserve wasm-bindgen's streaming compilation while a second branch counts the downloaded
  // bytes. Buffering the full binary first would double peak memory and delay compilation.
  const [compileStream, progressStream] = response.body.tee();
  return {
    response: new Response(compileStream, { status: response.status, statusText: response.statusText, headers: response.headers }),
    progress: reportWasmProgress(progressStream, total, onProgress),
  };
}

async function reportWasmProgress(stream: ReadableStream<Uint8Array>, total: number | null, onProgress: WasmLoadProgress): Promise<void> {
  const reader = stream.getReader();
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    loaded += value.byteLength;
    onProgress(loaded, total);
  }
}

export function getWasm(): WasmModule {
  if (!wasmModule) throw new Error("WASM not initialized");
  return wasmModule;
}
