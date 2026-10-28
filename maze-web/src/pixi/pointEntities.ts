import { presetEndpointKey, presetEndpointsEqual, type PresetEndpoint } from "./presetEndpoint";
import { type PresetConnectionEntry, type PresetTeleportEntry, type PresetVerticalPassageEntry, type PresetElevatorEntry } from "./fieldEditUtils";
import { allNodesAt, canonicalizePresetPair, presetEdgeKey } from "./presetSplitResolve";
import { presetTargetLabel, resolvePresetSplitShapeLabel, type PresetSplitLabelContext } from "./presetSplitLabels";
import { formatTargetLabel } from "./targetLabel";
import type { NodeLockKind } from "../wasm/types";
import * as m from "~/paraglide/messages";

export type PresetPointEntityKind =
  | "start" | "finish" | "gen_source" | "edge" | "teleport"
  | "vertical_passage" | "elevator" | "lock" | "split_node";

/** A single removable/resettable entity anchored on one node (`endpoint`) or one whole split tile,
 *  built for the entity-delete dialog (GitHub issue #540). Pure data — no mutation here; the store
 *  action (`removePresetPointEntity`) maps `kind`+`id` back to the existing per-entity remover.
 *  `id` is stable and `kind`-scoped (teleport/vertical-passage/elevator's own numeric id as a
 *  string, an edge's canonical key, `"lock"`, `"split_node"`, or the marker kind itself for
 *  start/finish/gen-source — at most one of each per point). `nodeIndex` is 0-based, matching
 *  `buildPresetCellInspection`'s "Node N" numbering (`nodeIndex + 1`) — always recomputed from the
 *  live `presetSplitPoints`, never cached as identity. */
export interface PresetPointEntityDescriptor {
  kind: PresetPointEntityKind;
  id: string;
  endpoint: PresetEndpoint;
  nodeIndex: number;
  title: string;
  /** Coordinate/endpoint bubbles shown by the entity-delete dialog. */
  bubbles?: string[];
  showArrow?: boolean;
  arrow?: "->" | "<-" | "<->";
  entityId?: string;
}

export type PresetPointEntityScope =
  | { kind: "point_all" }
  | { kind: "vertex_markers"; endpoints: PresetEndpoint[] };

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
    case "undefined": return m["preset.default_undefined"]();
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
  splitCtx: PresetSplitLabelContext | null = null,
  /** Compact status-bar display (GitHub issue #595's follow-up): a vertical-passage/elevator
   *  target's x/y is always identical to the departure point's own (only the floor ever differs),
   *  so `true` drops its coordinate pair and split-node suffix down to just the floor (`L{floor}`).
   *  Teleport targets are unaffected (their x/y can genuinely differ) — always the full display.
   *  The entity-delete dialog keeps `false` (full display for every kind), since removing an entity
   *  there benefits from the exact target shown. */
  compactVerticalTarget = false,
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

  // Target label always resolves the split-node suffix now (GitHub issue #602's fix for #595's
  // follow-up: a teleport/vertical-passage landing on a split tile used to only show its floor,
  // never which of the point's nodes it actually resolves to) — `splitCtx: null` (a caller with no
  // face-geometry context handy, e.g. this module's own geometry-free callers before #602) simply
  // omits the suffix, same as an unsplit point always has.
  for (const t of presetTeleports) {
    const departingHere = presetEndpointsEqual(t.from, endpoint);
    const arrivingHere = presetEndpointsEqual(t.to, endpoint);
    if (!departingHere && !arrivingHere) continue;
    const other = departingHere ? t.to : t.from;
    const crossFloor = (other.level ?? 0) !== activeFloorLevel;
    const target = `(${splitCtx
      ? presetTargetLabel(splitCtx, other, crossFloor)
      : formatTargetLabel(other.point, other.level ?? 0, crossFloor, undefined)})`;
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
    const target = `(${splitCtx
      ? presetTargetLabel(splitCtx, other, true, compactVerticalTarget)
      : formatTargetLabel(other.point, other.level ?? 0, true, undefined, compactVerticalTarget)})`;
    const isForward = departingHere === (v.direction !== "backward");
    const arrow = v.direction === "two_way" ? "<->" : isForward ? "->" : "<-";
    out.push({
      kind: "vertical_passage", id: String(v.id), endpoint, nodeIndex,
      title: m["status.cell_vertical_passage"]({ arrow, target }),
    });
  }

  for (const e of presetElevators) {
    if (!e.floors.some((f) => presetEndpointsEqual(f, endpoint))) continue;
    const others = e.floors.filter((f) => !presetEndpointsEqual(f, endpoint));
    if (others.length === 0) continue;
    const targets = [...new Map(others.map((f) => [f.level ?? 0, f])).values()]
      .sort((a, b) => (a.level ?? 0) - (b.level ?? 0))
      .map((f) => (splitCtx
        ? presetTargetLabel(splitCtx, f, true, compactVerticalTarget)
        : formatTargetLabel(f.point, f.level ?? 0, true, undefined, compactVerticalTarget)));
    out.push({
      kind: "elevator", id: String(e.id), endpoint, nodeIndex,
      title: m["status.cell_elevator"]({ targets: targets.join(", ") }),
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
  /** Full split-label resolution context (GitHub issue #602) — `null`/absent when the caller has
   *  no tessellation/face geometry handy, in which case every bubble/title falls back to the
   *  generic "N{n}" suffix (or no suffix on an unsplit point), same as before this issue. Passed
   *  through to `presetTargetLabel` for every endpoint this function names — the point's own
   *  entities AND any cross-point target (a teleport/vertical-passage/elevator's other end), so a
   *  target landing on a split tile now also gets a real semantic name, not just "N{n}" (this was
   *  the actual GitHub issue #595 follow-up gap: the "other end" bubble never resolved a semantic
   *  name before, only the point's own entity did). */
  splitCtx?: PresetSplitLabelContext | null;
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
    presetConnections, lockedNodes, splitCtx,
  } = input;

  const label = (ep: PresetEndpoint, includeFloor: boolean): string =>
    splitCtx ? presetTargetLabel(splitCtx, ep, includeFloor) : formatTargetLabel(ep.point, ep.level ?? 0, includeFloor, undefined);

  const decorate = (entities: PresetPointEntityDescriptor[]): PresetPointEntityDescriptor[] => entities.map((entity) => {
    const here = label(entity.endpoint, (entity.endpoint.level ?? 0) !== activeFloorLevel);
    let bubbles = [here];
    let showArrow = false;
    let arrow: "->" | "<-" | "<->" = "->";
    let entityId: string | undefined;

    if (entity.kind === "teleport") {
      const entry = presetTeleports.find((candidate) => String(candidate.id) === entity.id);
      if (entry) {
        const departingHere = presetEndpointsEqual(entry.from, entity.endpoint);
        const other = departingHere ? entry.to : entry.from;
        const isForward = departingHere === (entry.direction !== "backward");
        const forceFloor = (entity.endpoint.level ?? 0) !== (other.level ?? 0);
        bubbles = [label(entity.endpoint, forceFloor), label(other, forceFloor)];
        showArrow = true;
        arrow = entry.direction === "two_way" ? "<->" : isForward ? "->" : "<-";
        entityId = entity.id;
      }
    } else if (entity.kind === "vertical_passage") {
      const entry = presetVerticalPassages.find((candidate) => String(candidate.id) === entity.id);
      if (entry) {
        const departingHere = presetEndpointsEqual(entry.from, entity.endpoint);
        const other = departingHere ? entry.to : entry.from;
        const isForward = departingHere === (entry.direction !== "backward");
        const forceFloor = (entity.endpoint.level ?? 0) !== (other.level ?? 0);
        bubbles = [label(entity.endpoint, forceFloor), label(other, forceFloor)];
        showArrow = true;
        arrow = entry.direction === "two_way" ? "<->" : isForward ? "->" : "<-";
        entityId = entity.id;
      }
    } else if (entity.kind === "elevator") {
      const entry = presetElevators.find((candidate) => String(candidate.id) === entity.id);
      if (entry) {
        bubbles = [entity.endpoint, ...entry.floors.filter((floor) => !presetEndpointsEqual(floor, entity.endpoint))]
          .map((floor) => label(floor, true));
        entityId = entity.id;
      }
    } else if (entity.kind === "edge") {
      const entry = presetConnections.get(entity.id);
      if (entry) {
        const other = presetEndpointsEqual(entry.from, entity.endpoint) ? entry.to : entry.from;
        bubbles = [here, label(other, (other.level ?? 0) !== activeFloorLevel)];
        showArrow = true;
        arrow = entry.state === "one_way_forward"
          ? (presetEndpointsEqual(entry.from, entity.endpoint) ? "->" : "<-")
          : entry.state === "one_way_backward"
            ? (presetEndpointsEqual(entry.from, entity.endpoint) ? "<-" : "->")
            : "<->";
      }
    }

    if (entity.kind === "start" || entity.kind === "finish") bubbles = [];

    return { ...entity, bubbles, showArrow, arrow, ...(entityId ? { entityId } : {}) };
  });

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
    return decorate(out);
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
  // split shape, already represented as a single whole-tile row below; no edge gets its own row
  // there (GitHub issue #540 follow-up: no duplicate rows for a split's connections — the split is
  // one row, period).
  const key = pointKey(point, level);
  const hasSplit = (presetSplitPoints[key]?.length ?? 0) > 0;
  if (!hasSplit) {
    const seenEdge = new Set<string>();
    const originalEndpoint = nodesHere[0];
    for (const entry of presetConnections.values()) {
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
        title: `${formatEdgeState(entry.state)} ${arrow} (${label(otherEnd, (otherEnd.level ?? 0) !== activeFloorLevel)})`,
      });
    }
  }

  // Lock — original node only (matches `buildPresetCellInspection`'s own rule), and only a
  // manually-set lock (`lockedNodes`): an auto-computed lock (`autoLockedNodes`, derived from
  // graph shape — see `recomputeAutoLock`) isn't user-removable, so it gets no row here (GitHub
  // issue #540 follow-up bug report).
  nodesHere.forEach((endpoint, nodeIndex) => {
    const lockKind = lockedNodes.get(presetEndpointKey(endpoint));
    if (lockKind) out.push({
      kind: "lock", id: `lock:${presetEndpointKey(endpoint)}`, endpoint, nodeIndex,
      title: m["status.cell_lock"]({ kind: formatLockKind(lockKind) }),
    });
  });

  // Split nodes — one row for the whole split tile, regardless of how many declared slots it has
  // (GitHub issue #700). A split tile is one removable entity: removing it removes every slot at
  // once and migrates every entity anchored on a removed node onto the point's original node
  // (`removePresetSplitAll`). The row is anchored on the original node because the entity belongs
  // to the tile, not to one of its individual nodes.
  const slotIds = presetSplitPoints[key] ?? [];
  if (slotIds.length > 0) {
    const endpoint = nodesHere[0] ?? { point, level };
    const title = (splitCtx && resolvePresetSplitShapeLabel(splitCtx, point, level ?? 0)) ?? m["preset.split_tile"]();
    out.push({ kind: "split_node", id: "split_node", endpoint, nodeIndex: 0, title });
  }

  return decorate(out);
}
