type WasmModule = typeof import("./pkg/maze_wasm");
export type WasmLoadProgress = (loaded: number, total: number | null) => void;

/** A user-visible stage of loading the maze engine. The original error remains attached for logs. */
export type WasmLoadFailure = "network" | "binaryMissing" | "accessDenied" | "invalidBinary" | "moduleLoad" | "initialization";

export class WasmLoadError extends Error {
  readonly cause: unknown;

  constructor(readonly failure: WasmLoadFailure, message: string, cause?: unknown) {
    super(message);
    this.name = "WasmLoadError";
    this.cause = cause;
  }
}

let wasmModule: WasmModule | null = null;
let initPromise: Promise<void> | null = null;

let compilePromise: Promise<WebAssembly.Module> | null = null;

const WASM_CACHE_NAME = "maze-engine-v1";

interface FetchedWasm {
  response: Response;
  progress: Promise<void>;
  /** The response starts streaming to an isolated Cache Storage entry immediately, avoiding a
   * full binary clone in memory. It becomes the live entry only after compilation succeeds. */
  cacheEntry?: { cache: Cache; url: URL; stagingUrl: URL; write: Promise<void> };
}

/** Fetches and compiles the WASM binary once per thread; later callers share the first attempt
 *  (and its `onProgress`). A `WebAssembly.Module` is structured-cloneable, so the main thread
 *  instantiates it itself and hands it to every worker, which then only instantiates it instead of
 *  fetching and compiling the binary again (GitHub issue #951). */
export function compileWasmModule(onProgress?: WasmLoadProgress): Promise<WebAssembly.Module> {
  if (!compilePromise) {
    compilePromise = (async () => {
      const { response, progress, cacheEntry } = await fetchWasm(onProgress);
      try {
        let compiled: WebAssembly.Module;
        if (response.headers.get("Content-Type")?.startsWith("application/wasm")) {
          try {
            compiled = await WebAssembly.compileStreaming(response);
          } catch (error) {
            // A CompileError means the downloaded bytes are invalid; other streaming failures mean
            // the response body was interrupted before the browser could compile it.
            const failure = error instanceof WebAssembly.CompileError ? "invalidBinary" : "network";
            throw new WasmLoadError(failure, "The WASM binary could not be compiled", error);
          }
        } else {
          let bytes: ArrayBuffer;
          try {
            bytes = await response.arrayBuffer();
          } catch (error) {
            throw new WasmLoadError("network", "The WASM binary could not be downloaded", error);
          }
          try {
            compiled = await WebAssembly.compile(bytes);
          } catch (error) {
            throw new WasmLoadError("invalidBinary", "The WASM binary could not be compiled", error);
          }
        }
        try {
          await progress;
        } catch (error) {
          throw new WasmLoadError("network", "The WASM download was interrupted", error);
        }
        if (cacheEntry) {
          try {
            await cacheEntry.write;
            const staged = await cacheEntry.cache.match(cacheEntry.stagingUrl);
            if (staged) await cacheEntry.cache.put(cacheEntry.url, staged);
          } catch {
            // Persisting is an optimization; compilation succeeded and the current engine is valid.
          }
        }
        return compiled;
      } finally {
        if (cacheEntry) {
          try {
            await cacheEntry.cache.delete(cacheEntry.stagingUrl);
          } catch {
            // A failed cleanup only leaves an unreachable cache entry behind.
          }
        }
      }
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
    initPromise = (async () => {
      let pkg: WasmModule;
      try {
        pkg = await import("./pkg/maze_wasm");
      } catch (error) {
        throw new WasmLoadError("moduleLoad", "The WASM JavaScript module could not be loaded", error);
      }

      const moduleOrPath = source ?? await compileWasmModule(onProgress);
      try {
        await pkg.default({ module_or_path: moduleOrPath });
      } catch (error) {
        throw new WasmLoadError("initialization", "The WASM module could not be initialized", error);
      }
      wasmModule = pkg;
    })().catch((error: unknown) => {
      // A rejected promise must not poison later user-initiated retries. Concurrent callers
      // still share this attempt until it settles.
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

async function fetchWasm(onProgress?: WasmLoadProgress): Promise<FetchedWasm> {
  const url = new URL("./pkg/maze_wasm_bg.wasm", import.meta.url);
  const cache = await openWasmCache();
  const cached = cache ? await cache.match(url).catch(() => undefined) : undefined;

  if (cached) {
    try {
      // Vite provides an ETag for source assets. A HEAD request makes a normal reload cheap while
      // still detecting a locally rebuilt engine before it can be used.
      const metadata = await fetch(url, { method: "HEAD", cache: "no-cache" });
      if (metadata.ok && hasSameValidator(cached, metadata)) {
        return { response: cached, progress: Promise.resolve() };
      }
    } catch {
      // A previously successful engine is usable offline. A first visit has no cached response
      // and falls through to the normal, user-visible network failure below.
      return { response: cached, progress: Promise.resolve() };
    }
  }

  let response: Response;
  try {
    response = await fetch(url, { cache: "no-cache" });
  } catch (error) {
    throw new WasmLoadError("network", "The WASM binary could not be fetched", error);
  }
  if (!response.ok) {
    const failure = response.status === 404
      ? "binaryMissing"
      : response.status === 401 || response.status === 403
        ? "accessDenied"
        : "network";
    throw new WasmLoadError(failure, `Failed to load WASM: ${response.status} ${response.statusText}`);
  }

  const contentLength = Number(response.headers.get("Content-Length"));
  const total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null;
  const cacheEntry = cache && response.ok ? stageWasmCacheEntry(cache, url, response) : undefined;

  if (!onProgress || !response.body) return { response, progress: Promise.resolve(), cacheEntry };

  // Preserve wasm-bindgen's streaming compilation while a second branch counts the downloaded
  // bytes. Buffering the full binary first would double peak memory and delay compilation.
  const [compileStream, progressStream] = response.body.tee();
  return {
    response: new Response(compileStream, { status: response.status, statusText: response.statusText, headers: response.headers }),
    progress: reportWasmProgress(progressStream, total, onProgress),
    cacheEntry,
  };
}

function stageWasmCacheEntry(cache: Cache, url: URL, response: Response): NonNullable<FetchedWasm["cacheEntry"]> {
  const stagingUrl = new URL(url);
  // One stable staging key bounds leftover storage to one response if the page is terminated
  // before the normal finally cleanup runs.
  stagingUrl.searchParams.set("__maze_engine_staging", "1");
  return { cache, url, stagingUrl, write: cache.put(stagingUrl, response.clone()) };
}

async function openWasmCache(): Promise<Cache | undefined> {
  if (typeof caches === "undefined") return undefined;
  try {
    return await caches.open(WASM_CACHE_NAME);
  } catch {
    // Cache Storage is optional (for example, it can be disabled by a privacy policy). The engine
    // must retain its normal fetch behavior when it is unavailable.
    return undefined;
  }
}

function hasSameValidator(cached: Response, metadata: Response): boolean {
  for (const name of ["ETag", "Last-Modified"]) {
    const value = cached.headers.get(name);
    if (value && value === metadata.headers.get(name)) return true;
  }
  return false;
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
