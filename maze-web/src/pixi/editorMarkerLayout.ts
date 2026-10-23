import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import type { MarkerData, TeleportEdge, VerticalConnectionMarker } from "./renderers/types";
import { DEFAULT_VERTICAL_STYLE, verticalMarkerFootprint } from "./renderers/VerticalConnectionRenderer";
import { DEFAULT_MAZE_RENDER_STYLE } from "./defaultMazeRenderStyle";
import {
  applyMarkerLayout, buildSplitHostKeys, DEFAULT_MARKER_LAYOUT_MODE, DEFAULT_MARKER_SCALE, MARKER_LAYOUT_SPACING,
  type MarkerLayoutResult,
} from "./selectors/mazeSelectors/markerLayout";

/** Marker positioning layer (GitHub issue #735) for the editor canvases (`GenerationRenderer`,
 *  `PostEditRenderer`, `MazeOverlayRenderer`) — they expose no layout settings, so the default look
 *  applies: `DEFAULT_MARKER_LAYOUT_MODE` with `DEFAULT_MARKER_SCALE`, sized from the fixed editor
 *  teleport/vertical styles. */
export function layoutEditorMarkers(args: {
  markers: MarkerData[];
  teleportEdges: TeleportEdge[];
  verticalMarkers?: VerticalConnectionMarker[];
  nodeById: Map<number, NodeDto>;
  edges: EdgeDto[];
  cfg: TessellationConfig;
}): MarkerLayoutResult {
  return layoutEditorMarkersOnHosts({ ...args, splitHostKeys: buildSplitHostKeys(args.nodeById, args.edges, args.cfg) });
}

/** Same layer for canvases with no `NodeDto` graph (the preset editor) — the caller supplies the
 *  split-node host keys (`hostKey` of every split node's position) itself. */
export function layoutEditorMarkersOnHosts(args: {
  markers: MarkerData[];
  teleportEdges: TeleportEdge[];
  verticalMarkers?: VerticalConnectionMarker[];
  splitHostKeys: Set<string>;
}): MarkerLayoutResult {
  const t = DEFAULT_MAZE_RENDER_STYLE.teleport;
  return applyMarkerLayout(
    {
      markers: args.markers,
      teleportEdges: args.teleportEdges,
      verticalMarkers: args.verticalMarkers ?? [],
      teleportRadius: t.size / 2 + t.borderWidth + t.edgeGapWidth,
      verticalRadius: (m) => verticalMarkerFootprint(DEFAULT_VERTICAL_STYLE, m),
      splitHostKeys: args.splitHostKeys,
    },
    { mode: DEFAULT_MARKER_LAYOUT_MODE, spacing: MARKER_LAYOUT_SPACING, scale: DEFAULT_MARKER_SCALE },
  );
}
