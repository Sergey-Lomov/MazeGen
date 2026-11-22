import * as m from "~/paraglide/messages";
import { WasmLoadError } from "../wasm/wasmLoader";

/** Converts a structured engine-load failure into the boot screen's localized message. */
export function wasmLoadErrorMessage(error: unknown): string {
  if (!(error instanceof WasmLoadError)) return m["loading.wasm_failed"]();
  switch (error.failure) {
    case "network": return m["loading.wasm_server_unavailable"]();
    case "binaryMissing": return m["loading.wasm_binary_missing"]();
    case "accessDenied": return m["loading.wasm_access_denied"]();
    case "invalidBinary": return m["loading.wasm_binary_invalid"]();
    case "moduleLoad": return m["loading.wasm_module_failed"]();
    case "initialization": return m["loading.wasm_initialization_failed"]();
  }
}
