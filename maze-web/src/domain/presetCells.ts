import { getFieldPreset, type FieldOpError } from "../wasm/mazeService";
import type { FieldConfig } from "../fieldConfig";
import { presetParams } from "./fieldOps";

/**
 * The cells of a field config, unsmoothed: a preset shape is built by `maze-core` (`field_preset`,
 * GitHub issue #760) in its canonical orientation; `custom` carries its cells directly. Smoothing
 * lives in `tessellationCells.ts` (`configAllCells`), which needs the cell geometry cache — this
 * module stays below that cache so the cache can read a field's cells without a dependency cycle.
 */
export function configCells(cfg: FieldConfig): [number, number][] {
  const { shape } = cfg;
  if (shape.shape === "custom") return shape.points.map(([x, y]) => [x, y]);
  const { shape: preset, ...params } = shape;
  // Core rejects sizes below 1; an unset (0) dimension is an empty field.
  if (belowMinimum(cfg, preset, params)) return [];
  const key = JSON.stringify([cfg.tessellation, preset, params]);
  const cached = presetCache.get(key);
  if (cached) return copyCells(cached);
  const cells = buildPresetCells(cfg, preset, params);
  if (presetCache.size >= PRESET_CACHE_LIMIT) presetCache.delete(presetCache.keys().next().value!);
  presetCache.set(key, cells);
  return copyCells(cells);
}

/** Core rejects a param below its minimum; an unset (0) size is an empty field. */
export function belowMinimum(cfg: FieldConfig, preset: string, params: Record<string, number>): boolean {
  // Only a zero-or-below value can violate a minimum, so ordinary shapes skip the capabilities lookup.
  if (Object.values(params).every((value) => value >= 1)) return false;
  return presetParams(cfg.tessellation, preset).some(({ name, min }) => params[name] < min);
}

/** Callers may mutate what they get, so the cache never hands out its own arrays. */
function copyCells(cells: [number, number][]): [number, number][] {
  return cells.map(([x, y]) => [x, y]);
}

/** Field configs are resolved on every render and selector call; each preset build is a wasm call. */
const PRESET_CACHE_LIMIT = 32;
const presetCache = new Map<string, [number, number][]>();

/** A shape core refuses as `invalid_preset` (it holds no cells, or is too large) is an empty field. */
function buildPresetCells(cfg: FieldConfig, preset: string, params: Record<string, number>): [number, number][] {
  try {
    return getFieldPreset(cfg.tessellation, preset, params);
  } catch (error) {
    if ((error as FieldOpError | undefined)?.kind === "invalid_preset") return [];
    throw error;
  }
}