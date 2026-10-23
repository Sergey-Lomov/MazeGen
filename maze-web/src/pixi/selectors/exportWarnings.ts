import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { VectorByWallsSettings, VectorByCorridorsSettings, TeleportSettingsFields, MarkerLayoutSettingsFields } from "../../store/storeTypes";
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
import { textOverflows, type TextFitItem } from "../textFit";
import { formatIndexLabel } from "../renderers/indexLabel";
import { buildMarkerIndexLabels } from "./mazeSelectors/markerIndex";
import { applyMarkerLayout, MARKER_LAYOUT_SPACING, buildSplitHostKeys } from "./mazeSelectors/markerLayout";
import { DEFAULT_MARKER_TEXT_SIZE, DEFAULT_TEXT_MARGIN } from "../renderConstants";
import {
  buildColorVisibility, visibleColor, unownedColor,
  type ColorVisibilityContext, type VisibleColor,
} from "./colorFieldRegistry";
import { withResolvedGroupOverrides } from "../../store/teleportGroupLinks";
import { splitNodeKey, teleportGroupKey, type ColorFieldKey, type TeleportGroupColorRole } from "../colorFieldKeys";

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
  /** Start/finish marker caption, elevator floor badge or teleport floor badge text exceeds its plate
   *  in width or height (GitHub issue #707). One id per element kind so the message can name it. */
  | "marker_text_overflow"
  | "elevator_badge_text_overflow"
  | "marker_index_text_overflow"
  | "teleport_badge_text_overflow"
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
  | "elevator_line_low_contrast_floor";

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

/** Marker "radius" in world px for the given `MarkerSettings`-like size — used only for the
 *  overlap distance check below, not for actual drawing. */
function markerWorldRadius(size: number, borderWidth: number): number {
  return size / 2 + borderWidth;
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
 *  field they read (`teleportMarker.borderWidth`, `teleportConnectorStyle`, `teleportGroupOverrides`,
 *  etc.) lives on the common `TeleportSettingsFields` (GitHub issue #313 follow-up: teleport
 *  rendering transfers as-is between the two modes, so its warnings should too — previously
 *  `computeVectorByCorridorsWarnings` detected none of these, silently missing e.g. ambiguous
 *  teleport groups with no connector to tell them apart). Takes `start`/`finish` marker style
 *  directly (not a whole mode-specific settings object) so it stays mode-agnostic. */
function computeTeleportWarnings(
  teleportEdges: TeleportEdge[],
  settings: TeleportSettingsFields & MarkerLayoutSettingsFields,
  startMarker: { id: number | null; size: number; borderWidth: number },
  finishMarker: { id: number | null; size: number; borderWidth: number },
  allNodes: NodeDto[],
  cfg: TessellationConfig,
  edges: EdgeDto[],
): ExportWarning[] {
  const warnings: ExportWarning[] = [];

  // --- teleport_marker_invisible: a one-way teleport's exit-only endpoint draws "outline" —
  // floor-colored fill, not `edgeColor` — so with no border it has nothing to draw at all. Only
  // checked when `teleportMarker.borderWidth` is 0; a filled ("entry"/two-way) point is unaffected
  // regardless of border, since its own `edgeColor` fill is always visible. ---
  if (settings.teleportMarker.borderWidth === 0) {
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
      return `${o?.fillColor ?? settings.teleportMarker.fillColor}:${o?.borderColor ?? settings.teleportMarker.borderColor}:${o?.shape ?? settings.teleportMarker.shape}`;
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
  const teleportRadius = markerWorldRadius(settings.teleportMarker.size, settings.teleportMarker.borderWidth);
  const overlappingNodeIds = new Set<number>();
  // The marker positioning layer (GitHub issue #735) already separates markers sharing one host, so
  // measure overlap on the laid-out positions — a start/finish stacked on a teleport point only counts
  // when the layout couldn't pull them apart (e.g. a split node's tight bounds). Vertical markers are
  // not part of this warning's inputs and so take no slot here.
  const waypoints = [startMarker, finishMarker].filter((w) => w.id !== null);
  const waypointPositions = waypoints.map((w) => getSplitAwareNodePosition(allNodes, w.id!, cfg, edges));
  const placed = waypoints.flatMap((w, i) => {
    const p = waypointPositions[i];
    return p ? [{ w, data: { pos: [p.x, p.y] as [number, number], radius: w.size / 2, borderWidth: w.borderWidth, color: 0 } }] : [];
  });
  const laidOut = applyMarkerLayout(
    {
      markers: placed.map((x) => x.data),
      teleportEdges,
      verticalMarkers: [],
      // Same slot size the renderers use (incl. gap), so the layout here matches the drawn one.
      teleportRadius: teleportRadius + (settings.teleportMarker.gapWidth ?? 0),
      verticalRadius: () => 0,
      splitHostKeys: buildSplitHostKeys(new Map(allNodes.map((n) => [n.id, n])), edges, cfg),
    },
    { mode: settings.markerLayout, spacing: MARKER_LAYOUT_SPACING, scale: settings.markerScale },
  );
  placed.forEach(({ w }, i) => {
    const waypointPos = laidOut.markers[i].pos;
    const waypointRadius = markerWorldRadius(w.size, w.borderWidth) * (w.size > 0 ? laidOut.markers[i].radius / (w.size / 2) : 1);
    for (const e of laidOut.teleportEdges) {
      for (const [pos, nodeId, sc] of [[e.from, e.fromNode, e.fromScale], [e.to, e.toNode, e.toScale]] as const) {
        if (nodeId === undefined) continue;
        const dist = Math.hypot(pos[0] - waypointPos[0], pos[1] - waypointPos[1]);
        if (dist < teleportRadius * (sc ?? 1) + waypointRadius) {
          overlappingNodeIds.add(nodeId);
          overlappingNodeIds.add(w.id!);
        }
      }
    }
  });
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

/** One color pair to check. Both colors come from the registry ({@link VisibleColor}); a `null`
 *  side is a hidden/valueless field and drops the entry — a warning can't concern a color the
 *  panel doesn't show. Entries with different field pairs never share a warning, even when the
 *  color values coincide. */
type ContrastEntry = {
  foreground: VisibleColor | null;
  background: VisibleColor | null;
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
  type Group = {
    nodes: Set<number>; edges: WarningEdge[]; cells: { x: number; y: number; floorIndex: number }[];
    colorValues: [number, number]; foregroundField: ColorFieldKey | null; backgroundField: ColorFieldKey | null;
  };
  const grouped = new Map<string, Group>();
  for (const entry of entries) {
    const { foreground, background } = entry;
    if (!foreground || !background) continue;
    if (!hasLowContrast(foreground.value, background.value)) continue;
    // One warning per (kind, foreground field, background field). A color with no owning field falls
    // back to its value so distinct pairs still stay separate.
    const key = foreground.field && background.field
      ? `${id}:${foreground.field}:${background.field}`
      : `${id}:${foreground.field ?? ""}:${background.field ?? ""}:${foreground.value.toString(16)}:${background.value.toString(16)}`;
    const group = grouped.get(key) ?? {
      nodes: new Set<number>(), edges: [], cells: [], colorValues: [foreground.value, background.value],
      foregroundField: foreground.field, backgroundField: background.field,
    };
    for (const node of entry.nodes ?? []) group.nodes.add(node);
    group.edges.push(...(entry.edges ?? []));
    group.cells.push(...(entry.cells ?? []));
    grouped.set(key, group);
  }
  for (const [key, group] of grouped) {
    const fields = [group.foregroundField, group.backgroundField].filter((f): f is ColorFieldKey => f !== null);
    warnings.push({
      id,
      key,
      nodes: Array.from(group.nodes),
      edges: group.edges,
      cells: group.cells.length > 0 ? group.cells : undefined,
      colorFields: group.foregroundField && group.backgroundField ? [group.foregroundField, group.backgroundField] : undefined,
      fields: fields.length > 0 ? fields : undefined,
      colorValues: group.colorValues,
    });
  }
}

/** `[foreground, background]` — one color pair to check. */
type ContrastPair = readonly [VisibleColor | null, VisibleColor | null];

function pushContrastWarning(
  warnings: ExportWarning[],
  id: ExportWarningId,
  pairs: readonly ContrastPair[],
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

/** The field a teleport group's color is edited in: the group's own override row while it overrides
 *  `role` (named by the override's 1-based order, same as the picker's "Project colors" list), the
 *  shared `fallback` field otherwise. */
function teleportGroupColorField(
  settings: TeleportSettingsFields,
  groupKey: string,
  role: TeleportGroupColorRole,
  fallback: ColorFieldKey,
): ColorFieldKey {
  const override = settings.teleportGroupOverrides[groupKey];
  if ((role === "fill" ? override?.fillColor : override?.borderColor) === undefined) return fallback;
  const index = Object.keys(settings.teleportGroupOverrides).sort((a, b) => a.localeCompare(b)).indexOf(groupKey);
  return teleportGroupKey(index, role);
}

function teleportConnectorEntries(
  teleportEdges: TeleportEdge[],
  ctx: ColorVisibilityContext,
  background: VisibleColor | null,
): ContrastEntry[] {
  const settings = ctx.settings;
  const baseNodes = teleportEdges.flatMap((edge) => [edge.fromNode, edge.toNode].filter((id): id is number => id !== undefined));
  if (!settings.teleportGroupCustomization) {
    return [{ foreground: visibleColor(ctx, "teleportConnector"), background, nodes: baseNodes }];
  }
  const groups = buildTeleportGroups(teleportEdges);
  const edgesByKey = new Map(teleportEdges.map((edge) => [teleportEdgeKey(edge), edge]));
  const entries: ContrastEntry[] = [];
  for (const group of groups) {
    const groupEdges = group.edgeKeys.map((key) => edgesByKey.get(key)).filter((edge): edge is TeleportEdge => edge !== undefined);
    entries.push({
      foreground: visibleColor(ctx, teleportGroupColorField(settings, group.key, "border", "teleportConnector")),
      background,
      nodes: groupEdges.flatMap((edge) => [edge.fromNode, edge.toNode].filter((id): id is number => id !== undefined)),
    });
  }
  return entries;
}

function teleportBadgeColorEntries(
  teleportEdges: TeleportEdge[],
  ctx: ColorVisibilityContext,
  background: VisibleColor | null,
  displayFloorIndex: number,
  cfg: TessellationConfig,
  color: "border" | "fill",
): ContrastEntry[] {
  const settings = ctx.settings;
  const defaultField: ColorFieldKey = color === "border" ? "teleportBadgeBorder" : "teleportBadgeFill";
  const crossFloorEdges = teleportEdges.filter((edge) => edge.toFloor !== undefined || edge.fromFloor !== undefined);
  if (!settings.teleportGroupCustomization) {
    return [{ foreground: visibleColor(ctx, defaultField), background, cells: teleportBadgeCells(crossFloorEdges, displayFloorIndex, cfg) }];
  }
  const groups = buildTeleportGroups(teleportEdges);
  const edgesByKey = new Map(teleportEdges.map((edge) => [teleportEdgeKey(edge), edge]));
  return groups.map((group) => {
    const groupEdges = group.edgeKeys.map((key) => edgesByKey.get(key)).filter((edge): edge is TeleportEdge => edge !== undefined && (edge.toFloor !== undefined || edge.fromFloor !== undefined));
    return {
      foreground: visibleColor(ctx, teleportGroupColorField(settings, group.key, "border", defaultField)),
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

/** Which size control a text label belongs to — one per independent font-size field (GitHub issue
 *  #707). Auto-fit resolves a size per kind; the overflow warnings group start/finish together. */
export type TextFitKind = "start" | "finish" | "elevator" | "teleport" | "markerIndex";

/** Visibility context of a warning pass. Built from the *unscoped* graph (a floor-scoped edge list
 *  can't tell a two-way passage from a one-way one — its reverse half lives on another floor); the
 *  per-floor data conditions (does this floor have such an edge) stay with the callers. `floors`
 *  is left empty: it only feeds the section-level `vertical` flag, and every per-kind vertical
 *  predicate already implies it. */
function warningVisibility(nodes: NodeDto[], edges: EdgeDto[], settings: VectorByWallsSettings | VectorByCorridorsSettings): ColorVisibilityContext {
  return buildColorVisibility({ nodes, edges, floors: [] }, settings);
}

type TextFitSettings = Pick<VectorByWallsSettings, "startMarker" | "finishMarker" | "elevatorBadges" | "teleportFloorBadge" | "teleportConnectorStyle" | "markerIndex">;

type TextFitEntry = TextFitItem & {
  kind: TextFitKind;
  /** Font size currently configured for the owning field (px). */
  fontSize: number;
  nodes: number[];
  cells?: { x: number; y: number; floorIndex: number }[];
  crossFloorTargets?: { nodeId: number; targetFloorIndex: number }[];
};

/** Every label drawn on one floor, with the plate it must fit and the elements to highlight when it
 *  does not. Mirrors the renderers' own draw rules: start/finish text honors `textEnabled`, elevator
 *  badges `enabled`, teleport floor badges need a visible connector (`teleportConnectorStyle`). */
function collectTextFitEntries(
  nodeById: Map<number, NodeDto>,
  edges: EdgeDto[],
  cfg: TessellationConfig,
  teleportEdges: TeleportEdge[],
  settings: TextFitSettings,
  start: number | null,
  finish: number | null,
  resolveNodeLevel: ReturnType<typeof selectNodeLevelResolver>,
  displayFloorIndex: number,
  unscoped: { nodes: NodeDto[]; edges: EdgeDto[] },
): TextFitEntry[] {
  const entries: TextFitEntry[] = [];
  const addMarker = (kind: "start" | "finish", id: number | null, marker: TextFitSettings["startMarker"]) => {
    if (id === null || !marker.text || marker.textEnabled === false) return;
    entries.push({
      kind, text: marker.text, fontWeight: marker.textFontWeight ?? "bold", shape: marker.shape, plateSize: marker.size,
      fontSize: marker.textSize ?? DEFAULT_MARKER_TEXT_SIZE, margin: marker.textMargin ?? DEFAULT_TEXT_MARGIN, nodes: [id],
    });
  };
  addMarker("start", start, settings.startMarker);
  addMarker("finish", finish, settings.finishMarker);

  const badges = settings.elevatorBadges;
  if (badges.enabled) {
    const verticalPairs = selectVerticalPassagePairSet(edges);
    const markers = buildVerticalConnectionMarkers(nodeById, edges, cfg, resolveNodeLevel, 0, verticalPairs, edges);
    for (const marker of markers) {
      if (marker.kind !== "elevator" || !marker.targetFloorIndices) continue;
      for (const [i, floorIndex] of marker.targetFloorIndices.entries()) {
        entries.push({
          kind: "elevator", text: formatIndexLabel(floorIndex, badges.labelType), fontWeight: badges.textFontWeight,
          shape: badges.shape, plateSize: badges.size, fontSize: badges.textSize, margin: badges.textMargin, nodes: [marker.fromNode],
          crossFloorTargets: [{ nodeId: marker.fromNode, targetFloorIndex: marker.targetFloorIndices[i] }],
        });
      }
    }
  }

  if (settings.teleportConnectorStyle !== "none") {
    const badge = settings.teleportFloorBadge;
    const addTeleport = (point: [number, number], floorIndex: number) => {
      const [x, y] = nearestCellCoord(point[0], point[1], cfg);
      entries.push({
        kind: "teleport", text: formatIndexLabel(floorIndex, badge.labelType), fontWeight: badge.textFontWeight,
        shape: badge.shape, plateSize: badge.size, fontSize: badge.textSize, margin: badge.textMargin, nodes: [], cells: [{ x, y, floorIndex: displayFloorIndex }],
      });
    };
    for (const edge of teleportEdges) {
      if (edge.toFloor !== undefined) addTeleport(edge.to, edge.toFloor);
      if (edge.fromFloor !== undefined) addTeleport(edge.from, edge.fromFloor);
    }
  }

  // Marker-index plates (GitHub issue #725): fixed-size rectangles, labels of the displayed floor.
  const index = settings.markerIndex;
  if (index.enabled) {
    const { labels } = buildMarkerIndexLabels(unscoped.nodes, unscoped.edges, cfg, displayFloorIndex, index, NO_ENDPOINT_VISUAL);
    for (const label of labels) {
      const [x, y] = nearestCellCoord(label.pos[0], label.pos[1], cfg);
      entries.push({
        kind: "markerIndex", text: label.label, fontWeight: index.textFontWeight, shape: "circle", plateSize: 0,
        plateWidth: index.width, plateHeight: index.height, fontSize: index.textSize, margin: index.textMargin, nodes: [], cells: [{ x, y, floorIndex: displayFloorIndex }],
      });
    }
  }
  return entries;
}

/** Endpoint visual stand-in: the text-fit passes need the index strings and cells, not plate colors. */
const NO_ENDPOINT_VISUAL = () => ({ outerRadius: 0, borderWidth: 0, borderMatchColor: 0 });

const TEXT_OVERFLOW_WARNING_ID: Record<TextFitKind, ExportWarningId> = {
  start: "marker_text_overflow",
  finish: "marker_text_overflow",
  elevator: "elevator_badge_text_overflow",
  teleport: "teleport_badge_text_overflow",
  markerIndex: "marker_index_text_overflow",
};

function pushTextOverflowWarnings(warnings: ExportWarning[], entries: readonly TextFitEntry[]): void {
  const byId = new Map<ExportWarningId, ExportWarning>();
  for (const entry of entries) {
    if (!textOverflows(entry, entry.fontSize)) continue;
    const id = TEXT_OVERFLOW_WARNING_ID[entry.kind];
    let warning = byId.get(id);
    if (!warning) {
      warning = { id, key: id, nodes: [], edges: [] };
      byId.set(id, warning);
      warnings.push(warning);
    }
    warning.nodes.push(...entry.nodes);
    if (entry.cells) warning.cells = [...(warning.cells ?? []), ...entry.cells];
    if (entry.crossFloorTargets) warning.crossFloorTargets = [...(warning.crossFloorTargets ?? []), ...entry.crossFloorTargets];
  }
}

/** Every label across all floors, grouped by size control — the input of the "Auto-fit" buttons
 *  (GitHub issue #707). Empty array for a kind with nothing to fit. */
export function computeTextFitItemsAcrossFloors(
  nodes: NodeDto[], edges: EdgeDto[], floors: WarningFloor[], cfg: TessellationConfig,
  settings: TextFitSettings, start: number | null, finish: number | null,
): Record<TextFitKind, TextFitItem[]> {
  const result: Record<TextFitKind, TextFitItem[]> = { start: [], finish: [], elevator: [], teleport: [], markerIndex: [] };
  const resolveNodeLevel = selectNodeLevelResolver(nodes);
  for (const [index, floor] of floors.entries()) {
    const scoped = selectFloorScopedMaze(nodes, edges, floors, floor.id, start, finish);
    const floorContext: TeleportFloorContext = {
      resolveNodeLevel,
      unscopedNodeById: new Map(nodes.map((node) => [node.id, node])),
      unscopedEdges: edges,
      activeFloorIndex: index,
    };
    const nodeById = new Map(scoped.nodes.map((node) => [node.id, node]));
    const teleportEdges = buildTeleportEdges(nodeById, scoped.edges, cfg, floorContext);
    for (const entry of collectTextFitEntries(nodeById, scoped.edges, cfg, teleportEdges, settings, scoped.start, scoped.finish, resolveNodeLevel, index, { nodes, edges })) {
      result[entry.kind].push({
        text: entry.text, fontWeight: entry.fontWeight, shape: entry.shape, plateSize: entry.plateSize,
        plateWidth: entry.plateWidth, plateHeight: entry.plateHeight, margin: entry.margin,
      });
    }
  }
  return result;
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
  ctx: ColorVisibilityContext,
): { colors: (VisibleColor | null)[]; keys: string[]; nodes: number[] } {
  if (maxSplitNodeCount(nodes) === 0) return { colors: [], keys: [], nodes: [] };
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const effectiveColors = buildEffectiveSplitNodeColors(ctx.settings.splitNodeColors, maxSplitNodeCount(nodes));
  const { passages } = buildSplitPassages(nodes, edges, cfg, new Set(), {}, {}, effectiveColors);
  const colors: (VisibleColor | null)[] = [];
  const keys: string[] = [];
  const seen = new Set<string>();
  const ids = new Set<number>();
  for (const passage of passages) {
    const key = passage.nodeIndex === undefined ? `color:${passage.color}` : `slot:${passage.nodeIndex}`;
    if (!seen.has(key)) {
      seen.add(key);
      // A slot's color is edited in that slot's own split-node field; a passage with no slot has
      // no owning field.
      colors.push(passage.nodeIndex === undefined ? unownedColor(passage.color) : visibleColor(ctx, splitNodeKey(passage.nodeIndex)));
      keys.push(String(key));
    }
    for (const node of nodeById.values()) {
      if (`${node.x},${node.y}` === passage.pointKey) ids.add(node.id);
    }
  }
  return { colors, keys, nodes: Array.from(ids) };
}

function pushSplitPairwiseWarning(
  warnings: ExportWarning[],
  split: { colors: readonly (VisibleColor | null)[]; keys: readonly string[]; nodes: readonly number[] },
): void {
  const { colors, keys, nodes } = split;
  // This is one visual problem — split colors are not distinguishable from each other — even
  // when several slot pairs happen to trip the same contrast check. Keep one warning for the
  // whole split palette (key = id, so floors merge into it); the first offending pair feeds the
  // detailed color description, every offending slot field is attached so each slot's picker
  // shows it.
  let first: { colorValues: [number, number]; colorFields?: [ColorFieldKey, ColorFieldKey] } | undefined;
  const fields = new Set<ColorFieldKey>();
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const [first_, second_] = [colors[i], colors[j]];
      if (!first_ || !second_ || keys[i] === keys[j] || !hasLowContrast(first_.value, second_.value)) continue;
      const [a, b] = [first_.field, second_.field];
      if (a) fields.add(a);
      if (b) fields.add(b);
      first ??= { colorValues: [first_.value, second_.value], colorFields: a && b ? [a, b] : undefined };
    }
  }
  if (!first) return;
  warnings.push({
    id: "split_colors_low_contrast_each_other",
    key: "split_colors_low_contrast_each_other",
    nodes: [...nodes],
    edges: [],
    colorValues: first.colorValues,
    colorFields: first.colorFields,
    fields: fields.size > 0 ? Array.from(fields) : undefined,
  });
}

function addCommonContrastWarnings(
  warnings: ExportWarning[],
  nodes: NodeDto[],
  edges: EdgeDto[],
  ctx: ColorVisibilityContext,
  teleportEdges: TeleportEdge[],
  allNodesForWarnings: NodeDto[],
  allEdgesForWarnings: EdgeDto[],
  start: number | null,
  finish: number | null,
  displayFloorIndex: number,
  cfg: TessellationConfig,
): void {
  const settings = ctx.settings;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const warningNodeById = new Map(allNodesForWarnings.map((node) => [node.id, node]));
  const surfaceKind = ctx.mode === "walls" ? "floor" : "corridor";
  /** Every color below is read through the registry: hidden fields come back `null` and their
   *  entries are dropped by `pushContrastWarningEntries` (GitHub issue #717). */
  const color = (key: ColorFieldKey) => visibleColor(ctx, key);
  /** The floor / corridor surface color. */
  const base = color(surfaceKind === "floor" ? "tilesFloor" : "corridorFill");
  const markerFillWarningId = surfaceKind === "floor" ? "marker_fill_low_contrast_floor" : "marker_fill_low_contrast_corridor";
  const markerBorderWarningId = surfaceKind === "floor" ? "marker_border_low_contrast_floor" : "marker_border_low_contrast_corridor";
  const elevatorBadgeFillWarningId = surfaceKind === "floor" ? "elevator_badge_fill_low_contrast_floor" : "elevator_badge_fill_low_contrast_corridor";
  const teleportBadgeBorderWarningId = surfaceKind === "floor" ? "teleport_badge_border_low_contrast_floor" : "teleport_badge_border_low_contrast_corridor";
  const teleportBadgeFillWarningId = surfaceKind === "floor" ? "teleport_badge_fill_low_contrast_floor" : "teleport_badge_fill_low_contrast_corridor";
  const vertical = verticalPassageEdges(edges);
  const oneWayVertical = oneWayVerticalPassageEdges(edges, allEdgesForWarnings);
  const elevator = edges.filter((edge) => edge.kind === "elevator");
  const teleport = edges.filter((edge) => edge.kind === "teleport");
  pushContrastWarning(warnings, "grid_low_contrast_background", [[color("bgGrid"), color("bgFill")]]);
  pushContrastWarning(warnings, "inner_grid_low_contrast_floor", [[color("innerGrid"), base]]);
  pushContrastWarning(warnings, "inner_grid_low_contrast_wall", [[color("innerGrid"), color("tilesWall")]]);

  const fillEntries: ContrastEntry[] = [];
  const borderEntries: ContrastEntry[] = [];
  const addMarker = (
    borderWidth: number,
    markerNodes: Iterable<number>,
    fill: ColorFieldKey,
    border: ColorFieldKey,
  ) => {
    if (borderWidth === 0) fillEntries.push({ foreground: color(fill), background: base, nodes: markerNodes });
    else borderEntries.push({ foreground: color(border), background: base, nodes: markerNodes });
  };
  if (start !== null && nodeById.has(start)) addMarker(settings.startMarker.borderWidth, [start], "startFill", "startBorder");
  if (finish !== null && nodeById.has(finish)) addMarker(settings.finishMarker.borderWidth, [finish], "finishFill", "finishBorder");
  if (teleport.length > 0) {
    const groups = settings.teleportGroupCustomization ? buildTeleportGroups(teleportEdges) : [];
    const edgesByKey = new Map(teleportEdges.map((edge) => [teleportEdgeKey(edge), edge]));
    const teleportBorderWidth = settings.teleportMarker.borderWidth;
    if (groups.length === 0) {
      addMarker(teleportBorderWidth, teleportEdges.flatMap((edge) => [edge.fromNode, edge.toNode].filter((id): id is number => id !== undefined)), "teleportEdge", "teleportEdgeBorder");
    } else {
      for (const group of groups) {
        const groupNodeIds = group.edgeKeys.flatMap((key) => {
          const edge = edgesByKey.get(key);
          return edge ? [edge.fromNode, edge.toNode].filter((id): id is number => id !== undefined) : [];
        });
        addMarker(
          teleportBorderWidth,
          groupNodeIds,
          teleportGroupColorField(settings, group.key, "fill", "teleportEdge"),
          teleportGroupColorField(settings, group.key, "border", "teleportEdgeBorder"),
        );
      }
    }
  }
  for (const edge of vertical) {
    if (!oneWayVertical.includes(edge)) addMarker(settings.twoWayPassageMarker.borderWidth, [edge.from, edge.to], "twoWayFill", "twoWayBorder");
  }
  for (const edge of oneWayVertical) {
    addMarker(settings.oneWayPassageMarker.borderWidth, [edge.from, edge.to], "oneWayFill", "oneWayBorder");
  }
  for (const edge of elevator) addMarker(settings.elevatorMarker.borderWidth, [edge.from, edge.to], "elevatorFill", "elevatorBorder");
  pushContrastWarningEntries(warnings, markerFillWarningId, fillEntries);
  pushContrastWarningEntries(warnings, markerBorderWarningId, borderEntries);

  const labelEntries: ContrastEntry[] = [];
  const crossFloorTeleportEdges = teleport.filter((edge) => (warningNodeById.get(edge.from)?.level ?? 0) !== (warningNodeById.get(edge.to)?.level ?? 0));
  if (crossFloorTeleportEdges.length > 0) {
    pushContrastWarningEntries(warnings, "teleport_badge_text_low_contrast", [{
      foreground: color("teleportBadgeText"),
      background: color("teleportBadgeFill"),
      cells: teleportBadgeCells(teleportEdges, displayFloorIndex, cfg),
    }]);
  }
  if (elevator.length > 0) {
    labelEntries.push({ foreground: color("elevatorBadgeText"), background: color("elevatorBadgeFill"), nodes: elevator.flatMap((edge) => [edge.from, edge.to]) });
  }
  if (start !== null && nodeById.has(start)) {
    labelEntries.push({ foreground: color("startText"), background: color("startFill"), nodes: [start] });
  }
  if (finish !== null && nodeById.has(finish)) {
    labelEntries.push({ foreground: color("finishText"), background: color("finishFill"), nodes: [finish] });
  }
  const indexedEdges = edges.filter((edge) => {
    if (edge.kind === "elevator") return settings.markerIndex.coverage.elevator;
    if (edge.kind === "vertical_passage") return settings.markerIndex.coverage.verticalPassage;
    if (edge.kind !== "teleport") return false;
    const fromLevel = warningNodeById.get(edge.from)?.level ?? 0;
    const toLevel = warningNodeById.get(edge.to)?.level ?? 0;
    return fromLevel === toLevel ? settings.markerIndex.coverage.singleFloorTeleport : settings.markerIndex.coverage.crossFloorTeleport;
  });
  if (indexedEdges.length > 0) {
    labelEntries.push({ foreground: color("markerIndexText"), background: color("markerIndexFill"), nodes: edgeNodeIds(indexedEdges, warningNodeById), edges: edgePairs(indexedEdges) });
  }
  pushContrastWarningEntries(warnings, "label_low_contrast", labelEntries);

  const twoWay = vertical.filter((edge) => !oneWayVertical.includes(edge));
  /** A per-kind entry: present only when the maze has that kind on this floor. */
  const verticalEntry = (
    kindEdges: EdgeDto[],
    foreground: ColorFieldKey,
    background: ColorFieldKey,
  ): ContrastEntry[] => kindEdges.length > 0
    ? [{ foreground: color(foreground), background: color(background), nodes: edgeNodeIds(kindEdges, warningNodeById), edges: edgePairs(kindEdges) }]
    : [];
  // Abstract-style arrows (their fields are hidden under the decorative style) …
  pushContrastWarningEntries(warnings, "vertical_arrow_low_contrast", verticalEntry(twoWay, "twoWayArrow", "twoWayFill"));
  pushContrastWarningEntries(warnings, "vertical_one_way_arrow_low_contrast_fill", verticalEntry(oneWayVertical, "oneWayArrow", "oneWayFill"));
  pushContrastWarningEntries(warnings, "elevator_arrow_low_contrast", verticalEntry(elevator, "elevatorArrow", "elevatorFill"));
  pushContrastWarning(warnings, "wall_low_contrast_floor", [[color("tilesWall"), color("tilesFloor")]]);
  // … and decorative-style lines/arrows over the floor (Vector by walls only; hidden otherwise).
  const decor = (kindEdges: EdgeDto[], foreground: ColorFieldKey) => kindEdges.length > 0
    ? [{ foreground: color(foreground), background: base, nodes: edgeNodeIds(kindEdges, warningNodeById), edges: edgePairs(kindEdges) }]
    : [];
  pushContrastWarningEntries(warnings, "vertical_two_way_line_low_contrast_floor", decor(twoWay, "decorLineTwoWay"));
  pushContrastWarningEntries(warnings, "vertical_two_way_arrow_low_contrast_floor", decor(twoWay, "decorArrowTwoWay"));
  pushContrastWarningEntries(warnings, "vertical_one_way_line_low_contrast_floor", decor(oneWayVertical, "decorLineOneWay"));
  pushContrastWarningEntries(warnings, "vertical_one_way_accent_low_contrast_floor", decor(oneWayVertical, "decorArrowOneWay"));
  pushContrastWarningEntries(warnings, "elevator_line_low_contrast_floor", decor(elevator, "decorLineElevator"));
  if (elevator.length > 0) {
    pushContrastWarning(warnings, elevatorBadgeFillWarningId, [[color("elevatorBadgeFill"), base]], edgeNodeIds(elevator, warningNodeById), edgePairs(elevator));
  }
  const crossFloorTeleports = teleportEdges.filter((edge) => (warningNodeById.get(edge.fromNode ?? -1)?.level ?? 0) !== (warningNodeById.get(edge.toNode ?? -1)?.level ?? 0));
  if (crossFloorTeleports.length > 0) {
    // Group overrides replace the badge border as well as the connector border. Without group
    // customization the badge has its own dedicated border color.
    const badgeBorderWidth = settings.teleportFloorBadge.borderWidth;
    const badgeHasBorder = badgeBorderWidth > 0;
    pushContrastWarningEntries(
      warnings,
      badgeHasBorder ? teleportBadgeBorderWarningId : teleportBadgeFillWarningId,
      teleportBadgeColorEntries(teleportEdges, ctx, base, displayFloorIndex, cfg, badgeHasBorder ? "border" : "fill"),
    );
  }
}

export function computeVectorByWallsWarnings(
  nodes: NodeDto[],
  edges: EdgeDto[],
  cfg: TessellationConfig,
  rawSettings: VectorByWallsSettings,
  start: number | null,
  finish: number | null,
  unscopedNodes: NodeDto[] = nodes,
  teleportFloorContext?: TeleportFloorContext,
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

  const ctx = warningVisibility(unscopedNodes, teleportFloorContext?.unscopedEdges ?? edges, settings);
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
  const splitFloor = splitContrastData(nodes, edges, cfg, ctx);
  pushContrastWarning(warnings, "split_low_contrast_floor", splitFloor.colors.map((color): ContrastPair => [color, visibleColor(ctx, "tilesFloor")]), splitFloor.nodes);
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
  ));

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
  rawSettings: VectorByCorridorsSettings,
  start: number | null,
  finish: number | null,
  unscopedNodesOrContext?: NodeDto[] | TeleportFloorContext,
  allNodesForWarnings: NodeDto[] = Array.isArray(unscopedNodesOrContext) ? unscopedNodesOrContext : nodes,
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

  const ctx = warningVisibility(allNodesForWarnings, teleportFloorContext?.unscopedEdges ?? edges, settings);
  addCommonContrastWarnings(
    warnings, nodes, edges, ctx, teleportEdges, allNodesForWarnings, teleportFloorContext?.unscopedEdges ?? edges, start, finish,
    teleportFloorContext?.activeFloorIndex ?? nodes[0]?.level ?? 0, cfg,
  );

  const corridorSegments = buildCorridorSegments(nodes, edges, cfg);
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
  const splitCorridor = splitContrastData(nodes, edges, cfg, ctx);
  pushContrastWarning(warnings, "split_low_contrast_corridor", splitCorridor.colors.map((color): ContrastPair => [color, visibleColor(ctx, "corridorFill")]), splitCorridor.nodes);
  pushContrastWarning(warnings, "split_low_contrast_background", splitCorridor.colors.map((color): ContrastPair => [color, visibleColor(ctx, "bgFill")]), splitCorridor.nodes);
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
  ));

  const indistinguishable = computeElevatorIndistinguishableWarning(
    nodes, edges, settings.markerIndex.enabled && settings.markerIndex.coverage.elevator, settings.elevatorBadges.enabled,
  );
  if (indistinguishable) warnings.push(indistinguishable);

  return warnings;
}
