import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { FieldConfig } from "../../fieldConfig";
import type { VectorByWallsSettings, VectorByCorridorsSettings } from "../../store/storeTypes";
import type { TeleportEdge, TeleportLineStyle, VerticalConnectionStyle, WallEdge } from "../renderers/types";
import {
  buildMazeWalls, buildMazeMarkers, buildCorridorSegments, buildSplitPassages, buildVerticalConnectionMarkers,
  buildTeleportAvoidanceWaypoints, maxSplitNodeCount, selectNodeLevelResolver, selectVerticalPassagePairSet,
  type CorridorSegment,
} from "./mazeSelectors";
import { buildSplitHostKeys } from "./mazeSelectors/markerLayout";
import {
  buildEffectiveSplitNodeColors, buildMarkerStyle, buildTeleportLineStyle, buildVerticalConnectionStyle, layoutExportMarkers,
} from "../imageExport/exportStyleBuilders";
import { TeleportConnectorRouter } from "../renderers/teleportConnectorRouter";
import { routeTeleportConnectors } from "../renderers/teleportConnectorPlan";
import type { RoutedConnector } from "../renderers/teleportConnectorRouting";
import { buildMarkerScaler, type MarkerFootprint, type MarkerScaler } from "../markerScale";
import { footprintsOfMarkers, footprintsOfTeleports, footprintsOfVertical } from "../markerFootprints";

/** Shared by every call: the orthogonal router's cache keeps a settings slider drag from re-routing
 *  an unchanged layout on each warning recompute. */
const sharedRouter = new TeleportConnectorRouter();

export type TeleportConnectorInput = {
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

/** The connectors of one floor exactly as the mode renderer lays out and routes them: marker layout,
 *  marker scaler, avoidance waypoints and the routed (or manually authored) paths, one `RoutedConnector`
 *  per `layout.teleportEdges` entry. Shared by every connector warning, so each judges the path that is drawn. */
export type TeleportConnectorContext = {
  teleportStyle: TeleportLineStyle;
  verticalStyle: VerticalConnectionStyle;
  layout: ReturnType<typeof layoutExportMarkers>;
  scaler: MarkerScaler;
  /** Every marker footprint of the floor (start/finish, vertical passages, teleport endpoints and badges). */
  footprints: MarkerFootprint[];
  routed: RoutedConnector[];
  wallEdges: WallEdge[];
  corridorSegments: CorridorSegment[];
};

export function buildTeleportConnectorContext(input: TeleportConnectorInput): TeleportConnectorContext {
  const { nodes, edges, cfg, start, finish, settings } = input;
  // Built once: the one-way indicators and the router's avoidance waypoints are both derived from them.
  const wallEdges = input.mode === "walls" ? buildMazeWalls(nodes, edges, cfg) : [];
  const corridorSegments = input.mode === "corridors" ? buildCorridorSegments(nodes, edges, cfg) : [];

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
    teleportEdges: input.teleportEdges,
    verticalMarkers: buildVerticalConnectionMarkers(
      nodeById, edges, cfg, selectNodeLevelResolver(input.unscopedNodes), input.activeFloorIndex,
      selectVerticalPassagePairSet(input.unscopedEdges), input.unscopedEdges, settings.replaceTwoFloorElevatorsWithStairs,
    ),
    settings,
    verticalStyle,
    splitHostKeys: buildSplitHostKeys(nodeById, edges, cfg),
  });
  const teleportStyle = buildTeleportLineStyle(settings, floorColor);
  const footprints = [
    ...footprintsOfMarkers(layout.markers),
    ...footprintsOfVertical(layout.verticalMarkers, verticalStyle),
    ...footprintsOfTeleports(layout.teleportEdges, teleportStyle),
  ];
  const scaler = buildMarkerScaler(cfg, footprints);

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
    manualPaths: settings.manualTeleportConnectorPaths,
    seam: settings.teleportThroughSeams !== false ? { cfg } : undefined,
  });
  return { teleportStyle, verticalStyle, layout, scaler, footprints, routed, wallEdges, corridorSegments };
}
