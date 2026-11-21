import { getFieldPresetExtents, type FieldOpError } from "../wasm/mazeService";
import { type FieldConfig, type ResolvedField, requiresExactCells } from "../fieldConfig";
import { belowMinimum, configCells } from "./presetCells";
import { normalizeCells } from "./primitiveGeometry";

/**
 * The cells of a field config; `smooth` also peels single-connection spikes off a preset shape
 * (`custom` and exact-cell shapes are never smoothed). The unsmoothed cells come from `presetCells.ts`.
 */
export function configAllCells(cfg: FieldConfig, smooth = false): [number, number][] {
  const cells = configCells(cfg);
  if (!smooth || cfg.shape.shape === "custom" || requiresExactCells(cfg.shape)) return cells;
  return smoothPreset(cells, cfg);
}

/** A one-cell preset is a valid field, so it is not stripped as an isolated cell. A preset that
 * smoothing would peel away entirely (a one-cell-thick strip) is kept as chosen. */
function smoothPreset(cells: [number, number][], cfg: FieldConfig): [number, number][] {
  if (cells.length < 2) return cells;
  const smoothed = normalizeCells(cells, cfg, true);
  return smoothed.length === 0 ? cells : smoothed;
}

/**
 * Extent of a preset shape along two world directions (`[min, max]` each), measured by core
 * without materializing the cells. `null` for a custom shape or one core refuses (empty field).
 * With `smooth` the cells smoothing removes (`smoothPreset`) do not count; core applies the same
 * rule (`maze_core::space::normalize_cells`, GitHub issue #957).
 */
export function presetShapeExtents(
  cfg: FieldConfig,
  directions: [[number, number], [number, number]],
  smooth = false,
): [[number, number], [number, number]] | null {
  const { shape } = cfg;
  if (shape.shape === "custom") return null;
  const { shape: preset, ...params } = shape;
  if (belowMinimum(cfg, preset, params)) return null;
  try {
    return getFieldPresetExtents(cfg.tessellation, preset, params, directions, smooth && !requiresExactCells(shape));
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
