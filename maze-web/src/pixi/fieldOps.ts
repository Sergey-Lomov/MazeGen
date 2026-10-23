import type { FieldConfig } from "../fieldConfig";
import { getFieldCapabilities, type FieldCapabilities, type FieldOpError } from "../wasm/mazeService";
import * as m from "~/paraglide/messages";

type TessellationConfig = FieldConfig["tessellation"];

/// Tessellation params can take many values while a slider is dragged, so the cache is bounded.
const CAPABILITIES_CACHE_LIMIT = 32;
const capabilitiesCache = new Map<string, FieldCapabilities>();

/// What `maze-core` offers for a tessellation instance: field operations and preset schemas. Cached
/// per serialized config (equal configs build equal instances).
export function fieldCapabilities(tessellation: TessellationConfig): FieldCapabilities {
  const key = JSON.stringify(tessellation);
  let capabilities = capabilitiesCache.get(key);
  if (!capabilities) {
    capabilities = getFieldCapabilities(tessellation);
    if (capabilitiesCache.size >= CAPABILITIES_CACHE_LIMIT) {
      capabilitiesCache.delete(capabilitiesCache.keys().next().value as string);
    }
    capabilitiesCache.set(key, capabilities);
  }
  return capabilities;
}

export function fieldOperationAvailable(tessellation: TessellationConfig, operation: "translate" | "reflect"): boolean {
  return fieldCapabilities(tessellation).operations.includes(operation);
}

/// Preset shape keys the tessellation offers, in core's order.
export function availablePresetKeys(tessellation: TessellationConfig): string[] {
  return fieldCapabilities(tessellation).presets.map((preset) => preset.key);
}

/// Param names with their bounds for one preset shape (`max` only when core limits it); empty when the preset is not offered.
export function presetParams(tessellation: TessellationConfig, key: string): { name: string; min: number; max?: number }[] {
  return fieldCapabilities(tessellation).presets.find((preset) => preset.key === key)?.params ?? [];
}

export function isFieldOpError(error: unknown): error is FieldOpError {
  return typeof error === "object" && error !== null && typeof (error as { kind?: unknown }).kind === "string";
}

/// The wire reason of a failed field operation. Anything that is not a `FieldOpError` is a bug and
/// is rethrown.
export function asFieldOpError(error: unknown): FieldOpError {
  if (isFieldOpError(error)) return error;
  throw error;
}

/// User-facing text of a failed field operation.
export function fieldOpErrorMessage(error: FieldOpError): string {
  switch (error.kind) {
    case "unavailable": return m["field.op_error.unavailable"]();
    case "not_a_symmetry": return m["field.op_error.not_a_symmetry"]();
    case "outside_tessellation": return m["field.op_error.outside_tessellation"]();
    case "invalid_preset": return m["field.op_error.invalid_preset"]({ message: error.message });
    case "invalid_request": return m["field.op_error.invalid_request"]({ message: error.message });
  }
}
