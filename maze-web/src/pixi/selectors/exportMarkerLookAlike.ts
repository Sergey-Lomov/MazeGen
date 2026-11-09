import type { MarkerShape, TeleportEdge, VerticalConnectionStyle, VerticalMarkerStyle } from "../renderers/types";
import type { TeleportSettingsFields } from "../../store/storeTypes";
import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { FieldConfig } from "../../fieldConfig";
import { hasLowContrast } from "../colorContrast";
import { buildVerticalConnectionStyle } from "../imageExport/exportStyleBuilders";
import { withLazyResolvedGroupOverrides } from "../../store/teleportGroupLinks";
import { buildVerticalConnectionMarkers, selectNodeLevelResolver, selectVerticalPassagePairSet, buildTeleportEdges, selectFloorScopedMaze } from "./mazeSelectors";
import type { AnySettings } from "./exportWarningGroups";
import { buildTeleportGroups, teleportEdgeKey, coordKey } from "./teleportGroups";
import { buildPointFillStates } from "./exportTeleportWarnings";
import type { ExportWarning } from "./exportWarnings";

/** Kinds of markers `markers_look_alike` (GitHub issue #959) compares; the names a warning lists the alike pairs by. */
export type MarkerLookKind = "edge_marker" | "start" | "finish" | "teleport" | "two_way_passage" | "one_way_passage" | "elevator";

export const MARKER_KIND_ORDER: readonly MarkerLookKind[] = ["edge_marker", "start", "finish", "teleport", "two_way_passage", "one_way_passage", "elevator"];

/** Everything about a marker that the reader sees: fill, border, shape, size and the inner elements (caption, direction arrow). */
export interface MarkerLook {
  kind: MarkerLookKind;
  shape: MarkerShape;
  fill: number;
  /** `null` when the marker has no border. */
  border: number | null;
  /** Border width in px; the border is drawn outside the marker's `size`. 0 without a border. */
  borderWidth: number;
  /** Marker diameter in px as configured (without the border), and its per-cell size adaptation (GitHub issue #819): markers of other sizes read as other markers. */
  size: number;
  sizeAdaptation: number;
  /** Caption, arrow pattern, ...; compared for equality. Colors inside are part of the string. */
  inner: string;
  nodes: number[];
}

interface WaypointStyle {
  shape: MarkerShape;
  fillColor: number;
  borderColor: number;
  borderWidth: number;
  size: number;
  sizeAdaptation: number;
  text?: string;
  textEnabled?: boolean;
  textColor?: number;
}

export interface VerticalMarkerEntry {
  kind: "vertical_passage" | "elevator";
  filled: boolean;
  fromNode: number;
}

function waypointLook(kind: "start" | "finish", style: WaypointStyle, node: number): MarkerLook {
  const caption = style.textEnabled !== false ? (style.text ?? "").trim() : "";
  return {
    kind, shape: style.shape, fill: style.fillColor, border: style.borderWidth > 0 ? style.borderColor : null, borderWidth: Math.max(0, style.borderWidth),
    size: style.size, sizeAdaptation: style.sizeAdaptation, inner: caption ? `text:${caption}:${style.textColor ?? ""}` : "", nodes: [node],
  };
}

function verticalLook(kind: MarkerLookKind, marker: VerticalMarkerStyle, arrow: string, nodes: number[]): MarkerLook {
  return {
    kind, shape: marker.shape, fill: marker.fillColor, border: marker.borderWidth > 0 ? marker.borderColor : null, borderWidth: Math.max(0, marker.borderWidth),
    size: marker.size, sizeAdaptation: marker.sizeAdaptation, inner: arrow, nodes,
  };
}

function sizeOf(marker: { size: number; sizeAdaptation: number }): Pick<MarkerLook, "size" | "sizeAdaptation"> {
  return { size: marker.size, sizeAdaptation: marker.sizeAdaptation };
}

/** The looks of the teleport markers: per group (with its overrides) and per kind of end, because the two ends of a one-way teleport
 *  differ: the entry draws filled, the exit-only end is an outline (floor-colored fill), which has nothing to show without a border.
 *  Each look carries only the nodes of the ends that draw it. Cross-floor badge ends are not markers of this kind and are skipped. */
function teleportLooks(
  teleportEdges: TeleportEdge[],
  settings: Pick<TeleportSettingsFields, "teleportMergeMode" | "teleportGroupOverrides" | "teleportMarker">,
  surface: number,
): MarkerLook[] {
  const edgesByKey = new Map(teleportEdges.map((e) => [teleportEdgeKey(e), e]));
  const fillStates = buildPointFillStates(teleportEdges);
  const base = settings.teleportMarker;
  const looks: MarkerLook[] = [];
  for (const group of buildTeleportGroups(teleportEdges, settings.teleportMergeMode)) {
    const override = settings.teleportGroupOverrides[group.key];
    const nodesByState: Record<"filled" | "outline", number[]> = { filled: [], outline: [] };
    for (const edgeKey of group.edgeKeys) {
      const e = edgesByKey.get(edgeKey);
      if (!e) continue;
      for (const [pos, nodeId, floor] of [[e.from, e.fromNode, e.fromFloor], [e.to, e.toNode, e.toFloor]] as const) {
        if (nodeId === undefined || floor !== undefined) continue;
        nodesByState[fillStates.get(coordKey(pos[0], pos[1])) ?? "filled"].push(nodeId);
      }
    }
    const shape = override?.shape ?? base.shape;
    const border = base.borderWidth > 0 ? (override?.borderColor ?? base.borderColor) : null;
    const borderWidth = border === null ? 0 : base.borderWidth;
    if (nodesByState.filled.length > 0) looks.push({ kind: "teleport", shape, fill: override?.fillColor ?? base.fillColor, border, borderWidth, ...sizeOf(base), inner: "", nodes: nodesByState.filled });
    if (nodesByState.outline.length > 0 && border !== null) looks.push({ kind: "teleport", shape, fill: surface, border, borderWidth, ...sizeOf(base), inner: "", nodes: nodesByState.outline });
  }
  return looks;
}

/** Sizes closer than this fraction of the bigger one read as the same size. */
const MARKER_SIZE_TOLERANCE = 0.15;

/** A border of the fill's own color is indistinguishable from the fill: the marker is a borderless one of the outer size. */
function withoutInvisibleBorder(look: MarkerLook): MarkerLook {
  if (look.border === null || !hasLowContrast(look.fill, look.border)) return look;
  return { ...look, border: null, size: look.size + 2 * look.borderWidth, borderWidth: 0 };
}

/** Two looks read as the same marker: same shape, close size (a border of the fill's color counts as size), close fill, same border
 *  presence (and close border colors), same inner elements. */
export function markerLooksAlike(first: MarkerLook, second: MarkerLook): boolean {
  const a = withoutInvisibleBorder(first);
  const b = withoutInvisibleBorder(second);
  if (a.shape !== b.shape || a.sizeAdaptation !== b.sizeAdaptation || a.inner !== b.inner || !hasLowContrast(a.fill, b.fill)) return false;
  if (Math.abs(a.size - b.size) > MARKER_SIZE_TOLERANCE * Math.max(a.size, b.size)) return false;
  if (a.border === null || b.border === null) return a.border === b.border;
  return hasLowContrast(a.border, b.border);
}

export interface MarkerLookInput {
  start: { id: number | null; style: WaypointStyle };
  finish: { id: number | null; style: WaypointStyle };
  teleportEdges: TeleportEdge[];
  teleportSettings: Pick<TeleportSettingsFields, "teleportMergeMode" | "teleportGroupOverrides" | "teleportMarker">;
  vertical: VerticalMarkerEntry[];
  verticalStyle: VerticalConnectionStyle;
  /** The color under the markers (floor / corridor color): what an outline marker is filled with. */
  surface: number;
}

/** The looks of every non-edge marker kind drawn on the floor. */
export function collectMarkerLooks(input: MarkerLookInput): MarkerLook[] {
  const looks: MarkerLook[] = [];
  if (input.start.id !== null) looks.push(waypointLook("start", input.start.style, input.start.id));
  if (input.finish.id !== null) looks.push(waypointLook("finish", input.finish.style, input.finish.id));
  looks.push(...teleportLooks(input.teleportEdges, input.teleportSettings, input.surface));

  const vs = input.verticalStyle;
  // Decorative pictograms are line icons that differ by construction; only the abstract marker-plus-arrow composition can coincide.
  if (vs.style === "abstract") {
    const nodesOf = (pick: (m: VerticalMarkerEntry) => boolean) => input.vertical.filter(pick).map((m) => m.fromNode);
    const twoWay = nodesOf((m) => m.kind === "vertical_passage" && m.filled);
    const oneWay = nodesOf((m) => m.kind === "vertical_passage" && !m.filled);
    const elevator = nodesOf((m) => m.kind === "elevator");
    if (twoWay.length > 0) looks.push(verticalLook("two_way_passage", vs.twoWayPassageMarker, `arrow:${vs.twoWayArrowStyle}:${vs.twoWayArrowCornerStyle}:${vs.twoWayArrowColor}`, twoWay));
    // A one-way passage always carries a stop line, which no other marker has.
    if (oneWay.length > 0) looks.push(verticalLook("one_way_passage", vs.oneWayPassageMarker, `stop-line:arrow:${vs.oneWayArrowStyle}:${vs.oneWayArrowCornerStyle}:${vs.oneWayArrowColor}`, oneWay));
    if (elevator.length > 0) looks.push(verticalLook("elevator", vs.elevatorMarker, `arrow:${vs.elevatorArrowStyle}:${vs.elevatorArrowCornerStyle}:${vs.elevatorArrowColor}`, elevator));
  }
  return looks;
}

/** `markers_look_alike`: markers of different kinds that read the same on the exported image (GitHub issue #959), over the collected
 *  looks of the whole project. Teleport groups against each other are `teleport_group_ambiguous`'s business and are not compared here.
 *  `markerPairs` names the alike kinds; `nodes` highlights the markers of those kinds. */
export function markersLookAlikeWarningOf(looks: readonly MarkerLook[]): ExportWarning | null {
  const pairs = new Map<string, [MarkerLookKind, MarkerLookKind]>();
  const nodes = new Set<number>();
  for (let i = 0; i < looks.length; i++) {
    for (let j = i + 1; j < looks.length; j++) {
      const a = looks[i];
      const b = looks[j];
      if (a.kind === b.kind || !markerLooksAlike(a, b)) continue;
      const [first, second] = MARKER_KIND_ORDER.indexOf(a.kind) < MARKER_KIND_ORDER.indexOf(b.kind) ? [a.kind, b.kind] : [b.kind, a.kind];
      pairs.set(`${first}|${second}`, [first, second]);
      for (const id of a.nodes) nodes.add(id);
      for (const id of b.nodes) nodes.add(id);
    }
  }
  if (pairs.size === 0) return null;
  return { id: "markers_look_alike", key: "markers_look_alike", nodes: Array.from(nodes), edges: [], markerPairs: Array.from(pairs.values()) };
}

/** What `collectMarkerLooks` reads for one floor, from its scoped maze (`edges` and `nodeById` scoped, `unscoped*` project-wide). */
export function markerLookInputOf(
  settings: AnySettings,
  floor: {
    nodeById: Map<number, NodeDto>; edges: EdgeDto[]; unscopedNodes: NodeDto[]; unscopedEdges: EdgeDto[]; cfg: FieldConfig;
    floorIndex: number; teleportEdges: TeleportEdge[]; start: number | null; finish: number | null;
  },
): MarkerLookInput {
  const resolved = withLazyResolvedGroupOverrides(settings);
  const verticalStyle = "floorColor" in resolved
    ? buildVerticalConnectionStyle(resolved, resolved.floorColor, resolved)
    : buildVerticalConnectionStyle(resolved, resolved.color);
  const vertical = buildVerticalConnectionMarkers(
    floor.nodeById, floor.edges, floor.cfg, selectNodeLevelResolver(floor.unscopedNodes), floor.floorIndex,
    selectVerticalPassagePairSet(floor.unscopedEdges), floor.unscopedEdges, resolved.replaceTwoFloorElevatorsWithStairs,
  ).map((marker) => ({ kind: marker.kind, filled: marker.filled, fromNode: marker.fromNode }));
  return {
    start: { id: floor.start, style: resolved.startMarker }, finish: { id: floor.finish, style: resolved.finishMarker },
    teleportEdges: floor.teleportEdges, teleportSettings: resolved, vertical, verticalStyle,
    surface: "floorColor" in resolved ? resolved.floorColor : resolved.color,
  };
}

/** The non-edge marker looks of the whole project, floor by floor: markers on different floors share one exported set, so a start on
 *  one floor and a finish on another can still pass for each other. `project.start`/`finish` are the effective endpoints. */
export function projectMarkerLooks(
  settings: AnySettings,
  project: { nodes: NodeDto[]; edges: EdgeDto[]; floors: { id: string }[]; start: number | null; finish: number | null },
  cfg: FieldConfig,
): MarkerLook[] {
  const resolveNodeLevel = selectNodeLevelResolver(project.nodes);
  const unscopedNodeById = new Map(project.nodes.map((node) => [node.id, node]));
  return project.floors.flatMap((floor, floorIndex) => {
    const scoped = selectFloorScopedMaze(project.nodes, project.edges, project.floors, floor.id, project.start, project.finish);
    const nodeById = new Map(scoped.nodes.map((node) => [node.id, node]));
    const floorContext = { resolveNodeLevel, unscopedNodeById, unscopedEdges: project.edges, activeFloorIndex: floorIndex, floorCount: project.floors.length };
    return collectMarkerLooks(markerLookInputOf(settings, {
      nodeById, edges: scoped.edges, unscopedNodes: project.nodes, unscopedEdges: project.edges, cfg, floorIndex,
      teleportEdges: buildTeleportEdges(nodeById, scoped.edges, cfg, floorContext), start: scoped.start, finish: scoped.finish,
    }));
  });
}

/** `projectMarkerLooks` for a caller that has the store state (the edge marker warnings) and the effective endpoints. */
export function stateMarkerLooks(
  state: { nodes: NodeDto[]; edges: EdgeDto[]; floors: { id: string }[]; activeFieldConfig: FieldConfig },
  settings: AnySettings,
  endpoints: { start: number | null; finish: number | null },
): MarkerLook[] {
  return projectMarkerLooks(settings, { nodes: state.nodes, edges: state.edges, floors: state.floors, ...endpoints }, state.activeFieldConfig);
}
