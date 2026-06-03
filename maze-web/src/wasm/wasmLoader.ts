type WasmModule = typeof import("../../pkg/maze_wasm");

let wasmModule: WasmModule | null = null;
let initPromise: Promise<void> | null = null;

export function initWasm(): Promise<void> {
  if (!initPromise) {
    initPromise = import("../../pkg/maze_wasm").then((pkg) => { wasmModule = pkg; });
  }
  return initPromise;
}

export function getWasm(): WasmModule {
  if (!wasmModule) throw new Error("WASM not initialized");
  return wasmModule;
}
