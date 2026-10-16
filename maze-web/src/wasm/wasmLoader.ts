type WasmModule = typeof import("./pkg/maze_wasm");

let wasmModule: WasmModule | null = null;
let initPromise: Promise<void> | null = null;

/** `source` overrides how the binary is fetched (the unit tests pass the file's bytes, since there
 *  is no `fetch` of `import.meta.url` under Node). */
export function initWasm(source?: BufferSource): Promise<void> {
  if (!initPromise) {
    initPromise = import("./pkg/maze_wasm").then(async (pkg) => {
      await (source ? pkg.default({ module_or_path: source }) : pkg.default());
      wasmModule = pkg;
    });
  }
  return initPromise;
}

export function getWasm(): WasmModule {
  if (!wasmModule) throw new Error("WASM not initialized");
  return wasmModule;
}
