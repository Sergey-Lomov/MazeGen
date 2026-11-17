import type { MazeState } from "../../store/storeTypes";
import type { SeamHopContext, SeamPairsContext } from "../graphSeams";
import { seamArrowsFor, type SeamArrow, type SeamPair } from "./seamArrows";

const pairsCache = new WeakMap<SeamArrow[], Map<number, SeamPair>>();
const contextCache = new WeakMap<object, { arrows: SeamArrow[]; context: SeamHopContext }>();

/// The pairs of the arrows by seam index (arrows are cached per config and topology).
function pairsBySeam(arrows: SeamArrow[]): Map<number, SeamPair> {
  let map = pairsCache.get(arrows);
  if (!map) {
    map = new Map(arrows.flatMap((arrow) => arrow.pairs).map((pair) => [pair.seam, pair]));
    pairsCache.set(arrows, map);
  }
  return map;
}

/// The arrows of the active floor's glues; none when the floor has no field or no geometry yet.
export function selectActiveSeamArrows(state: MazeState): SeamArrow[] {
  const field = state.floorFields[state.activeFloorId];
  if (!field) return [];
  try {
    return seamArrowsFor(field.fieldConfig, state.floorTopology[state.activeFloorId] ?? null);
  } catch {
    // A field mid-reset has no geometry to read; the next change redraws.
    return [];
  }
}

/// The glued pairs of the active floor, or `undefined` when the floor has no field or no seams.
export function selectSeamPairs(state: MazeState): SeamPairsContext | undefined {
  const field = state.floorFields[state.activeFloorId];
  const arrows = selectActiveSeamArrows(state);
  return field && arrows.length > 0 ? { cfg: field.fieldConfig, pairs: pairsBySeam(arrows) } : undefined;
}

/// What the graph overlays of the analytics renderer need to draw a hop through a seam (GitHub issue
/// #841): the active floor's glued pairs and the cell of each node (a node's cell is its own `(x, y)`).
/// `undefined` when the floor has no field or no seams.
export function selectSeamHopContext(state: MazeState, nodes: readonly { id: number; x: number; y: number }[]): SeamHopContext | undefined {
  const field = state.floorFields[state.activeFloorId];
  if (!field) return undefined;
  const arrows = selectActiveSeamArrows(state);
  if (arrows.length === 0) return undefined;
  // Remembered per node list, so a renderer sees the same context (and skips redrawing) until the arrows change.
  const cached = contextCache.get(nodes);
  if (cached && cached.arrows === arrows) return cached.context;
  const cells = new Map(nodes.map((node) => [node.id, [node.x, node.y] as [number, number]]));
  const context: SeamHopContext = { cfg: field.fieldConfig, cellOf: (id) => cells.get(id), pairs: pairsBySeam(arrows) };
  contextCache.set(nodes, { arrows, context });
  return context;
}
