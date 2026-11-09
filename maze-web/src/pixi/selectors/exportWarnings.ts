import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { FieldConfig } from "../../fieldConfig";
import type { VectorByWallsSettings, VectorByCorridorsSettings } from "../../store/storeTypes";
import { shortestCorridorFaceAcrossFloors, selectNodeLevelResolver, selectFloorScopedMaze } from "./mazeSelectors";
import type { TeleportFloorContext } from "./mazeSelectors";
import type { TeleportGroup } from "./teleportGroups";
export { computeTextFitItemsAcrossFloors } from "./exportTextFit";
export type { TextFitKind } from "./exportTextFit";
import { type ColorFieldKey } from "../colorFieldKeys";
import { trackedMemo, inputMemo } from "./trackedMemo";
import {
  WarningFloorEnv, TELEPORT_CONNECTORS_GROUP, WALLS_WARNING_GROUPS, CORRIDORS_WARNING_GROUPS,
  type AnySettings, type WarningGroup, type WarningMode,
} from "./exportWarningGroups";

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
  /** Both vector modes (GitHub issue #945) — presentation caveats of the drawn teleport connectors; each highlights the
   *  offending parts of the connectors as `floorPolygons`. Overlapping lines hide one another. */
  | "teleport_connectors_overlap"
  /** A manually routed connector's end lies outside its marker. */
  | "teleport_connector_endpoint_detached"
  /** "Avoid field exit" is on, but a connector (manual or automatic) leaves the field. */
  | "teleport_connector_leaves_field"
  /** A connector runs over a marker automatic routing steers around (start/finish, vertical passage, another teleport's endpoint or badge). */
  | "teleport_connector_crosses_marker"
  /** A direction arrow's tip or tail lies off the line it sits on (a bend under the arrow, a line shorter than the arrow). */
  | "teleport_connector_arrow_sticks_out"
  /** A one-way connector leaves no room for its arrow between the markers hiding its two ends. */
  | "teleport_connector_too_short_for_arrow"
  | "teleport_connector_covers_arrow"
  /** A connector with both ends in one point, so no line is left to read. */
  | "teleport_connector_degenerate"
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
  | "glue_tab_outline_low_contrast_fill"
  | "glue_tab_fill_low_contrast_background"
  /** Both vector modes (GitHub issue #913) — glue tabs of the active floor overlap each other. Highlights the overlapping tabs as `polygons`. */
  | "glue_tabs_overlap"
  /** Both vector modes (GitHub issue #913) — the inset leaves less than `MIN_TAB_BASE` (10 display units) of an edge for its glue tab. Highlights those tabs as `polygons`. */
  | "glue_tab_too_thin"
  /** Both vector modes (GitHub issue #913) — the inset leaves nothing of a glued stretch, so it gets no tab at all. Highlights the stretch as `bands`. */
  | "glue_tab_missing"
  /** Both vector modes (GitHub issue #902) — two edge markers with different keys have colours too close to tell apart. Highlights them as `polygons`. */
  | "edge_marker_colors_similar"
  /** Both vector modes (GitHub issue #902) — an edge marker colour is too close to the background. Highlights those markers as `polygons`. */
  | "edge_marker_low_contrast_background"
  /** Both vector modes (GitHub issue #920) — alignment marks are hidden and runs from different, disconnected glues have the same wall/passage pattern. Highlights the ambiguous runs as `bands`. */
  | "seam_matching_ambiguous_without_markers"
  | "inner_grid_low_contrast_floor"
  | "inner_grid_low_contrast_wall"
  | "marker_fill_low_contrast_corridor"
  | "marker_fill_low_contrast_floor"
  | "marker_border_low_contrast_corridor"
  | "marker_border_low_contrast_floor"
  | "label_low_contrast"
  | "teleport_badge_text_low_contrast"
  | "vertical_arrow_low_contrast"
  | "vertical_one_way_arrow_low_contrast_fill"
  | "elevator_arrow_low_contrast"
  | "elevator_badge_fill_low_contrast_corridor"
  | "elevator_badge_fill_low_contrast_floor"
  | "teleport_badge_border_low_contrast_corridor"
  | "teleport_badge_border_low_contrast_floor"
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
  /** Arbitrary polygons (display space, active floor) the hover highlight fills (GitHub issue #913), e.g. the offending glue tabs. */
  polygons?: [number, number][][];
  /** Like `polygons`, but each shape belongs to one floor (GitHub issue #945): the connector warnings are computed per floor and merged
   *  across floors, and the mode renderer's hover highlight draws only the shapes of the floor it shows. */
  floorPolygons?: { floorIndex: number; polygon: [number, number][] }[];
  /** Display-space polylines (active floor) the hover highlight draws as boundary bands, like the glue editor's runs (GitHub issue #913). */
  bands?: [number, number][][];
};

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
          floorPolygons: warning.floorPolygons ? [...warning.floorPolygons] : undefined,
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
      if (warning.floorPolygons) existing.floorPolygons = [...(existing.floorPolygons ?? []), ...warning.floorPolygons];
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

/** Runs every group on every floor, each (mode, group, floor) cached under its own tracked slot (GitHub issue #928): a
 *  settings change recomputes only the groups whose recorded reads it touched, a maze change (new `nodes`/`edges`/
 *  `floors`/`cfg`) all of them. Warnings are listed group by group, floors in order within a group. */
function computeGroupsAcrossFloors<S extends AnySettings>(
  mode: WarningMode, groups: readonly WarningGroup<S>[],
  nodes: NodeDto[], edges: EdgeDto[], floors: WarningFloor[], cfg: FieldConfig,
  settings: S, start: number | null, finish: number | null, cutFloorIds: ReadonlySet<string>, hasGlues: boolean,
  corridorFaceLimit?: () => number,
): ExportWarning[] {
  const mergeSlot = `merge:${mode}:${groups.map((group) => group.name).join(",")}`;
  const project = { nodes, edges, floors, start, finish };
  // Scoping and teleport context read floor ids and their order only; a floor's title is a hidden input of the groups that show it.
  const floorsKey = floors.map((floor) => floor.id).join("\u0000");
  const envs = floors.map((floor) => {
    const highlightSeamMirrors = !cutFloorIds.has(floor.id);
    const env = new WarningFloorEnv(mode, () => {
      const scoped = selectFloorScopedMaze(nodes, edges, floors, floor.id, start, finish);
      return {
        nodes: scoped.nodes, edges: scoped.edges, start: scoped.start, finish: scoped.finish, unscopedNodes: nodes,
        floorContext: buildFloorContext(nodes, edges, floors, floor),
      };
    }, { cfg, hasGlues, highlightSeamMirrors, floorTitle: floor.title, corridorFaceLimit, project });
    return { floor, env };
  });
  const warningLists: ExportWarning[][] = [];
  for (const group of groups) {
    for (const { floor, env } of envs) {
      warningLists.push(trackedMemo(
        `${mode}:${group.name}:${floor.id}`,
        [nodes, edges, floorsKey, cfg, start, finish, hasGlues, ...(group.hiddenInputs?.(env) ?? [])],
        settings,
        (tracked) => group.run(env, tracked),
      ));
    }
  }
  // Every group hit returns the same list object, so an unchanged pass hands back the same merged list: no O(nodes) rebuild and no new identity for the panel to re-render on.
  return inputMemo(mergeSlot, [nodes, ...warningLists], () => mergeWarningsAcrossFloors(warningLists, nodes));
}

/** The shortest corridor face of the whole project: it depends on the maze alone, so it is kept apart from the settings-tracked groups. */
function projectCorridorFaceLimit(nodes: NodeDto[], edges: EdgeDto[], floors: WarningFloor[], cfg: FieldConfig): () => number {
  return () => inputMemo("corridorFaceLimit", [nodes, edges, floors, cfg], () => shortestCorridorFaceAcrossFloors(nodes, edges, floors, cfg));
}

export function computeVectorByWallsWarningsAcrossFloors(
  nodes: NodeDto[], edges: EdgeDto[], floors: WarningFloor[], cfg: FieldConfig,
  settings: VectorByWallsSettings, start: number | null, finish: number | null,
  cutFloorIds: ReadonlySet<string> = NO_CUT_FLOORS,
  hasGlues = true,
): ExportWarning[] {
  return computeGroupsAcrossFloors("walls", WALLS_WARNING_GROUPS, nodes, edges, floors, cfg, settings, start, finish, cutFloorIds, hasGlues);
}

/** Only the teleport connector warnings of "Vector by walls" (GitHub issue #952): the `teleportConnectors` group alone, run
 *  through the same per-group cache as the full pass, so the teleport connector editor doesn't compute the other groups. */
export function computeTeleportConnectorWarningsAcrossFloors(
  nodes: NodeDto[], edges: EdgeDto[], floors: WarningFloor[], cfg: FieldConfig,
  settings: VectorByWallsSettings, start: number | null, finish: number | null,
  cutFloorIds: ReadonlySet<string> = NO_CUT_FLOORS,
  hasGlues = true,
): ExportWarning[] {
  const groups = WALLS_WARNING_GROUPS.filter((group) => group.name === TELEPORT_CONNECTORS_GROUP);
  return computeGroupsAcrossFloors("walls", groups, nodes, edges, floors, cfg, settings, start, finish, cutFloorIds, hasGlues);
}

export function computeVectorByCorridorsWarningsAcrossFloors(
  nodes: NodeDto[], edges: EdgeDto[], floors: WarningFloor[], cfg: FieldConfig,
  settings: VectorByCorridorsSettings, start: number | null, finish: number | null,
  cutFloorIds: ReadonlySet<string> = NO_CUT_FLOORS,
  hasGlues = true,
): ExportWarning[] {
  return computeGroupsAcrossFloors(
    "corridors", CORRIDORS_WARNING_GROUPS, nodes, edges, floors, cfg, settings, start, finish, cutFloorIds, hasGlues,
    projectCorridorFaceLimit(nodes, edges, floors, cfg),
  );
}

/** Every export-specific warning "Vector by walls" currently knows how to detect (GitHub issue #298), of one floor, uncached.
 *  The groups themselves live in `exportWarningGroups.ts`; each warning's `nodes`/`edges` back the hover-highlight the
 *  settings panel wires up. `unscopedNodes` (GitHub issue #430) is the maze's full, floor-*un*scoped node list, needed to
 *  resolve a badge's own target floor; optional and defaulted to `nodes` so single-floor callers need no change. */
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
  teleportGroups: TeleportGroup[] = [],
  hasGlues = true,
): ExportWarning[] {
  const env = new WarningFloorEnv(
    "walls",
    () => ({ nodes, edges, start, finish, unscopedNodes, floorContext: teleportFloorContext }),
    { cfg, hasGlues, highlightSeamMirrors, floorTitle: displayFloorTitle, teleportGroups },
  );
  return WALLS_WARNING_GROUPS.flatMap((group) => group.run(env, rawSettings));
}

/** Every export-specific warning "Vector by corridors" currently knows how to detect (GitHub issue
 *  #311, teleport checks added as a #313 follow-up bugfix — this mode reuses `TeleportRenderer`
 *  as-is, so it can hit the exact same "ambiguous group"/"invisible marker"/"waypoint overlap"
 *  caveats "Vector by walls" already flags). Its group list differs from the walls one in the
 *  one-way overflow check and the corridor-specific contrast checks; `waypoint_on_split`/
 *  `teleport_on_special_split` (GitHub issue #314) are shared — this mode draws the same bridge/diagonal
 *  special-shape geometry, gated on the same `splitSpecialShapes` setting. */
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
  teleportGroups: TeleportGroup[] = [],
  hasGlues = true,
): ExportWarning[] {
  const floorContext = Array.isArray(unscopedNodesOrContext) ? undefined : unscopedNodesOrContext;
  const env = new WarningFloorEnv(
    "corridors",
    () => ({ nodes, edges, start, finish, unscopedNodes: allNodesForWarnings, floorContext }),
    {
      cfg, hasGlues, highlightSeamMirrors, floorTitle: displayFloorTitle, teleportGroups,
      corridorFaceLimit: maxCorridorFace === undefined ? undefined : () => maxCorridorFace,
    },
  );
  return CORRIDORS_WARNING_GROUPS.flatMap((group) => group.run(env, rawSettings));
}
