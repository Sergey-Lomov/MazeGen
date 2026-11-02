import type { FieldConfig } from "../fieldConfig";
import { belowMinimum } from "../pixi/tessellationCells";
import type { WireTopology } from "../wasm/types";
import { getFieldPresetCreases, getFieldPresetTopology, type FieldOpError } from "../wasm/mazeService";
import type { Crease } from "./creases";
import type { MazeState } from "./storeTypes";

/**
 * The topology a floor's standard field shape defines (GitHub issue #858, `Specs/topology.md`,
 * "Topology presets"): the `box` net comes with its gluings. `undefined` for a shape that
 * is only a field (rect, circle, …), for a custom field and for a size core refuses.
 */
export function presetTopologyOf(cfg: FieldConfig): WireTopology | undefined {
  const request = presetRequestOf(cfg);
  if (!request) return undefined;
  const { preset, params, key } = request;
  if (!cache.has(key)) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(key, buildTopology(cfg, preset, params));
  }
  return cache.get(key);
}

/** The preset and parameters of a standard shape and their cache key; `undefined` for a custom field and a size below the minimum. */
function presetRequestOf(cfg: FieldConfig): { preset: string; params: Record<string, number>; key: string } | undefined {
  const { shape } = cfg;
  if (shape.shape === "custom") return undefined;
  const { shape: preset, ...params } = shape;
  if (belowMinimum(cfg, preset, params)) return undefined;
  return { preset, params, key: JSON.stringify([cfg.tessellation, preset, params]) };
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

// Topology values are immutable wire data, so targets share the source's object. A source without
// a topology clears the targets' (the copy must not keep stale seams of the replaced field).
export function topologyCopiedTo(
  floorTopology: MazeState["floorTopology"],
  sourceFloorId: string,
  targetIds: readonly string[],
): MazeState["floorTopology"] {
  const next = { ...floorTopology };
  const source = floorTopology[sourceFloorId];
  for (const id of targetIds) {
    if (source) next[id] = source;
    else delete next[id];
  }
  return next;
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

/**
 * The crease lines a floor's standard field shape defines (GitHub issue #899, `Specs/topology.md`,
 * "Topology presets"): the net edges that join two faces of a folded shape. `undefined` for a
 * shape without creases (including every shape that is only a field), a custom field and a size
 * core refuses.
 */
export function presetCreasesOf(cfg: FieldConfig): Crease[] | undefined {
  const request = presetRequestOf(cfg);
  if (!request) return undefined;
  const { preset, params, key } = request;
  if (!creaseCache.has(key)) {
    if (creaseCache.size >= CACHE_LIMIT) creaseCache.delete(creaseCache.keys().next().value!);
    creaseCache.set(key, buildCreases(cfg, preset, params));
  }
  return creaseCache.get(key);
}

// Like topologies, creases are immutable and shared by every floor on the same shape.
const creaseCache = new Map<string, Crease[] | undefined>();

function buildCreases(cfg: FieldConfig, preset: string, params: Record<string, number>): Crease[] | undefined {
  try {
    const segments = getFieldPresetCreases(cfg.tessellation, preset, params);
    return segments.length === 0 ? undefined : segments.map(([a, b], id) => ({ id, a, b }));
  } catch (error) {
    if ((error as FieldOpError | undefined)?.kind === "invalid_preset") return undefined;
    throw error;
  }
}

/** `floorCreases` with `floorId` holding the creases `cfg` defines, or none (see `withPresetTopology`). */
export function withPresetCreases(
  floorCreases: MazeState["floorCreases"],
  floorId: string,
  cfg: FieldConfig,
): MazeState["floorCreases"] {
  const creases = presetCreasesOf(cfg);
  if (floorCreases[floorId] === creases) return floorCreases;
  const next = { ...floorCreases };
  if (creases) next[floorId] = creases;
  else delete next[floorId];
  return next;
}
