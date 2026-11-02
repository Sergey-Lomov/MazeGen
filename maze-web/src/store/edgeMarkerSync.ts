import type { StoreApi } from "zustand";
import { edgeMarkerKeys, selectExportEdgeMarkers } from "../pixi/imageExport/edgeMarkerExport";
import type { EdgeMarkerOverride, EdgeMarkerStyle } from "./imageExportTypes";
import { markLinked } from "./slices/parameterLinksEngine";
import type { MazeStore } from "./storeTypes";

/// Keeps the edge alignment markers' bookkeeping in step with the geometry (GitHub issue #902, `Specs/image-export.md`, "Edge
/// alignment markers"): the active floor's marker order (a marker's number on its floor) and the cleanup of overrides whose
/// marker no longer exists.

/** The style without the overrides of vanished markers: those of floors not in `floorIds`, and, when `active` is given, the ones
 *  of that floor whose key is not in `active.keys`. Returns `style` itself when nothing is stale. */
export function pruneEdgeMarkerOverrides(style: EdgeMarkerStyle, floorIds: ReadonlySet<string>, active: { floorId: string; keys: ReadonlySet<string> } | null): EdgeMarkerStyle {
  let changed = false;
  const overrides: Record<string, Record<string, EdgeMarkerOverride>> = {};
  for (const [floorId, floor] of Object.entries(style.overrides)) {
    if (!floorIds.has(floorId)) {
      changed = true;
      continue;
    }
    if (active?.floorId !== floorId) {
      overrides[floorId] = floor;
      continue;
    }
    const kept = Object.entries(floor).filter(([key]) => active.keys.has(key));
    if (kept.length === Object.keys(floor).length) overrides[floorId] = floor;
    else {
      changed = true;
      if (kept.length > 0) overrides[floorId] = Object.fromEntries(kept);
    }
  }
  return changed ? { ...style, overrides } : style;
}

function sameKeys(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return a !== undefined && a.length === b.length && a.every((key, i) => key === b[i]);
}

/** One pass: refreshes the active floor's order and prunes stale overrides of both render modes. Idempotent (a second run changes
 *  nothing), so the store write it makes cannot loop. */
export function syncEdgeMarkers(store: StoreApi<MazeStore>): void {
  const state = store.getState();
  const floorIds = new Set(state.floors.map((floor) => floor.id));
  const floorId = state.activeFloorId;
  let keys: string[] | null = null;
  // The order only matters to a floor that has overrides (its colour fields are numbered by it), so a project that does not
  // use per-marker looks costs nothing and writes nothing.
  const used = floorId in state.vectorByWallsSettings.edgeMarkers.overrides || floorId in state.vectorByCorridorsSettings.edgeMarkers.overrides || floorId in state.edgeMarkerOrder;
  if (used && floorIds.has(floorId)) {
    try {
      const markers = selectExportEdgeMarkers(state, { mode: "all" });
      const topology = state.floorTopology[floorId];
      // A floor with glues that yields no glue marker has no seam geometry yet (cache not warmed): not a verdict.
      const hasGlueMarker = markers.some((marker) => marker.key.startsWith("g"));
      if (!topology || topology.groups.length === 0 || hasGlueMarker) keys = edgeMarkerKeys(markers);
    } catch {
      keys = null;
    }
  }
  const active = keys && { floorId, keys: new Set(keys) };
  const walls = pruneEdgeMarkerOverrides(state.vectorByWallsSettings.edgeMarkers, floorIds, active);
  const corridors = pruneEdgeMarkerOverrides(state.vectorByCorridorsSettings.edgeMarkers, floorIds, active);
  const orderFloors = Object.keys(state.edgeMarkerOrder);
  const orderStale = orderFloors.some((id) => !floorIds.has(id));
  const orderChanged = keys !== null && !sameKeys(state.edgeMarkerOrder[floorId], keys);
  if (walls === state.vectorByWallsSettings.edgeMarkers && corridors === state.vectorByCorridorsSettings.edgeMarkers && !orderStale && !orderChanged) return;

  let edgeMarkerOrder = state.edgeMarkerOrder;
  if (orderStale || orderChanged) {
    edgeMarkerOrder = Object.fromEntries(Object.entries(state.edgeMarkerOrder).filter(([id]) => floorIds.has(id)));
    if (keys) edgeMarkerOrder[floorId] = keys;
  }
  store.setState({
    edgeMarkerOrder,
    ...(walls !== state.vectorByWallsSettings.edgeMarkers ? { vectorByWallsSettings: markLinked({ ...state.vectorByWallsSettings, edgeMarkers: walls }) } : {}),
    ...(corridors !== state.vectorByCorridorsSettings.edgeMarkers ? { vectorByCorridorsSettings: markLinked({ ...state.vectorByCorridorsSettings, edgeMarkers: corridors }) } : {}),
  });
}

/** Runs {@link syncEdgeMarkers} whenever something the markers derive from changes: the active floor, its topology, creases, cut
 *  lines or field, the floor list, or the stored overrides (a project load). */
export function installEdgeMarkerSync(store: StoreApi<MazeStore>): void {
  store.subscribe((state, prev) => {
    if (
      state.activeFloorId === prev.activeFloorId &&
      state.floorTopology === prev.floorTopology &&
      state.floorCreases === prev.floorCreases &&
      state.pngExportSettings.cuts === prev.pngExportSettings.cuts &&
      state.activeFieldConfig === prev.activeFieldConfig &&
      state.nodes === prev.nodes &&
      state.floors === prev.floors &&
      state.vectorByWallsSettings.edgeMarkers.overrides === prev.vectorByWallsSettings.edgeMarkers.overrides &&
      state.vectorByCorridorsSettings.edgeMarkers.overrides === prev.vectorByCorridorsSettings.edgeMarkers.overrides
    ) return;
    syncEdgeMarkers(store);
  });
}
