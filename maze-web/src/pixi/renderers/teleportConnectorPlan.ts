import type { TeleportEdge, TeleportLineStyle } from "./types";
import type { FieldConfig } from "../../fieldConfig";
import { routeCurvedConnectors, routeRadialConnectors, routeStraightConnectors, type RoutedConnector } from "./teleportConnectorRouting";
import type { TeleportConnectorRouter, EndpointMarkerStyle } from "./teleportConnectorRouter";
import { getSeamModel } from "../selectors/seams";
import { cutPolylineAtChain, shortestSeamCrossing } from "../selectors/seamUnfold";
import { displayTransform } from "../tessellationGeometry";
import { applyTransform, invertTransform } from "../geometry/worldTransform";

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
  /** Glued pairs of the floor (GitHub issue #873); when given, a connector between two cells glued
   *  by a seam is routed as two pieces through the seam whenever that is shorter than the direct
   *  connector, as if the field continued beyond the glue. */
  seam?: { cfg: FieldConfig };
}): RoutedConnector[] {
  const { edges, seam } = args;
  const model = seam ? getSeamModel(seam.cfg) : null;
  if (!seam || !model || model.isEmpty) return routeWholeConnectors(args);

  const toDisplay = displayTransform(seam.cfg);
  const toWorld = invertTransform(toDisplay);
  // As if the field continued beyond the seam: a connector whose way through the glue is shorter is
  // routed to its target unfolded into the source side's frame, then cut at the seam.
  const crossings = edges.map(({ from, to }) =>
    from[0] === to[0] && from[1] === to[1] ? null : shortestSeamCrossing(model, applyTransform(toWorld, from), applyTransform(toWorld, to)),
  );
  const unfoldedEdges = edges.map((edge, i) => {
    const crossing = crossings[i];
    return crossing ? { ...edge, to: applyTransform(toDisplay, crossing.unfolded) } : edge;
  });
  const routed = routeWholeConnectors({ ...args, edges: unfoldedEdges });

  return routed.map((connector, i) => {
    const { from, to } = edges[i];
    const crossing = crossings[i];
    if (crossing) {
      const polyline: [number, number][] = [];
      for (let k = 0; k + 1 < connector.points.length; k += 2) polyline.push(applyTransform(toWorld, [connector.points[k], connector.points[k + 1]]));
      const cut = cutPolylineAtChain(crossing.chains, polyline);
      const flat = (points: readonly [number, number][]): number[] => points.flatMap((p) => applyTransform(toDisplay, p));
      if (cut) {
        // The target's piece starts at the same seam point on the far side and follows the routed path
        // mapped back; it ends exactly on the target (the unfolded end maps onto it).
        const after = cut.after.map(crossing.toTarget);
        const piece = flat(after);
        piece.splice(piece.length - 2, 2, to[0], to[1]);
        const first = flat(cut.before);
        first.splice(0, 2, from[0], from[1]);
        return { points: first, partnerPoints: piece };
      }
      // The routed shape never crosses this face: the straight way through the seam.
      const at = applyTransform(toDisplay, crossing.at);
      const partnerAt = applyTransform(toDisplay, crossing.partnerAt);
      return { points: [from[0], from[1], at[0], at[1]], partnerPoints: [partnerAt[0], partnerAt[1], to[0], to[1]] };
    }
    return connector;
  });
}

function routeWholeConnectors(args: Omit<Parameters<typeof routeTeleportConnectors>[0], "seam">): RoutedConnector[] {
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
