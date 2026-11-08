import type { ExportWarning } from "./exportWarnings";
import type { WallEdge } from "../renderers/types";
import type { CorridorSegment } from "./mazeSelectors";
import { BOUNDARY_HIGHLIGHT_PADDING, chevronRowStep, oneWayIndicatorSpan } from "../renderers/wallUtils";
import { buildOneWayStyle } from "../imageExport/exportStyleBuilders";
import { pointToSegmentDistance } from "../renderers/teleportGeometryUtils";
import { getSharedEdgeSegment } from "../tessellationGeometry";
import { buildTeleportConnectorContext, type TeleportConnectorContext, type TeleportConnectorInput } from "./teleportConnectorContext";

/** One drawn one-way indicator: its center, a circle bounding what it draws, and the node pair of
 *  the passage it marks (what the warning highlights). */
type OneWayIndicator = { center: [number, number]; radius: number; fromNode: number; toNode: number };

export type TeleportOneWayCoverageInput = TeleportConnectorInput;

/** Wall-mode indicators (triangle/chevron/arrow on the wall between two cells). The footprint is the
 *  indicator's own extent: `oneWayIndicatorSpan` minus the highlight padding it adds on both sides. */
function wallIndicators(input: Extract<TeleportOneWayCoverageInput, { mode: "walls" }>, wallEdges: WallEdge[]): OneWayIndicator[] {
  const { nodes, edges, cfg, settings } = input;
  const radius = Math.max(0, oneWayIndicatorSpan(buildOneWayStyle(settings)) / 2 - BOUNDARY_HIGHLIGHT_PADDING);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const pairByCells = new Map<string, [number, number]>();
  for (const e of edges) {
    if (e.kind === "teleport") continue;
    const from = nodeById.get(e.from);
    const to = nodeById.get(e.to);
    if (!from || !to) continue;
    pairByCells.set(`${from.x},${from.y}|${to.x},${to.y}`, [e.from, e.to]);
  }
  const result: OneWayIndicator[] = [];
  for (const wall of wallEdges) {
    if (!wall.oneWayDir) continue;
    const seg = getSharedEdgeSegment(wall.a, wall.b, cfg);
    if (!seg) continue;
    const pair = pairByCells.get(`${wall.a[0]},${wall.a[1]}|${wall.b[0]},${wall.b[1]}`)
      ?? pairByCells.get(`${wall.b[0]},${wall.b[1]}|${wall.a[0]},${wall.a[1]}`);
    if (!pair) continue;
    result.push({ center: [seg.contact.x, seg.contact.y], radius, fromNode: pair[0], toNode: pair[1] });
  }
  return result;
}

/** Corridor-mode indicators (the chevron row centered on a one-way segment), bounded by a circle
 *  covering the row's length along the corridor and its width across it — mirrors the geometry
 *  `one_way_arrows_overflow_corridor` measures. */
function corridorIndicators(input: Extract<TeleportOneWayCoverageInput, { mode: "corridors" }>, segments: CorridorSegment[]): OneWayIndicator[] {
  const { settings } = input;
  const fullWidth = settings.oneWayWidth * settings.thickness;
  const lengthPx = settings.oneWayLength * fullWidth;
  const rowLength = (settings.oneWayCount - 1) * chevronRowStep(lengthPx, settings.oneWayGap, settings.oneWayThickness)
    + lengthPx + settings.oneWayThickness;
  const radius = Math.max(rowLength, fullWidth) / 2;
  return segments
    .filter((seg) => seg.oneWayDir)
    .map((seg) => ({
      center: [(seg.v0.x + seg.v1.x) / 2, (seg.v0.y + seg.v1.y) / 2] as [number, number],
      radius,
      fromNode: seg.fromNode,
      toNode: seg.toNode,
    }));
}

function polylineDistance(points: number[], center: [number, number]): number {
  let closest = Infinity;
  for (let i = 0; i + 3 < points.length; i += 2) {
    closest = Math.min(closest, pointToSegmentDistance(center, [points[i], points[i + 1]], [points[i + 2], points[i + 3]]));
  }
  return closest;
}

/** `teleport_connector_covers_one_way`: a drawn teleport connector (its line plus the floor-colored
 *  gap around it) passes over a one-way indicator, which draws below the teleport layer, so the
 *  passage reads as two-way. Routing is rebuilt the way the renderer builds it (`buildTeleportConnectorContext`:
 *  same marker layout, scaler, avoidance waypoints, manual paths and `routeTeleportConnectors`), so the warning
 *  follows the path that is actually drawn — including the cases routing can't fix, like both ends on one
 *  line — and goes away once the user routes the connector around the indicator by hand.
 *  Flags the covered one-way passages (`nodes` + `edges`), not the teleport. */
export function computeTeleportConnectorCoversOneWayWarning(input: TeleportConnectorInput, context?: TeleportConnectorContext): ExportWarning | null {
  const { teleportEdges, settings } = input;
  if (settings.teleportConnectorStyle === "none" || teleportEdges.length === 0) return null;
  const ctx = context ?? buildTeleportConnectorContext(input);
  const indicators = input.mode === "walls" ? wallIndicators(input, ctx.wallEdges) : corridorIndicators(input, ctx.corridorSegments);
  if (indicators.length === 0) return null;
  const { teleportStyle, layout, routed } = ctx;

  // The line and the floor-colored gap around it both hide what is below.
  const reach = teleportStyle.connectorWidth / 2 + teleportStyle.connectorGapWidth;
  const covered = new Map<string, OneWayIndicator>();
  layout.teleportEdges.forEach((edge, i) => {
    if (edge.from[0] === edge.to[0] && edge.from[1] === edge.to[1]) return;
    for (const indicator of indicators) {
      const { points, partnerPoints } = routed[i];
      if (polylineDistance(points, indicator.center) < indicator.radius + reach || (partnerPoints && polylineDistance(partnerPoints, indicator.center) < indicator.radius + reach)) {
        covered.set(`${indicator.fromNode}:${indicator.toNode}`, indicator);
      }
    }
  });
  if (covered.size === 0) return null;

  const flagged = Array.from(covered.values());
  return {
    id: "teleport_connector_covers_one_way",
    key: "teleport_connector_covers_one_way",
    nodes: Array.from(new Set(flagged.flatMap((i) => [i.fromNode, i.toNode]))),
    edges: flagged.map((i): [number, number] => [i.fromNode, i.toNode]),
  };
}
