import type { TeleportEdge, TeleportLineStyle } from "./types";
import type { FieldConfig } from "../../fieldConfig";
import { routeCurvedConnectors, routeRadialConnectors, routeStraightConnectors, type RoutedConnector } from "./teleportConnectorRouting";
import type { TeleportConnectorRouter, EndpointMarkerStyle } from "./teleportConnectorRouter";

/** Routes every connector of `edges` (one `RoutedConnector` per edge, same order) for `style`'s
 *  `connectorStyle` — pure routing, no drawing. Shared by `TeleportRenderer` (drawing) and the
 *  export warnings (`teleport_connector_covers_one_way`), so a warning is judged against exactly the
 *  path the renderer draws. `markerMaxFactor` is the marker scaler's `maxFactor` (GitHub issue #819).
 *  `router` owns the orthogonal-routing result cache. */
export function routeTeleportConnectors(args: {
  router: TeleportConnectorRouter;
  edges: TeleportEdge[];
  style: TeleportLineStyle;
  cfg: FieldConfig | undefined;
  waypoints: [number, number][];
  avoidFieldExit: boolean;
  fieldCells: [number, number][];
  markerMaxFactor: number;
}): RoutedConnector[] {
  const { router, edges, style, cfg, waypoints, avoidFieldExit, fieldCells, markerMaxFactor } = args;
  // Includes the gap once (not doubled) — two adjacent connectors' gaps are allowed to
  // overlap a bit, only their core lines need to stay visually distinct.
  const gap = (style.connectorWidth + style.connectorGapWidth) * 1.5;
  // `edgeGapWidth` (GitHub issue #302) folded into `markerBorderWidth` here — the marker's real
  // visual footprint that `endpointCollisionRadius`/corridor-offset clamping must stay clear of is
  // `size + borderWidth + edgeGapWidth` (see `drawGroupGaps`'s own `r` formula), not
  // just `size + borderWidth` — omitting the gap ring here would let another connector's
  // routed path visually cut through it even though it correctly avoids the marker/border proper.
  const endpointRadius = (style.size / 2) * markerMaxFactor;
  const endpointStyle: EndpointMarkerStyle = {
    markerRadius: endpointRadius,
    markerBorderWidth: style.borderWidth + style.edgeGapWidth,
    connectorGapWidth: style.connectorGapWidth,
    connectorWidth: style.connectorWidth,
  };
  const markerAvoidanceRadius =
    (endpointStyle.markerRadius + endpointStyle.markerBorderWidth + endpointStyle.connectorGapWidth + endpointStyle.connectorWidth / 2) * 1.25;
  if (style.connectorStyle === "curved") {
    return routeCurvedConnectors(edges, style.curveDirection ?? "inward", style.curveStrength ?? 0.25, cfg?.tessellation.kind === "radial", markerAvoidanceRadius, waypoints);
  }
  if (cfg?.tessellation.kind === "radial" && style.connectorStyle === "orthogonal") {
    return routeRadialConnectors(edges, markerAvoidanceRadius, waypoints);
  }
  if (style.connectorStyle === "orthogonal") {
    return router.route(
      edges, gap, endpointRadius + style.borderWidth + style.edgeGapWidth, cfg, endpointStyle, waypoints, avoidFieldExit, fieldCells,
    );
  }
  return routeStraightConnectors(edges);
}
