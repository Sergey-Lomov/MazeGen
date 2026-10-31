import type { FieldConfig } from "../fieldConfig";
import { belowMinimum } from "../pixi/tessellationCells";
import type { WireTopology } from "../wasm/types";
import { getFieldPresetTopology, type FieldOpError } from "../wasm/mazeService";
import type { MazeState } from "./storeTypes";

/**
 * The topology a floor's standard field shape defines (GitHub issue #858, `Specs/topology.md`,
 * "Topology presets"): the `box` net comes with its gluings. `undefined` for a shape that
 * is only a field (rect, circle, …), for a custom field and for a size core refuses.
 */
export function presetTopologyOf(cfg: FieldConfig): WireTopology | undefined {
  const { shape } = cfg;
  if (shape.shape === "custom") return undefined;
  const { shape: preset, ...params } = shape;
  if (belowMinimum(cfg, preset, params)) return undefined;
  const key = JSON.stringify([cfg.tessellation, preset, params]);
  if (!cache.has(key)) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(key, buildTopology(cfg, preset, params));
  }
  return cache.get(key);
}

// Wire topologies are immutable, so one object per shape is shared by every floor that uses it.
const CACHE_LIMIT = 32;
const cache = new Map<string, WireTopology | undefined>();

function buildTopology(cfg: FieldConfig, preset: string, params: Record<string, number>): WireTopology | undefined {
  try {
    return getFieldPresetTopology(cfg.tessellation, preset, params) ?? undefined;
  } catch (error) {
    if ((error as FieldOpError | undefined)?.kind === "invalid_preset") return undefined;
    throw error;
  }
}

/**
 * `floorTopology` with `floorId` holding the topology `cfg` defines. A floor on a standard shape
 * has no glues of its own (the glue editor works on custom fields only), so its entry is exactly
 * the shape's topology, or none.
 */
export function withPresetTopology(
  floorTopology: MazeState["floorTopology"],
  floorId: string,
  cfg: FieldConfig,
): MazeState["floorTopology"] {
  const topology = presetTopologyOf(cfg);
  if (floorTopology[floorId] === topology) return floorTopology;
  const next = { ...floorTopology };
  if (topology) next[floorId] = topology;
  else delete next[floorId];
  return next;
}
