import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { FieldConfig } from "../../fieldConfig";
import type { VectorByWallsSettings, VectorByCorridorsSettings } from "../../store/storeTypes";
import type { TeleportEdge, WallEdge } from "../renderers/types";
import type { ExportWarning } from "./exportWarnings";
import {
  buildMazeWalls, buildMazeMarkers, buildCorridorSegments, buildSplitPassages, buildVerticalConnectionMarkers,
  buildTeleportAvoidanceWaypoints, maxSplitNodeCount, selectNodeLevelResolver, selectVerticalPassagePairSet,
  type CorridorSegment,
} from "./mazeSelectors";
import { buildSplitHostKeys } from "./mazeSelectors/markerLayout";
import {
  buildEffectiveSplitNodeColors, buildMarkerStyle, buildOneWayStyle, buildTeleportLineStyle, buildVerticalConnectionStyle,
  layoutExportMarkers,
} from "../imageExport/exportStyleBuilders";
import { TeleportConnectorRouter } from "../renderers/teleportConnectorRouter";
import { routeTeleportConnectors } from "../renderers/teleportConnectorPlan";
import { BOUNDARY_HIGHLIGHT_PADDING, chevronRowStep, oneWayIndicatorSpan } from "../renderers/wallUtils";
import { pointToSegmentDistance } from "../renderers/teleportGeometryUtils";
import { buildMarkerScaler } from "../markerScale";
import { footprintsOfMarkers, footprintsOfTeleports, footprintsOfVertical } from "../markerFootprints";
import { getSharedEdgeSegment } from "../tessellationGeometry";

/** One drawn one-way indicator: its center, a circle bounding what it draws, and the node pair of
 *  the passage it marks (what the warning highlights). */
type OneWayIndicator = { center: [number, number]; radius: number; fromNode: number; toNode: number };

/** Shared by every call: the orthogonal router's cache keeps a settings slider drag from re-routing
 *  an unchanged layout on each warning recompute. */
const sharedRouter = new TeleportConnectorRouter();

export type TeleportOneWayCoverageInput = {
  nodes: NodeDto[];
  edges: EdgeDto[];
  cfg: FieldConfig;
  start: number | null;
  finish: number | null;
  /** Floor-scoped teleport edges, as `computeTeleportWarnings` receives them. */
  teleportEdges: TeleportEdge[];
  unscopedNodes: NodeDto[];
  unscopedEdges: EdgeDto[];
  activeFloorIndex: number;
} & (
  | { mode: "walls"; settings: VectorByWallsSettings }
  | { mode: "corridors"; settings: VectorByCorridorsSettings }
);

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
 *  passage reads as two-way. Routing is rebuilt the way the renderer builds it (same marker layout,
 *  scaler and avoidance waypoints, same `routeTeleportConnectors`), so the warning follows the path
 *  that is actually drawn — including the cases routing can't fix, like both ends on one line.
 *  Flags the covered one-way passages (`nodes` + `edges`), not the teleport. */
export function computeTeleportConnectorCoversOneWayWarning(input: TeleportOneWayCoverageInput): ExportWarning | null {
  const { nodes, edges, cfg, start, finish, teleportEdges, settings } = input;
  if (settings.teleportConnectorStyle === "none" || teleportEdges.length === 0) return null;
  // Built once: both the indicators and the router's avoidance waypoints are derived from them.
  const wallEdges = input.mode === "walls" ? buildMazeWalls(nodes, edges, cfg) : [];
  const corridorSegments = input.mode === "corridors" ? buildCorridorSegments(nodes, edges, cfg) : [];
  const indicators = input.mode === "walls" ? wallIndicators(input, wallEdges) : corridorIndicators(input, corridorSegments);
  if (indicators.length === 0) return null;

  const floorColor = input.mode === "walls" ? input.settings.floorColor : input.settings.color;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const verticalStyle = input.mode === "walls"
    ? buildVerticalConnectionStyle(input.settings, floorColor, input.settings)
    : buildVerticalConnectionStyle(input.settings, floorColor);
  const layout = layoutExportMarkers({
    markers: buildMazeMarkers(
      nodeById, start, finish, cfg,
      buildMarkerStyle(settings.startMarker, floorColor), buildMarkerStyle(settings.finishMarker, floorColor), edges,
    ),
    teleportEdges,
    verticalMarkers: buildVerticalConnectionMarkers(
      nodeById, edges, cfg, selectNodeLevelResolver(input.unscopedNodes), input.activeFloorIndex,
      selectVerticalPassagePairSet(input.unscopedEdges), input.unscopedEdges, settings.replaceTwoFloorElevatorsWithStairs,
    ),
    settings,
    verticalStyle,
    splitHostKeys: buildSplitHostKeys(nodeById, edges, cfg),
  });
  const teleportStyle = buildTeleportLineStyle(settings, floorColor);
  const scaler = buildMarkerScaler(cfg, [
    ...footprintsOfMarkers(layout.markers),
    ...footprintsOfVertical(layout.verticalMarkers, verticalStyle),
    ...footprintsOfTeleports(layout.teleportEdges, teleportStyle),
  ]);

  const specialNodeIds = new Set<number>();
  if (start !== null) specialNodeIds.add(start);
  if (finish !== null) specialNodeIds.add(finish);
  for (const e of edges) {
    if (e.kind === "teleport") { specialNodeIds.add(e.from); specialNodeIds.add(e.to); }
  }
  const splitPassages = maxSplitNodeCount(nodes) > 0
    ? buildSplitPassages(
      nodes, edges, cfg, specialNodeIds, {}, {},
      buildEffectiveSplitNodeColors(settings.splitNodeColors, maxSplitNodeCount(nodes)),
      input.mode === "corridors" ? input.settings.thickness : undefined,
    ).passages
    : [];
  const waypoints = buildTeleportAvoidanceWaypoints({
    markers: layout.markers,
    verticalMarkers: layout.verticalMarkers,
    cfg,
    splitPassages,
    ...(input.mode === "walls" ? { oneWayWallEdges: wallEdges } : { oneWayCorridorSegments: corridorSegments }),
  });
  const routed = routeTeleportConnectors({
    router: sharedRouter,
    edges: layout.teleportEdges,
    style: teleportStyle,
    cfg,
    waypoints,
    avoidFieldExit: settings.teleportAvoidFieldExit,
    fieldCells: nodes.map((n): [number, number] => [n.x, n.y]),
    markerMaxFactor: scaler.maxFactor,
  });

  // The line and the floor-colored gap around it both hide what is below.
  const reach = teleportStyle.connectorWidth / 2 + teleportStyle.connectorGapWidth;
  const covered = new Map<string, OneWayIndicator>();
  layout.teleportEdges.forEach((edge, i) => {
    if (edge.from[0] === edge.to[0] && edge.from[1] === edge.to[1]) return;
    for (const indicator of indicators) {
      if (polylineDistance(routed[i].points, indicator.center) < indicator.radius + reach) {
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
