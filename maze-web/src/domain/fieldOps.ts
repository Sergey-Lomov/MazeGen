import { BOX_DEFAULT_ASPECT, BOX_NET_COMPACT, type FieldConfig, type PolyhedronShapeName, type SwitchedFieldShape } from "../fieldConfig";
import { getFieldCapabilities, getFieldPreset, type FieldCapabilities, type FieldOpError } from "../wasm/mazeService";

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

/// Number of unfolded nets of a polyhedron preset — core publishes it as the `net` switch's max, the
/// index of the compact print layout that follows them.
export function polyhedronNetCount(tessellation: TessellationConfig, shape: PolyhedronShapeName): number {
  return presetParams(tessellation, shape).find((param) => param.name === "net")?.max ?? 0;
}

/// The `net` value of the compact print layout (always by faces) of a topology preset.
export function compactNetOf(tessellation: TessellationConfig, shape: SwitchedFieldShape): number {
  return shape.shape === "box" ? BOX_NET_COMPACT : polyhedronNetCount(tessellation, shape.shape);
}

const faceCounts = new Map<string, number>();

/// Faces of a polyhedron preset: with `side` 1 every face is one cell.
export function polyhedronFaceCount(tessellation: TessellationConfig, shape: PolyhedronShapeName): number {
  const key = `${JSON.stringify(tessellation)}|${shape}`;
  let count = faceCounts.get(key);
  if (count === undefined) {
    count = getFieldPreset(tessellation, shape, { side: 1, net: 0, mode: 1, aspect: BOX_DEFAULT_ASPECT }).length;
    faceCounts.set(key, count);
  }
  return count;
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
