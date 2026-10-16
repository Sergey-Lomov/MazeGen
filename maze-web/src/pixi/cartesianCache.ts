import type { FieldConfig, TessellationConfig } from "../fieldConfig";
import { configAllCells } from "./tessellationCells";
import { getCellCenters } from "../wasm/mazeService";

/// Cache of `maze-core`'s world-unit cell centers, keyed by "x,y" -- the single source of truth
/// `tessellationGeometry.ts`'s low-level `squareCenter`/`hexCenter`/`triCenter` read from instead
/// of duplicating `maze-core`'s geometry in TypeScript (see `maze-wasm::cell_centers`'s doc
/// comment). Rebuilt whenever the tessellation config
/// (`{ kind, params }`) changes via `warmCartesianCache` -- a single batched wasm call over every
/// field cell, not one call per cell, since render loops call `getCellCenter` synchronously and
/// per-call wasm round-trips would be far too slow for a hot path.
const cache = new Map<string, [number, number]>();
let cachedTessellation: string | null = null;

/// Identity of a tessellation instance: the same `{ kind, params }` always builds an equivalent
/// instance, so it is a complete cache key for the instance's projection. Memoized per config
/// object: `getCartesian` runs on render hot paths and must not serialize on every call.
const tessellationKeys = new WeakMap<TessellationConfig, string>();

function tessellationKey(cfg: FieldConfig): string {
  let key = tessellationKeys.get(cfg.tessellation);
  if (key === undefined) {
    key = JSON.stringify(cfg.tessellation);
    tessellationKeys.set(cfg.tessellation, key);
  }
  return key;
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/// Batched prewarm -- call once when the tessellation config changes (confirmTessellation,
/// project load, generateWithSeed), not per-frame. Clears the cache first: cached coordinates are
/// only valid for the tessellation instance they were computed under (a "square" (2,3) and a
/// "hex" (2,3) project to different points), so a config change invalidates everything already
/// cached rather than merging in.
export function warmCartesianCache(cfg: FieldConfig): void {
  cache.clear();
  cachedTessellation = tessellationKey(cfg);
  const points = configAllCells(cfg);
  if (points.length === 0) return;
  const coords = getCellCenters({ tessellation: cfg.tessellation, points });
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    cache.set(cellKey(x, y), coords[i]);
  }
}

/// World-unit center of one cell. Serves from the prewarmed
/// cache for the common case (any point inside the current field); falls back to a single wasm
/// call for a cache miss (points outside the field -- e.g. an invalid preset connection's
/// endpoint, or a boundary neighbor -- are geometrically valid to query but never prewarmed,
/// since prewarming covers exactly `configAllCells(cfg)`, not every possible coordinate).
/// The fallback result is cached too, so a repeatedly-queried out-of-field point (e.g. hovering
/// the same invalid preset edge every frame) only ever pays the wasm round-trip once.
export function getCartesian(x: number, y: number, cfg: FieldConfig): [number, number] {
  if (tessellationKey(cfg) !== cachedTessellation) {
    // Defensive: a caller queried before the cache was warmed for this tessellation (or the
    // config changed without going through warmCartesianCache) -- warm it now rather than
    // silently serving stale/wrong-tessellation coordinates.
    warmCartesianCache(cfg);
  }
  const key = cellKey(x, y);
  const cached = cache.get(key);
  if (cached) return cached;
  const [coord] = getCellCenters({ tessellation: cfg.tessellation, points: [[x, y]] });
  cache.set(key, coord);
  return coord;
}
