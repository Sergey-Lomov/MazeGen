import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { FieldConfig } from "../../fieldConfig";
import type { VectorByWallsSettings, VectorByCorridorsSettings } from "../../store/storeTypes";
import { buildTeleportEdges, buildSplitPassages, buildCorridorSegments, shortestCorridorFace, shortestCorridorFaceAcrossFloors, maxSplitNodeCount, selectNodeLevelResolver, selectVerticalPassagePairSet, buildVerticalConnectionMarkers, selectFloorScopedMaze } from "./mazeSelectors";
import type { TeleportFloorContext } from "./mazeSelectors";
import type { TeleportEdge } from "../renderers/types";
import { chevronRowStep } from "../renderers/wallUtils";
import { computeElevatorBadgePositions, elevatorBadgesOverlap, elevatorBadgesTooMany } from "../renderers/elevatorBadgeLayout";
import { TILE_SIZE } from "../constants";
import { buildMarkerIndexEndpointResolver, buildTeleportLineStyle, buildVerticalConnectionStyle } from "../imageExport/exportStyleBuilders";
import { oneWayStopLineShape, stopLineOverlapsRoundedRect } from "../renderers/verticalConnectionGeometry";
import type { VerticalConnectionStyle } from "../renderers/types";
import { buildMarkerIndexLabels, markerIndexPlateBox } from "./mazeSelectors/markerIndex";
import { buildColorVisibility, visibleColor, type ColorVisibilityContext, type ColorVisibilityMaze } from "./colorFieldRegistry";
import { withResolvedGroupOverrides } from "../../store/teleportGroupLinks";
import { computeTeleportConnectorCoversOneWayWarning } from "./teleportOneWayCoverage";
import { collectTextFitEntries, pushTextOverflowWarnings } from "./exportTextFit";
export { computeTextFitItemsAcrossFloors } from "./exportTextFit";
export type { TextFitKind } from "./exportTextFit";
import { type ColorFieldKey } from "../colorFieldKeys";
import { pushContrastWarningEntries, pushContrastWarning, teleportConnectorEntries, splitContrastData, splitColorEntries, pushSplitPairwiseWarning, addCommonContrastWarnings } from "./exportContrastWarnings";
import { computeTeleportWarnings, computeElevatorIndistinguishableWarning } from "./exportTeleportWarnings";
import { computeMarkerExtensionHitsCorridorWarning } from "./exportCorridorWarnings";

/** One export-method-specific warning — a maze can be perfectly valid QC-wise but a particular
 *  render mode still can't depict some case correctly (GitHub issue #298), e.g. a teleport whose
 *  border/marker size settings currently render it invisible. Distinct from `IssueDto` (generic
 *  maze validity, `Specs/quality_control.md`) — these are presentation caveats of one specific
 *  `RenderModeId`, not maze problems. Renderer-agnostic (no Pixi/store dependency) so any consumer
 *  — the settings panel today, a future feature-card status summary — can call the same
 *  `compute*Warnings` function and get the same list. */
export type ExportWarningId =
  | "teleport_marker_invisible"
  | "teleport_group_ambiguous"
  /** Merge mode on (GitHub issue #868), teleports really share a cell, and connectors are off — the
   *  merged marker shows no real links. Highlights the teleports drawn merged. */
  | "teleport_merged_without_connectors"
  | "teleport_waypoint_overlap"
  /** Both vector modes (GitHub issue #862) — a drawn teleport connector (line plus its gap) passes
   *  over a one-way indicator, which draws below it, so the passage reads as two-way. Highlights
   *  the covered one-way passages. */
  | "teleport_connector_covers_one_way"
  | "waypoint_on_split"
  | "teleport_on_special_split"
  /** Start/finish marker caption, elevator floor badge or teleport floor badge text exceeds its plate
   *  in width or height (GitHub issue #707). One id per element kind so the message can name it. */
  | "marker_text_overflow"
  | "elevator_badge_text_overflow"
  | "marker_index_text_overflow"
  /** Both vector modes (GitHub issue #744) — a marker-index plate (border included) overlaps the
   *  stop line (wall tick) of a one-way vertical passage marker, so that end may read as two-way. */
  | "marker_index_covers_stop_line"
  | "teleport_badge_text_overflow"
  | "floor_label_text_overflow"
  /** "Vector by walls" only (GitHub issue #347) — a `VerticalPassage`/`Elevator` marker's own
   *  `from` node lands on a specially-rendered split point (bridge/diagonal), same rationale as
   *  `waypoint_on_split`/`teleport_on_special_split`. */
  | "vertical_on_special_split"
  /** "Vector by corridors" only (GitHub issue #312) — the one-way chevron row's own settings
   *  (count/length/gap/width) would overflow past a single cell's bounds along the corridor
   *  (`TILE_SIZE`) or across it (the corridor's own `thickness`). One warning total, covering every
   *  overflowing one-way passage. */
  | "one_way_arrows_overflow_corridor"
  /** "Vector by corridors" only — a thick passage plus both sides of a split gap exceeds the
   *  40px safe width used by split cells, so the rendered gap may be reduced. */
  | "split_gap_may_shrink"
  /** "Vector by corridors" only (GitHub issue #802) — a marker's corridor-colored widen patch
   *  reaches a corridor segment that does not belong to the marker's own node. */
  | "marker_extension_hits_corridor"
  /** PNG export canvas-fit warnings (not maze-content geometry) — built locally by
   *  `PngExportSettingsPanel` from `computeDigitalExportFit`/`computePrintExportFit`'s own result,
   *  not through `computeVectorByWallsWarnings`. Carry no `nodes`/`edges` (canvas-level, not
   *  per-cell). */
  | "png_content_overflows_canvas"
  /** Print mode: content's placed rect extends past the sheet's own edges — part of the maze is
   *  actually clipped/lost on export, not just sitting close to an edge. */
  | "png_content_clips_sheet"
  /** Print mode: content's placed rect extends past the margin-inset rect (still within the
   *  sheet, so nothing is lost) — informational, the user asked for a margin and part of the
   *  content sits inside it. */
  | "png_content_in_margin_zone"
  /** "Vector by walls" only (GitHub issue #430) — an `Elevator` marker's own floor-number badge
   *  ring visually overlaps itself: two or more badges sit closer than `2 * badgeRadius` apart
   *  given the current size/distance/placement settings and the number of floors that elevator
   *  reaches. One warning total, covering every affected elevator marker. */
  | "elevator_badges_overlap"
  /** "Vector by walls" only (GitHub issue #430 follow-ups) — a two-sided elevator badge placement
   *  has more floors on one side than `slotsPerRow` capacity can hold in a single row (after
   *  `evenDistribution`'s own split/fallback rules, see `elevatorBadgesTooMany`) — that side draws
   *  overflowing past its own cell, rather than wrapping (there's no second sub-row any more). One
   *  warning total, covering every affected elevator marker, with the same `crossFloorTargets`
   *  hover-highlight treatment `elevator_badges_overlap` gets; never fires for `"full_circle"`,
   *  which has no per-row capacity (an overflowing uneven arc falls back to the even ring instead of
   *  ever visually breaking, see `computeElevatorBadgePositions`). */
  | "elevator_badges_too_many"
  /** Both vector modes (GitHub issue #471) — "Marker indices" are not shown for elevators (the
   *  feature is off, or its "Coverage" → elevators toggle is off) AND elevator
   *  floor-number badges are disabled AND two unlinked elevators share the same cell on the active
   *  floor, so the player has no way to tell the two apart. One warning total, covering every such
   *  cell (one elevator shaft has at most one node per floor, so two elevator nodes in one cell are
   *  always distinct shafts). */
  | "elevator_indistinguishable"
  | "one_way_low_contrast_corridor"
  | "corridor_low_contrast_background"
  | "teleport_connector_low_contrast_corridor"
  | "teleport_connector_low_contrast_background"
  | "split_low_contrast_corridor"
  | "teleport_connector_low_contrast_floor"
  | "teleport_connector_low_contrast_wall"
  | "split_low_contrast_floor"
  | "grid_low_contrast_background"
  | "inner_grid_low_contrast_floor"
  | "inner_grid_low_contrast_wall"
  | "marker_fill_low_contrast"
  | "marker_border_low_contrast"
  | "marker_fill_low_contrast_corridor"
  | "marker_fill_low_contrast_floor"
  | "marker_border_low_contrast_corridor"
  | "marker_border_low_contrast_floor"
  | "label_low_contrast"
  | "teleport_badge_text_low_contrast"
  | "vertical_arrow_low_contrast"
  | "vertical_one_way_arrow_low_contrast_fill"
  | "elevator_arrow_low_contrast"
  | "elevator_badge_fill_low_contrast"
  | "elevator_badge_fill_low_contrast_corridor"
  | "elevator_badge_fill_low_contrast_floor"
  | "teleport_badge_border_low_contrast"
  | "teleport_badge_border_low_contrast_corridor"
  | "teleport_badge_border_low_contrast_floor"
  | "teleport_badge_fill_low_contrast"
  | "teleport_badge_fill_low_contrast_corridor"
  | "teleport_badge_fill_low_contrast_floor"
  | "split_low_contrast_background"
  | "split_colors_low_contrast_each_other"
  | "wall_low_contrast_floor"
  | "vertical_two_way_line_low_contrast_floor"
  | "vertical_two_way_arrow_low_contrast_floor"
  | "vertical_one_way_line_low_contrast_floor"
  | "vertical_one_way_accent_low_contrast_floor"
  | "elevator_line_low_contrast_floor"
  | "floor_label_fill_low_contrast_corridor"
  | "floor_label_fill_low_contrast_floor"
  | "floor_label_border_low_contrast_corridor"
  | "floor_label_border_low_contrast_floor"
  | "floor_label_text_low_contrast";

export type ExportWarning = {
  id: ExportWarningId;
  /** One warning per `id`, always — every occurrence of the same kind of caveat collapses into a
   *  single entry (e.g. every colliding teleport group, every overlapping waypoint) so the panel
   *  shows one bubble per warning *type*, not one per affected entity. `key` is just `id` itself,
   *  kept as its own field (rather than reusing `id` directly) so the hover-highlight lookup and
   *  the list's React key share one source of truth. */
  key: string;
  /** Node ids whose position(s) should be highlighted on hover — a point marker for each,
   *  spanning every entity this warning covers (all colliding groups, all overlapping waypoints,
   *  etc.), not just the first one found. */
  nodes: number[];
  /** [from, to] node-id pairs whose connecting line should be highlighted on hover, in addition to
   *  `nodes`. */
  edges: [number, number][];
  /** Keys of the foreground/background color fields (`PC.*`, `colorFieldKeys.ts`) the contrast check
   *  compared — labels for the detailed explanation are derived from the field registry. Omitted when
   *  either color has no owning field. */
  colorFields?: [ColorFieldKey, ColorFieldKey];
  /** Every color field this warning concerns (for the color picker: "does a warning exist on my
   *  field?"). Usually the two `colorFields`; the split palette check lists every offending slot. */
  fields?: ColorFieldKey[];
  /** Actual foreground/background values used by the contrast check, in RGB integer form. */
  colorValues?: [number, number];
  /** Explicit rendered cells for warnings whose visual target is not a node (e.g. a cross-floor
   *  teleport badge at the snapped midpoint). */
  cells?: { x: number; y: number; floorIndex: number }[];
  /** `(onFloorNode, targetFloorIndex)` pairs for a floor-crossing warning whose flagged entity has
   *  no real off-floor node of its own to point `edges` at (GitHub issue #430's
   *  `elevator_badges_overlap`: the elevator's own badge ring reaches several floors, each a plain
   *  floor index, not a specific node id) — same click-to-navigate floor-bubble treatment
   *  `IssueHighlightOverlay`'s own cross-floor markers give a real off-floor edge endpoint
   *  (`ExportWarningHighlight`, mirroring `BaseGraphRenderer.renderCrossFloorMarkers`), but built
   *  directly from known floor indices instead of `buildCrossFloorMarkers`' pair/level-resolution
   *  machinery, which has no node id to resolve here. Omitted (or empty) for every other warning
   *  id — no bubbles drawn. */
  crossFloorTargets?: { nodeId: number; targetFloorIndex: number }[];
};

/** Filters `nodeIds` down to those sitting on one of `specialSplitPointKeys` — shared by
 *  `waypoint_on_split` (checked against `start`/`finish`) and `teleport_on_special_split` (checked
 *  against every teleport endpoint), which otherwise differ only in which node ids they check. */
function filterNodesOnSpecialSplit(
  nodeIds: Iterable<number>,
  nodeById: Map<number, NodeDto>,
  specialSplitPointKeys: ReadonlySet<string>,
): number[] {
  const result: number[] = [];
  for (const id of nodeIds) {
    const node = nodeById.get(id);
    if (node && specialSplitPointKeys.has(`${node.x},${node.y}`)) result.push(id);
  }
  return result;
}

export type WarningFloor = { id: string; title?: string };

function mergeWarningsAcrossFloors(warningLists: ExportWarning[][], allNodes: NodeDto[]): ExportWarning[] {
  const byKey = new Map<string, ExportWarning>();
  const nodeById = new Map(allNodes.map((node) => [node.id, node]));
  for (const warnings of warningLists) {
    for (const warning of warnings) {
      const existing = byKey.get(warning.key);
      if (!existing) {
        byKey.set(warning.key, {
          ...warning,
          nodes: Array.from(new Set(warning.nodes)),
          edges: Array.from(new Set(warning.edges.map(([from, to]) => `${from}:${to}`))).map((key) => key.split(":").map(Number) as [number, number]),
          cells: warning.cells ? [...warning.cells] : undefined,
          fields: warning.fields ? [...warning.fields] : undefined,
          crossFloorTargets: warning.crossFloorTargets ? [...warning.crossFloorTargets] : undefined,
        });
        continue;
      }
      existing.nodes = Array.from(new Set([...existing.nodes, ...warning.nodes]));
      const edgeKeys = new Set(existing.edges.map(([from, to]) => `${from}:${to}`));
      for (const edge of warning.edges) {
        const key = `${edge[0]}:${edge[1]}`;
        if (!edgeKeys.has(key)) { existing.edges.push(edge); edgeKeys.add(key); }
      }
      existing.crossFloorTargets = [...(existing.crossFloorTargets ?? []), ...(warning.crossFloorTargets ?? [])];
      existing.cells = [...(existing.cells ?? []), ...(warning.cells ?? [])];
      if (warning.fields) existing.fields = Array.from(new Set([...(existing.fields ?? []), ...warning.fields]));
    }
  }
  for (const warning of byKey.values()) {
    const targets = new Map<string, { nodeId: number; targetFloorIndex: number }>();
    for (const target of warning.crossFloorTargets ?? []) targets.set(`${target.nodeId}:${target.targetFloorIndex}`, target);
    for (const nodeId of warning.nodes) {
      const node = nodeById.get(nodeId);
      if (node) targets.set(`${nodeId}:${node.level ?? 0}`, { nodeId, targetFloorIndex: node.level ?? 0 });
    }
    warning.crossFloorTargets = Array.from(targets.values());
    if (warning.cells) {
      const cellKeys = new Set<string>();
      warning.cells = warning.cells.filter((cell) => {
        const key = `${cell.x}:${cell.y}:${cell.floorIndex}`;
        if (cellKeys.has(key)) return false;
        cellKeys.add(key);
        return true;
      });
    }
  }
  return Array.from(byKey.values());
}

/** Teleport context of one floor's warning pass, built from the *unscoped* graph. */
function buildFloorContext(nodes: NodeDto[], edges: EdgeDto[], floors: WarningFloor[], floor: WarningFloor): TeleportFloorContext {
  return {
    resolveNodeLevel: selectNodeLevelResolver(nodes),
    unscopedNodeById: new Map(nodes.map((node) => [node.id, node])),
    unscopedEdges: edges,
    activeFloorIndex: Math.max(floors.findIndex((candidate) => candidate.id === floor.id), 0),
    floorCount: floors.length,
  };
}

/** Floors with an export cut line (GitHub issue #859), by id: the argument of the `*AcrossFloors` passes. */
const NO_CUT_FLOORS: ReadonlySet<string> = new Set();

export function computeVectorByWallsWarningsAcrossFloors(
  nodes: NodeDto[], edges: EdgeDto[], floors: WarningFloor[], cfg: FieldConfig,
  settings: VectorByWallsSettings, start: number | null, finish: number | null,
  cutFloorIds: ReadonlySet<string> = NO_CUT_FLOORS,
): ExportWarning[] {
  const warningLists = floors.map((floor) => {
    const scoped = selectFloorScopedMaze(nodes, edges, floors, floor.id, start, finish);
    const floorContext = buildFloorContext(nodes, edges, floors, floor);
    return computeVectorByWallsWarnings(scoped.nodes, scoped.edges, cfg, settings, scoped.start, scoped.finish, nodes, floorContext, floor.title, !cutFloorIds.has(floor.id));
  });
  return mergeWarningsAcrossFloors(warningLists, nodes);
}

export function computeVectorByCorridorsWarningsAcrossFloors(
  nodes: NodeDto[], edges: EdgeDto[], floors: WarningFloor[], cfg: FieldConfig,
  settings: VectorByCorridorsSettings, start: number | null, finish: number | null,
  cutFloorIds: ReadonlySet<string> = NO_CUT_FLOORS,
): ExportWarning[] {
  const corridorFaceLimit = shortestCorridorFaceAcrossFloors(nodes, edges, floors, cfg);
  const warningLists = floors.map((floor) => {
    const scoped = selectFloorScopedMaze(nodes, edges, floors, floor.id, start, finish);
    const floorContext = buildFloorContext(nodes, edges, floors, floor);
    return computeVectorByCorridorsWarnings(scoped.nodes, scoped.edges, cfg, settings, scoped.start, scoped.finish, floorContext, nodes, floor.title, corridorFaceLimit, !cutFloorIds.has(floor.id));
  });
  return mergeWarningsAcrossFloors(warningLists, nodes);
}

/** Visibility context of a warning pass. Built from the *unscoped* graph (a floor-scoped edge list
 *  can't tell a two-way passage from a one-way one — its reverse half lives on another floor); the
 *  per-floor data conditions (does this floor have such an edge) stay with the callers. A minimal
 *  floor array preserves project-wide visibility for the floor-label colors. */
function warningVisibility(nodes: NodeDto[], edges: EdgeDto[], settings: VectorByWallsSettings | VectorByCorridorsSettings, floorCount?: number): ColorVisibilityContext {
  const count = floorCount ?? new Set(nodes.map((node) => node.level ?? 0)).size;
  const floors = Array.from({ length: count }, (_, i) => ({ id: String(i) })) as unknown as ColorVisibilityMaze["floors"];
  return buildColorVisibility({ nodes, edges, floors }, settings);
}

/** `marker_index_covers_stop_line` (GitHub issue #744): on the displayed floor, every one-way
 *  vertical passage marker whose stop line (wall tick) is overlapped by any marker-index plate —
 *  its body plus border, never its floor-colored gap ring, which is drawn under the markers. The
 *  plate body is drawn above the markers, so an overlap hides part of the stop line. Mirrors both
 *  mode renderers: markers from `buildVerticalConnectionMarkers`, plates from
 *  `buildMarkerIndexLabels` + `markerIndexPlateBox`. Highlights the affected markers. */
function computeMarkerIndexStopLineWarning(
  nodeById: Map<number, NodeDto>,
  edges: EdgeDto[],
  cfg: FieldConfig,
  settings: VectorByWallsSettings | VectorByCorridorsSettings,
  verticalStyle: VerticalConnectionStyle,
  teleportEdges: TeleportEdge[],
  displayFloorIndex: number,
  unscoped: { nodes: NodeDto[]; edges: EdgeDto[] },
): ExportWarning | null {
  const index = settings.markerIndex;
  if (!index.enabled) return null;
  const markers = buildVerticalConnectionMarkers(
    nodeById, edges, cfg, selectNodeLevelResolver(unscoped.nodes), displayFloorIndex,
    selectVerticalPassagePairSet(unscoped.edges), unscoped.edges, settings.replaceTwoFloorElevatorsWithStairs,
  );
  const stopLines = markers.flatMap((marker) => {
    const shape = oneWayStopLineShape(marker, verticalStyle);
    return shape ? [{ node: marker.fromNode, shape }] : [];
  });
  if (stopLines.length === 0) return null;

  // Plate placement depends only on each endpoint marker's outer radius, never on its colors, so
  // the teleport gap color and group customization are irrelevant here.
  const resolveEndpointVisual = buildMarkerIndexEndpointResolver({
    teleportEdges, teleportStyle: buildTeleportLineStyle(settings, 0), groupCustomization: false, mergeTeleports: settings.teleportMergeMode, groupOverrides: {}, verticalStyle,
  });
  const { labels } = buildMarkerIndexLabels(unscoped.nodes, unscoped.edges, cfg, displayFloorIndex, index, resolveEndpointVisual);
  const plates = labels.map((label) => {
    const box = markerIndexPlateBox(label, index);
    const border = box.borderWidth;
    return {
      x: box.x - border, y: box.y - border, w: box.w + 2 * border, h: box.h + 2 * border,
      radius: box.cornerRadius + border,
    };
  });
  const flagged = stopLines
    .filter(({ shape }) => plates.some((plate) => stopLineOverlapsRoundedRect(shape, plate)))
    .map(({ node }) => node);
  if (flagged.length === 0) return null;
  return { id: "marker_index_covers_stop_line", key: "marker_index_covers_stop_line", nodes: Array.from(new Set(flagged)), edges: [] };
}

export function computeVectorByWallsWarnings(
  nodes: NodeDto[],
  edges: EdgeDto[],
  cfg: FieldConfig,
  rawSettings: VectorByWallsSettings,
  start: number | null,
  finish: number | null,
  unscopedNodes: NodeDto[] = nodes,
  teleportFloorContext?: TeleportFloorContext,
  displayFloorTitle?: string,
  highlightSeamMirrors = true,
): ExportWarning[] {
  const settings = withResolvedGroupOverrides(rawSettings);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const teleportEdges = buildTeleportEdges(nodeById, edges, cfg, teleportFloorContext);
  const allNodes = Array.from(nodeById.values());
  const resolveNodeLevel = selectNodeLevelResolver(unscopedNodes);

  const warnings: ExportWarning[] = computeTeleportWarnings(
    teleportEdges,
    settings,
    { id: start, size: settings.startMarker.size, borderWidth: settings.startMarker.borderWidth },
    { id: finish, size: settings.finishMarker.size, borderWidth: settings.finishMarker.borderWidth },
    allNodes,
    cfg,
    edges,
  );

  const coversOneWay = computeTeleportConnectorCoversOneWayWarning({
    mode: "walls", settings, nodes, edges, cfg, start, finish, teleportEdges,
    unscopedNodes, unscopedEdges: teleportFloorContext?.unscopedEdges ?? edges,
    activeFloorIndex: teleportFloorContext?.activeFloorIndex ?? nodes[0]?.level ?? 0,
  });
  if (coversOneWay) warnings.push(coversOneWay);

  const ctx = warningVisibility(unscopedNodes, teleportFloorContext?.unscopedEdges ?? edges, settings, teleportFloorContext?.floorCount);
  addCommonContrastWarnings(
    warnings, nodes, edges, ctx, teleportEdges, unscopedNodes, teleportFloorContext?.unscopedEdges ?? edges, start, finish,
    teleportFloorContext?.activeFloorIndex ?? nodes[0]?.level ?? 0, cfg,
  );

  if (teleportEdges.length > 0) {
    pushContrastWarningEntries(warnings, "teleport_connector_low_contrast_floor", teleportConnectorEntries(teleportEdges, ctx, visibleColor(ctx, "tilesFloor")));
    if (settings.teleportConnectorGapWidth === 0) {
      pushContrastWarningEntries(warnings, "teleport_connector_low_contrast_wall", teleportConnectorEntries(teleportEdges, ctx, visibleColor(ctx, "tilesWall")));
    }
  }
  const splitFloor = splitContrastData(nodes, edges, cfg, ctx, highlightSeamMirrors);
  pushContrastWarningEntries(warnings, "split_low_contrast_floor", splitColorEntries(splitFloor, visibleColor(ctx, "tilesFloor")));
  pushSplitPairwiseWarning(warnings, splitFloor);

  // Split points recognized as a dedicated "special shape" (bridge/diagonal, `SplitSpecialShapeKind`)
  // — only these draw noticeably different geometry from a generic split point, and only when
  // `splitSpecialShapes` is actually on (off, every split point draws the plain per-node reading,
  // which a waypoint/teleport endpoint handles fine — see GitHub issue #298 follow-up). Keyed by
  // point (`"${x},${y}"`), resolved once and shared by both checks below.
  const specialSplitPointKeys = new Set<string>();
  if (settings.splitSpecialShapes && maxSplitNodeCount(nodes) > 0) {
    const { specialShapes } = buildSplitPassages(nodes, edges, cfg);
    for (const shape of specialShapes) specialSplitPointKeys.add(shape.pointKey);
  }

  // --- waypoint_on_split: start/finish lands on a specially-rendered split point (bridge/
  // diagonal) — that geometry draws differently from a plain split point and a waypoint marker
  // there can visually collide with it. One warning total, covering start and/or finish. ---
  if (specialSplitPointKeys.size > 0) {
    const flaggedIds = filterNodesOnSpecialSplit(
      [start, finish].filter((id): id is number => id !== null),
      nodeById,
      specialSplitPointKeys,
    );
    if (flaggedIds.length > 0) {
      warnings.push({
        id: "waypoint_on_split",
        key: "waypoint_on_split",
        nodes: flaggedIds,
        edges: [],
      });
    }
  }

  // --- teleport_on_special_split: a teleport endpoint lands on a specially-rendered split point
  // (bridge/diagonal) — same rationale as `waypoint_on_split`, checked separately since a teleport
  // endpoint's own marker geometry differs from a waypoint marker's. One warning total. ---
  if (specialSplitPointKeys.size > 0) {
    const teleportNodeIds = new Set<number>();
    for (const e of teleportEdges) {
      if (e.fromNode !== undefined) teleportNodeIds.add(e.fromNode);
      if (e.toNode !== undefined) teleportNodeIds.add(e.toNode);
    }
    const flaggedIds = filterNodesOnSpecialSplit(teleportNodeIds, nodeById, specialSplitPointKeys);
    if (flaggedIds.length > 0) {
      warnings.push({
        id: "teleport_on_special_split",
        key: "teleport_on_special_split",
        nodes: flaggedIds,
        edges: [],
      });
    }
  }

  // --- vertical_on_special_split: a VerticalPassage/Elevator marker's own `from` node lands on a
  // specially-rendered split point — same rationale as teleport_on_special_split. One warning
  // total, covering every affected marker. ---
  if (specialSplitPointKeys.size > 0) {
    const verticalNodeIds = new Set<number>();
    for (const e of edges) {
      if (e.kind === "vertical_passage" || e.kind === "elevator") verticalNodeIds.add(e.from);
    }
    const flaggedIds = filterNodesOnSpecialSplit(verticalNodeIds, nodeById, specialSplitPointKeys);
    if (flaggedIds.length > 0) {
      warnings.push({
        id: "vertical_on_special_split",
        key: "vertical_on_special_split",
        nodes: flaggedIds,
        edges: [],
      });
    }
  }

  // --- elevator_badges_overlap / elevator_badges_too_many: an Elevator marker's own floor-number
  // badge ring either visually overlaps itself, or has more floors on one side than that side's
  // single row can hold (GitHub issue #430, #430 follow-ups). One warning total per id, covering
  // every affected marker; each warning's own `crossFloorTargets` carries every reached floor of
  // every flagged marker (not just the specific overlapping pair, or the specific overflowing side)
  // so the hover highlight can show a click-to-navigate bubble per floor, same as
  // `IssueHighlightOverlay`'s cross-floor markers. Mirrors `VerticalConnectionRenderer.
  // drawElevatorBadges`'s own `markerRadius`/`badgeRadius` computation exactly (`elevatorMarker.size`,
  // no border-width addition — unlike `markerWorldRadius` above, which is only used
  // for the teleport/waypoint overlap check). ---
  if (settings.elevatorBadges.enabled) {
    const verticalPairs = selectVerticalPassagePairSet(edges);
    const markers = buildVerticalConnectionMarkers(nodeById, edges, cfg, resolveNodeLevel, 0, verticalPairs, edges);
    const markerRadius = settings.elevatorMarker.size / 2;
    const badgeRadius = settings.elevatorBadges.size / 2 + settings.elevatorBadges.borderWidth;
    const overlappingNodeIds: number[] = [];
    const overlappingTargets: { nodeId: number; targetFloorIndex: number }[] = [];
    const tooManyNodeIds: number[] = [];
    const tooManyTargets: { nodeId: number; targetFloorIndex: number }[] = [];
    for (const marker of markers) {
      if (marker.kind !== "elevator" || !marker.targetFloorIndices || marker.targetFloorIndices.length < 2) continue;
      const count = marker.targetFloorIndices.length;
      const positions = computeElevatorBadgePositions(
        marker.pos[0], marker.pos[1], markerRadius, count, badgeRadius,
        settings.elevatorBadges.distance, settings.elevatorBadges.gap, settings.elevatorBadges.placement,
        settings.elevatorBadges.evenDistribution,
      );
      if (elevatorBadgesOverlap(positions, badgeRadius)) {
        overlappingNodeIds.push(marker.fromNode);
        for (const targetFloorIndex of marker.targetFloorIndices) overlappingTargets.push({ nodeId: marker.fromNode, targetFloorIndex });
      }
      if (elevatorBadgesTooMany(count, badgeRadius, settings.elevatorBadges.gap, settings.elevatorBadges.placement, settings.elevatorBadges.evenDistribution)) {
        tooManyNodeIds.push(marker.fromNode);
        for (const targetFloorIndex of marker.targetFloorIndices) tooManyTargets.push({ nodeId: marker.fromNode, targetFloorIndex });
      }
    }
    if (overlappingNodeIds.length > 0) {
      warnings.push({
        id: "elevator_badges_overlap",
        key: "elevator_badges_overlap",
        nodes: overlappingNodeIds,
        edges: [],
        crossFloorTargets: overlappingTargets,
      });
    }
    if (tooManyNodeIds.length > 0) {
      warnings.push({
        id: "elevator_badges_too_many",
        key: "elevator_badges_too_many",
        nodes: tooManyNodeIds,
        edges: [],
        crossFloorTargets: tooManyTargets,
      });
    }
  }

  pushTextOverflowWarnings(warnings, collectTextFitEntries(
    nodeById, edges, cfg, teleportEdges, settings, start, finish, resolveNodeLevel,
    teleportFloorContext?.activeFloorIndex ?? nodes[0]?.level ?? 0,
    { nodes: unscopedNodes, edges: teleportFloorContext?.unscopedEdges ?? edges },
    displayFloorTitle,
  ));

  const stopLineCovered = computeMarkerIndexStopLineWarning(
    nodeById, edges, cfg, settings, buildVerticalConnectionStyle(settings, settings.floorColor, settings), teleportEdges,
    teleportFloorContext?.activeFloorIndex ?? nodes[0]?.level ?? 0,
    { nodes: unscopedNodes, edges: teleportFloorContext?.unscopedEdges ?? edges },
  );
  if (stopLineCovered) warnings.push(stopLineCovered);

  const indistinguishable = computeElevatorIndistinguishableWarning(
    nodes, edges, settings.markerIndex.enabled && settings.markerIndex.coverage.elevator, settings.elevatorBadges.enabled,
  );
  if (indistinguishable) warnings.push(indistinguishable);

  return warnings;
}

/** Every export-specific warning "Vector by corridors" currently knows how to detect (GitHub issue
 *  #311, teleport checks added as a #313 follow-up bugfix — this mode reuses `TeleportRenderer`
 *  as-is, so it can hit the exact same "ambiguous group"/"invisible marker"/"waypoint overlap"
 *  caveats "Vector by walls" already flags, and previously silently didn't). Kept as its own
 *  function (not folded into `computeVectorByWallsWarnings`) since the two modes' warning sets
 *  still differ in their one-way overflow check. `waypoint_on_split`/`teleport_on_special_split`
 *  (GitHub issue #314) are now shared with "Vector by walls" — this mode draws the exact same
 *  bridge/diagonal special-shape geometry, gated on the same `splitSpecialShapes` setting, so the
 *  same caveat applies: a marker/teleport endpoint landing on a recognized special-shape point can
 *  visually collide with that shape's own geometry. */
export function computeVectorByCorridorsWarnings(
  nodes: NodeDto[],
  edges: EdgeDto[],
  cfg: FieldConfig,
  rawSettings: VectorByCorridorsSettings,
  start: number | null,
  finish: number | null,
  unscopedNodesOrContext?: NodeDto[] | TeleportFloorContext,
  allNodesForWarnings: NodeDto[] = Array.isArray(unscopedNodesOrContext) ? unscopedNodesOrContext : nodes,
  displayFloorTitle?: string,
  maxCorridorFace?: number,
  highlightSeamMirrors = true,
): ExportWarning[] {
  const settings = withResolvedGroupOverrides(rawSettings);
  const teleportFloorContext = Array.isArray(unscopedNodesOrContext) ? undefined : unscopedNodesOrContext;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const teleportEdges = buildTeleportEdges(nodeById, edges, cfg, teleportFloorContext);
  const allNodes = Array.from(nodeById.values());

  const warnings: ExportWarning[] = computeTeleportWarnings(
    teleportEdges,
    settings,
    { id: start, size: settings.startMarker.size, borderWidth: settings.startMarker.borderWidth },
    { id: finish, size: settings.finishMarker.size, borderWidth: settings.finishMarker.borderWidth },
    allNodes,
    cfg,
    edges,
  );

  const coversOneWay = computeTeleportConnectorCoversOneWayWarning({
    mode: "corridors", settings, nodes, edges, cfg, start, finish, teleportEdges,
    unscopedNodes: allNodesForWarnings, unscopedEdges: teleportFloorContext?.unscopedEdges ?? edges,
    activeFloorIndex: teleportFloorContext?.activeFloorIndex ?? nodes[0]?.level ?? 0,
  });
  if (coversOneWay) warnings.push(coversOneWay);

  const ctx = warningVisibility(allNodesForWarnings, teleportFloorContext?.unscopedEdges ?? edges, settings, teleportFloorContext?.floorCount);
  addCommonContrastWarnings(
    warnings, nodes, edges, ctx, teleportEdges, allNodesForWarnings, teleportFloorContext?.unscopedEdges ?? edges, start, finish,
    teleportFloorContext?.activeFloorIndex ?? nodes[0]?.level ?? 0, cfg,
  );

  const corridorSegments = buildCorridorSegments(nodes, edges, cfg);
  const markerExtensionHitsCorridor = computeMarkerExtensionHitsCorridorWarning(
    corridorSegments, maxCorridorFace ?? shortestCorridorFace(corridorSegments), nodeById, cfg, edges, settings, start, finish,
  );
  if (markerExtensionHitsCorridor) warnings.push(markerExtensionHitsCorridor);
  if (corridorSegments.length > 0) {
    pushContrastWarning(warnings, "corridor_low_contrast_background", [[visibleColor(ctx, "corridorFill"), visibleColor(ctx, "bgFill")]]);
  }
  if (corridorSegments.some((segment) => segment.oneWayDir)) {
    pushContrastWarning(
      warnings,
      "one_way_low_contrast_corridor",
      [[visibleColor(ctx, "oneWaysMarker"), visibleColor(ctx, "corridorFill")]],
      corridorSegments.filter((segment) => segment.oneWayDir).flatMap((segment) => [segment.fromNode, segment.toNode]),
      corridorSegments.filter((segment) => segment.oneWayDir).map((segment) => [segment.fromNode, segment.toNode]),
    );
  }
  if (teleportEdges.length > 0) {
    pushContrastWarningEntries(warnings, "teleport_connector_low_contrast_corridor", teleportConnectorEntries(teleportEdges, ctx, visibleColor(ctx, "corridorFill")));
    if (settings.teleportConnectorGapWidth === 0) {
      pushContrastWarningEntries(warnings, "teleport_connector_low_contrast_background", teleportConnectorEntries(teleportEdges, ctx, visibleColor(ctx, "bgFill")));
    }
  }
  const splitCorridor = splitContrastData(nodes, edges, cfg, ctx, highlightSeamMirrors);
  pushContrastWarningEntries(warnings, "split_low_contrast_corridor", splitColorEntries(splitCorridor, visibleColor(ctx, "corridorFill")));
  pushContrastWarningEntries(warnings, "split_low_contrast_background", splitColorEntries(splitCorridor, visibleColor(ctx, "bgFill")));
  pushSplitPairwiseWarning(warnings, splitCorridor);

  if (settings.thickness + 2 * settings.splitGapWidth > 40) {
    warnings.push({
      id: "split_gap_may_shrink",
      key: "split_gap_may_shrink",
      nodes: [],
      edges: [],
    });
  }

  const specialSplitPointKeys = new Set<string>();
  if (settings.splitSpecialShapes && maxSplitNodeCount(nodes) > 0) {
    const { specialShapes } = buildSplitPassages(nodes, edges, cfg);
    for (const shape of specialShapes) specialSplitPointKeys.add(shape.pointKey);
  }

  if (specialSplitPointKeys.size > 0) {
    const flaggedIds = filterNodesOnSpecialSplit(
      [start, finish].filter((id): id is number => id !== null),
      nodeById,
      specialSplitPointKeys,
    );
    if (flaggedIds.length > 0) {
      warnings.push({
        id: "waypoint_on_split",
        key: "waypoint_on_split",
        nodes: flaggedIds,
        edges: [],
      });
    }

    const teleportNodeIds = new Set<number>();
    for (const e of teleportEdges) {
      if (e.fromNode !== undefined) teleportNodeIds.add(e.fromNode);
      if (e.toNode !== undefined) teleportNodeIds.add(e.toNode);
    }
    const flaggedTeleportIds = filterNodesOnSpecialSplit(teleportNodeIds, nodeById, specialSplitPointKeys);
    if (flaggedTeleportIds.length > 0) {
      warnings.push({
        id: "teleport_on_special_split",
        key: "teleport_on_special_split",
        nodes: flaggedTeleportIds,
        edges: [],
      });
    }
  }

  // --- one_way_arrows_overflow_corridor: the chevron row's own full visible extent exceeds a
  // cell's own size along the corridor, or its width (oneWayWidth * thickness) exceeds the
  // corridor's own thickness — GitHub issue #312, gap-accounts-for-thickness follow-up. Mirrors
  // `VectorByCorridorsRenderer`'s own `oneWayLengthPx` (`oneWayLength` is a multiplier of the
  // chevron's own full opening width, not an absolute pixel size — GitHub issue #312 follow-up) and
  // `drawOneWayChevronRow`'s own `chevronRowStep` spacing exactly: `(count-1)` steps between
  // chevron centers, plus the trailing chevron's own `length + thickness` overhang past its
  // center. Checked once against the settings (every one-way passage draws the exact same row
  // geometry), then applied via `buildCorridorSegments`' own `oneWayDir` — the same segments this
  // mode's renderer actually draws a chevron row for (geometric neighbors, split points already
  // excluded), not a looser re-derivation from the raw edge list that could flag an edge with no
  // drawn corridor segment at all. ---
  const oneWayFullWidth = settings.oneWayWidth * settings.thickness;
  const oneWayLengthPx = settings.oneWayLength * oneWayFullWidth;
  const rowStep = chevronRowStep(oneWayLengthPx, settings.oneWayGap, settings.oneWayThickness);
  const rowLength = (settings.oneWayCount - 1) * rowStep + oneWayLengthPx + settings.oneWayThickness;
  const rowOverflows = rowLength > TILE_SIZE || settings.oneWayWidth > 1;
  if (rowOverflows) {
    const oneWaySegments = buildCorridorSegments(nodes, edges, cfg).filter((seg) => seg.oneWayDir);
    if (oneWaySegments.length > 0) {
      const flaggedNodeIds = new Set<number>();
      const flaggedEdgePairs: [number, number][] = [];
      for (const seg of oneWaySegments) {
        flaggedNodeIds.add(seg.fromNode);
        flaggedNodeIds.add(seg.toNode);
        flaggedEdgePairs.push([seg.fromNode, seg.toNode]);
      }
      warnings.push({
        id: "one_way_arrows_overflow_corridor",
        key: "one_way_arrows_overflow_corridor",
        nodes: Array.from(flaggedNodeIds),
        edges: flaggedEdgePairs,
      });
    }
  }

  pushTextOverflowWarnings(warnings, collectTextFitEntries(
    nodeById, edges, cfg, teleportEdges, settings, start, finish, selectNodeLevelResolver(allNodesForWarnings),
    teleportFloorContext?.activeFloorIndex ?? nodes[0]?.level ?? 0,
    { nodes: allNodesForWarnings, edges: teleportFloorContext?.unscopedEdges ?? edges },
    displayFloorTitle,
  ));

  const stopLineCovered = computeMarkerIndexStopLineWarning(
    nodeById, edges, cfg, settings, buildVerticalConnectionStyle(settings, settings.color), teleportEdges,
    teleportFloorContext?.activeFloorIndex ?? nodes[0]?.level ?? 0,
    { nodes: allNodesForWarnings, edges: teleportFloorContext?.unscopedEdges ?? edges },
  );
  if (stopLineCovered) warnings.push(stopLineCovered);

  const indistinguishable = computeElevatorIndistinguishableWarning(
    nodes, edges, settings.markerIndex.enabled && settings.markerIndex.coverage.elevator, settings.elevatorBadges.enabled,
  );
  if (indistinguishable) warnings.push(indistinguishable);

  return warnings;
}
