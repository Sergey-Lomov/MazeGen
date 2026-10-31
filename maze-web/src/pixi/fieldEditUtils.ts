import { makeProjection, decodePoint } from "./tessellationProjection";
import { configAllCells } from "./tessellationCells";
import { resolveFaceNeighbors } from "./faceNeighbors";
import { prefetchCellGeometries } from "./cartesianCache";
import type { NodeLockKind, PresetConnectionState } from "../wasm/types";
import type { FieldConfig } from "../fieldConfig";
import { presetEndpoint, presetEndpointKey, type PresetEndpoint } from "./presetEndpoint";
import { pickNearestPointerHit } from "./pointerInteraction";
import { resolvePresetActiveEndpoint, resolvePresetPartnerAt, presetEdgeKey } from "./presetSplitResolve";

export type PresetConnectionClientState = PresetConnectionState | "undefined";

/** `from`/`to` are `PresetEndpoint` (point + optional slot, GitHub issue #231), not a bare cell
 * tuple — a preset connection can address one of a split point's declared extra nodes. Edge
 * picking/hit-testing (`pickEdgeAtPosition`, `canonicalize`, `edgeKey`) still operates on raw
 * cell coordinates (the cursor targets a point/face, never a specific node) — the active slot
 * (`presetActiveSplitNode`, mirrors post-edit's `postEditActiveSplitNode`) is folded in only when
 * `applyTool` actually writes an entry. */
export interface PresetConnectionEntry {
  from: PresetEndpoint;
  to: PresetEndpoint;
  state: PresetConnectionClientState;
  source: "user" | "default";
}

export type PresetConnectionTool = "wall" | "passage" | "reset" | "one_way" | "set_start" | "set_finish" | "lock_in" | "lock_out" | "full_lock" | "gen_source" | "teleport_one_way" | "teleport_two_way" | "vertical_passage_one_way" | "vertical_passage_two_way" | "elevator" | "manage_split_nodes" | "clear" | "move" | "settings";

export interface FieldEdge {
  key: string;
  from: [number, number];
  to: [number, number];
}

export type PresetTeleportDirection = "forward" | "backward" | "two_way";

/** `from`/`to` are `PresetEndpoint` (GitHub issue #231) — same rationale as `PresetConnectionEntry`. */
export interface PresetTeleportEntry {
  id: number;
  from: PresetEndpoint;
  to: PresetEndpoint;
  direction: PresetTeleportDirection;
}

export function presetTeleportEntryToState(direction: PresetTeleportDirection): PresetConnectionState {
  if (direction === "forward") return "teleport_forward";
  if (direction === "backward") return "teleport_backward";
  return "teleport_two_way";
}

export type PresetVerticalPassageDirection = "forward" | "backward" | "two_way";

/** A user-placed `VerticalPassage` preset (GitHub issue #357) — stored the same way
 * `PresetTeleportEntry` is (its own flat array, not folded into `presetConnections`), since its two
 * endpoints live on different (adjacent) floors, not a geometrically-adjacent cell pair. `from`/`to`
 * are the two click points in placement order; `"backward"` runs `to -> from`, mirroring
 * `PresetTeleportEntry.direction`'s own convention — `from`/`to` are never swapped after creation,
 * only interpretation of direction changes. */
export interface PresetVerticalPassageEntry {
  id: number;
  from: PresetEndpoint;
  to: PresetEndpoint;
  direction: PresetVerticalPassageDirection;
}

/** A user-placed `Elevator` preset (GitHub issue #357) — a fan across `floors.length` endpoints,
 * always sharing the same `(x, y)` point (only `level` differs per entry — see
 * `Specs/preset-connections.md`'s "Preset vertical connections"). Two-way by construction, no
 * direction concept (mirrors the core-side `PresetElevator`). */
export interface PresetElevatorEntry {
  id: number;
  floors: PresetEndpoint[];
}

/** Endpoint of a preset teleport, identified for hit-testing/drag by the owning entry's id and which end it is. */
export interface PresetTeleportEndpointHit {
  id: number;
  end: "from" | "to";
}

/** Endpoint of a preset vertical passage — mirrors `PresetTeleportEndpointHit`. */
export interface PresetVerticalPassageEndpointHit {
  id: number;
  end: "from" | "to";
}

/** Endpoint of a preset elevator (GitHub issue #566) — identified by the owning entry's id and the
 * floor level of the dragged marker (an elevator has no "from"/"to", only a set of floor
 * endpoints, so the hit is keyed by floor level rather than an end name). */
export interface PresetElevatorEndpointHit {
  id: number;
  level: number;
}

/** Filters a flat, maze-wide `presetConnections` map (GitHub issue #340) down to the entries
 * living entirely on `level` — both endpoints on the same floor. Used by the renderer, which only
 * ever draws one floor's own edges/wall groups/split passages at a time; a future cross-floor
 * entry (vertical passage/elevator) needs its own dedicated rendering path, not this generic
 * "belongs to one floor" filter. Re-keys each surviving entry via a level-free version of
 * `presetEdgeKey` (dropping just the `@level` suffix, keeping the slot-aware part) —
 * `presetSelectors.ts`'s wall-group builder looks up plain (non-split) edges by
 * `edgeKey([x,y],[nx,ny])`, which this produces unchanged when neither endpoint has a `slotId`, so
 * a level-suffixed key wouldn't match on any floor but 0 (reading every non-floor-0 preset as
 * undecided despite the entry being present and correct). A level-agnostic but slot-*unaware* key
 * (plain `edgeKey`, pre-GitHub-issue-418 fix) collided a split point's original-node and slot-node
 * entries toward the same geometric neighbor into one map slot, silently dropping whichever was
 * inserted first — this stayed slot-aware to keep them distinct. The stored entry's own
 * `from`/`to` are level-stripped too (GitHub issue #424), not just the map key — leaving `.level`
 * set on the value made `presetEndpointKey(entry.from/.to)` disagree with every other level-free id
 * on this floor (declared split nodes, `edgeKey` lookups), fabricating phantom split nodes and
 * broken face-partner matches on any floor above 0. */
export function presetConnectionsOnLevel(
  presetConnections: Map<string, PresetConnectionEntry>,
  level: number | undefined,
): Map<string, PresetConnectionEntry> {
  const result = new Map<string, PresetConnectionEntry>();
  for (const entry of presetConnections.values()) {
    if ((entry.from.level ?? 0) === (level ?? 0) && (entry.to.level ?? 0) === (level ?? 0)) {
      const from = { ...entry.from, level: undefined };
      const to = { ...entry.to, level: undefined };
      result.set(presetEdgeKey(from, to), { ...entry, from, to });
    }
  }
  return result;
}

/** Filters `presetSplitPoints`/a level-keyed `Record<string, T>` down to `level`'s own entries,
 * stripping the `"@level"` key suffix back to plain `"x,y"` — the shape every selector consuming
 * one floor's own split-point data already expects (GitHub issue #340). */
export function recordOnLevel<T>(record: Record<string, T>, level: number | undefined): Record<string, T> {
  const suffix = level === undefined ? undefined : `@${level}`;
  const result: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (suffix === undefined) {
      if (key.includes("@")) continue;
      result[key] = value;
    } else {
      if (!key.endsWith(suffix)) continue;
      result[key.slice(0, -suffix.length)] = value;
    }
  }
  return result;
}

/** Filters `lockedNodes`/`autoLockedNodes` (keyed `"x,y"`/`"x,y@level"`) down to `level`'s own
 * entries, stripping the suffix — mirrors `recordOnLevel` for `Map`/`Set` instead of a plain
 * record (GitHub issue #340). */
export function mapOnLevel<T>(map: Map<string, T>, level: number | undefined): Map<string, T> {
  const suffix = level === undefined ? undefined : `@${level}`;
  const result = new Map<string, T>();
  for (const [key, value] of map) {
    if (suffix === undefined) {
      if (key.includes("@")) continue;
      result.set(key, value);
    } else {
      if (!key.endsWith(suffix)) continue;
      result.set(key.slice(0, -suffix.length), value);
    }
  }
  return result;
}

/** `lockedNodes` with the lock a live drag carries (GitHub issue #748) shown on `override.point`'s
 *  original node, on the lock's own floor, instead of its committed node. A lock already there is
 *  replaced in the preview, as it would be on drop. */
export function lockedNodesWithMovedLock(
  lockedNodes: Map<string, NodeLockKind>,
  override: { from: PresetEndpoint; point: [number, number] },
): Map<string, NodeLockKind> {
  const fromKey = presetEndpointKey(override.from);
  const kind = lockedNodes.get(fromKey);
  if (!kind) return lockedNodes;
  const next = new Map(lockedNodes);
  next.delete(fromKey);
  next.set(presetEndpointKey(presetEndpoint(override.point, undefined, override.from.level)), kind);
  return next;
}

export function setOnLevel(set: Set<string>, level: number | undefined): Set<string> {
  const suffix = level === undefined ? undefined : `@${level}`;
  const result = new Set<string>();
  for (const key of set) {
    if (suffix === undefined) {
      if (key.includes("@")) continue;
      result.add(key);
    } else {
      if (!key.endsWith(suffix)) continue;
      result.add(key.slice(0, -suffix.length));
    }
  }
  return result;
}

/** Hit-tests preset teleport endpoints by the cell under the pointer, not by the drawn marker's
 * radius (GitHub issue #694). The nearest candidate in that cell wins when endpoints overlap. */
export function pickTeleportEndpointAt(
  viewportX: number,
  viewportY: number,
  cfg: FieldConfig,
  teleports: PresetTeleportEntry[],
): PresetTeleportEndpointHit | null {
  const proj = makeProjection(cfg);
  const pointerCell = proj.screenToGrid(viewportX, viewportY);
  const candidates = teleports.flatMap((teleport) => ([
    { id: teleport.id, end: "from" as const, point: teleport.from.point },
    { id: teleport.id, end: "to" as const, point: teleport.to.point },
  ]));
  const hit = pickNearestPointerHit(
    viewportX,
    viewportY,
    candidates,
    (candidate) => proj.gridToScreen(candidate.point[0], candidate.point[1]),
    (candidate) => candidate.point[0] === pointerCell.x && candidate.point[1] === pointerCell.y,
  );
  return hit ? { id: hit.id, end: hit.end } : null;
}

/** Same cell-based hit-test as `pickTeleportEndpointAt`, for vertical passages — only ever tests the
 * endpoint on the *active* floor (the caller pre-filters `passages` to the active level's own
 * `from`, same as `teleportsOnLevel`), so only that one endpoint is checked per entry. */
export function pickVerticalPassageEndpointAt(
  viewportX: number,
  viewportY: number,
  cfg: FieldConfig,
  passages: PresetVerticalPassageEntry[],
  activeLevel: number | undefined,
): PresetVerticalPassageEndpointHit | null {
  const proj = makeProjection(cfg);
  const pointerCell = proj.screenToGrid(viewportX, viewportY);
  const candidates = passages.flatMap((passage) => (["from", "to"] as const).flatMap((end) => {
    const endpoint = end === "from" ? passage.from : passage.to;
    return (endpoint.level ?? 0) === (activeLevel ?? 0)
      ? [{ id: passage.id, end, point: endpoint.point }]
      : [];
  }));
  const hit = pickNearestPointerHit(
    viewportX,
    viewportY,
    candidates,
    (candidate) => proj.gridToScreen(candidate.point[0], candidate.point[1]),
    (candidate) => candidate.point[0] === pointerCell.x && candidate.point[1] === pointerCell.y,
  );
  return hit ? { id: hit.id, end: hit.end } : null;
}

/** Same cell-based hit-test as `pickVerticalPassageEndpointAt`, for elevators (GitHub issue #566) —
 * only ever tests the active floor's own endpoint of each elevator entry (mirrors
 * `buildPresetVerticalMarkers`'s own active-floor filter), so `PresetElevatorEndpointHit.level` is
 * always the active floor. */
export function pickElevatorEndpointAt(
  viewportX: number,
  viewportY: number,
  cfg: FieldConfig,
  elevators: PresetElevatorEntry[],
  activeLevel: number | undefined,
): PresetElevatorEndpointHit | null {
  const proj = makeProjection(cfg);
  const pointerCell = proj.screenToGrid(viewportX, viewportY);
  const candidates = elevators.flatMap((elevator) => {
    const own = elevator.floors.find((floor) => (floor.level ?? 0) === (activeLevel ?? 0));
    return own ? [{ id: elevator.id, level: activeLevel ?? 0, point: own.point }] : [];
  });
  const hit = pickNearestPointerHit(
    viewportX,
    viewportY,
    candidates,
    (candidate) => proj.gridToScreen(candidate.point[0], candidate.point[1]),
    (candidate) => candidate.point[0] === pointerCell.x && candidate.point[1] === pointerCell.y,
  );
  return hit ? { id: hit.id, level: hit.level } : null;
}

export function cycleTeleportDirection(
  teleports: PresetTeleportEntry[],
  id: number,
): PresetTeleportEntry[] {
  return teleports.map(t => {
    if (t.id !== id || t.direction === "two_way") return t;
    return { ...t, direction: t.direction === "forward" ? "backward" : "forward" };
  });
}

export function removeTeleport(teleports: PresetTeleportEntry[], id: number): PresetTeleportEntry[] {
  return teleports.filter(t => t.id !== id);
}

export function moveTeleportEndpoint(
  teleports: PresetTeleportEntry[],
  hit: PresetTeleportEndpointHit,
  cell: [number, number],
  level: number,
): PresetTeleportEntry[] {
  return teleports.map(t => {
    if (t.id !== hit.id) return t;
    // Moving to a different cell drops any slot the endpoint previously addressed — the slot
    // belonged to the old point, not the new one. Floor 0 is represented by an omitted level
    // throughout preset state; keep the moved endpoint canonical so structural endpoint matching
    // (including the clear-tool entity picker) still finds it.
    return { ...t, [hit.end]: presetEndpoint(cell, undefined, level === 0 ? undefined : level) };
  });
}

/** Only meaningful for the `vertical_passage_one_way` tool — `vertical_passage_two_way` entries
 * ignore this, same rationale as `cycleTeleportDirection`. */
export function cycleVerticalPassageDirection(
  passages: PresetVerticalPassageEntry[],
  id: number,
): PresetVerticalPassageEntry[] {
  return passages.map(p => {
    if (p.id !== id || p.direction === "two_way") return p;
    return { ...p, direction: p.direction === "forward" ? "backward" : "forward" };
  });
}

export function removeVerticalPassage(passages: PresetVerticalPassageEntry[], id: number): PresetVerticalPassageEntry[] {
  return passages.filter(p => p.id !== id);
}

export function removeElevator(elevators: PresetElevatorEntry[], id: number): PresetElevatorEntry[] {
  return elevators.filter(e => e.id !== id);
}

/** `PresetVerticalPassageEntry.direction` → the wire `PresetVerticalPassageDto.one_way` field
 * (`undefined` = two-way, mirrors `PresetVerticalPassage.one_way: Option<...>` on the Rust side). */
export function presetVerticalPassageDirectionToDto(
  direction: PresetVerticalPassageDirection,
): import("../wasm/types").VerticalPassageDirectionDto | undefined {
  if (direction === "two_way") return undefined;
  return direction;
}

export function canonicalize(
  p1: [number, number],
  p2: [number, number],
): [[number, number], [number, number]] {
  const less = p1[0] < p2[0] || (p1[0] === p2[0] && p1[1] < p2[1]);
  return less ? [p1, p2] : [p2, p1];
}

export function edgeKey(a: [number, number], b: [number, number]): string {
  const [fa, fb] = canonicalize(a, b);
  return `${fa[0]},${fa[1]}-${fb[0]},${fb[1]}`;
}

export function resolveCells(cfg: FieldConfig, customPoints?: Set<number>, smooth = false): [number, number][] {
  if (customPoints && customPoints.size > 0)
    return Array.from(customPoints).map(k => decodePoint(k) as [number, number]);
  return configAllCells(cfg, smooth);
}

/** Per-floor field cells (GitHub issue #340) — `level === undefined` (floor 0) or any other level
 * index resolves to that floor's own `(cfg, customPoints)` pair via `resolveFieldAt`. Every
 * multi-floor validity/auto-lock function below takes a `resolveFieldAt` callback instead of a
 * single `cfg`, since a flat, maze-wide preset collection can hold entries for several floors at
 * once, each with its own field shape (`FloorFieldConfig`, GitHub issue #338). */
export type ResolveFieldAt = (level: number | undefined) => { cfg: FieldConfig; customPoints?: Set<number>; smooth?: boolean } | undefined;

/** One floor's own field, for `computeAutoLockedNodes`'s multi-floor walk (GitHub issue #340) —
 * `level` is that floor's 0-based index (matches `PresetEndpoint.level`; the first entry is
 * implicitly floor 0). */
export interface LevelField {
  level: number | undefined;
  cfg: FieldConfig;
  customPoints?: Set<number>;
  smooth?: boolean;
}

/**
 * Returns set of "x,y"/"x,y@level" keys (GitHub issue #340) for cells where all interior edges are
 * explicitly preset, across every floor in `fields`. An interior edge is one shared with another
 * cell in that same floor's own field.
 *
 * A declared split point (`presetSplitPoints`) auto-locks only if every one of its nodes
 * (original + every declared slot) has every interior face decided — one node with an
 * `undefined`/missing face on any side means the point as a whole still has an undecided
 * connection, even if the original node's own faces all happen to be decided.
 */
export function computeAutoLockedNodes(
  presetConnections: Map<string, PresetConnectionEntry>,
  fields: LevelField[],
  presetSplitPoints: Record<string, number[]> = {},
): Set<string> {
  const result = new Set<string>();
  // A cell locks only when every interior face has an entry, and each entry names the cell as an
  // endpoint, so the candidates are the cells the entries mention, not the whole field.
  const mentioned = new Map<number, Map<string, [number, number]>>();
  for (const { from, to } of presetConnections.values()) {
    for (const { point, level } of [from, to]) {
      const floor = level ?? 0;
      let cells = mentioned.get(floor);
      if (!cells) mentioned.set(floor, (cells = new Map()));
      cells.set(`${point[0]},${point[1]}`, point);
    }
  }
  for (const { level, cfg, customPoints, smooth } of fields) {
    const candidates = mentioned.get(level ?? 0);
    if (!candidates) continue;
    const cellSet = new Set<string>();
    for (const [x, y] of resolveCells(cfg, customPoints, smooth)) cellSet.add(`${x},${y}`);
    const cells = [...candidates.values()].filter(([x, y]) => cellSet.has(`${x},${y}`));
    // Floors share one warmed snapshot; the others' cells load here in one batch, not one by one.
    prefetchCellGeometries(cells, cfg);

    for (const [x, y] of cells) {
      const neighbors = resolveFaceNeighbors(cfg, [x, y], cellSet);
      const pointKey = level === undefined ? `${x},${y}` : `${x},${y}@${level}`;
      const slots = presetSplitPoints[pointKey] ?? [];
      const endpoints = [presetEndpoint([x, y], undefined, level), ...slots.map((slotId) => presetEndpoint([x, y], slotId, level))];

      if (neighbors.every((n) => n === null)) continue;
      let allNodesDefined = true;
      const nodeResults: { key: string; defined: boolean }[] = [];
      for (const ep of endpoints) {
        let allDefined = true;
        for (const faceNeighbor of neighbors) {
          if (faceNeighbor === null) continue;
          // A geometric neighbor can itself be a split point. Resolve the actual node
          // recorded on this face instead of assuming that the original node is used;
          // otherwise autoblock misses decided split-to-split connections.
          const neighbor = resolvePresetPartnerAt(
            [ep], faceNeighbor, presetConnections, presetSplitPoints, {}, level,
          );
          const key = presetEdgeKey(ep, neighbor);
          const entry = presetConnections.get(key);
          if (!entry || entry.state === "undefined") { allDefined = false; break; }
        }
        nodeResults.push({ key: presetEndpointKey(ep), defined: allDefined });
        if (!allDefined) allNodesDefined = false;
      }
      if (allNodesDefined) {
        for (const node of nodeResults) result.add(node.key);
      }
    }
  }
  return result;
}

/**
 * Clears an edge's explicit user override so it goes back to tracking the current default:
 * deletes the entry if `defaultEdgeState` is `"undefined"`, otherwise materializes it as a
 * `source: "default"` entry (so a later default change recomputes it like any other default edge).
 */
export function materializeReset(
  connections: Map<string, PresetConnectionEntry>,
  edge: FieldEdge,
  defaultEdgeState: PresetConnectionClientState,
  from: PresetEndpoint = presetEndpoint(edge.from),
  to: PresetEndpoint = presetEndpoint(edge.to),
): Map<string, PresetConnectionEntry> {
  const next = new Map(connections);
  if (defaultEdgeState === "undefined") {
    next.delete(edge.key);
  } else {
    next.set(edge.key, { from, to, state: defaultEdgeState, source: "default" });
  }
  return next;
}

/** Edge mutation applied by `applyTool`: a toolbar tool, or `one_way_flip` — the settings tool's
 *  direction swap of an existing one-way edge (GitHub issue #748). */
export type PresetEdgeToolMode = PresetConnectionTool | "one_way_flip";

/** Current preset state of the face between `edge.from`/`edge.to`, resolved through the same
 *  active-node/floor key `applyTool` writes to. `undefined` when the face has no entry. */
export function presetEdgeStateAt(
  connections: Map<string, PresetConnectionEntry>,
  edge: FieldEdge,
  activeMap: Record<string, PresetEndpoint> = {},
  level?: number,
): PresetConnectionClientState | undefined {
  const from = resolvePresetActiveEndpoint(edge.from, activeMap, level);
  const to = resolvePresetActiveEndpoint(edge.to, activeMap, level);
  return connections.get(presetEdgeKey(from, to))?.state;
}

export function applyTool(
  connections: Map<string, PresetConnectionEntry>,
  edge: FieldEdge,
  tool: PresetEdgeToolMode,
  defaultEdgeState: PresetConnectionClientState = "undefined",
  activeMap: Record<string, PresetEndpoint> = {},
  level?: number,
): Map<string, PresetConnectionEntry> {
  const from = resolvePresetActiveEndpoint(edge.from, activeMap, level);
  const to = resolvePresetActiveEndpoint(edge.to, activeMap, level);
  const key = presetEdgeKey(from, to);
  if (tool === "reset") {
    // Clearing an edge only removes an override that is actually present on that edge. A missing
    // entry (or a derived default entry) is not a user preset, so changing it would mutate an edge
    // the user never configured (GitHub issue #689).
    const current = connections.get(key);
    if (!current || current.source !== "user") return connections;
    // Removing a user preset restores the configured default, rather than pinning this edge to an
    // explicit `undefined` state. Build the reset key from resolved endpoints so floor/slot-aware
    // edges are restored at their actual map key (the raw FieldEdge key is floor-agnostic).
    return materializeReset(connections, { ...edge, key }, defaultEdgeState, from, to);
  }
  const next = new Map(connections);
  if (tool === "one_way" || tool === "one_way_flip") {
    const current = connections.get(key);
    const isOneWay = current?.state === "one_way_forward" || current?.state === "one_way_backward";
    // The one-way tool creates a forward one-way edge or reverses an existing one; `one_way_flip`
    // (settings tool, GitHub issue #748) only reverses and leaves any other face unchanged.
    if (tool === "one_way_flip" && !isOneWay) return connections;
    const state: PresetConnectionState = current?.state === "one_way_forward" ? "one_way_backward" : "one_way_forward";
    next.set(key, { from, to, state, source: "user" });
    return next;
  }
  const state: PresetConnectionState = tool === "wall" ? "wall" : "passage";
  next.set(key, { from, to, state, source: "user" });
  return next;
}

export { pickEdgeAtPosition, isInEdgeVertexDeadZone } from "./edgeHitTesting";
export {
  cellExistsAt, computeInvalidKeys, computeInvalidKeysFromCells, computeInvalidMarkers, computeInvalidEndpoint, computeInvalidLockedNodeKeys,
  computeInvalidTeleportIds, computeInvalidVerticalPassageIds, computeInvalidElevatorIds, computeInvalidSplitPoints,
  moveVerticalPassageEndpoint, moveElevatorEndpoint, type VerticalDragFailure,
} from "./fieldValidity";
