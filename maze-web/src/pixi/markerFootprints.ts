import type { MarkerData, TeleportEdge, TeleportLineStyle, VerticalConnectionMarker, VerticalConnectionStyle } from "./renderers/types";
import type { MarkerFootprint } from "./markerScale";
import { coordKey, computeFloorBadges } from "./renderers/teleportGeometry";

/** Adapters from each marker kind's render data to the shared `MarkerFootprint` the marker scaler
 *  (`markerScale.ts`) fits into cells — the one place that knows how a kind's size/border/gap map
 *  to a footprint. */

export function footprintsOfMarkers(markers: readonly MarkerData[]): MarkerFootprint[] {
  return markers.map((m) => ({
    pos: m.pos,
    shape: m.shape ?? "circle",
    radius: m.radius,
    outset: (m.borderWidth ?? 0) + (m.gapWidth ?? 0),
    adaptation: m.sizeAdaptation ?? 0,
  }));
}

export function footprintsOfVertical(markers: readonly VerticalConnectionMarker[], style: VerticalConnectionStyle): MarkerFootprint[] {
  return markers.map((marker) => {
    if (style.style === "decorative") {
      const line = marker.kind === "elevator" ? style.decorativeElevator : marker.filled ? style.decorativeStairsTwoWay : style.decorativeStairsOneWay;
      return { pos: marker.pos, shape: "circle", radius: line.size / 2, outset: line.lineWidth / 2, outsetScales: true, adaptation: line.sizeAdaptation };
    }
    const settings = marker.kind === "elevator" ? style.elevatorMarker : marker.filled ? style.twoWayPassageMarker : style.oneWayPassageMarker;
    return { pos: marker.pos, shape: settings.shape, radius: settings.size / 2, outset: (settings.borderWidth ?? 0) + (settings.gapWidth ?? 0), outsetScales: true, adaptation: settings.sizeAdaptation };
  });
}

export function footprintsOfTeleports(edges: readonly TeleportEdge[], style: TeleportLineStyle): MarkerFootprint[] {
  const badges = computeFloorBadges([...edges]);
  const seen = new Set<string>();
  const footprints: MarkerFootprint[] = [];
  for (const edge of edges) {
    for (const pos of [edge.from, edge.to]) {
      const key = coordKey(pos[0], pos[1]);
      if (seen.has(key)) continue;
      seen.add(key);
      footprints.push(badges.has(key)
        ? { pos, shape: style.floorBadge.shape, radius: style.floorBadge.size / 2, outset: style.floorBadge.borderWidth + style.floorBadge.gapWidth, adaptation: style.floorBadge.sizeAdaptation }
        : { pos, shape: style.shape, radius: style.size / 2, outset: style.borderWidth + style.edgeGapWidth, adaptation: style.sizeAdaptation });
    }
  }
  return footprints;
}
