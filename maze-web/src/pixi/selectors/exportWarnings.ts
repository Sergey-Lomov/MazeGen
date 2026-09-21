import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { VectorByWallsSettings, VectorByCorridorsSettings, TeleportSettingsFields } from "../../store/storeTypes";
import {
  buildTeleportEdges,
  buildSplitPassages,
  buildCorridorSegments,
  getSplitAwareNodePosition,
  maxSplitNodeCount,
  selectNodeLevelResolver,
  selectVerticalPassagePairSet,
  buildVerticalConnectionMarkers,
  selectFloorScopedMaze,
} from "./mazeSelectors";
import type { TeleportFloorContext } from "./mazeSelectors";
import { buildTeleportGroups, teleportEdgeKey, coordKey } from "./teleportGroups";
import type { TeleportEdge } from "../renderers/types";
import { chevronRowStep } from "../renderers/wallUtils";
import { computeElevatorBadgePositions, elevatorBadgesOverlap, elevatorBadgesTooMany } from "../renderers/elevatorBadgeLayout";
import { TILE_SIZE } from "../constants";
import { hasLowContrast } from "../colorContrast";
import { buildEffectiveSplitNodeColors } from "../imageExport/exportStyleBuilders";
import { nearestCellCoord } from "../tessellationGeometry";

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
  | "teleport_waypoint_overlap"
  | "waypoint_on_split"
  | "teleport_on_special_split"
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
  | "vertical_two_way_fill_low_contrast_one_way_accent"
  | "vertical_two_way_border_low_contrast_one_way_accent"
  | "elevator_arrow_low_contrast"
  | "vertical_one_way_accent_low_contrast_fill"
  | "vertical_one_way_accent_low_contrast_arrow"
  | "elevator_badge_fill_low_contrast"
  | "elevator_badge_fill_low_contrast_corridor"
  | "elevator_badge_fill_low_contrast_floor"
  | "teleport_badge_border_low_contrast"
  | "teleport_badge_border_low_contrast_corridor"
  | "teleport_badge_border_low_contrast_floor"
  | "split_low_contrast_background"
  | "split_colors_low_contrast_each_other"
  | "wall_low_contrast_floor"
  | "vertical_two_way_line_low_contrast_floor"
  | "vertical_two_way_arrow_low_contrast_floor"
  | "vertical_one_way_line_low_contrast_floor"
  | "vertical_one_way_accent_low_contrast_floor"
  | "elevator_line_low_contrast_floor";

export type ExportWarningColorRole =
  | "background" | "grid" | "corridor" | "floor" | "wall"
  | "one_way" | "split" | "marker_fill" | "marker_border" | "label_text" | "label_background"
  | "teleport_connector" | "teleport_badge_border" | "teleport_badge_fill" | "teleport_badge_text"
  | "vertical_two_way_fill" | "vertical_two_way_border" | "vertical_two_way_arrow"
  | "vertical_two_way_line" | "vertical_one_way_fill" | "vertical_one_way_accent" | "vertical_one_way_arrow" | "vertical_one_way_line"
  | "elevator_fill" | "elevator_border" | "elevator_arrow" | "elevator_line"
  | "elevator_badge_fill";

const COLOR_ROLES_BY_WARNING_ID: Partial<Record<ExportWarningId, [ExportWarningColorRole, ExportWarningColorRole]>> = {
  one_way_low_contrast_corridor: ["one_way", "corridor"], corridor_low_contrast_background: ["corridor", "background"],
  teleport_connector_low_contrast_corridor: ["teleport_connector", "corridor"], teleport_connector_low_contrast_background: ["teleport_connector", "background"],
  split_low_contrast_corridor: ["split", "corridor"], teleport_connector_low_contrast_floor: ["teleport_connector", "floor"],
  teleport_connector_low_contrast_wall: ["teleport_connector", "wall"], split_low_contrast_floor: ["split", "floor"],
  split_low_contrast_background: ["split", "background"], grid_low_contrast_background: ["grid", "background"],
  marker_fill_low_contrast: ["marker_fill", "floor"], marker_border_low_contrast: ["marker_border", "floor"],
  marker_fill_low_contrast_corridor: ["marker_fill", "corridor"], marker_fill_low_contrast_floor: ["marker_fill", "floor"],
  marker_border_low_contrast_corridor: ["marker_border", "corridor"], marker_border_low_contrast_floor: ["marker_border", "floor"],
  label_low_contrast: ["label_text", "label_background"], teleport_badge_text_low_contrast: ["teleport_badge_text", "teleport_badge_fill"],
  vertical_arrow_low_contrast: ["vertical_two_way_arrow", "vertical_two_way_fill"], vertical_one_way_arrow_low_contrast_fill: ["vertical_one_way_arrow", "vertical_one_way_fill"],
  vertical_two_way_fill_low_contrast_one_way_accent: ["vertical_two_way_fill", "vertical_one_way_accent"], vertical_two_way_border_low_contrast_one_way_accent: ["vertical_two_way_border", "vertical_one_way_accent"],
  elevator_arrow_low_contrast: ["elevator_arrow", "elevator_fill"], vertical_one_way_accent_low_contrast_fill: ["vertical_one_way_accent", "vertical_one_way_fill"],
  vertical_one_way_accent_low_contrast_arrow: ["vertical_one_way_accent", "vertical_one_way_arrow"], elevator_badge_fill_low_contrast: ["elevator_badge_fill", "floor"],
  elevator_badge_fill_low_contrast_corridor: ["elevator_badge_fill", "corridor"], elevator_badge_fill_low_contrast_floor: ["elevator_badge_fill", "floor"],
  teleport_badge_border_low_contrast: ["teleport_badge_border", "floor"], teleport_badge_border_low_contrast_corridor: ["teleport_badge_border", "corridor"],
  teleport_badge_border_low_contrast_floor: ["teleport_badge_border", "floor"], split_colors_low_contrast_each_other: ["split", "split"],
  wall_low_contrast_floor: ["wall", "floor"], vertical_two_way_line_low_contrast_floor: ["vertical_two_way_line", "floor"],
  vertical_two_way_arrow_low_contrast_floor: ["vertical_two_way_arrow", "floor"],
  vertical_one_way_accent_low_contrast_floor: ["vertical_one_way_accent", "floor"], elevator_line_low_contrast_floor: ["elevator_line", "floor"],
  vertical_one_way_line_low_contrast_floor: ["vertical_one_way_line", "floor"],
};

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
  /** Semantic color roles used to render the detailed contrast explanation. */
  colorRoles?: [ExportWarningColorRole, ExportWarningColorRole];
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

/** Squared marker "radius" in world units for the given `MarkerSettings`-like fraction, mirroring
 *  `buildMazeMarkers`'s own `size * TILE_SIZE` scaling — used only for the overlap distance check
 *  below, not for actual drawing. */
function markerWorldRadius(sizeFraction: number, borderWidth: number): number {
  return sizeFraction * TILE_SIZE + borderWidth;
}

/** One point-key -> fill-state pass over every teleport edge, mirroring
 *  `TeleportRenderer.resolvePointFillState`'s per-point logic but computed once for every point
 *  instead of once per point queried (that function itself scans all edges on each call — calling
 *  it in a loop over every endpoint would make this O(edges²)). `"outline"` means every edge
 *  landing on this point wants it empty (an exit-only one-way endpoint); `"filled"` means at least
 *  one edge wants it filled (an entry, or either end of a two-way). */
function buildPointFillStates(teleportEdges: TeleportEdge[]): Map<string, "filled" | "outline"> {
  const filled = new Set<string>();
  const outline = new Set<string>();
  for (const e of teleportEdges) {
    const fromKey = coordKey(e.from[0], e.from[1]);
    const toKey = coordKey(e.to[0], e.to[1]);
    if (e.oneWay) {
      filled.add(fromKey);
      outline.add(toKey);
    } else {
      filled.add(fromKey);
      filled.add(toKey);
    }
  }
  const result = new Map<string, "filled" | "outline">();
  for (const key of filled) result.set(key, "filled");
  for (const key of outline) if (!filled.has(key)) result.set(key, "outline");
  return result;
}

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

/** The three teleport-only checks (`teleport_marker_invisible`, `teleport_group_ambiguous`,
 *  `teleport_waypoint_overlap`) both "Vector by walls" and "Vector by corridors" share — every
 *  field they read (`teleportEdgeBorderWidth`, `teleportConnectorStyle`, `teleportGroupOverrides`,
 *  etc.) lives on the common `TeleportSettingsFields` (GitHub issue #313 follow-up: teleport
 *  rendering transfers as-is between the two modes, so its warnings should too — previously
 *  `computeVectorByCorridorsWarnings` detected none of these, silently missing e.g. ambiguous
 *  teleport groups with no connector to tell them apart). Takes `start`/`finish` marker style
 *  directly (not a whole mode-specific settings object) so it stays mode-agnostic. */
function computeTeleportWarnings(
  teleportEdges: TeleportEdge[],
  settings: TeleportSettingsFields,
  startMarker: { id: number | null; size: number; borderWidth: number },
  finishMarker: { id: number | null; size: number; borderWidth: number },
  allNodes: NodeDto[],
  cfg: TessellationConfig,
  edges: EdgeDto[],
): ExportWarning[] {
  const warnings: ExportWarning[] = [];

  // --- teleport_marker_invisible: a one-way teleport's exit-only endpoint draws "outline" —
  // floor-colored fill, not `edgeColor` — so with no border it has nothing to draw at all. Only
  // checked when `teleportEdgeBorderWidth` is 0; a filled ("entry"/two-way) point is unaffected
  // regardless of border, since its own `edgeColor` fill is always visible. ---
  if (settings.teleportEdgeBorderWidth === 0) {
    const fillStates = buildPointFillStates(teleportEdges);
    const outlineNodeIds = new Set<number>();
    for (const e of teleportEdges) {
      for (const [pos, nodeId] of [[e.from, e.fromNode], [e.to, e.toNode]] as const) {
        if (nodeId === undefined) continue;
        if (fillStates.get(coordKey(pos[0], pos[1])) === "outline") outlineNodeIds.add(nodeId);
      }
    }
    if (outlineNodeIds.size > 0) {
      warnings.push({
        id: "teleport_marker_invisible",
        key: "teleport_marker_invisible",
        nodes: Array.from(outlineNodeIds),
        edges: [],
      });
    }
  }

  // --- teleport_group_ambiguous: two or more groups share the same resolved color+shape while
  // there is no connector to tell them apart visually (mirrors the panel's own pre-existing
  // check). One warning total, covering every colliding group at once — not one per group — but
  // its `nodes` still spans every affected group so hovering it highlights all of them. ---
  if (settings.teleportConnectorStyle === "none") {
    const groups = buildTeleportGroups(teleportEdges);
    const resolvedKey = (groupKey: string) => {
      const o = settings.teleportGroupOverrides[groupKey];
      return `${o?.fillColor ?? settings.teleportEdgeColor}:${o?.borderColor ?? settings.teleportEdgeBorderColor}:${o?.shape ?? settings.teleportLineShape}`;
    };
    const byResolved = new Map<string, typeof groups>();
    for (const g of groups) {
      const rk = resolvedKey(g.key);
      const list = byResolved.get(rk);
      if (list) list.push(g); else byResolved.set(rk, [g]);
    }
    const edgesByKey = new Map(teleportEdges.map((e) => [teleportEdgeKey(e), e]));
    const ambiguousNodeIds = new Set<number>();
    for (const collidingGroups of byResolved.values()) {
      if (collidingGroups.length <= 1) continue;
      for (const g of collidingGroups) {
        for (const edgeKey of g.edgeKeys) {
          const e = edgesByKey.get(edgeKey);
          if (!e) continue;
          if (e.fromNode !== undefined) ambiguousNodeIds.add(e.fromNode);
          if (e.toNode !== undefined) ambiguousNodeIds.add(e.toNode);
        }
      }
    }
    if (ambiguousNodeIds.size > 0) {
      warnings.push({
        id: "teleport_group_ambiguous",
        key: "teleport_group_ambiguous",
        nodes: Array.from(ambiguousNodeIds),
        edges: [],
      });
    }
  }

  // --- teleport_waypoint_overlap: a teleport marker's visual footprint overlaps a start/finish
  // marker's footprint. One warning total, covering every overlapping pair. ---
  const teleportRadius = markerWorldRadius(settings.teleportLineSize, settings.teleportEdgeBorderWidth);
  const overlappingNodeIds = new Set<number>();
  for (const waypoint of [startMarker, finishMarker]) {
    if (waypoint.id === null) continue;
    const waypointPos = getSplitAwareNodePosition(allNodes, waypoint.id, cfg, edges);
    if (!waypointPos) continue;
    const waypointRadius = markerWorldRadius(waypoint.size, waypoint.borderWidth);
    for (const e of teleportEdges) {
      for (const [pos, nodeId] of [[e.from, e.fromNode], [e.to, e.toNode]] as const) {
        if (nodeId === undefined) continue;
        const dist = Math.hypot(pos[0] - waypointPos.x, pos[1] - waypointPos.y);
        if (dist < teleportRadius + waypointRadius) {
          overlappingNodeIds.add(nodeId);
          overlappingNodeIds.add(waypoint.id);
        }
      }
    }
  }
  if (overlappingNodeIds.size > 0) {
    warnings.push({
      id: "teleport_waypoint_overlap",
      key: "teleport_waypoint_overlap",
      nodes: Array.from(overlappingNodeIds),
      edges: [],
    });
  }

  return warnings;
}

/** Every export-specific warning "Vector by walls" currently knows how to detect (GitHub issue
 *  #298). Each warning's `nodes`/`edges` back the hover-highlight the settings panel wires up —
 *  see `VectorByWallsSettingsPanel`'s warning list and `VectorByWallsRenderer`'s highlight overlay.
 *  `unscopedNodes` (GitHub issue #430) is the maze's full, floor-*un*scoped node list — needed only
 *  for `elevator_badges_overlap`, to resolve a badge's own target floor the same way
 *  `buildVerticalConnectionMarkers`/`resolveNodeLevel` require (an `Elevator`'s fan targets live on
 *  other floors, absent from this function's own floor-scoped `nodes`). Optional and defaulted to
 *  `nodes` so existing single-floor callers/tests need no change — that warning simply never fires
 *  without real cross-floor data to resolve. */
/** "Marker indices" disabled + elevator badges disabled + two distinct elevator nodes in one cell
 *  of the drawn floor (GitHub issue #471) — the player can't tell the two shafts apart. `nodes` is
 *  the already floor-scoped node list; `edges` its scoped edge list. One elevator shaft has at most
 *  one node per floor, so two elevator nodes sharing a cell are always distinct shafts — no
 *  connected-component check needed. Returns a single warning, or `null`. */
function computeElevatorIndistinguishableWarning(
  nodes: NodeDto[],
  edges: EdgeDto[],
  markerIndexElevatorsShown: boolean,
  elevatorBadgesEnabled: boolean,
): ExportWarning | null {
  if (markerIndexElevatorsShown || elevatorBadgesEnabled) return null;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const elevatorNodeIds = new Set<number>();
  for (const e of edges) {
    if (e.kind !== "elevator") continue;
    if (nodeById.has(e.from)) elevatorNodeIds.add(e.from);
    if (nodeById.has(e.to)) elevatorNodeIds.add(e.to);
  }
  const byCell = new Map<string, number[]>();
  for (const id of elevatorNodeIds) {
    const n = nodeById.get(id)!;
    const key = `${n.x},${n.y}`;
    const list = byCell.get(key) ?? [];
    list.push(id);
    byCell.set(key, list);
  }
  const flagged: number[] = [];
  for (const list of byCell.values()) {
    if (list.length >= 2) flagged.push(...list);
  }
  if (flagged.length === 0) return null;
  return {
    id: "elevator_indistinguishable",
    key: "elevator_indistinguishable",
    nodes: flagged.sort((a, b) => a - b),
    edges: [],
  };
}

type WarningEdge = [number, number];

type ContrastEntry = {
  foreground: number;
  background: number;
  nodes?: Iterable<number>;
  edges?: readonly WarningEdge[];
  cells?: readonly { x: number; y: number; floorIndex: number }[];
};

type WarningFloor = { id: string };

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

export function computeVectorByWallsWarningsAcrossFloors(
  nodes: NodeDto[], edges: EdgeDto[], floors: WarningFloor[], cfg: TessellationConfig,
  settings: VectorByWallsSettings, start: number | null, finish: number | null,
): ExportWarning[] {
  const warningLists = floors.map((floor) => {
    const scoped = selectFloorScopedMaze(nodes, edges, floors, floor.id, start, finish);
    const floorContext: TeleportFloorContext = {
      resolveNodeLevel: selectNodeLevelResolver(nodes),
      unscopedNodeById: new Map(nodes.map((node) => [node.id, node])),
      unscopedEdges: edges,
      activeFloorIndex: Math.max(floors.findIndex((candidate) => candidate.id === floor.id), 0),
    };
    return computeVectorByWallsWarnings(scoped.nodes, scoped.edges, cfg, settings, scoped.start, scoped.finish, nodes, floorContext);
  });
  return mergeWarningsAcrossFloors(warningLists, nodes);
}

export function computeVectorByCorridorsWarningsAcrossFloors(
  nodes: NodeDto[], edges: EdgeDto[], floors: WarningFloor[], cfg: TessellationConfig,
  settings: VectorByCorridorsSettings, start: number | null, finish: number | null,
): ExportWarning[] {
  const warningLists = floors.map((floor) => {
    const scoped = selectFloorScopedMaze(nodes, edges, floors, floor.id, start, finish);
    const floorContext: TeleportFloorContext = {
      resolveNodeLevel: selectNodeLevelResolver(nodes),
      unscopedNodeById: new Map(nodes.map((node) => [node.id, node])),
      unscopedEdges: edges,
      activeFloorIndex: Math.max(floors.findIndex((candidate) => candidate.id === floor.id), 0),
    };
    return computeVectorByCorridorsWarnings(scoped.nodes, scoped.edges, cfg, settings, scoped.start, scoped.finish, floorContext, nodes);
  });
  return mergeWarningsAcrossFloors(warningLists, nodes);
}

function pushContrastWarningEntries(
  warnings: ExportWarning[],
  id: ExportWarningId,
  entries: readonly ContrastEntry[],
): void {
  const grouped = new Map<string, { nodes: Set<number>; edges: WarningEdge[]; cells: { x: number; y: number; floorIndex: number }[]; colorValues: [number, number] }>();
  for (const entry of entries) {
    if (!hasLowContrast(entry.foreground, entry.background)) continue;
    const colorValues: [number, number] = [entry.foreground, entry.background];
    const key = `${id}:${entry.foreground.toString(16)}:${entry.background.toString(16)}`;
    const group = grouped.get(key) ?? { nodes: new Set<number>(), edges: [], cells: [], colorValues };
    for (const node of entry.nodes ?? []) group.nodes.add(node);
    group.edges.push(...(entry.edges ?? []));
    group.cells.push(...(entry.cells ?? []));
    grouped.set(key, group);
  }
  for (const [key, group] of grouped) {
    warnings.push({
      id,
      key,
      nodes: Array.from(group.nodes),
      edges: group.edges,
      cells: group.cells.length > 0 ? group.cells : undefined,
      colorRoles: COLOR_ROLES_BY_WARNING_ID[id],
      colorValues: group.colorValues,
    });
  }
}

function pushContrastWarning(
  warnings: ExportWarning[],
  id: ExportWarningId,
  pairs: readonly (readonly [number, number])[],
  nodes: Iterable<number> = [],
  edges: readonly WarningEdge[] = [],
): void {
  pushContrastWarningEntries(warnings, id, pairs.map(([foreground, background]) => ({ foreground, background, nodes, edges })));
}

function edgeNodeIds(edges: EdgeDto[], nodeById: Map<number, NodeDto>): number[] {
  const ids = new Set<number>();
  for (const edge of edges) {
    if (nodeById.has(edge.from)) ids.add(edge.from);
    if (nodeById.has(edge.to)) ids.add(edge.to);
  }
  return Array.from(ids);
}

function edgePairs(edges: EdgeDto[]): WarningEdge[] {
  return edges.map((edge) => [edge.from, edge.to]);
}

function teleportConnectorEntries(
  teleportEdges: TeleportEdge[],
  settings: TeleportSettingsFields,
  background: number,
): ContrastEntry[] {
  const baseNodes = teleportEdges.flatMap((edge) => [edge.fromNode, edge.toNode].filter((id): id is number => id !== undefined));
  if (!settings.teleportGroupCustomization) {
    return [{ foreground: settings.teleportConnectorColor, background, nodes: baseNodes }];
  }
  const groups = buildTeleportGroups(teleportEdges);
  const edgesByKey = new Map(teleportEdges.map((edge) => [teleportEdgeKey(edge), edge]));
  const entries: ContrastEntry[] = [];
  for (const group of groups) {
    const override = settings.teleportGroupOverrides[group.key];
    const groupEdges = group.edgeKeys.map((key) => edgesByKey.get(key)).filter((edge): edge is TeleportEdge => edge !== undefined);
    entries.push({
      foreground: override?.borderColor ?? settings.teleportConnectorColor,
      background,
      nodes: groupEdges.flatMap((edge) => [edge.fromNode, edge.toNode].filter((id): id is number => id !== undefined)),
    });
  }
  return entries;
}

function teleportBadgeBorderEntries(
  teleportEdges: TeleportEdge[],
  settings: TeleportSettingsFields,
  background: number,
  displayFloorIndex: number,
  cfg: TessellationConfig,
): ContrastEntry[] {
  const crossFloorEdges = teleportEdges.filter((edge) => edge.toFloor !== undefined || edge.fromFloor !== undefined);
  if (!settings.teleportGroupCustomization) {
    return [{ foreground: settings.teleportFloorBadge.borderColor, background, cells: teleportBadgeCells(crossFloorEdges, displayFloorIndex, cfg) }];
  }
  const groups = buildTeleportGroups(teleportEdges);
  const edgesByKey = new Map(teleportEdges.map((edge) => [teleportEdgeKey(edge), edge]));
  return groups.map((group) => {
    const override = settings.teleportGroupOverrides[group.key];
    const groupEdges = group.edgeKeys.map((key) => edgesByKey.get(key)).filter((edge): edge is TeleportEdge => edge !== undefined && (edge.toFloor !== undefined || edge.fromFloor !== undefined));
    return {
      foreground: override?.borderColor ?? settings.teleportFloorBadge.borderColor,
      background,
      cells: teleportBadgeCells(groupEdges, displayFloorIndex, cfg),
    };
  });
}

function teleportBadgeCells(edges: TeleportEdge[], displayFloorIndex: number, cfg: TessellationConfig): { x: number; y: number; floorIndex: number }[] {
  const cells: { x: number; y: number; floorIndex: number }[] = [];
  for (const edge of edges) {
    if (edge.toFloor !== undefined) {
      const [x, y] = nearestCellCoord(edge.to[0], edge.to[1], cfg);
      cells.push({ x, y, floorIndex: displayFloorIndex });
    }
    if (edge.fromFloor !== undefined) {
      const [x, y] = nearestCellCoord(edge.from[0], edge.from[1], cfg);
      cells.push({ x, y, floorIndex: displayFloorIndex });
    }
  }
  return cells;
}

function verticalPassageEdges(edges: EdgeDto[]): EdgeDto[] {
  return edges.filter((edge) => edge.kind === "vertical_passage");
}

function oneWayVerticalPassageEdges(edges: EdgeDto[], allEdges: EdgeDto[] = edges): EdgeDto[] {
  const vertical = verticalPassageEdges(edges);
  const pairs = new Set(allEdges.filter((edge) => edge.kind === "vertical_passage").map((edge) => `${edge.from}->${edge.to}`));
  return vertical.filter((edge) => !pairs.has(`${edge.to}->${edge.from}`));
}

function splitContrastData(
  nodes: NodeDto[],
  edges: EdgeDto[],
  cfg: TessellationConfig,
  splitNodeColors: readonly number[],
): { colors: number[]; keys: string[]; nodes: number[] } {
  if (maxSplitNodeCount(nodes) === 0) return { colors: [], keys: [], nodes: [] };
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const effectiveColors = buildEffectiveSplitNodeColors(splitNodeColors, maxSplitNodeCount(nodes));
  const { passages } = buildSplitPassages(nodes, edges, cfg, new Set(), {}, {}, effectiveColors);
  const colors: number[] = [];
  const keys: string[] = [];
  const seen = new Set<string>();
  const ids = new Set<number>();
  for (const passage of passages) {
    const key = passage.nodeIndex === undefined ? `color:${passage.color}` : `slot:${passage.nodeIndex}`;
    if (!seen.has(key)) {
      seen.add(key);
      colors.push(passage.color);
      keys.push(String(key));
    }
    for (const node of nodeById.values()) {
      if (`${node.x},${node.y}` === passage.pointKey) ids.add(node.id);
    }
  }
  return { colors, keys, nodes: Array.from(ids) };
}

function pushSplitPairwiseWarning(warnings: ExportWarning[], colors: readonly number[], keys: readonly string[], nodes: readonly number[]): void {
  const entries: ContrastEntry[] = [];
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      if (keys[i] === keys[j]) continue;
      entries.push({ foreground: colors[i], background: colors[j], nodes });
    }
  }
  // This is one visual problem — split colors are not distinguishable from each other — even
  // when several slot pairs happen to trip the same contrast check. Keep one warning for the
  // whole split palette, just as the non-pairwise split warnings do. The first offending pair is
  // retained for the detailed color description; all affected nodes are already shared by the
  // split data passed here.
  const first = entries.find((entry) => hasLowContrast(entry.foreground, entry.background));
  if (first) pushContrastWarningEntries(warnings, "split_colors_low_contrast_each_other", [first]);
}

function addCommonContrastWarnings(
  warnings: ExportWarning[],
  nodes: NodeDto[],
  edges: EdgeDto[],
  baseColor: number,
  background: number,
  showGrid: boolean,
  settings: VectorByWallsSettings | VectorByCorridorsSettings,
  teleportEdges: TeleportEdge[],
  allNodesForWarnings: NodeDto[],
  allEdgesForWarnings: EdgeDto[],
  start: number | null,
  finish: number | null,
  verticalStyle: "abstract" | "decorative",
  displayFloorIndex: number,
  cfg: TessellationConfig,
): void {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const warningNodeById = new Map(allNodesForWarnings.map((node) => [node.id, node]));
  const surfaceKind = "floorColor" in settings ? "floor" : "corridor";
  const markerFillWarningId = surfaceKind === "floor" ? "marker_fill_low_contrast_floor" : "marker_fill_low_contrast_corridor";
  const markerBorderWarningId = surfaceKind === "floor" ? "marker_border_low_contrast_floor" : "marker_border_low_contrast_corridor";
  const elevatorBadgeFillWarningId = surfaceKind === "floor" ? "elevator_badge_fill_low_contrast_floor" : "elevator_badge_fill_low_contrast_corridor";
  const teleportBadgeBorderWarningId = surfaceKind === "floor" ? "teleport_badge_border_low_contrast_floor" : "teleport_badge_border_low_contrast_corridor";
  const vertical = verticalPassageEdges(edges);
  const oneWayVertical = oneWayVerticalPassageEdges(edges, allEdgesForWarnings);
  const elevator = edges.filter((edge) => edge.kind === "elevator");
  const teleport = edges.filter((edge) => edge.kind === "teleport");
  if (showGrid) pushContrastWarning(warnings, "grid_low_contrast_background", [[settings.gridColor, background]]);

  const fillEntries: ContrastEntry[] = [];
  const borderEntries: ContrastEntry[] = [];
  const addMarker = (marker: { fillColor: number; borderColor: number; borderWidth: number }, markerNodes: Iterable<number>) => {
    const entry = { nodes: markerNodes };
    if (marker.borderWidth === 0) fillEntries.push({ foreground: marker.fillColor, background: baseColor, ...entry });
    else borderEntries.push({ foreground: marker.borderColor, background: baseColor, ...entry });
  };
  if (start !== null && nodeById.has(start)) addMarker(settings.startMarker, [start]);
  if (finish !== null && nodeById.has(finish)) addMarker(settings.finishMarker, [finish]);
  if (teleport.length > 0) {
    const groups = settings.teleportGroupCustomization ? buildTeleportGroups(teleportEdges) : [];
    const edgesByKey = new Map(teleportEdges.map((edge) => [teleportEdgeKey(edge), edge]));
    if (groups.length === 0) {
      addMarker({ fillColor: settings.teleportEdgeColor, borderColor: settings.teleportEdgeBorderColor, borderWidth: settings.teleportEdgeBorderWidth }, teleportEdges.flatMap((edge) => [edge.fromNode, edge.toNode].filter((id): id is number => id !== undefined)));
    } else {
      for (const group of groups) {
        const override = settings.teleportGroupOverrides[group.key];
        const groupNodeIds = group.edgeKeys.flatMap((key) => {
          const edge = edgesByKey.get(key);
          return edge ? [edge.fromNode, edge.toNode].filter((id): id is number => id !== undefined) : [];
        });
        addMarker({
          fillColor: override?.fillColor ?? settings.teleportEdgeColor,
          borderColor: override?.borderColor ?? settings.teleportEdgeBorderColor,
          borderWidth: settings.teleportEdgeBorderWidth,
        }, groupNodeIds);
      }
    }
  }
  for (const edge of vertical) {
    if (!oneWayVertical.includes(edge)) addMarker(settings.twoWayPassageMarker, [edge.from, edge.to]);
  }
  for (const edge of oneWayVertical) {
    addMarker({ ...settings.oneWayPassageMarker, borderColor: settings.oneWayAccentColor }, [edge.from, edge.to]);
  }
  for (const edge of elevator) addMarker(settings.elevatorMarker, [edge.from, edge.to]);
  pushContrastWarningEntries(warnings, markerFillWarningId, fillEntries);
  pushContrastWarningEntries(warnings, markerBorderWarningId, borderEntries);

  const labelEntries: ContrastEntry[] = [];
  const crossFloorTeleportEdges = teleport.filter((edge) => (warningNodeById.get(edge.from)?.level ?? 0) !== (warningNodeById.get(edge.to)?.level ?? 0));
  if (crossFloorTeleportEdges.length > 0) {
    pushContrastWarningEntries(warnings, "teleport_badge_text_low_contrast", [{
      foreground: settings.teleportFloorBadge.textColor,
      background: settings.teleportFloorBadge.fillColor,
      cells: teleportBadgeCells(teleportEdges, displayFloorIndex, cfg),
    }]);
  }
  if (settings.elevatorBadges.enabled && elevator.length > 0) {
    labelEntries.push({ foreground: settings.elevatorBadges.textColor, background: settings.elevatorBadges.fillColor, nodes: elevator.flatMap((edge) => [edge.from, edge.to]) });
  }
  const indexedEdges = edges.filter((edge) => {
    if (edge.kind === "elevator") return settings.markerIndex.coverage.elevator;
    if (edge.kind === "vertical_passage") return settings.markerIndex.coverage.verticalPassage;
    if (edge.kind !== "teleport") return false;
    const fromLevel = warningNodeById.get(edge.from)?.level ?? 0;
    const toLevel = warningNodeById.get(edge.to)?.level ?? 0;
    return fromLevel === toLevel ? settings.markerIndex.coverage.singleFloorTeleport : settings.markerIndex.coverage.crossFloorTeleport;
  });
  if (settings.markerIndex.enabled && indexedEdges.length > 0) {
    labelEntries.push({ foreground: settings.markerIndex.textColor, background: settings.markerIndex.fillColor, nodes: edgeNodeIds(indexedEdges, warningNodeById), edges: edgePairs(indexedEdges) });
  }
  pushContrastWarningEntries(warnings, "label_low_contrast", labelEntries);

  const twoWay = vertical.filter((edge) => !oneWayVertical.includes(edge));
  if (verticalStyle === "abstract") {
    pushContrastWarningEntries(warnings, "vertical_arrow_low_contrast", twoWay.length > 0 ? [{ foreground: settings.twoWayArrowColor, background: settings.twoWayPassageMarker.fillColor, nodes: edgeNodeIds(twoWay, warningNodeById), edges: edgePairs(twoWay) }] : []);
    if (oneWayVertical.length > 0 && settings.oneWayArrowColor !== settings.oneWayAccentColor) {
      pushContrastWarningEntries(warnings, "vertical_one_way_arrow_low_contrast_fill", [{ foreground: settings.oneWayArrowColor, background: settings.oneWayPassageMarker.fillColor, nodes: edgeNodeIds(oneWayVertical, warningNodeById), edges: edgePairs(oneWayVertical) }]);
    }
    pushContrastWarningEntries(warnings, "elevator_arrow_low_contrast", elevator.length > 0 ? [{ foreground: settings.elevatorArrowColor, background: settings.elevatorMarker.fillColor, nodes: edgeNodeIds(elevator, warningNodeById), edges: edgePairs(elevator) }] : []);
    const twoWayAccentEntries = twoWay.flatMap((edge) => [
      { foreground: settings.twoWayPassageMarker.fillColor, background: settings.oneWayAccentColor, nodes: [edge.from, edge.to], edges: edgePairs([edge]) },
      { foreground: settings.twoWayPassageMarker.borderColor, background: settings.oneWayAccentColor, nodes: [edge.from, edge.to], edges: edgePairs([edge]) },
    ]);
    pushContrastWarningEntries(warnings, "vertical_two_way_fill_low_contrast_one_way_accent", twoWayAccentEntries.filter((_, index) => index % 2 === 0));
    pushContrastWarningEntries(warnings, "vertical_two_way_border_low_contrast_one_way_accent", twoWayAccentEntries.filter((_, index) => index % 2 === 1));
  }
  if (surfaceKind === "floor") {
    const wallsSettings = settings as VectorByWallsSettings;
    pushContrastWarning(warnings, "wall_low_contrast_floor", [[wallsSettings.wallColor, baseColor]]);
  }
  if (surfaceKind === "floor" && verticalStyle === "decorative") {
    const wallsSettings = settings as VectorByWallsSettings;
    pushContrastWarningEntries(warnings, "vertical_two_way_line_low_contrast_floor", twoWay.length > 0 ? [{
      foreground: wallsSettings.decorativeStairsTwoWay.lineColor,
      background: baseColor,
      nodes: edgeNodeIds(twoWay, warningNodeById),
      edges: edgePairs(twoWay),
    }] : []);
    pushContrastWarningEntries(warnings, "vertical_two_way_arrow_low_contrast_floor", twoWay.length > 0 ? [{
      foreground: wallsSettings.decorativeStairsArrowColor,
      background: baseColor,
      nodes: edgeNodeIds(twoWay, warningNodeById),
      edges: edgePairs(twoWay),
    }] : []);
    pushContrastWarningEntries(warnings, "vertical_one_way_line_low_contrast_floor", oneWayVertical.length > 0 ? [{
      foreground: wallsSettings.decorativeStairsOneWay.lineColor,
      background: baseColor,
      nodes: edgeNodeIds(oneWayVertical, warningNodeById),
      edges: edgePairs(oneWayVertical),
    }] : []);
    pushContrastWarningEntries(warnings, "vertical_one_way_accent_low_contrast_floor", oneWayVertical.length > 0 ? [{
      foreground: wallsSettings.decorativeStairsAccentColor,
      background: baseColor,
      nodes: edgeNodeIds(oneWayVertical, warningNodeById),
      edges: edgePairs(oneWayVertical),
    }] : []);
    pushContrastWarningEntries(warnings, "elevator_line_low_contrast_floor", elevator.length > 0 ? [{
      foreground: wallsSettings.decorativeElevator.lineColor,
      background: baseColor,
      nodes: edgeNodeIds(elevator, warningNodeById),
      edges: edgePairs(elevator),
    }] : []);
  }
  if (oneWayVertical.length > 0) {
    pushContrastWarning(warnings, "vertical_one_way_accent_low_contrast_fill", [[settings.oneWayAccentColor, settings.oneWayPassageMarker.fillColor]], edgeNodeIds(oneWayVertical, warningNodeById), edgePairs(oneWayVertical));
    if (verticalStyle === "abstract") {
      pushContrastWarning(warnings, "vertical_one_way_accent_low_contrast_arrow", [[settings.oneWayAccentColor, settings.oneWayArrowColor]], edgeNodeIds(oneWayVertical, warningNodeById), edgePairs(oneWayVertical));
    }
  }
  if (settings.elevatorBadges.enabled && elevator.length > 0) {
    pushContrastWarning(warnings, elevatorBadgeFillWarningId, [[settings.elevatorBadges.fillColor, baseColor]], edgeNodeIds(elevator, warningNodeById), edgePairs(elevator));
  }
  const crossFloorTeleports = teleportEdges.filter((edge) => (warningNodeById.get(edge.fromNode ?? -1)?.level ?? 0) !== (warningNodeById.get(edge.toNode ?? -1)?.level ?? 0));
  if (crossFloorTeleports.length > 0) {
    // Group overrides replace the badge border as well as the connector border. Without group
    // customization the badge has its own dedicated border color.
    pushContrastWarningEntries(warnings, teleportBadgeBorderWarningId, teleportBadgeBorderEntries(teleportEdges, settings, baseColor, displayFloorIndex, cfg));
  }
}

export function computeVectorByWallsWarnings(
  nodes: NodeDto[],
  edges: EdgeDto[],
  cfg: TessellationConfig,
  settings: VectorByWallsSettings,
  start: number | null,
  finish: number | null,
  unscopedNodes: NodeDto[] = nodes,
  teleportFloorContext?: TeleportFloorContext,
): ExportWarning[] {
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

  addCommonContrastWarnings(
    warnings, nodes, edges, settings.floorColor, settings.background, settings.showGrid,
    settings, teleportEdges, unscopedNodes, teleportFloorContext?.unscopedEdges ?? edges, start, finish, settings.verticalStyle,
    teleportFloorContext?.activeFloorIndex ?? nodes[0]?.level ?? 0, cfg,
  );

  if (teleportEdges.length > 0 && settings.teleportConnectorStyle !== "none") {
    const connectorEntries = teleportConnectorEntries(teleportEdges, settings, settings.floorColor);
    pushContrastWarningEntries(warnings, "teleport_connector_low_contrast_floor", connectorEntries);
    if (settings.teleportConnectorGapWidth === 0) {
      pushContrastWarningEntries(warnings, "teleport_connector_low_contrast_wall", teleportConnectorEntries(teleportEdges, settings, settings.wallColor));
    }
  }
  const splitFloor = splitContrastData(nodes, edges, cfg, settings.splitNodeColors);
  pushContrastWarning(warnings, "split_low_contrast_floor", splitFloor.colors.map((color) => [color, settings.floorColor] as [number, number]), splitFloor.nodes);
  pushSplitPairwiseWarning(warnings, splitFloor.colors, splitFloor.keys, splitFloor.nodes);

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
  // drawElevatorBadges`'s own `markerRadius`/`badgeRadius` computation exactly (`elevatorMarker.size
  // * TILE_SIZE`, no border-width addition — unlike `markerWorldRadius` above, which is only used
  // for the teleport/waypoint overlap check). ---
  if (settings.elevatorBadges.enabled) {
    const verticalPairs = selectVerticalPassagePairSet(edges);
    const markers = buildVerticalConnectionMarkers(nodeById, edges, cfg, resolveNodeLevel, 0, verticalPairs, edges);
    const markerRadius = settings.elevatorMarker.size * TILE_SIZE;
    const badgeRadius = markerRadius * settings.elevatorBadges.size;
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
  cfg: TessellationConfig,
  settings: VectorByCorridorsSettings,
  start: number | null,
  finish: number | null,
  unscopedNodesOrContext?: NodeDto[] | TeleportFloorContext,
  allNodesForWarnings: NodeDto[] = Array.isArray(unscopedNodesOrContext) ? unscopedNodesOrContext : nodes,
): ExportWarning[] {
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

  addCommonContrastWarnings(
    warnings, nodes, edges, settings.color, settings.background, settings.showGrid,
    settings, teleportEdges, allNodesForWarnings, teleportFloorContext?.unscopedEdges ?? edges, start, finish, "abstract",
    teleportFloorContext?.activeFloorIndex ?? nodes[0]?.level ?? 0, cfg,
  );

  const corridorSegments = buildCorridorSegments(nodes, edges, cfg);
  if (corridorSegments.length > 0) {
    pushContrastWarning(warnings, "corridor_low_contrast_background", [[settings.color, settings.background]]);
  }
  if (corridorSegments.some((segment) => segment.oneWayDir)) {
    pushContrastWarning(
      warnings,
      "one_way_low_contrast_corridor",
      [[settings.oneWayColor, settings.color]],
      corridorSegments.filter((segment) => segment.oneWayDir).flatMap((segment) => [segment.fromNode, segment.toNode]),
      corridorSegments.filter((segment) => segment.oneWayDir).map((segment) => [segment.fromNode, segment.toNode]),
    );
  }
  if (teleportEdges.length > 0 && settings.teleportConnectorStyle !== "none") {
    pushContrastWarningEntries(warnings, "teleport_connector_low_contrast_corridor", teleportConnectorEntries(teleportEdges, settings, settings.color));
    if (settings.teleportConnectorGapWidth === 0) {
      pushContrastWarningEntries(warnings, "teleport_connector_low_contrast_background", teleportConnectorEntries(teleportEdges, settings, settings.background));
    }
  }
  const splitCorridor = splitContrastData(nodes, edges, cfg, settings.splitNodeColors);
  pushContrastWarning(warnings, "split_low_contrast_corridor", splitCorridor.colors.map((color) => [color, settings.color] as [number, number]), splitCorridor.nodes);
  pushContrastWarning(warnings, "split_low_contrast_background", splitCorridor.colors.map((color) => [color, settings.background] as [number, number]), splitCorridor.nodes);
  pushSplitPairwiseWarning(warnings, splitCorridor.colors, splitCorridor.keys, splitCorridor.nodes);

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

  const indistinguishable = computeElevatorIndistinguishableWarning(
    nodes, edges, settings.markerIndex.enabled && settings.markerIndex.coverage.elevator, settings.elevatorBadges.enabled,
  );
  if (indistinguishable) warnings.push(indistinguishable);

  return warnings;
}
