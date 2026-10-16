type WasmModule = typeof import("./pkg/maze_wasm");

let wasmModule: WasmModule | null = null;
let initPromise: Promise<void> | null = null;

export function initWasm(): Promise<void> {
  if (!initPromise) {
    initPromise = import("./pkg/maze_wasm").then(async (pkg) => {
      await pkg.default();
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

export function getWasm(): WasmModule {
  if (!wasmModule) throw new Error("WASM not initialized");
  return wasmModule;
}
