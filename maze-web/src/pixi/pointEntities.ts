import { presetEndpointsEqual, type PresetEndpoint } from "./presetEndpoint";
import {
  allNodesAt, canonicalizePresetPair, presetEdgeKey,
  type PresetConnectionEntry, type PresetTeleportEntry, type PresetVerticalPassageEntry, type PresetElevatorEntry,
} from "./fieldEditUtils";
import type { NodeLockKind } from "../wasm/types";
import * as m from "~/paraglide/messages";

export type PresetPointEntityKind =
  | "start" | "finish" | "gen_source" | "edge" | "teleport"
  | "vertical_passage" | "elevator" | "lock" | "split_node";

/** A single removable/resettable entity anchored on one node (`endpoint`) of a preset point,
 *  built for the entity-delete dialog (GitHub issue #540). Pure data — no mutation here; the store
 *  action (`removePresetPointEntity`) maps `kind`+`id` back to the existing per-entity remover.
 *  `id` is stable and `kind`-scoped (teleport/vertical-passage/elevator's own numeric id as a
 *  string, an edge's canonical key, `"lock"`, `"split_node:<slotId>"`, or the marker kind itself
 *  for start/finish/gen-source — at most one of each per point). `nodeIndex` is 0-based, matching
 *  `buildPresetCellInspection`'s "Node N" numbering (`nodeIndex + 1`) — always recomputed from the
 *  live `presetSplitPoints`, never cached as identity. */
export interface PresetPointEntityDescriptor {
  kind: PresetPointEntityKind;
  id: string;
  endpoint: PresetEndpoint;
  nodeIndex: number;
  title: string;
}

export type PresetPointEntityScope =
  | { kind: "point_all" }
  | { kind: "vertex_markers"; endpoints: PresetEndpoint[] };

function formatFloor(level: number): string {
  return `L${level + 1}`;
}

function formatTarget(other: PresetEndpoint, activeFloorLevel: number): string {
  const otherLevel = other.level ?? 0;
  return otherLevel === activeFloorLevel ? `(${other.point[0]},${other.point[1]})` : `(${formatFloor(otherLevel)})`;
}

function formatLockKind(kind: NodeLockKind): string {
  switch (kind) {
    case "in": return m["status.cell_lock_in"]();
    case "out": return m["status.cell_lock_out"]();
    case "both": return m["status.cell_lock_both"]();
  }
}

/** Localized edge-row label for the entity-delete dialog (GitHub issue #540 follow-up bug report:
 *  a wall was mislabeled with the lock "out" string, and a passage/one-way showed its raw,
 *  untranslated state literal) — reuses the same tool-name messages the preset toolbar itself
 *  shows (`preset.wall`/`preset.passage`/`preset.one_way`). Just the state name — direction and
 *  target are appended separately by the caller (same `<arrow> (target)` convention as
 *  teleport/vertical-passage rows), so a one-way's own arrow isn't duplicated in the row title.
 *  Callers only ever pass a `"wall"`/`"passage"`/one-way state here — `"undefined"`/teleport
 *  states never reach an `"edge"` row (filtered upstream / never stored in `presetConnections`). */
function formatEdgeState(state: PresetConnectionEntry["state"]): string {
  switch (state) {
    case "wall": return m["preset.wall"]();
    case "passage": return m["preset.passage"]();
    case "one_way_forward": return m["preset.one_way"]();
    case "one_way_backward": return m["preset.one_way"]();
    default: return state;
  }
}

/** Marker-kind (start/finish/gen-source/teleport/vertical-passage/elevator) descriptors anchored
 *  on one specific `endpoint` — the shared core behind both `buildPresetNodeMarkerLines` (status
 *  bar, formats these into plain strings) and `buildPresetPointEntities`'s `vertex_markers` scope
 *  (formats these into dialog rows). Does not include edges/lock/split-slot — those only ever
 *  belong to the `point_all` scope (GitHub issue #540's architecture: `vertex_markers` never grows
 *  past the five RMB vertex-tool kinds). */
export function presetVertexMarkerEntities(
  endpoint: PresetEndpoint,
  activeFloorLevel: number,
  presetStart: PresetEndpoint | null,
  presetFinish: PresetEndpoint | null,
  presetGenSource: PresetEndpoint | null,
  presetTeleports: PresetTeleportEntry[],
  presetVerticalPassages: PresetVerticalPassageEntry[],
  presetElevators: PresetElevatorEntry[],
): PresetPointEntityDescriptor[] {
  const out: PresetPointEntityDescriptor[] = [];
  const nodeIndex = 0; // placeholder, overwritten by callers that know the point's node order

  if (presetStart && presetEndpointsEqual(presetStart, endpoint)) {
    out.push({ kind: "start", id: "start", endpoint, nodeIndex, title: m["status.cell_start"]() });
  }
  if (presetFinish && presetEndpointsEqual(presetFinish, endpoint)) {
    out.push({ kind: "finish", id: "finish", endpoint, nodeIndex, title: m["status.cell_finish"]() });
  }
  if (presetGenSource && presetEndpointsEqual(presetGenSource, endpoint)) {
    out.push({ kind: "gen_source", id: "gen_source", endpoint, nodeIndex, title: m["status.cell_gen_source"]() });
  }

  for (const t of presetTeleports) {
    const departingHere = presetEndpointsEqual(t.from, endpoint);
    const arrivingHere = presetEndpointsEqual(t.to, endpoint);
    if (!departingHere && !arrivingHere) continue;
    const other = departingHere ? t.to : t.from;
    const target = formatTarget(other, activeFloorLevel);
    const isForward = departingHere === (t.direction !== "backward");
    const arrow = t.direction === "two_way" ? "<->" : isForward ? "->" : "<-";
    out.push({
      kind: "teleport", id: String(t.id), endpoint, nodeIndex,
      title: m["status.cell_teleport"]({ arrow, target }),
    });
  }

  for (const v of presetVerticalPassages) {
    const departingHere = presetEndpointsEqual(v.from, endpoint);
    const arrivingHere = presetEndpointsEqual(v.to, endpoint);
    if (!departingHere && !arrivingHere) continue;
    const other = departingHere ? v.to : v.from;
    const target = `(${formatFloor(other.level ?? 0)})`;
    const isForward = departingHere === (v.direction !== "backward");
    const arrow = v.direction === "two_way" ? "<->" : isForward ? "->" : "<-";
    out.push({
      kind: "vertical_passage", id: String(v.id), endpoint, nodeIndex,
      title: m["status.cell_vertical_passage"]({ arrow, target }),
    });
  }

  for (const e of presetElevators) {
    if (!e.floors.some((f) => presetEndpointsEqual(f, endpoint))) continue;
    const targetLevels = [...new Set(e.floors.filter((f) => !presetEndpointsEqual(f, endpoint)).map((f) => f.level ?? 0))]
      .sort((a, b) => a - b);
    if (targetLevels.length === 0) continue;
    out.push({
      kind: "elevator", id: String(e.id), endpoint, nodeIndex,
      title: m["status.cell_elevator"]({ targets: targetLevels.map(formatFloor).join(", ") }),
    });
  }

  return out;
}

function pointKey(point: [number, number], level: number | undefined): string {
  return level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
}

export interface PresetPointEntitiesInput {
  presetSplitPoints: Record<string, number[]>;
  presetStart: PresetEndpoint | null;
  presetFinish: PresetEndpoint | null;
  presetGenSource: PresetEndpoint | null;
  presetTeleports: PresetTeleportEntry[];
  presetVerticalPassages: PresetVerticalPassageEntry[];
  presetElevators: PresetElevatorEntry[];
  presetConnections: Map<string, PresetConnectionEntry>;
  lockedNodes: Map<string, NodeLockKind>;
  autoLockedNodes: Set<string>;
  /** Per-node semantic names (original node first, then each slot in `presetSplitPoints` order),
   *  as produced by `splitNodeSemanticNamesFromKinds` — `null`/absent when the point's topology
   *  isn't a recognized special shape, or the caller doesn't have tessellation geometry handy
   *  (this module stays geometry-free by design; callers that can compute face kinds, such as
   *  `PresetEntityDeleteDialog`, pass this in). Only the slot names (index 1+) are used here — the
   *  original node's own name (index 0) has no row of its own in this list. */
  splitSemanticNames?: { full: string; short: string }[] | null;
}

/** Builds the full removable-entity list for the entity-delete dialog (GitHub issue #540) —
 *  `scope: "point_all"` covers every node of the point (edges, markers, teleports, vertical
 *  passages, elevators, lock, split-node), `scope: "vertex_markers"` restricts to the five
 *  RMB vertex-tool marker kinds anchored on `scope.endpoints` only (never edges/lock/split-node).
 *  `activeFloorLevel` is only used for same-floor-vs-cross-floor teleport target formatting,
 *  matching `buildPresetCellInspection`'s own convention. */
export function buildPresetPointEntities(
  point: [number, number],
  level: number | undefined,
  activeFloorLevel: number,
  scope: PresetPointEntityScope,
  input: PresetPointEntitiesInput,
): PresetPointEntityDescriptor[] {
  const {
    presetSplitPoints, presetStart, presetFinish, presetGenSource,
    presetTeleports, presetVerticalPassages, presetElevators,
    presetConnections, lockedNodes, splitSemanticNames,
  } = input;

  if (scope.kind === "vertex_markers") {
    const out: PresetPointEntityDescriptor[] = [];
    const seen = new Set<string>();
    const nodesHere = allNodesAt(point, presetSplitPoints, level);
    for (const endpoint of scope.endpoints) {
      const nodeIndex = nodesHere.findIndex((n) => presetEndpointsEqual(n, endpoint));
      const entities = presetVertexMarkerEntities(
        endpoint, activeFloorLevel, presetStart, presetFinish, presetGenSource,
        presetTeleports, presetVerticalPassages, presetElevators,
      );
      for (const e of entities) {
        const dedupKey = `${e.kind}:${e.id}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        out.push({ ...e, nodeIndex: nodeIndex === -1 ? 0 : nodeIndex });
      }
    }
    return out;
  }

  const nodesHere = allNodesAt(point, presetSplitPoints, level);
  const out: PresetPointEntityDescriptor[] = [];

  nodesHere.forEach((endpoint, nodeIndex) => {
    const entities = presetVertexMarkerEntities(
      endpoint, activeFloorLevel, presetStart, presetFinish, presetGenSource,
      presetTeleports, presetVerticalPassages, presetElevators,
    );
    for (const e of entities) out.push({ ...e, nodeIndex });
  });

  // Edges — original node only, and only for a point with no split nodes at all. Once a point has
  // slots, *every* edge of the point (original node's own faces included — a bridge/diagonal
  // shape is drawn across both the original and its slot node's faces together) is part of the
  // split shape, already represented as a single "Bridge"/"Node N" row below; no edge gets its own
  // row there (GitHub issue #540 follow-up: no duplicate rows for a split's connections — the
  // split is one row, period).
  const key = pointKey(point, level);
  const hasSplit = (presetSplitPoints[key]?.length ?? 0) > 0;
  if (!hasSplit) {
    const seenEdge = new Set<string>();
    const originalEndpoint = nodesHere[0];
    for (const entry of presetConnections.values()) {
      if (entry.state === "undefined") continue;
      // Only entries the user actually set (`source: "user"`) get their own removable row — a
      // `"default"` entry is just `defaultEdgeState`'s field-wide fill-in (`applyDefaultEdgeState`),
      // not something the user placed on this point, so it shouldn't clutter the entity list
      // (GitHub issue #540 follow-up bug report).
      if (entry.source !== "user") continue;
      const touchesHere = presetEndpointsEqual(entry.from, originalEndpoint) || presetEndpointsEqual(entry.to, originalEndpoint);
      if (!touchesHere) continue;
      const [a, b] = canonicalizePresetPair(entry.from, entry.to);
      const edgeKey = presetEdgeKey(a, b);
      if (seenEdge.has(edgeKey)) continue;
      seenEdge.add(edgeKey);
      const fromIsHere = presetEndpointsEqual(entry.from, originalEndpoint);
      const otherEnd = fromIsHere ? entry.to : entry.from;
      const arrow = entry.state === "one_way_forward"
        ? (fromIsHere ? "->" : "<-")
        : entry.state === "one_way_backward"
          ? (fromIsHere ? "<-" : "->")
          : "->";
      out.push({
        kind: "edge", id: edgeKey, endpoint: originalEndpoint, nodeIndex: 0,
        title: `${formatEdgeState(entry.state)} ${arrow} (${otherEnd.point[0]},${otherEnd.point[1]})`,
      });
    }
  }

  // Lock — original node only (matches `buildPresetCellInspection`'s own rule), and only a
  // manually-set lock (`lockedNodes`): an auto-computed lock (`autoLockedNodes`, derived from
  // graph shape — see `recomputeAutoLock`) isn't user-removable, so it gets no row here (GitHub
  // issue #540 follow-up bug report).
  const lockKind = lockedNodes.get(key);
  if (lockKind) {
    out.push({
      kind: "lock", id: "lock", endpoint: nodesHere[0], nodeIndex: 0,
      title: m["status.cell_lock"]({ kind: formatLockKind(lockKind) }),
    });
  }

  // Split nodes — one row per declared slot (GitHub issue #540's revised design): each row names
  // one segment of the split ("Bridge", "Corridor 1", ... when the topology is a recognized
  // special shape, else the generic "Node N" fallback), and removing it removes the *entire*
  // split point at once — every slot, not just this one — migrating every entity anchored on a
  // removed node onto the point's original node (`removePresetSplitAll`, not a per-slot delete).
  // There's no orphan gating any more: the row is always present whenever the point has slots.
  const slotIds = presetSplitPoints[key] ?? [];
  slotIds.forEach((slotId, i) => {
    const endpoint = nodesHere[i + 1] ?? { point, slotId, level };
    const title = splitSemanticNames?.[i + 1]?.full ?? m["status.cell_node"]({ number: i + 2 });
    out.push({ kind: "split_node", id: `split_node:${slotId}`, endpoint, nodeIndex: i + 1, title });
  });

  return out;
}
