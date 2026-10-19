import { getFieldPreset, getFieldPresetExtents, type FieldOpError } from "../wasm/mazeService";
import { type FieldConfig, type ResolvedField } from "../fieldConfig";
import { normalizePrimitiveCells } from "./primitiveGeometry";

/**
 * The cells of a field config. Preset shapes are built by `maze-core` (`field_preset`, GitHub
 * issue #760) in its canonical orientation; `custom` carries its cells directly.
 */
export function configAllCells(cfg: FieldConfig, smooth = false): [number, number][] {
  const { shape } = cfg;
  if (shape.shape === "custom") return shape.points.map(([x, y]) => [x, y]);
  const { shape: preset, ...params } = shape;
  // Core rejects sizes below 1; an unset (0) dimension is an empty field.
  if (Object.values(params).some((value) => value < 1)) return [];
  const key = JSON.stringify([cfg.tessellation, preset, params]);
  const cached = presetCache.get(key);
  if (cached) return smooth ? normalizePrimitiveCells(copyCells(cached), cfg, true) : copyCells(cached);
  const cells = buildPresetCells(cfg, preset, params);
  if (presetCache.size >= PRESET_CACHE_LIMIT) presetCache.delete(presetCache.keys().next().value!);
  presetCache.set(key, cells);
  const result = copyCells(cells);
  return smooth ? normalizePrimitiveCells(result, cfg, true) : result;
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

/**
 * Extent of a preset shape along two world directions (`[min, max]` each), measured by core
 * without materializing the cells. `null` for a custom shape or one core refuses (empty field).
 */
export function presetShapeExtents(
  cfg: FieldConfig,
  directions: [[number, number], [number, number]],
): [[number, number], [number, number]] | null {
  const { shape } = cfg;
  if (shape.shape === "custom") return null;
  const { shape: preset, ...params } = shape;
  if (Object.values(params).some((value) => value < 1)) return null;
  try {
    return getFieldPresetExtents(cfg.tessellation, preset, params, directions);
  } catch (error) {
    if ((error as FieldOpError | undefined)?.kind === "invalid_preset") return null;
    throw error;
  }
}

/**
 * Converts the editor's preset shape into the only representation runtime code needs: the same
 * tessellation and orientation with an explicit cell list. Keep all preset-shape knowledge in
 * this module.
 */
export function resolveFieldConfig(cfg: FieldConfig, smooth = false): ResolvedField {
  return { ...cfg, shape: { shape: "custom", points: configAllCells(cfg, smooth) } };
}
