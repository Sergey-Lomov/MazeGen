import type { MarkerIndexSettings } from "../../store/imageExportTypes";
import type { MarkerIndexLabel } from "../selectors/mazeSelectors/markerIndex";
import { markerIndexPlateFootprint } from "../selectors/mazeSelectors";
import type { SeamDisk } from "../selectors/seamCopies";
import type { MarkerData, VerticalConnectionMarker, VerticalConnectionStyle } from "../renderers/types";
import { MarkerIndexRenderer, type MarkerIndexRenderData } from "../renderers/MarkerIndexRenderer";
import { VerticalConnectionRenderer, verticalMarkerFootprint, type VerticalConnectionRenderData } from "../renderers/VerticalConnectionRenderer";
import { WaypointsRenderer } from "../renderers/WaypointsRenderer";
import type { SeamCopySource } from "../renderers/SeamCopyRenderer";
import { DEFAULT_MARKER_TEXT_SIZE } from "../renderConstants";
import { NO_MARKER_SCALING, type MarkerScaler } from "../markerScale";

/// The free-standing artwork that can reach past a glued face, as `SeamCopySource`s for `SeamCopyRenderer`
/// (GitHub issue #981, `Specs/topology.md`, "Elements that cross a seam"). Adding a kind is a bound per
/// element and a way to draw a subset of them. The bounds are generous: an element that is listed but does
/// not really cross shows nothing, as the copy is masked to the far side of the face.

/** The circle bounding a marker index plate, gap ring included. */
export function markerIndexDisks(labels: readonly MarkerIndexLabel[], style: MarkerIndexSettings): SeamDisk[] {
  return labels.map((label) => {
    const plate = markerIndexPlateFootprint(label, style);
    const outset = Math.max(0, style.gap) * (label.scale ?? 1) + 1;
    return { x: plate.x + plate.w / 2, y: plate.y + plate.h / 2, r: Math.hypot(plate.w, plate.h) / 2 + outset };
  });
}

/** The circle bounding a vertical-connection marker and, for an elevator, its floor badges. */
export function verticalMarkerDisks(markers: readonly VerticalConnectionMarker[], style: VerticalConnectionStyle, scaler: MarkerScaler = NO_MARKER_SCALING): SeamDisk[] {
  const badges = style.elevatorBadges;
  return markers.map((marker) => {
    const factor = scaler.maxFactor * Math.max(1, marker.scale ?? 1);
    let reach = verticalMarkerFootprint(style, marker);
    const count = marker.targetFloorIndices?.length ?? 0;
    if (badges.enabled && marker.kind === "elevator" && count > 0) {
      const badgeRadius = badges.size / 2 + badges.borderWidth + badges.gapWidth;
      reach += badges.distance + count * (2 * badgeRadius + badges.gap) + badgeRadius;
    }
    return { x: marker.pos[0], y: marker.pos[1], r: reach * factor + 1 };
  });
}

/** The circle bounding a start/finish marker: its corners and ring, or its label if that is wider. */
export function waypointDisks(markers: readonly MarkerData[], scaler: MarkerScaler = NO_MARKER_SCALING): SeamDisk[] {
  return markers.map((marker) => {
    const corner = (marker.shape ?? "circle") === "circle" ? 1 : Math.SQRT2;
    const body = marker.radius * corner + (marker.borderWidth ?? 0) + (marker.gapWidth ?? 0);
    const text = marker.text ? ((marker.textSize ?? DEFAULT_MARKER_TEXT_SIZE) * marker.text.length) / 2 : 0;
    return { x: marker.pos[0], y: marker.pos[1], r: Math.max(body, text) * scaler.maxFactor + 1 };
  });
}

function subset<T>(items: readonly T[], indices: readonly number[]): T[] {
  return indices.map((index) => items[index]);
}

export function markerIndexSource(data: MarkerIndexRenderData | null): SeamCopySource | null {
  if (!data || !data.style.enabled) return null;
  return {
    disks: markerIndexDisks(data.labels, data.style),
    draw: (layers, indices) => {
      const renderer = new MarkerIndexRenderer(layers.indexGap, layers.indexBody);
      renderer.render({ ...data, labels: subset(data.labels, indices) });
      return () => renderer.destroy();
    },
  };
}

export function verticalSource(data: VerticalConnectionRenderData | null): SeamCopySource | null {
  if (!data) return null;
  return {
    disks: verticalMarkerDisks(data.markers, data.style, data.scaler),
    draw: (layers, indices) => {
      const renderer = new VerticalConnectionRenderer(layers.vertical);
      renderer.render({ ...data, markers: subset(data.markers, indices), interactive: false });
      return () => renderer.destroy();
    },
  };
}

export function waypointSource(data: { markers: MarkerData[]; scaler?: MarkerScaler } | null): SeamCopySource | null {
  if (!data) return null;
  return {
    disks: waypointDisks(data.markers, data.scaler),
    draw: (layers, indices) => {
      const renderer = new WaypointsRenderer(layers.markers);
      renderer.render({ ...data, markers: subset(data.markers, indices) });
      return () => renderer.destroy();
    },
  };
}

export interface SeamCopyInputs {
  markerIndex: MarkerIndexRenderData | null;
  vertical: VerticalConnectionRenderData | null;
  waypoints: { markers: MarkerData[]; scaler?: MarkerScaler } | null;
}

/** Every kind of artwork that may cross a seam on this floor, for `SeamCopyRenderer.render`. */
export function buildSeamCopySources({ markerIndex, vertical, waypoints }: SeamCopyInputs): SeamCopySource[] {
  return [markerIndexSource(markerIndex), verticalSource(vertical), waypointSource(waypoints)].filter((source): source is SeamCopySource => source !== null);
}
