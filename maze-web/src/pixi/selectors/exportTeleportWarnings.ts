import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { FieldConfig } from "../../fieldConfig";
import type { TeleportSettingsFields, MarkerLayoutSettingsFields } from "../../store/storeTypes";
import { getSplitAwareNodePosition } from "./mazeSelectors";
import { buildTeleportGroups, teleportEdgeKey, coordKey } from "./teleportGroups";
import type { TeleportEdge } from "../renderers/types";
import { applyMarkerLayout, MARKER_LAYOUT_SPACING, buildSplitHostKeys } from "./mazeSelectors/markerLayout";
import type { ExportWarning } from "./exportWarnings";

/** Marker "radius" in world px for the given `MarkerSettings`-like size — used only for the
 *  overlap distance check below, not for actual drawing. */
export function markerWorldRadius(size: number, borderWidth: number): number {
  return size / 2 + borderWidth;
}

/** One point-key -> fill-state pass over every teleport edge, mirroring
 *  `TeleportRenderer.resolvePointFillState`'s per-point logic but computed once for every point
 *  instead of once per point queried (that function itself scans all edges on each call — calling
 *  it in a loop over every endpoint would make this O(edges²)). `"outline"` means every edge
 *  landing on this point wants it empty (an exit-only one-way endpoint); `"filled"` means at least
 *  one edge wants it filled (an entry, or either end of a two-way). */
export function buildPointFillStates(teleportEdges: TeleportEdge[]): Map<string, "filled" | "outline"> {
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

/** The three teleport-only checks (`teleport_marker_invisible`, `teleport_group_ambiguous`,
 *  `teleport_waypoint_overlap`) both "Vector by walls" and "Vector by corridors" share — every
 *  field they read (`teleportMarker.borderWidth`, `teleportConnectorStyle`, `teleportGroupOverrides`,
 *  etc.) lives on the common `TeleportSettingsFields` (GitHub issue #313 follow-up: teleport
 *  rendering transfers as-is between the two modes, so its warnings should too — previously
 *  `computeVectorByCorridorsWarnings` detected none of these, silently missing e.g. ambiguous
 *  teleport groups with no connector to tell them apart). Takes `start`/`finish` marker style
 *  directly (not a whole mode-specific settings object) so it stays mode-agnostic. */
export function computeTeleportWarnings(
  teleportEdges: TeleportEdge[],
  settings: TeleportSettingsFields & MarkerLayoutSettingsFields,
  startMarker: { id: number | null; size: number; borderWidth: number },
  finishMarker: { id: number | null; size: number; borderWidth: number },
  allNodes: NodeDto[],
  cfg: FieldConfig,
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
  if (settings.teleportMergeMode && settings.teleportConnectorStyle === "none") {
    const edgeKeysByPoint = new Map<string, Set<string>>();
    const nodesByPoint = new Map<string, Set<number>>();
    for (const e of teleportEdges) {
      const edgeKey = teleportEdgeKey(e);
      for (const [pos, nodeId, floor] of [[e.from, e.fromNode, e.fromFloor], [e.to, e.toNode, e.toFloor]] as const) {
        if (floor !== undefined) continue;
        const pk = coordKey(pos[0], pos[1]);
        (edgeKeysByPoint.get(pk) ?? edgeKeysByPoint.set(pk, new Set()).get(pk)!).add(edgeKey);
        if (nodeId !== undefined) (nodesByPoint.get(pk) ?? nodesByPoint.set(pk, new Set()).get(pk)!).add(nodeId);
      }
    }
    const mergedNodeIds = new Set<number>();
    for (const [pk, keys] of edgeKeysByPoint) {
      if (keys.size > 1) for (const id of nodesByPoint.get(pk) ?? []) mergedNodeIds.add(id);
    }
    if (mergedNodeIds.size > 0) {
      warnings.push({
        id: "teleport_merged_without_connectors",
        key: "teleport_merged_without_connectors",
        nodes: Array.from(mergedNodeIds),
        edges: [],
      });
    }
  }

  if (settings.teleportConnectorStyle === "none") {
    const groups = buildTeleportGroups(teleportEdges, settings.teleportMergeMode);
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
      mergeTeleports: settings.teleportMergeMode,
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
export function computeElevatorIndistinguishableWarning(
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
