import { getFieldPreset, type FieldOpError } from "../wasm/mazeService";
import { type FieldConfig, type ResolvedField } from "../fieldConfig";

/**
 * The cells of a field config. Preset shapes are built by `maze-core` (`field_preset`, GitHub
 * issue #760) in its canonical orientation; `custom` carries its cells directly.
 */
export function configAllCells(cfg: FieldConfig): [number, number][] {
  const { shape } = cfg;
  if (shape.shape === "custom") return shape.points.map(([x, y]) => [x, y]);
  const { shape: preset, ...params } = shape;
  // Core rejects sizes below 1; an unset (0) dimension is an empty field.
  if (Object.values(params).some((value) => value < 1)) return [];
  const key = JSON.stringify([cfg.tessellation, preset, params]);
  const cached = presetCache.get(key);
  if (cached) return copyCells(cached);
  const cells = buildPresetCells(cfg, preset, params);
  if (presetCache.size >= PRESET_CACHE_LIMIT) presetCache.delete(presetCache.keys().next().value!);
  presetCache.set(key, cells);
  return copyCells(cells);
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
 * Converts the editor's preset shape into the only representation runtime code needs: the same
 * tessellation and orientation with an explicit cell list. Keep all preset-shape knowledge in
 * this module.
 */
export function resolveFieldConfig(cfg: FieldConfig): ResolvedField {
  return { ...cfg, shape: { shape: "custom", points: configAllCells(cfg) } };
}

/** Returns the cells in the outer two fundamental-square layers of a Cairo rectangle. Cell
 * polygons are affine in this block layout, so this bounded set contains every possible x/y
 * extremum and is sufficient for exact print-fit bounds without materializing the full field. */
export function cairoRectangleBoundaryCells(cols: number, rows: number): [number, number][] {
  if (cols <= 0 || rows <= 0) return [];
  const [originX, originY] = cairoRectangleOrigin(cols, rows);
  const colCandidates = new Set([0, 1, cols - 2, cols - 1].filter((col) => col >= 0 && col < cols));
  const rowCandidates = new Set([0, 1, rows - 2, rows - 1].filter((row) => row >= 0 && row < rows));
  const cells: [number, number][] = [];
  for (const cellY of rowCandidates) {
    for (const cellX of colCandidates) {
      cells.push(...cairoFundamentalSquareCells(cellX, cellY, originX, originY));
    }
  }
  return cells;
}

function cairoRectangleOrigin(cols: number, rows: number): [number, number] {
  // Cairo's checkerboard repeats after two fundamental blocks. Translate by complete blocks only
  // and keep the combined block offset even; otherwise a valid core point lands in an empty
  // position when the rectangle is centred for an odd width/height combination.
  let blockX = Math.floor(cols / 2);
  const blockY = Math.floor(rows / 2);
  if ((blockX + blockY) % 2 !== 0) blockX++;
  return [4 * blockX, 4 * blockY];
}

function cairoFundamentalSquareCells(cellX: number, cellY: number, originX: number, originY: number): [number, number][] {
  const x = cellX * 4;
  const y = cellY * 4;
  const points: [number, number][] = (cellX + cellY) % 2 === 1
    ? [[x + 1, y + 2], [x + 3, y + 2]]
    : [[x + 2, y + 1], [x + 2, y + 3]];
  return points.map(([pointX, pointY]) => [pointX - originX, pointY - originY]);
}
