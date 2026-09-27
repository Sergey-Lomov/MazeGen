import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { configAllCells } from "./tessellationCells";
import { getCartesianCoords } from "../wasm/mazeService";

/// Cache of canonical (unrotated, unit-tile-scale) Cartesian projections, keyed by "x,y" -- the
/// single source of truth `tessellationGeometry.ts`'s low-level `squareCenter`/`hexCenter`/
/// `triCenter` read from instead of duplicating `maze-core`'s projection formulas in TypeScript
/// (see `maze-wasm::cartesian_coords`'s doc comment). Rebuilt whenever the tessellation kind
/// changes via `warmCartesianCache` -- a single batched wasm call over every field cell, not one
/// call per cell, since render loops call `getCellCenter` synchronously and per-call wasm
/// round-trips would be far too slow for a hot path.
const cache = new Map<string, [number, number]>();
let cachedKind: "square" | "hex" | "tri" | null = null;

function toWasmKind(cfg: TessellationConfig): "square" | "hex" | "tri" {
  switch (cfg.type) {
    case "square":
    case "square_circle":
    case "square_triangle":
    case "square_custom":
      return "square";
    case "hex_rectangle":
    case "hex_circle":
    case "hex_parallelogram":
    case "hex_hexagon":
    case "hex_custom":
      return "hex";
    case "triangle_rect":
    case "triangle_triangle":
    case "triangle_circle":
    case "triangle_hexagon":
    case "tri_custom":
      return "tri";
  }
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/// Batched prewarm -- call once when the tessellation config's kind changes (confirmTessellation,
/// project load, generateWithSeed), not per-frame. Clears the cache first: cached coordinates are
/// only valid for the tessellation kind they were computed under (a "square" (2,3) and a "hex"
/// (2,3) project to different points), so a kind change invalidates everything already cached
/// rather than merging in.
export function warmCartesianCache(cfg: TessellationConfig): void {
  const kind = toWasmKind(cfg);
  cache.clear();
  cachedKind = kind;
  const points = configAllCells(cfg);
  if (points.length === 0) return;
  const coords = getCartesianCoords({ tessellation_type: kind, points });
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    cache.set(cellKey(x, y), coords[i]);
  }
}

/// Canonical Cartesian projection for one point, in unit tile scale. Serves from the prewarmed
/// cache for the common case (any point inside the current field); falls back to a single wasm
/// call for a cache miss (points outside the field -- e.g. an invalid preset connection's
/// endpoint, or a boundary neighbor -- are geometrically valid to query but never prewarmed,
/// since prewarming covers exactly `configAllCells(cfg)`, not every possible coordinate).
/// The fallback result is cached too, so a repeatedly-queried out-of-field point (e.g. hovering
/// the same invalid preset edge every frame) only ever pays the wasm round-trip once.
export function getCartesian(x: number, y: number, cfg: TessellationConfig): [number, number] {
  const kind = toWasmKind(cfg);
  if (kind !== cachedKind) {
    // Defensive: a caller queried before the cache was warmed for this kind (or the kind
    // changed without going through warmCartesianCache) -- warm it now rather than silently
    // serving stale/wrong-kind coordinates.
    warmCartesianCache(cfg);
  }
  const key = cellKey(x, y);
  const cached = cache.get(key);
  if (cached) return cached;
  const [coord] = getCartesianCoords({ tessellation_type: kind, points: [[x, y]] });
  cache.set(key, coord);
  return coord;
}
