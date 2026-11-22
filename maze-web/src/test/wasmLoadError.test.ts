import { describe, expect, it } from "vitest";
import * as m from "~/paraglide/messages";
import { WasmLoadError } from "../wasm/wasmLoader";
import { wasmLoadErrorMessage } from "../startup/wasmLoadError";

describe("wasmLoadErrorMessage", () => {
  it.each([
    ["network", "loading.wasm_server_unavailable"],
    ["binaryMissing", "loading.wasm_binary_missing"],
    ["accessDenied", "loading.wasm_access_denied"],
    ["invalidBinary", "loading.wasm_binary_invalid"],
    ["moduleLoad", "loading.wasm_module_failed"],
    ["initialization", "loading.wasm_initialization_failed"],
  ] as const)("uses %s message", (failure, messageKey) => {
    expect(wasmLoadErrorMessage(new WasmLoadError(failure, "test"))).toBe(m[messageKey]());
  });

  it("uses the generic engine failure message for an unclassified error", () => {
    expect(wasmLoadErrorMessage(new Error("test"))).toBe(m["loading.wasm_failed"]());
  });
});
