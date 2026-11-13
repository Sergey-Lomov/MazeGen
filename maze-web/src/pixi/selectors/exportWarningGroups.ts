import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { FieldConfig } from "../../fieldConfig";
import type { VectorByWallsSettings, VectorByCorridorsSettings } from "../../store/storeTypes";
import {
  buildTeleportEdges, buildCorridorSegments, shortestCorridorFace, selectNodeLevelResolver,
  selectVerticalPassagePairSet, buildVerticalConnectionMarkers,
} from "./mazeSelectors";
import { withMarkerVisibility, isWaypointVisible } from "./mazeSelectors/markers";
import type { TeleportFloorContext } from "./mazeSelectors";
import type { TeleportEdge } from "../renderers/types";
import { chevronRowStep } from "../renderers/wallUtils";
import { computeElevatorBadgeLayout, elevatorBadgesOverlap, formatElevatorBadgeLabel } from "../renderers/elevatorBadgeLayout";
import { measureText } from "../textFit";
import { plainLabelFont } from "../renderers/fontChoice";
import { TILE_SIZE } from "../constants";
import { buildMarkerIndexEndpointResolver, buildTeleportLineStyle, buildVerticalConnectionStyle } from "../imageExport/exportStyleBuilders";
import { oneWayStopLineShape, stopLineOverlapsRoundedRect, type RoundedRectGeometry } from "../renderers/verticalConnectionGeometry";
import type { VerticalConnectionStyle } from "../renderers/types";
import { buildMarkerIndexLabels, markerIndexPlateFootprint } from "./mazeSelectors/markerIndex";
import type { TeleportGroup } from "./teleportGroups";
import { getProjectTeleportGroups } from "./projectTeleportGroups";
import { buildColorVisibility, visibleColor, type ColorVisibilityContext, type ColorVisibilityMaze } from "./colorFieldRegistry";
import { withLazyResolvedGroupOverrides } from "../../store/teleportGroupLinks";
import { computeTeleportConnectorCoversOneWayWarning } from "./teleportOneWayCoverage";
import { computeTeleportConnectorWarnings } from "./teleportConnectorWarnings";
import { buildTeleportConnectorContext, type TeleportConnectorInput } from "./teleportConnectorContext";
import { collectTextFitEntries, pushTextOverflowWarnings } from "./exportTextFit";
import { textMetricsKey } from "../textFit";
import {
  pushContrastWarningEntries, pushContrastWarning, teleportConnectorEntries, splitContrastData, splitColorEntries, pushSplitPairwiseWarning,
  buildContrastFloorEnv, COMMON_CONTRAST_CHECKS, type ContrastFloorEnv,
} from "./exportContrastWarnings";
import {
  computeTeleportMarkerInvisibleWarning, computeTeleportMergedWithoutConnectorsWarning, computeTeleportGroupAmbiguousWarning,
  computeTeleportWaypointOverlapWarning, computeElevatorIndistinguishableWarning,
} from "./exportTeleportWarnings";
import { computeMarkerExtensionHitsCorridorWarning } from "./exportCorridorWarnings";
import { markersLookAlikeWarningOf, projectMarkerLooks } from "./exportMarkerLookAlike";
import type { ExportWarning, ExportWarningId, WarningFloor } from "./exportWarnings";

/** The export warnings of one render mode as independent groups (GitHub issue #928). A group is a pure
 *  function of one floor's maze data (`WarningFloorEnv`) and of the settings fields it reads; it owns a fixed
 *  set of warning ids, and no id belongs to two groups. `exportWarnings.ts` caches each group per floor under
 *  `trackedMemo`, which records the settings fields the group actually reads — a group never lists its own
 *  dependencies, and a change to a field it does not read cannot recompute it. Rules for a group:
 *  - read settings only through the `settings` argument, maze data only through `env`;
 *  - never keep a settings sub-object in the result (the tracker rejects it);
 *  - emit only the ids it declares (a test checks), and add a new id to exactly one group. */
export interface WarningGroup<S extends AnySettings = AnySettings> {
  readonly name: string;
  readonly ids: readonly ExportWarningId[];
  readonly run: (env: WarningFloorEnv, settings: S) => ExportWarning[];
  /** Cache inputs of this group beyond the maze, the settings and `hasGlues`: per-floor options and state no settings field
   *  carries (a floor title, loaded fonts). Listing one the group reads is the group author's job; a test guards the known ones. */
  readonly hiddenInputs?: (env: WarningFloorEnv) => readonly unknown[];
}

export type AnySettings = VectorByWallsSettings | VectorByCorridorsSettings;
export type WarningMode = "walls" | "corridors";

export interface ScopedFloor {
  nodes: NodeDto[];
  edges: EdgeDto[];
  start: number | null;
  finish: number | null;
  unscopedNodes: NodeDto[];
  floorContext?: TeleportFloorContext;
}

export interface WarningEnvOptions {
  cfg: FieldConfig;
  /** Whether some floor has a glue (glue tab fields are hidden without one). */
  hasGlues: boolean;
  /** Whether a share mirrored onto a seam partner highlights the partner's node (off when a cut line separates the two). */
  highlightSeamMirrors: boolean;
  floorTitle?: string;
  /** The shortest corridor face of the whole project; defaults to this floor's own. */
  corridorFaceLimit?: () => number;
  /** Project-wide teleport groups the marker index numbers by; derived from the settings and `project` when omitted. */
  teleportGroups?: TeleportGroup[];
  project?: { nodes: NodeDto[]; edges: EdgeDto[]; floors: WarningFloor[]; start: number | null; finish: number | null };
}

/** Project-wide teleport groups the marker index numbers by (GitHub issue #871); empty when the
 *  index is off, so nothing is built needlessly. */
function projectGroupsForMarkerIndex(project: NonNullable<WarningEnvOptions["project"]>, cfg: FieldConfig, settings: AnySettings): TeleportGroup[] {
  if (!settings.markerIndex.enabled) return [];
  return getProjectTeleportGroups({
    nodes: project.nodes, edges: project.edges, cfg, floors: project.floors, avoidFieldExit: settings.teleportAvoidFieldExit,
    start: project.start, finish: project.finish, mergeTeleports: settings.teleportMergeMode,
  });
}

/** Everything a warning group needs about one floor that no settings field feeds. Cheap to create: the
 *  floor's scoped maze and every derived structure are computed on first read, so a floor whose groups
 *  all hit the cache costs nothing. */
export class WarningFloorEnv {
  private readonly memo = new Map<string, unknown>();

  constructor(
    readonly mode: WarningMode,
    private readonly load: () => ScopedFloor,
    private readonly options: WarningEnvOptions,
  ) {}

  private once<T>(key: string, compute: () => T): T {
    if (!this.memo.has(key)) this.memo.set(key, compute());
    return this.memo.get(key) as T;
  }

  get cfg(): FieldConfig { return this.options.cfg; }
  /** The whole project this floor belongs to, when the caller gave it. */
  get project(): WarningEnvOptions["project"] { return this.options.project; }
  get floorTitle(): string | undefined { return this.options.floorTitle; }
  get highlightSeamMirrors(): boolean { return this.options.highlightSeamMirrors; }
  get scoped(): ScopedFloor { return this.once("scoped", this.load); }
  get nodes(): NodeDto[] { return this.scoped.nodes; }
  get edges(): EdgeDto[] { return this.scoped.edges; }
  get start(): number | null { return this.scoped.start; }
  get finish(): number | null { return this.scoped.finish; }
  get unscopedNodes(): NodeDto[] { return this.scoped.unscopedNodes; }
  get unscopedEdges(): EdgeDto[] { return this.scoped.floorContext?.unscopedEdges ?? this.scoped.edges; }
  get activeFloorIndex(): number { return this.scoped.floorContext?.activeFloorIndex ?? this.scoped.nodes[0]?.level ?? 0; }
  get nodeById(): Map<number, NodeDto> { return this.once("nodeById", () => new Map(this.nodes.map((node) => [node.id, node]))); }
  get allNodes(): NodeDto[] { return this.once("allNodes", () => Array.from(this.nodeById.values())); }
  get resolveNodeLevel(): ReturnType<typeof selectNodeLevelResolver> {
    return this.once("resolveNodeLevel", () => this.scoped.floorContext?.resolveNodeLevel ?? selectNodeLevelResolver(this.unscopedNodes));
  }
  get teleportEdges(): TeleportEdge[] {
    return this.once("teleportEdges", () => buildTeleportEdges(this.nodeById, this.edges, this.cfg, this.scoped.floorContext));
  }
  get corridorSegments(): ReturnType<typeof buildCorridorSegments> {
    return this.once("corridorSegments", () => buildCorridorSegments(this.nodes, this.edges, this.cfg));
  }
  get corridorFaceLimit(): number {
    return this.once("corridorFaceLimit", () => this.options.corridorFaceLimit?.() ?? shortestCorridorFace(this.corridorSegments));
  }
  get contrast(): ContrastFloorEnv {
    return this.once("contrast", () => buildContrastFloorEnv({
      nodes: this.nodes, edges: this.edges, teleportEdges: this.teleportEdges, allNodesForWarnings: this.unscopedNodes,
      allEdgesForWarnings: this.unscopedEdges, start: this.start, finish: this.finish, displayFloorIndex: this.activeFloorIndex, cfg: this.cfg,
    }));
  }
  /** Keys (`"x,y"`) of the split points drawn as a special shape; the groups apply `splitSpecialShapes` themselves. */
  /** The visibility context the color checks read through. A minimal floor array keeps project-wide
   *  visibility for the floor-label colors; the maze is the *unscoped* graph (a floor-scoped edge list
   *  can't tell a two-way passage from a one-way one — its reverse half lives on another floor). */
  colors(settings: AnySettings): ColorVisibilityContext {
    const maze = this.once<ColorVisibilityMaze>("visibilityMaze", () => {
      const count = this.scoped.floorContext?.floorCount ?? new Set(this.unscopedNodes.map((node) => node.level ?? 0)).size;
      const floors = Array.from({ length: count }, (_, i) => ({ id: String(i) })) as unknown as ColorVisibilityMaze["floors"];
      return { nodes: this.unscopedNodes, edges: this.unscopedEdges, floors, hasGlues: this.options.hasGlues };
    });
    return buildColorVisibility(maze, settings);
  }

  projectTeleportGroups(settings: AnySettings): TeleportGroup[] {
    if (this.options.teleportGroups) return this.options.teleportGroups;
    return this.options.project ? projectGroupsForMarkerIndex(this.options.project, this.cfg, settings) : [];
  }
}

const maybe = (warning: ExportWarning | null): ExportWarning[] => (warning ? [warning] : []);

function collect(fill: (out: ExportWarning[]) => void): ExportWarning[] {
  const out: ExportWarning[] = [];
  fill(out);
  return out;
}

function group<S extends AnySettings = AnySettings>(
  name: string, ids: readonly ExportWarningId[], run: WarningGroup<S>["run"], hiddenInputs?: WarningGroup<S>["hiddenInputs"],
): WarningGroup<S> {
  return { name, ids, run, hiddenInputs };
}

/** Footprints of every marker-index plate on the displayed floor (body plus border), as the mode
 *  renderers place them — `[]` while `markerIndex` is off. Plate placement depends only on each
 *  endpoint marker's outer radius, never on its colors, so the teleport gap color and group
 *  customization are irrelevant here. */
function markerIndexPlates(env: WarningFloorEnv, settings: AnySettings, verticalStyle: VerticalConnectionStyle): RoundedRectGeometry[] {
  const index = settings.markerIndex;
  if (!index.enabled) return [];
  const resolveEndpointVisual = buildMarkerIndexEndpointResolver({
    teleportEdges: env.teleportEdges, teleportStyle: buildTeleportLineStyle(settings, 0), groupCustomization: false, mergeTeleports: settings.teleportMergeMode, groupOverrides: {}, verticalStyle,
  });
  const { labels } = buildMarkerIndexLabels(env.unscopedNodes, env.unscopedEdges, env.cfg, env.activeFloorIndex, index, resolveEndpointVisual, undefined, env.projectTeleportGroups(settings));
  return labels.map((label) => markerIndexPlateFootprint(label, index));
}

/** `marker_index_covers_stop_line` (GitHub issue #744): on the displayed floor, every one-way
 *  vertical passage marker whose stop line (wall tick) is overlapped by any marker-index plate —
 *  its body plus border, never its floor-colored gap ring, which is drawn under the markers. The
 *  plate body is drawn above the markers, so an overlap hides part of the stop line. Mirrors both
 *  mode renderers: markers from `buildVerticalConnectionMarkers`, plates from
 *  `markerIndexPlates`. Highlights the affected markers. */
function computeMarkerIndexStopLineWarning(
  env: WarningFloorEnv,
  settings: AnySettings,
  verticalStyle: VerticalConnectionStyle,
): ExportWarning | null {
  const index = settings.markerIndex;
  if (!index.enabled) return null;
  const { edges, cfg, activeFloorIndex: displayFloorIndex } = env;
  const markers = buildVerticalConnectionMarkers(
    env.nodeById, edges, cfg, selectNodeLevelResolver(env.unscopedNodes), displayFloorIndex,
    selectVerticalPassagePairSet(env.unscopedEdges), env.unscopedEdges, settings.replaceTwoFloorElevatorsWithStairs,
  );
  const stopLines = markers.flatMap((marker) => {
    const shape = oneWayStopLineShape(marker, verticalStyle);
    return shape ? [{ node: marker.fromNode, shape }] : [];
  });
  if (stopLines.length === 0) return null;

  const plates = markerIndexPlates(env, settings, verticalStyle);
  const flagged = stopLines
    .filter(({ shape }) => plates.some((plate) => stopLineOverlapsRoundedRect(shape, plate)))
    .map(({ node }) => node);
  if (flagged.length === 0) return null;
  return { id: "marker_index_covers_stop_line", key: "marker_index_covers_stop_line", nodes: Array.from(new Set(flagged)), edges: [] };
}

// --- Groups shared by both modes ---

const teleportMarkerInvisible = group("teleportMarkerInvisible", ["teleport_marker_invisible"], (env, s) => (
  maybe(computeTeleportMarkerInvisibleWarning(env.teleportEdges, s))
));

const teleportMergedWithoutConnectors = group("teleportMergedWithoutConnectors", ["teleport_merged_without_connectors"], (env, s) => (
  maybe(computeTeleportMergedWithoutConnectorsWarning(env.teleportEdges, s))
));

const teleportGroupAmbiguous = group("teleportGroupAmbiguous", ["teleport_group_ambiguous"], (env, s) => (
  maybe(computeTeleportGroupAmbiguousWarning(env.teleportEdges, withLazyResolvedGroupOverrides(s)))
));

function waypointExtent(marker: VectorByWallsSettings["startMarker"]): { size: number; borderWidth: number } {
  const { size, borderWidth } = withMarkerVisibility(marker);
  return { size, borderWidth };
}

const teleportWaypointOverlap = group("teleportWaypointOverlap", ["teleport_waypoint_overlap"], (env, s) => (
  maybe(computeTeleportWaypointOverlapWarning(
    env.teleportEdges, withLazyResolvedGroupOverrides(s),
    { id: env.start, ...waypointExtent(s.startMarker) },
    { id: env.finish, ...waypointExtent(s.finishMarker) },
    env.allNodes, env.cfg, env.edges,
  ))
));

/** `start_invisible` / `finish_invisible` (GitHub issue #963): a start/finish with neither a visible marker nor a caption. */
const waypointInvisible = group("waypointInvisible", ["start_invisible", "finish_invisible"], (env, s) => {
  const out: ExportWarning[] = [];
  const check = (id: "start_invisible" | "finish_invisible", node: number | null, marker: AnySettings["startMarker"]) => {
    if (node === null || !env.nodeById.has(node) || isWaypointVisible(marker)) return;
    out.push({ id, key: id, nodes: [node], edges: [] });
  };
  check("start_invisible", env.start, s.startMarker);
  check("finish_invisible", env.finish, s.finishMarker);
  return out;
});

/** `markers_look_alike` (GitHub issue #959): markers of different kinds on the floor that render the same. */
const markersLookAlike = group("markersLookAlike", ["markers_look_alike"], (env, s) => {
  // Markers of every floor are compared with one another, so the warning is computed once, on the first floor, and only where the
  // whole project is known (the across-floors entry points; the single-floor ones have nothing to compare against).
  const project = env.project;
  return project && env.activeFloorIndex === 0 ? maybe(markersLookAlikeWarningOf(projectMarkerLooks(s, project, env.cfg))) : [];
});

const contrastGroups = COMMON_CONTRAST_CHECKS.map(({ name, ids, check }) => (
  group(`contrast.${name}`, ids, (env, s) => collect((out) => check(out, env.contrast, env.colors(s))))
));

export const TEXT_OVERFLOW_GROUP = "textOverflow";

const textOverflow = group(
  TEXT_OVERFLOW_GROUP,
  ["marker_text_overflow", "elevator_badge_text_overflow", "marker_index_text_overflow", "teleport_badge_text_overflow", "floor_label_text_overflow"],
  (env, s) => collect((out) => pushTextOverflowWarnings(out, collectTextFitEntries(
    env.nodeById, env.edges, env.cfg, env.teleportEdges, s, env.start, env.finish, env.resolveNodeLevel,
    env.activeFloorIndex, { nodes: env.unscopedNodes, edges: env.unscopedEdges }, env.floorTitle, env.projectTeleportGroups(s),
  ))),
  // The floor label shows the floor's title; overflow is judged against the loaded bitmap font, which no settings field feeds.
  (env) => [env.floorTitle, textMetricsKey()],
);

const elevatorIndistinguishable = group("elevatorIndistinguishable", ["elevator_indistinguishable"], (env, s) => (
  maybe(computeElevatorIndistinguishableWarning(env.nodes, env.edges, s.markerIndex.enabled && s.markerIndex.coverage.elevator, s.elevatorBadges.enabled))
));

// --- "Vector by walls" ---

/** Name of the group of the connector geometry warnings in both modes (`computeTeleportConnectorWarningsAcrossFloors` picks it). */
export const TELEPORT_CONNECTORS_GROUP = "teleportConnectors";
/** Warnings about the drawn teleport connectors (GitHub issue #862, #945): one group, so the connectors are laid out and routed once. */
const TELEPORT_CONNECTOR_IDS: readonly ExportWarningId[] = [
  "teleport_connector_covers_one_way", "teleport_connectors_overlap", "teleport_connector_endpoint_detached", "teleport_connector_leaves_field",
  "teleport_connector_crosses_marker", "teleport_connector_arrow_sticks_out", "teleport_connector_too_short_for_arrow", "teleport_connector_covers_arrow", "teleport_connector_degenerate",
];
function connectorWarnings(input: TeleportConnectorInput): ExportWarning[] {
  if (input.settings.teleportConnectorStyle === "none" || input.teleportEdges.length === 0) return [];
  const context = buildTeleportConnectorContext(input);
  return [...maybe(computeTeleportConnectorCoversOneWayWarning(input, context)), ...computeTeleportConnectorWarnings(input, context)];
}

const wallsTeleportConnectors = group<VectorByWallsSettings>(TELEPORT_CONNECTORS_GROUP, TELEPORT_CONNECTOR_IDS, (env, s) => (
  connectorWarnings({
    mode: "walls", settings: withLazyResolvedGroupOverrides(s), nodes: env.nodes, edges: env.edges, cfg: env.cfg, start: env.start, finish: env.finish,
    teleportEdges: env.teleportEdges, unscopedNodes: env.unscopedNodes, unscopedEdges: env.unscopedEdges, activeFloorIndex: env.activeFloorIndex,
  })
));

const wallsTeleportConnectorContrast = group<VectorByWallsSettings>(
  "teleportConnectorContrast", ["teleport_connector_low_contrast_floor", "teleport_connector_low_contrast_wall"],
  (env, s) => collect((out) => {
    if (env.teleportEdges.length === 0) return;
    const ctx = env.colors(s);
    pushContrastWarningEntries(out, "teleport_connector_low_contrast_floor", teleportConnectorEntries(env.teleportEdges, ctx, visibleColor(ctx, "tilesFloor")));
    if (s.teleportConnectorGapWidth === 0) {
      pushContrastWarningEntries(out, "teleport_connector_low_contrast_wall", teleportConnectorEntries(env.teleportEdges, ctx, visibleColor(ctx, "tilesWall")));
    }
  }),
);

const wallsSplitContrast = group<VectorByWallsSettings>(
  "splitContrast", ["split_low_contrast_floor", "split_colors_low_contrast_each_other"],
  (env, s) => collect((out) => {
    const ctx = env.colors(s);
    const split = splitContrastData(env.nodes, env.edges, env.cfg, ctx, env.highlightSeamMirrors);
    pushContrastWarningEntries(out, "split_low_contrast_floor", splitColorEntries(split, visibleColor(ctx, "tilesFloor")));
    pushSplitPairwiseWarning(out, split);
  }),
  (env) => [env.highlightSeamMirrors],
);

/** Split points recognized as a dedicated "special shape" (bridge/diagonal, `SplitSpecialShapeKind`)
 *  — only these draw noticeably different geometry from a generic split point, and only when
 *  `splitSpecialShapes` is actually on (off, every split point draws the plain per-node reading,
 *  which a waypoint/teleport endpoint handles fine — see GitHub issue #298 follow-up). A start/finish,
 *  teleport endpoint or vertical marker landing there can visually collide with that geometry. */
/** `true` when the unjoined ends of a circular run are closer than its ordinary neighbours. Center
 * distance is sufficient because all elevator badges in a run have the same radius. */
function elevatorBadgeEndGapTooSmall(positions: readonly { x: number; y: number }[]): boolean {
  if (positions.length < 2) return false;
  const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  const ordinaryGap = Math.min(...positions.slice(1).map((position, i) => distance(positions[i], position)));
  return distance(positions[0], positions.at(-1)!) < ordinaryGap - 1e-6;
}

/** `elevator_badges_overlap` / `elevator_badges_merged_end_gap_too_small` /
 * `elevator_badges_gap_falls_back_to_even_distribution` / `elevator_badges_too_many`: an Elevator marker's own floor-number
 *  badge ring either visually overlaps itself, or has more floors on one side than that side's
 *  single row can hold (GitHub issue #430, #430 follow-ups). Slots under a marker-index plate are
 *  unavailable (GitHub issue #964), exactly as the renderers lay badges out, so a plate shrinks a
 *  side's capacity instead of hiding a badge. One warning total per id, covering
 *  every affected marker. The warning is scoped to the floor on which its marker is rendered;
 *  aggregation derives that floor from the flagged node rather than listing every destination
 *  floor the elevator reaches. Mirrors `VerticalConnectionRenderer.drawElevatorBadges`'s own
 *  `markerRadius`/`badgeRadius` computation. */
const wallsElevatorBadges = group<VectorByWallsSettings>(
  "elevatorBadges", ["elevator_badges_overlap", "elevator_badges_merged_end_gap_too_small", "elevator_badges_gap_falls_back_to_even_distribution", "elevator_badges_too_many"],
  (env, s) => collect((out) => {
    if (!s.elevatorBadges.enabled) return;
    const verticalPairs = selectVerticalPassagePairSet(env.edges);
    const markers = buildVerticalConnectionMarkers(env.nodeById, env.edges, env.cfg, env.resolveNodeLevel, 0, verticalPairs, env.edges);
    const resolved = withLazyResolvedGroupOverrides(s);
    const obstacles = markerIndexPlates(env, resolved, buildVerticalConnectionStyle(resolved, resolved.floorColor, resolved));
    const markerRadius = s.elevatorMarker.size / 2;
    const badgeRadius = s.elevatorBadges.size / 2 + s.elevatorBadges.borderWidth;
    const overlappingNodeIds: number[] = [];
    const overlappingTargets: { nodeId: number; targetFloorIndex: number }[] = [];
    const tightEndGapNodeIds: number[] = [];
    const tightEndGapTargets: { nodeId: number; targetFloorIndex: number }[] = [];
    const fallbackNodeIds: number[] = [];
    const fallbackTargets: { nodeId: number; targetFloorIndex: number }[] = [];
    const tooManyNodeIds: number[] = [];
    const tooManyTargets: { nodeId: number; targetFloorIndex: number }[] = [];
    for (const marker of markers) {
      if (marker.kind !== "elevator" || !marker.targetFloorIndices || marker.targetFloorIndices.length < 2) continue;
      const count = marker.targetFloorIndices.length;
      const { positions, overflow, usedEvenDistributionFallback } = computeElevatorBadgeLayout({
        cx: marker.pos[0], cy: marker.pos[1], markerRadius, count, radius: badgeRadius,
        distance: s.elevatorBadges.distance, gap: s.elevatorBadges.gap, placement: s.elevatorBadges.placement,
        evenDistribution: s.elevatorBadges.evenDistribution, obstacles, startAngle: s.elevatorBadges.startAngle,
      });
      // Merged bands replace the individual bodies. Their only independently colliding content is
      // the floor label, so retain this warning only for overlapping label ink bounds.
      const merged = (s.elevatorBadges.backing ?? "individual") !== "individual";
      const overlaps = merged
        ? positions.some((position, i) => {
          const label = measureText(formatElevatorBadgeLabel(marker.targetFloorIndices![i], s.elevatorBadges.labelType), plainLabelFont(s.elevatorBadges.textFont), s.elevatorBadges.textSize);
          return positions.slice(i + 1).some((other, j) => {
            const otherLabel = measureText(formatElevatorBadgeLabel(marker.targetFloorIndices![i + j + 1], s.elevatorBadges.labelType), plainLabelFont(s.elevatorBadges.textFont), s.elevatorBadges.textSize);
            return Math.abs(position.x - other.x) < (label.width + otherLabel.width) / 2 && Math.abs(position.y - other.y) < (label.height + otherLabel.height) / 2;
          });
        })
        : elevatorBadgesOverlap(positions, badgeRadius);
      if (overlaps) {
        overlappingNodeIds.push(marker.fromNode);
        overlappingTargets.push({ nodeId: marker.fromNode, targetFloorIndex: env.resolveNodeLevel(marker.fromNode) ?? 0 });
      }
      if (
        (s.elevatorBadges.backing ?? "individual") !== "individual"
        && s.elevatorBadges.placement === "full_circle"
        && !s.elevatorBadges.evenDistribution
        && elevatorBadgeEndGapTooSmall(positions)
      ) {
        tightEndGapNodeIds.push(marker.fromNode);
        tightEndGapTargets.push({ nodeId: marker.fromNode, targetFloorIndex: env.resolveNodeLevel(marker.fromNode) ?? 0 });
      }
      if (usedEvenDistributionFallback) {
        fallbackNodeIds.push(marker.fromNode);
        fallbackTargets.push({ nodeId: marker.fromNode, targetFloorIndex: env.resolveNodeLevel(marker.fromNode) ?? 0 });
      }
      if (overflow) {
        tooManyNodeIds.push(marker.fromNode);
        tooManyTargets.push({ nodeId: marker.fromNode, targetFloorIndex: env.resolveNodeLevel(marker.fromNode) ?? 0 });
      }
    }
    if (overlappingNodeIds.length > 0) {
      out.push({ id: "elevator_badges_overlap", key: "elevator_badges_overlap", nodes: overlappingNodeIds, edges: [], crossFloorTargets: overlappingTargets });
    }
    if (tightEndGapNodeIds.length > 0) {
      out.push({ id: "elevator_badges_merged_end_gap_too_small", key: "elevator_badges_merged_end_gap_too_small", nodes: tightEndGapNodeIds, edges: [], crossFloorTargets: tightEndGapTargets });
    }
    if (fallbackNodeIds.length > 0) {
      out.push({ id: "elevator_badges_gap_falls_back_to_even_distribution", key: "elevator_badges_gap_falls_back_to_even_distribution", nodes: fallbackNodeIds, edges: [], crossFloorTargets: fallbackTargets });
    }
    if (tooManyNodeIds.length > 0) {
      out.push({ id: "elevator_badges_too_many", key: "elevator_badges_too_many", nodes: tooManyNodeIds, edges: [], crossFloorTargets: tooManyTargets });
    }
  }),
);

const wallsMarkerIndexStopLine = group<VectorByWallsSettings>("markerIndexStopLine", ["marker_index_covers_stop_line"], (env, s) => {
  const resolved = withLazyResolvedGroupOverrides(s);
  return maybe(computeMarkerIndexStopLineWarning(env, resolved, buildVerticalConnectionStyle(resolved, resolved.floorColor, resolved)));
});

/** Every warning group of "Vector by walls", in the order their warnings are listed. */
export const WALLS_WARNING_GROUPS: readonly WarningGroup<VectorByWallsSettings>[] = [
  teleportMarkerInvisible, teleportMergedWithoutConnectors, teleportGroupAmbiguous, teleportWaypointOverlap, markersLookAlike, waypointInvisible, wallsTeleportConnectors,
  ...contrastGroups,
  wallsTeleportConnectorContrast, wallsSplitContrast, wallsElevatorBadges,
  textOverflow, wallsMarkerIndexStopLine, elevatorIndistinguishable,
];

// --- "Vector by corridors" ---

const corridorsTeleportConnectors = group<VectorByCorridorsSettings>(TELEPORT_CONNECTORS_GROUP, TELEPORT_CONNECTOR_IDS, (env, s) => (
  connectorWarnings({
    mode: "corridors", settings: withLazyResolvedGroupOverrides(s), nodes: env.nodes, edges: env.edges, cfg: env.cfg, start: env.start, finish: env.finish,
    teleportEdges: env.teleportEdges, unscopedNodes: env.unscopedNodes, unscopedEdges: env.unscopedEdges, activeFloorIndex: env.activeFloorIndex,
  })
));

const corridorsMarkerExtension = group<VectorByCorridorsSettings>("markerExtensionHitsCorridor", ["marker_extension_hits_corridor"], (env, s) => {
  if (s.markerWidenPadding <= 0) return [];
  return maybe(computeMarkerExtensionHitsCorridorWarning(env.corridorSegments, env.corridorFaceLimit, env.nodeById, env.cfg, env.edges, s, env.start, env.finish));
});

const corridorsCorridorColors = group<VectorByCorridorsSettings>(
  "corridorContrast", ["corridor_low_contrast_background", "one_way_low_contrast_corridor"],
  (env, s) => collect((out) => {
    const segments = env.corridorSegments;
    const ctx = env.colors(s);
    if (segments.length > 0) {
      pushContrastWarning(out, "corridor_low_contrast_background", [[visibleColor(ctx, "corridorFill"), visibleColor(ctx, "bgFill")]]);
    }
    const oneWay = segments.filter((segment) => segment.oneWayDir);
    if (oneWay.length > 0) {
      pushContrastWarning(
        out,
        "one_way_low_contrast_corridor",
        [[visibleColor(ctx, "oneWaysMarker"), visibleColor(ctx, "corridorFill")]],
        oneWay.flatMap((segment) => [segment.fromNode, segment.toNode]),
        oneWay.map((segment) => [segment.fromNode, segment.toNode]),
      );
    }
  }),
);

const corridorsTeleportConnectorContrast = group<VectorByCorridorsSettings>(
  "teleportConnectorContrast", ["teleport_connector_low_contrast_corridor", "teleport_connector_low_contrast_background"],
  (env, s) => collect((out) => {
    if (env.teleportEdges.length === 0) return;
    const ctx = env.colors(s);
    pushContrastWarningEntries(out, "teleport_connector_low_contrast_corridor", teleportConnectorEntries(env.teleportEdges, ctx, visibleColor(ctx, "corridorFill")));
    if (s.teleportConnectorGapWidth === 0) {
      pushContrastWarningEntries(out, "teleport_connector_low_contrast_background", teleportConnectorEntries(env.teleportEdges, ctx, visibleColor(ctx, "bgFill")));
    }
  }),
);

const corridorsSplitContrast = group<VectorByCorridorsSettings>(
  "splitContrast", ["split_low_contrast_corridor", "split_low_contrast_background", "split_colors_low_contrast_each_other"],
  (env, s) => collect((out) => {
    const ctx = env.colors(s);
    const split = splitContrastData(env.nodes, env.edges, env.cfg, ctx, env.highlightSeamMirrors);
    pushContrastWarningEntries(out, "split_low_contrast_corridor", splitColorEntries(split, visibleColor(ctx, "corridorFill")));
    pushContrastWarningEntries(out, "split_low_contrast_background", splitColorEntries(split, visibleColor(ctx, "bgFill")));
    pushSplitPairwiseWarning(out, split);
  }),
  (env) => [env.highlightSeamMirrors],
);

const corridorsSplitGapMayShrink = group<VectorByCorridorsSettings>("splitGapMayShrink", ["split_gap_may_shrink"], (_env, s) => (
  s.thickness + 2 * s.splitGapWidth > 40 ? [{ id: "split_gap_may_shrink", key: "split_gap_may_shrink", nodes: [], edges: [] }] : []
));

/** `one_way_arrows_overflow_corridor`: the chevron row's own full visible extent exceeds a
 *  cell's own size along the corridor, or its width (oneWayWidth * thickness) exceeds the
 *  corridor's own thickness — GitHub issue #312, gap-accounts-for-thickness follow-up. Mirrors
 *  `VectorByCorridorsRenderer`'s own `oneWayLengthPx` (`oneWayLength` is a multiplier of the
 *  chevron's own full opening width, not an absolute pixel size) and `drawOneWayChevronRow`'s own
 *  `chevronRowStep` spacing exactly: `(count-1)` steps between chevron centers, plus the trailing
 *  chevron's own `length + thickness` overhang past its center. Checked once against the settings
 *  (every one-way passage draws the exact same row geometry), then applied via
 *  `buildCorridorSegments`' own `oneWayDir` — the same segments this mode's renderer actually draws
 *  a chevron row for (geometric neighbors, split points already excluded). */
const corridorsOneWayOverflow = group<VectorByCorridorsSettings>("oneWayArrowsOverflow", ["one_way_arrows_overflow_corridor"], (env, s) => {
  const oneWayFullWidth = s.oneWayWidth * s.thickness;
  const oneWayLengthPx = s.oneWayLength * oneWayFullWidth;
  const rowStep = chevronRowStep(oneWayLengthPx, s.oneWayGap, s.oneWayThickness);
  const rowLength = (s.oneWayCount - 1) * rowStep + oneWayLengthPx + s.oneWayThickness;
  if (!(rowLength > TILE_SIZE || s.oneWayWidth > 1)) return [];
  const oneWaySegments = env.corridorSegments.filter((seg) => seg.oneWayDir);
  if (oneWaySegments.length === 0) return [];
  const flaggedNodeIds = new Set<number>();
  const flaggedEdgePairs: [number, number][] = [];
  for (const seg of oneWaySegments) {
    flaggedNodeIds.add(seg.fromNode);
    flaggedNodeIds.add(seg.toNode);
    flaggedEdgePairs.push([seg.fromNode, seg.toNode]);
  }
  return [{ id: "one_way_arrows_overflow_corridor", key: "one_way_arrows_overflow_corridor", nodes: Array.from(flaggedNodeIds), edges: flaggedEdgePairs }];
});

const corridorsMarkerIndexStopLine = group<VectorByCorridorsSettings>("markerIndexStopLine", ["marker_index_covers_stop_line"], (env, s) => {
  const resolved = withLazyResolvedGroupOverrides(s);
  return maybe(computeMarkerIndexStopLineWarning(env, resolved, buildVerticalConnectionStyle(resolved, resolved.color)));
});

/** Every warning group of "Vector by corridors", in the order their warnings are listed. */
export const CORRIDORS_WARNING_GROUPS: readonly WarningGroup<VectorByCorridorsSettings>[] = [
  teleportMarkerInvisible, teleportMergedWithoutConnectors, teleportGroupAmbiguous, teleportWaypointOverlap, markersLookAlike, waypointInvisible, corridorsTeleportConnectors,
  ...contrastGroups,
  corridorsMarkerExtension, corridorsCorridorColors, corridorsTeleportConnectorContrast, corridorsSplitContrast, corridorsSplitGapMayShrink,
  corridorsOneWayOverflow,
  textOverflow, corridorsMarkerIndexStopLine, elevatorIndistinguishable,
];
