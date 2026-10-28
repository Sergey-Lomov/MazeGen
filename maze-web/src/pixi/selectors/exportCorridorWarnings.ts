import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { FieldConfig } from "../../fieldConfig";
import type { VectorByCorridorsSettings } from "../../store/storeTypes";
import { buildCorridorSegments, getSplitAwareNodePosition } from "./mazeSelectors";
import { pointToSegmentDistance } from "../renderers/teleportGeometryUtils";
import { pointInPolygon } from "../tessellationGeometry";
import { buildCorridorContourInstances, contourToPolyline } from "../imageExport/vectorByCorridorsContour";
import type { ExportWarning } from "./exportWarnings";

export function corridorCellId(point: { x: number; y: number }): string {
  return `${Math.round(point.x * 1e6)},${Math.round(point.y * 1e6)}`;
}

/** Distance from `point` to a closed rendered contour. A point inside the filled contour has no
 * gap, otherwise the nearest sampled contour edge determines the gap. */
export function pointToContourDistance(point: { x: number; y: number }, contour: { x: number; y: number }[]): number {
  if (contour.length < 2) return Infinity;
  if (pointInPolygon(point, contour)) return 0;
  let closest = Infinity;
  for (let index = 0; index < contour.length; index++) {
    const from = contour[index];
    const to = contour[(index + 1) % contour.length];
    closest = Math.min(closest, pointToSegmentDistance([point.x, point.y], [from.x, from.y], [to.x, to.y]));
  }
  return closest;
}

/** A start/finish marker's corridor-colored widen patch reaches a different corridor. The check
 * deliberately excludes tiles incident to the marker node: those are the corridor(s) the patch
 * exists to widen. Contour mode measures against the same filled tile paths the renderer draws;
 * line modes measure the same centreline-plus-half-stroke geometry their renderer uses. */
export function computeMarkerExtensionHitsCorridorWarning(
  corridorSegments: ReturnType<typeof buildCorridorSegments>,
  corridorFaceLimit: number,
  nodeById: Map<number, NodeDto>,
  cfg: FieldConfig,
  edges: EdgeDto[],
  settings: VectorByCorridorsSettings,
  start: number | null,
  finish: number | null,
): ExportWarning | null {
  if (settings.markerWidenPadding <= 0) return null;

  const markers = [
    { nodeId: start, style: settings.startMarker },
    { nodeId: finish, style: settings.finishMarker },
  ];
  const flaggedNodes = new Set<number>();

  const usesContourTiles = settings.join === "round" && settings.renderStyle === "contour";
  // The renderer clamps to the shortest face of the whole maze; a local candidate subset must match.
  const contourThickness = usesContourTiles ? Math.min(settings.thickness, corridorFaceLimit) : 0;

  for (const marker of markers) {
    if (marker.nodeId === null) continue;
    const pos = getSplitAwareNodePosition(Array.from(nodeById.values()), marker.nodeId, cfg, edges);
    if (!pos) continue;
    const patchRadius = Math.max(
      marker.style.size / 2 + marker.style.borderWidth + marker.style.gapWidth + settings.markerWidenPadding,
      settings.thickness / 2,
    );
    const ownTileIds = new Set<string>();
    for (const segment of corridorSegments) {
      if (segment.fromNode !== marker.nodeId && segment.toNode !== marker.nodeId) continue;
      ownTileIds.add(corridorCellId(segment.v0));
      ownTileIds.add(corridorCellId(segment.v1));
    }

    // Cheap broad phase: no contour can reach the patch when its source centreline is farther than
    // the patch plus the widest possible half-stroke. It prevents rebuilding every tile while a
    // settings slider changes for the normal case where no nearby foreign corridor exists.
    const candidateTileIds = new Set<string>();
    for (const segment of corridorSegments) {
      if (segment.fromNode === marker.nodeId || segment.toNode === marker.nodeId) continue;
      const distance = pointToSegmentDistance(
        [pos.x, pos.y], [segment.v0.x, segment.v0.y], [segment.v1.x, segment.v1.y],
      );
      if (distance > patchRadius + settings.thickness / 2) continue;
      candidateTileIds.add(corridorCellId(segment.v0));
      candidateTileIds.add(corridorCellId(segment.v1));
    }
    if (candidateTileIds.size === 0) continue;

    if (usesContourTiles) {
      // A tile's contour depends only on its own ports. Include every segment touching a candidate
      // tile so those ports remain identical to the renderer's complete corridor network.
      const localSegments = corridorSegments.filter((segment) =>
        candidateTileIds.has(corridorCellId(segment.v0)) || candidateTileIds.has(corridorCellId(segment.v1)),
      );
      const contourTiles = buildCorridorContourInstances(localSegments, contourThickness, settings.junctionRadius);
      for (const tile of contourTiles) {
        if (ownTileIds.has(String(tile.cellId)) || !candidateTileIds.has(String(tile.cellId))) continue;
        const contour = contourToPolyline(tile.shape, 1).map((point) => ({
          x: point.x + tile.offset.x,
          y: point.y + tile.offset.y,
        }));
        if (pointToContourDistance(pos, contour) <= patchRadius) flaggedNodes.add(marker.nodeId);
      }
    } else {
      for (const segment of corridorSegments) {
        if (segment.fromNode === marker.nodeId || segment.toNode === marker.nodeId) continue;
        const distance = pointToSegmentDistance(
          [pos.x, pos.y], [segment.v0.x, segment.v0.y], [segment.v1.x, segment.v1.y],
        );
        if (distance <= patchRadius + settings.thickness / 2) flaggedNodes.add(marker.nodeId);
      }
    }
  }

  return flaggedNodes.size > 0
    ? { id: "marker_extension_hits_corridor", key: "marker_extension_hits_corridor", nodes: Array.from(flaggedNodes), edges: [] }
    : null;
}
