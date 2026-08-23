import type { NodeDto, EdgeDto } from "../../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../../fieldConfig";
import type { MarkerData, MarkerShape, TeleportCornerStyle } from "../../renderers/types";
import { buildNodePositions } from "../../tessellationGeometry";
import { TILE_SIZE } from "../../constants";
import { canvas } from "../../colorTokens";

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

/** Matches "Vector by walls"' own export-panel default for `startMarker`/`finishMarker` (GitHub
 *  issue #347 follow-up) — those follow the "Shared style" (#322) `markerSize`/`markerBorderWidth`/
 *  `gapWidth`/`cornerStyle` defaults (0.16/3/3/round) rather than this module's own
 *  once-separate `DEFAULT_MARKER_SIZE`, so every marker-drawing feature (Generation, post-edit,
 *  overlay, export) renders the same start/finish look out of the box. */
const DEFAULT_START_STYLE: MarkerStyle = { shape: "circle", fillColor: canvas.node.start, borderColor: canvas.node.start, borderWidth: 3, size: 0.16, cornerStyle: "round", gapWidth: 3, gapColor: canvas.floor.default };
const DEFAULT_FINISH_STYLE: MarkerStyle = { shape: "circle", fillColor: canvas.node.finish, borderColor: canvas.node.finish, borderWidth: 3, size: 0.16, cornerStyle: "round", gapWidth: 3, gapColor: canvas.floor.default };

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
  startStyle: MarkerStyle = DEFAULT_START_STYLE,
  finishStyle: MarkerStyle = DEFAULT_FINISH_STYLE,
  edges: EdgeDto[] = [],
): MarkerData[] {
  const markers: MarkerData[] = [];
  const allNodes = Array.from(nodeById.values());
  const directedPairs = edges.filter((e) => e.kind !== "teleport").map((e) => ({ from: e.from, to: e.to }));
  const nodePos = buildNodePositions(allNodes, cfg, directedPairs);
  if (start !== null) {
    const c = nodePos.get(start);
    if (c) {
      markers.push({
        pos: [c.x, c.y], radius: startStyle.size * TILE_SIZE,
        shape: startStyle.shape, color: startStyle.fillColor, borderColor: startStyle.borderColor, borderWidth: startStyle.borderWidth,
        cornerStyle: startStyle.cornerStyle, gapWidth: startStyle.gapWidth, gapColor: startStyle.gapColor,
      });
    }
  }
  if (finish !== null) {
    const c = nodePos.get(finish);
    if (c) {
      markers.push({
        pos: [c.x, c.y], radius: finishStyle.size * TILE_SIZE,
        shape: finishStyle.shape, color: finishStyle.fillColor, borderColor: finishStyle.borderColor, borderWidth: finishStyle.borderWidth,
        cornerStyle: finishStyle.cornerStyle, gapWidth: finishStyle.gapWidth, gapColor: finishStyle.gapColor,
      });
    }
  }
  return markers;
}
