import type { NodeDto, EdgeDto } from "../../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../../fieldConfig";
import type { MarkerData, MarkerShape, TeleportCornerStyle } from "../../renderers/types";
import { buildNodePositions } from "../../tessellationGeometry";
import { TILE_SIZE } from "../../constants";
import { DEFAULT_MAZE_RENDER_STYLE } from "../../defaultMazeRenderStyle";

/** Same field shape as `MarkerSettings` (`storeTypes.ts`) by design — kept as its own type since
 *  this lower-level selector module must not depend on the store layer, but the identical field
 *  names let a `VectorByWallsSettings` marker be passed straight through without manual zipping. */
export interface MarkerStyle {
  shape: MarkerShape;
  fillColor: number;
  borderColor: number;
  borderWidth: number;
  /** Marker radius, as a fraction of the tile size (0-1) — same convention as
   *  `VectorByWallsSettings.teleportLineSize`. */
  size: number;
  /** Sharp vs. round corners (GitHub issue #302 follow-up), same convention/rounding as
   *  `TeleportCornerStyle` — only affects the four regular-polygon `MarkerShape`s. */
  cornerStyle: TeleportCornerStyle;
  /** Floor-colored gap drawn around the marker's border (GitHub issue #302 follow-up), same
   *  convention as `VectorByWallsSettings.teleportConnectorGapWidth` — `0` (the default) draws no
   *  gap. `gapColor` is meant to always mirror the caller's own floor color; callers outside
   *  `VectorByWallsRenderer` (which have no floor color of their own to give it) simply leave
   *  `gapWidth` at `0`, so `gapColor`'s value never actually shows. */
  gapWidth: number;
  gapColor: number;
}

/** Converts a marker position and style into the renderer-facing data shared by every maze stage. */
export function buildMarkerData(pos: [number, number], style: MarkerStyle): MarkerData {
  return {
    pos, radius: style.size * TILE_SIZE,
    shape: style.shape, color: style.fillColor, borderColor: style.borderColor, borderWidth: style.borderWidth,
    cornerStyle: style.cornerStyle, gapWidth: style.gapWidth, gapColor: style.gapColor,
  };
}

/** A start/finish marker on a split point (GitHub issue #223) anchors to that node's own hub
 *  point (`buildNodePositions`), not the tile's plain center — `nodeById`'s full value set
 *  stands in for `nodes` (see `buildTeleportEdges`'s doc comment for why this is safe for
 *  unsplit callers). `edges` drives shape detection for a bridge/diagonal split point (GitHub issue
 *  #318) — pass `[]` (default) to always use the generic hub position. `startStyle`/`finishStyle`
 *  default to a plain circle with no border (every caller except `VectorByWallsRenderer`, whose
 *  marker appearance is user-configurable — see GitHub issue #296), so passing them is opt-in. */
export function buildMazeMarkers(
  nodeById: Map<number, NodeDto>,
  start: number | null,
  finish: number | null,
  cfg: TessellationConfig,
  startStyle: MarkerStyle = DEFAULT_MAZE_RENDER_STYLE.startMarker,
  finishStyle: MarkerStyle = DEFAULT_MAZE_RENDER_STYLE.finishMarker,
  edges: EdgeDto[] = [],
): MarkerData[] {
  const markers: MarkerData[] = [];
  const allNodes = Array.from(nodeById.values());
  const directedPairs = edges.filter((e) => e.kind !== "teleport").map((e) => ({ from: e.from, to: e.to }));
  const nodePos = buildNodePositions(allNodes, cfg, directedPairs);
  if (start !== null) {
    const c = nodePos.get(start);
    if (c) {
      markers.push(buildMarkerData([c.x, c.y], startStyle));
    }
  }
  if (finish !== null) {
    const c = nodePos.get(finish);
    if (c) {
      markers.push(buildMarkerData([c.x, c.y], finishStyle));
    }
  }
  return markers;
}
