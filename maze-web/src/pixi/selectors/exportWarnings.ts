import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { VectorByWallsSettings, VectorByCorridorsSettings, TeleportSettingsFields } from "../../store/storeTypes";
import { buildTeleportEdges, buildSplitPassages, buildSplitPointKeys, getSplitAwareNodePosition, maxSplitNodeCount } from "./mazeSelectors";
import { buildTeleportGroups, teleportEdgeKey, coordKey } from "./teleportGroups";
import type { TeleportEdge } from "../renderers/types";
import { TILE_SIZE } from "../constants";

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
  /** "Vector by corridors" only (GitHub issue #311) — start/finish sits on *any* split point, not
   *  just a "special shape" one. Unlike `VectorByWallsRenderer`, this mode draws no split-point
   *  geometry at all (`buildCorridorSegments` skips every split point unconditionally), so a
   *  waypoint marker there sits with no corridor line drawn under it whatsoever — worth flagging
   *  regardless of whether the point would've been a recognized special shape. */
  | "waypoint_on_split_corridor"
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
  | "png_content_in_margin_zone";

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
    const waypointPos = getSplitAwareNodePosition(allNodes, waypoint.id, cfg);
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
 *  see `VectorByWallsSettingsPanel`'s warning list and `VectorByWallsRenderer`'s highlight overlay. */
export function computeVectorByWallsWarnings(
  nodes: NodeDto[],
  edges: EdgeDto[],
  cfg: TessellationConfig,
  settings: VectorByWallsSettings,
  start: number | null,
  finish: number | null,
): ExportWarning[] {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const teleportEdges = buildTeleportEdges(nodeById, edges, cfg);
  const allNodes = Array.from(nodeById.values());

  const warnings: ExportWarning[] = computeTeleportWarnings(
    teleportEdges,
    settings,
    { id: start, size: settings.startMarker.size, borderWidth: settings.startMarker.borderWidth },
    { id: finish, size: settings.finishMarker.size, borderWidth: settings.finishMarker.borderWidth },
    allNodes,
    cfg,
  );

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

  return warnings;
}

/** Every export-specific warning "Vector by corridors" currently knows how to detect (GitHub issue
 *  #311, teleport checks added as a #313 follow-up bugfix — this mode reuses `TeleportRenderer`
 *  as-is, so it can hit the exact same "ambiguous group"/"invisible marker"/"waypoint overlap"
 *  caveats "Vector by walls" already flags, and previously silently didn't). Kept as its own
 *  function (not folded into `computeVectorByWallsWarnings`) since the two modes' warning sets
 *  still differ: this mode has no special-split-shape rendering of its own (`waypoint_on_split`/
 *  `teleport_on_special_split` stay Walls-only), using `waypoint_on_split_corridor` instead. */
export function computeVectorByCorridorsWarnings(
  nodes: NodeDto[],
  edges: EdgeDto[],
  cfg: TessellationConfig,
  settings: VectorByCorridorsSettings,
  start: number | null,
  finish: number | null,
): ExportWarning[] {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const teleportEdges = buildTeleportEdges(nodeById, edges, cfg);
  const allNodes = Array.from(nodeById.values());

  const warnings: ExportWarning[] = computeTeleportWarnings(
    teleportEdges,
    settings,
    { id: start, size: settings.startMarker.size, borderWidth: settings.startMarker.borderWidth },
    { id: finish, size: settings.finishMarker.size, borderWidth: settings.finishMarker.borderWidth },
    allNodes,
    cfg,
  );

  const splitPointKeys = buildSplitPointKeys(nodes);

  if (splitPointKeys.size > 0) {
    const flaggedIds = filterNodesOnSpecialSplit(
      [start, finish].filter((id): id is number => id !== null),
      nodeById,
      splitPointKeys,
    );
    if (flaggedIds.length > 0) {
      warnings.push({
        id: "waypoint_on_split_corridor",
        key: "waypoint_on_split_corridor",
        nodes: flaggedIds,
        edges: [],
      });
    }
  }

  return warnings;
}
