import type { FieldConfig, FieldShape } from "../fieldConfig";
import { getFieldPresetTopology, type FieldOpError } from "../wasm/mazeService";

type GluedShape = Extract<FieldShape, { shape: "cylinder" | "torus" }>;
type GluedConfig = FieldConfig & { shape: GluedShape };

/** How far from the wanted size a size that closes up is looked for. */
const SNAP_RANGE = 16;

function isGluedRect(cfg: FieldConfig): cfg is GluedConfig {
  return cfg.shape.shape === "cylinder" || cfg.shape.shape === "torus";
}

/** The same field as a plain rectangle, for searches that do not know about gluing. */
export function withoutRectGluing(cfg: FieldConfig): FieldConfig {
  if (!isGluedRect(cfg)) return cfg;
  return { ...cfg, shape: { shape: "rect", cols: cfg.shape.cols, rows: cfg.shape.rows } };
}

/** `plane` (a plain rectangle) glued the way `glued` is, at the size of `plane`. */
export function withRectGluing(plane: FieldConfig, glued: FieldConfig): FieldConfig {
  if (!isGluedRect(glued) || plane.shape.shape !== "rect") return plane;
  const { cols, rows } = plane.shape;
  return { ...plane, shape: { ...glued.shape, cols, rows } };
}

const closeCache = new Map<string, boolean>();
const CACHE_LIMIT = 256;

/**
 * Whether the cylinder or torus closes up at its size (GitHub issue #894). Only core knows: it
 * refuses a size where a cell would meet another through two faces or the sides do not line up
 * (a hex grid needs an even number of columns for a gluing along the rows, ...). Any other shape does.
 */
export function rectCloses(cfg: FieldConfig): boolean {
  if (!isGluedRect(cfg)) return true;
  const { shape: preset, ...params } = cfg.shape;
  if (params.cols < 1 || params.rows < 1) return false;
  const key = JSON.stringify([cfg.tessellation, preset, params]);
  let closes = closeCache.get(key);
  if (closes === undefined) {
    try {
      getFieldPresetTopology(cfg.tessellation, preset, params);
      closes = true;
    } catch (error) {
      if ((error as FieldOpError | undefined)?.kind !== "invalid_preset") throw error;
      closes = false;
    }
    if (closeCache.size >= CACHE_LIMIT) closeCache.delete(closeCache.keys().next().value!);
    closeCache.set(key, closes);
  }
  return closes;
}

/** The values around `size` within `1..=max`, nearest first (the larger on a tie, or only smaller ones for `"down"`). */
function* aroundSize(size: number, max: number, direction: "nearest" | "down"): Generator<number> {
  for (let distance = 0; distance <= SNAP_RANGE; distance++) {
    const candidates = direction === "down" ? [size - distance] : distance === 0 ? [size] : [size + distance, size - distance];
    for (const candidate of candidates) {
      if (candidate >= 1 && candidate <= max) yield candidate;
    }
  }
}

/**
 * `cfg` with its cylinder or torus moved to the nearest size that closes up (GitHub issue #894): `changed`
 * is the dimension the user just set, it moves first and the other one only when that is not enough.
 * `direction: "down"` never grows a side (print sizing must stay on the sheet). `null` when no size
 * within reach closes up. Anything but a cylinder or torus is returned as is.
 */
export function snapRectToClose(
  cfg: FieldConfig,
  changed: "cols" | "rows" | "both" = "both",
  direction: "nearest" | "down" = "nearest",
  max = 1000,
): FieldConfig | null {
  if (!isGluedRect(cfg) || rectCloses(cfg)) return cfg;
  const withSize = (cols: number, rows: number): GluedConfig => ({ ...cfg, shape: { ...cfg.shape, cols, rows } });
  const first = changed === "rows" ? "rows" : "cols";
  const sized = (movable: number, fixed: number) => (first === "cols" ? withSize(movable, fixed) : withSize(fixed, movable));
  const { cols, rows } = cfg.shape;
  const [movable, fixed] = first === "cols" ? [cols, rows] : [rows, cols];
  for (const other of aroundSize(fixed, max, direction)) {
    for (const value of aroundSize(movable, max, direction)) {
      const candidate = sized(value, other);
      if (rectCloses(candidate)) return candidate;
    }
  }
  return null;
}
