import type { EdgeMarkerStyle, FloorEdgeMarkerStyle } from "../../store/imageExportTypes";
import type { MazeState } from "../../store/storeTypes";
import { hasLowContrast } from "../colorContrast";
import { edgeMarkerLook, edgeMarkerLooksAlike, markerPoint, selectExportEdgeMarkers, type EdgeMarker } from "../imageExport/edgeMarkerExport";
import type { ExportWarning } from "./exportWarnings";
import { withResolvedEdgeMarkers } from "../../store/edgeMarkerLinks";
import type { ParamLink } from "../../store/parameterLinks";

/// Edge marker warnings (GitHub issue #902, `Specs/export-warnings.md`, "Edge alignment markers"): markers are matched by
/// colour and shape, so two markers of different keys must not look alike (same shape, close colours), and a marker must stand
/// out from the background. Both highlight the offending markers as `polygons` (a rounded square around each).

type EdgeMarkerWarningState = Pick<MazeState, "activeFloorId" | "activeFieldConfig" | "floorTopology" | "floorCreases" | "pngExportSettings" | "nodes" | "floors">;

/// How far the highlight frame reaches past the marker's radius, in display units.
const FRAME_MARGIN = 4;
/// Corner radius of the highlight frame, in display units.
const FRAME_CORNER = 4;
/// Segments per rounded corner.
const CORNER_SEGMENTS = 4;

/// A rounded square around the marker, half its side being the marker's radius plus `FRAME_MARGIN` (the shape is not followed).
/// A half marker gets the half of it on its face's side of the edge, square along the edge and rounded on the far side.
export function frameAround(marker: EdgeMarker, size: number): [number, number][] {
  const half = size / 2 + FRAME_MARGIN;
  const corner = Math.min(FRAME_CORNER, half);
  const local: [number, number][] = [];
  // A corner is an arc of a quarter turn around (`cx`, `cy`) from angle `start`.
  const arc = (cx: number, cy: number, start: number): void => {
    for (let i = 0; i <= CORNER_SEGMENTS; i++) {
      const angle = start + (Math.PI / 2) * (i / CORNER_SEGMENTS);
      local.push([cx + corner * Math.cos(angle), cy + corner * Math.sin(angle)]);
    }
  };
  if (marker.inward === null) {
    arc(half - corner, -half + corner, -Math.PI / 2);
    arc(half - corner, half - corner, 0);
    arc(-half + corner, half - corner, Math.PI / 2);
    arc(-half + corner, -half + corner, Math.PI);
  } else {
    local.push([-half, 0], [half, 0]);
    arc(half - corner, half - corner, 0);
    arc(-half + corner, half - corner, Math.PI / 2);
  }
  // `markerPoint` flips local y on side B, while the drawn half is always the one toward `inward`: pre-flip so they agree.
  return local.map(([x, y]) => markerPoint(marker, x, y * marker.side));
}

function warningOf(id: ExportWarning["id"], markers: readonly EdgeMarker[], size: number): ExportWarning {
  return { id, key: id, nodes: [], edges: [], polygons: markers.map((marker) => frameAround(marker, size)) };
}

/// The warnings of the active floor's markers; none while they are hidden. `style` carries the links-resolved overrides.
export function computeEdgeMarkerWarnings(state: EdgeMarkerWarningState, style: FloorEdgeMarkerStyle, background: number): ExportWarning[] {
  const markers = selectExportEdgeMarkers(state, style);
  if (markers.length === 0) return [];
  const warnings: ExportWarning[] = [];

  const alike = new Set<string>();
  const firstOfKey = new Map<string, EdgeMarker>();
  for (const marker of markers) if (!firstOfKey.has(marker.key)) firstOfKey.set(marker.key, marker);
  const keys = [...firstOfKey.keys()];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (!edgeMarkerLooksAlike(edgeMarkerLook(style, keys[i]), edgeMarkerLook(style, keys[j]))) continue;
      alike.add(keys[i]);
      alike.add(keys[j]);
    }
  }
  if (alike.size > 0) warnings.push(warningOf("edge_marker_colors_similar", markers.filter((marker) => alike.has(marker.key)), style.size));

  const faint = markers.filter((marker) => hasLowContrast(edgeMarkerLook(style, marker.key).color, background));
  if (faint.length > 0) warnings.push(warningOf("edge_marker_low_contrast_background", faint, style.size));
  return warnings;
}

/// `computeEdgeMarkerWarnings` for a render mode's settings: the marker look is resolved through the mode's parameter links.
export function computeEdgeMarkerWarningsOf<P extends string>(
  state: EdgeMarkerWarningState,
  settings: { edgeMarkers: EdgeMarkerStyle; links: ParamLink<P>[]; background: number },
): ExportWarning[] {
  return computeEdgeMarkerWarnings(state, withResolvedEdgeMarkers(settings.edgeMarkers, settings.links as ParamLink<string>[], state.activeFloorId), settings.background);
}
