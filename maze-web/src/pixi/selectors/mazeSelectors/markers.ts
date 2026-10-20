import type { NodeDto, EdgeDto } from "../../../wasm/types";
import type { FieldConfig } from "../../../fieldConfig";
import type { MarkerData, MarkerShape, CornerStyle } from "../../renderers/types";
import type { LabelFontWeight } from "../../renderers/indexLabel";
import { buildNodePositions } from "../../tessellationGeometry";
import { DEFAULT_MAZE_RENDER_STYLE } from "../../defaultMazeRenderStyle";

/** Same field shape as `MarkerSettings` (`storeTypes.ts`) by design — kept as its own type since
 *  this lower-level selector module must not depend on the store layer, but the identical field
 *  names let a `VectorByWallsSettings` marker be passed straight through without manual zipping. */
export interface MarkerStyle {
  shape: MarkerShape;
  fillColor: number;
  borderColor: number;
  borderWidth: number;
  /** Marker diameter in px (GitHub issue #681 follow-up) — same convention as
   *  `VectorByWallsSettings.teleportLineSize`. */
  size: number;
  /** Marker size adaptation (GitHub issue #819) — see `SizeAdaptationField`. */
  sizeAdaptation: number;
  /** Sharp (`"miter"`) vs. round (`"round"`) corners (GitHub issue #302 follow-up) — only affects
   *  the four regular-polygon `MarkerShape`s. */
  cornerStyle: CornerStyle;
  /** Floor-colored gap drawn around the marker's border (GitHub issue #302 follow-up), same
   *  convention as `VectorByWallsSettings.teleportConnectorGapWidth` — `0` (the default) draws no
   *  gap. `gapColor` is meant to always mirror the caller's own floor color; callers outside
   *  `VectorByWallsRenderer` (which have no floor color of their own to give it) simply leave
   *  `gapWidth` at `0`, so `gapColor`'s value never actually shows. */
  gapWidth: number;
  gapColor: number;
  /** Custom one-text badge label (GitHub issue #697) — omitted/empty draws no label.
   *  Optional since only `startMarker`/`finishMarker` offer this in the UI so far — every other
   *  `MarkerStyle` caller (vertical connection markers) simply never sets it. */
  text?: string;
  /** Whether the text badge actually draws (GitHub issue #697 follow-up "Show text"
   *  toggle) — lets the stored `text` survive being hidden rather than being cleared.
   *  Optional for the same reason as `text`; `undefined`/`true` draws the badge (matches
   *  pre-toggle behavior), `false` suppresses it. */
  textEnabled?: boolean;
  /** Text badge font weight (GitHub issue #697 follow-up) — optional for the same reason as
   *  `text`. Defaults to `"bold"` when unset. */
  textFontWeight?: LabelFontWeight;
  /** Text badge font size in px — optional for the same reason as `text`. Defaults to
   *  `DEFAULT_MARKER_TEXT_SIZE` when unset. */
  textSize?: number;
  /** Text badge color (GitHub issue #697 second follow-up) — optional for the same
   *  reason as `text`. Defaults to `gapColor` (the floor-colored knockout look) when unset. */
  textColor?: number;
}

/** Converts a marker position and style into the renderer-facing data shared by every maze stage. */
export function buildMarkerData(pos: [number, number], style: MarkerStyle): MarkerData {
  return {
    pos, radius: style.size / 2, sizeAdaptation: style.sizeAdaptation,
    shape: style.shape, color: style.fillColor, borderColor: style.borderColor, borderWidth: style.borderWidth,
    cornerStyle: style.cornerStyle, gapWidth: style.gapWidth, gapColor: style.gapColor,
    text: style.textEnabled === false ? undefined : style.text, textColor: style.textColor ?? style.gapColor,
    textFontWeight: style.textFontWeight, textSize: style.textSize,
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
  cfg: FieldConfig,
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
