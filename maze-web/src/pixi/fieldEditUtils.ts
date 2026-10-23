import { makeProjection, encodePoint, decodePoint } from "./tessellationProjection";
import { configAllCells } from "./tessellationCells";
import { getCellNeighborOffsets, getNeighborData, rotateFaceIndex } from "./tessellationGeometry";
import type { NodeLockKind, PresetConnectionState } from "../wasm/types";
import type { FieldConfig } from "../fieldConfig";
import { presetEndpoint, presetEndpointsEqual, presetEndpointKey, type PresetEndpoint } from "./presetEndpoint";
import { type SplitFaceKind, canCompleteOppositePair, isFinishedSplitPair, detectSplitSpecialShapeKind } from "./splitFaceLayout";
import { splitShapeBinding } from "./splitShape";
import { selectByTiering, type PairState } from "./postEditEndpoint";
import { pickNearestPointerHit } from "./pointerInteraction";
import { refusedRotation, type SplitRotationResult } from "./splitRotationResult";

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
  for (const { level, cfg, customPoints, smooth } of fields) {
    const cells = resolveCells(cfg, customPoints, smooth);
    const cellSet = new Set<number>();
    for (const [x, y] of cells) cellSet.add(encodePoint(x, y));

    for (const [x, y] of cells) {
      const offsets = getCellNeighborOffsets(cfg, x, y);
      const pointKey = level === undefined ? `${x},${y}` : `${x},${y}@${level}`;
      const slots = presetSplitPoints[pointKey] ?? [];
      const endpoints = [presetEndpoint([x, y], undefined, level), ...slots.map((slotId) => presetEndpoint([x, y], slotId, level))];

      let hasInteriorEdge = false;
      for (const [dx, dy] of offsets) {
        const nx = x + dx, ny = y + dy;
        if (cellSet.has(encodePoint(nx, ny))) hasInteriorEdge = true;
      }
      if (!hasInteriorEdge) continue;
      let allNodesDefined = true;
      const nodeResults: { key: string; defined: boolean }[] = [];
      for (const ep of endpoints) {
        let allDefined = true;
        for (const [dx, dy] of offsets) {
          const nx = x + dx, ny = y + dy;
          if (!cellSet.has(encodePoint(nx, ny))) continue;
          // A geometric neighbor can itself be a split point. Resolve the actual node
          // recorded on this face instead of assuming that the original node is used;
          // otherwise autoblock misses decided split-to-split connections.
          const neighbor = resolvePresetPartnerAt(
            [ep], [nx, ny], presetConnections, presetSplitPoints, {}, level,
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

/** Resolves which node of `point` on `level` a preset edge-tool click currently targets — the
 * preset-stage counterpart of post-edit's `resolveActiveEndpointAt` (GitHub issue #231).
 * `activeMap[key]` if set, else the point's original node on `level`
 * (`presetEndpoint(point, undefined, level)`, no slot). `activeMap` is keyed by
 * `"x,y"`/`"x,y@level"` (GitHub issue #340, same convention `splitPointsCore.ts`'s `pointKey`
 * uses) — a point's declared split slots and which one is active are independent per floor. */
export function resolvePresetActiveEndpoint(
  point: [number, number],
  activeMap: Record<string, PresetEndpoint>,
  level?: number,
): PresetEndpoint {
  const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
  const active = activeMap[key];
  return active ?? presetEndpoint(point, undefined, level);
}

/** Resolves which node of a split `neighborPoint` genuinely connects across the face toward
 * `point` — used when wiring a face automatically (blueprint apply), where the correct partner is
 * whichever of the neighbor's nodes already has a decided (`passage`/`wall`/one-way) entry toward
 * any of `point`'s pre-blueprint nodes (`pointOldEndpoints` — `point` is about to be rebuilt by
 * its own blueprint too, so its *old* identity, not the fresh endpoint the caller is about to
 * write, is what any pre-existing neighbor entry was recorded against), not whichever node happens
 * to be the neighbor's currently active UI slot (GitHub issue #243 — picking "the" active node
 * here silently wired a connection to the wrong node while leaving the neighbor's real connecting
 * node's entry orphaned). Falls back to the active-slot resolution when no such decided entry
 * exists yet (neighbor not split, or this exact face not yet decided on any of its nodes) — mirrors
 * `buildSplitPassagesCore`'s `resolveOther`. */
export function resolvePresetPartnerAt(
  pointOldEndpoints: PresetEndpoint[],
  neighborPoint: [number, number],
  presetConnections: Map<string, PresetConnectionEntry>,
  presetSplitPoints: Record<string, number[]>,
  activeMap: Record<string, PresetEndpoint>,
  level?: number,
): PresetEndpoint {
  const candidates = allNodesAt(neighborPoint, presetSplitPoints, level).map((ep) => ({ forms: [ep], identity: ep }));
  const classifyPair = (target: PresetEndpoint, form: PresetEndpoint): PairState => {
    const entry = presetConnections.get(presetEdgeKey(form, target));
    if (!entry || entry.state === "undefined") return "none";
    if (entry.state === "wall") return "wall";
    return "decided";
  };
  const result = selectByTiering(candidates, pointOldEndpoints, classifyPair);
  return result?.identity ?? resolvePresetActiveEndpoint(neighborPoint, activeMap, level);
}

/** The `presetSplitPoints`/`presetActiveSplitNode` record key for `point`/`level` — `"x,y"` for
 * floor 0 (both `undefined` and `0` normalize to the unsuffixed key), `"x,y@level"` otherwise.
 * The one place this format is built, so every caller (`allNodesAt`, `resolvePresetSplitTargets`,
 * `presetSplitLabels.ts`'s `isPresetSplitPoint`) stays in sync with it. */
export function presetSplitPointKey(point: [number, number], level?: number): string {
  return level === undefined || level === 0 ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
}

/** Every node currently declared at `point` on `level` (original plus every declared slot, per
 * `presetSplitPoints`) — used both by `resolvePresetPartnerAt` (the neighbor's full candidate set)
 * and by `applyPresetSplitBlueprint` (to explicitly wall off every neighbor node the blueprint's
 * resolved partner didn't pick, so a face doesn't silently leave one of the neighbor's other nodes
 * undecided — GitHub issue #243 follow-up). */
export function allNodesAt(point: [number, number], presetSplitPoints: Record<string, number[]>, level?: number): PresetEndpoint[] {
  const slots = presetSplitPoints[presetSplitPointKey(point, level)] ?? [];
  return [presetEndpoint(point, undefined, level), ...slots.map((slotId) => presetEndpoint(point, slotId, level))];
}

/** GitHub issue #594 (parity with post-edit's `resolveDragTargets`, GitHub issue #567): resolves
 * every target of a preset vertical-passage/elevator placement OR drag against `presetSplitPoints`,
 * in `targets` order. A point with no declared slots resolves silently to its original node (`slotId:
 * undefined`), same as before this issue — its endpoint lands straight in `picks`. A point with one
 * or more declared slots needs the user to pick via `PresetSplitTargetDialog`, so it's left
 * `undefined` in `picks` and instead queued (`queue`, carrying its own `targetIndex` so
 * `applyPresetSplitTargetPick` can slot the eventual pick back into the right position once the
 * dialog resolves it). `queue` empty means every target was plain — the caller then has every
 * endpoint already in `picks` and should commit directly, no dialog. */
export function resolvePresetSplitTargets(
  targets: { point: [number, number]; level?: number }[],
  presetSplitPoints: Record<string, number[]>,
): { picks: (PresetEndpoint | undefined)[]; queue: { targetIndex: number; point: [number, number]; level?: number; slotIds: number[] }[] } {
  const picks: (PresetEndpoint | undefined)[] = [];
  const queue: { targetIndex: number; point: [number, number]; level?: number; slotIds: number[] }[] = [];
  targets.forEach((t, targetIndex) => {
    const slotIds = presetSplitPoints[presetSplitPointKey(t.point, t.level)] ?? [];
    if (slotIds.length > 0) {
      picks.push(undefined);
      queue.push({ targetIndex, point: t.point, level: t.level, slotIds });
    } else {
      picks.push(presetEndpoint(t.point, undefined, t.level));
    }
  });
  return { picks, queue };
}

/** One preset split node's kind on every one of its point's geometric faces (in `getNeighborData`
 * offset order) — a face with no in-field neighbor is `"wall"`, an undecided in-field face is
 * `"undefined"`. The neighbor's partner node is resolved per `resolvePresetPartnerAt` (its real
 * connecting node, not just its active UI slot — GitHub issue #243). Shared by
 * `PresetSplitNodesDialog`'s tile diagram and the `PresetSplitTargetDialog` / status-panel
 * special-split recognition (GitHub issue #487), so all agree on what a point's topology is. */
export function presetSplitNodeFaceKinds(
  endpoint: PresetEndpoint,
  point: [number, number],
  cfg: FieldConfig,
  inFieldCells: Set<string>,
  presetConnections: Map<string, PresetConnectionEntry>,
  presetSplitPoints: Record<string, number[]>,
  presetActiveSplitNode: Record<string, PresetEndpoint>,
  level?: number,
): SplitFaceKind[] {
  const { offsets } = getNeighborData(cfg, point[0], point[1]);
  return offsets.map(([dx, dy]): SplitFaceKind => {
    const neighbor: [number, number] = [point[0] + dx, point[1] + dy];
    if (!inFieldCells.has(`${neighbor[0]},${neighbor[1]}`)) return "wall";
    const neighborPartner = resolvePresetPartnerAt(
      [endpoint], neighbor, presetConnections, presetSplitPoints, presetActiveSplitNode, level,
    );
    const entry = presetConnections.get(presetEdgeKey(endpoint, neighborPartner));
    if (!entry) return "undefined";
    if (entry.state === "wall") return "wall";
    if (entry.state === "passage") return "passage";
    if (entry.state === "undefined") return "undefined";
    // entry.from/.to are canonical-order (see presetEdgeKey) — actual direction is
    // entry.from -> entry.to for "one_way_forward", reversed for "one_way_backward".
    const endpointIsFrom = presetEndpointsEqual(entry.from, endpoint);
    const forward = entry.state === "one_way_forward";
    return endpointIsFrom === forward ? "one_way_out" : "one_way_in";
  });
}

/** Orders two preset endpoints `[from, to]` by the same canonical rule `presetEdgeKey` uses for
 * its own key ordering (lower `level`, then lower `x`, then lower `y` — GitHub issue #340 added
 * the `level` tiebreak ahead of the pre-existing point comparison) — exported so callers that need
 * to build a `PresetConnectionEntry` (which stores `from`/`to` in this same canonical order, see
 * `applyTool`/`applyPresetSplitBlueprint`) don't have to re-derive the comparison themselves. A
 * same-floor pair (the overwhelming majority — every entry until cross-floor edges exist) never
 * consults `level` at all, so this is byte-identical to the pre-#340 point-only ordering there. */
export function canonicalizePresetPair(a: PresetEndpoint, b: PresetEndpoint): [PresetEndpoint, PresetEndpoint] {
  const al = a.level ?? 0, bl = b.level ?? 0;
  if (al !== bl) return al < bl ? [a, b] : [b, a];
  return a.point[0] < b.point[0] || (a.point[0] === b.point[0] && a.point[1] < b.point[1]) ? [a, b] : [b, a];
}

/** Preset-side edge key, slot- and level-aware (GitHub issue #231/#340): for two endpoints with no
 * active slot and floor-0 level on either side, identical to `edgeKey`'s plain geometric key —
 * every existing preset entry (and the default-edge-state mechanism, which only ever targets
 * original nodes on the active floor) keeps its exact key. A slot-addressed or non-floor-0
 * endpoint on either side changes the key, so a split-targeted or other-floor preset never
 * collides with the point's plain (original-node, floor-0) preset. */
export function presetEdgeKey(a: PresetEndpoint, b: PresetEndpoint): string {
  const [fa, fb] = canonicalizePresetPair(a, b);
  return `${presetEndpointKey(fa)}-${presetEndpointKey(fb)}`;
}

/** Which of `candidatePoint`'s own geometric face indices (per `getNeighborData`'s fixed offset
 * order) already carry a **decided** connection (`passage`/`one_way_forward`/`one_way_backward`),
 * checked against any of the candidate's own forms — mirrors post-edit's own `decidedFaceIndicesOf`
 * (`postEditUtils.ts`). A `wall`/`undefined` entry does not count (see `canCompleteOppositePair`'s
 * own doc comment — only a real decided connection forms a bridge pair). */
function presetDecidedFaceIndicesOf(
  candidatePoint: [number, number],
  candidateForms: PresetEndpoint[],
  presetConnections: Map<string, PresetConnectionEntry>,
  cfg: FieldConfig,
  presetSplitPoints: Record<string, number[]>,
): Set<number> {
  const { offsets } = getNeighborData(cfg, candidatePoint[0], candidatePoint[1]);
  const result = new Set<number>();
  for (const form of candidateForms) {
    offsets.forEach(([dx, dy], i) => {
      const neighbor: [number, number] = [candidatePoint[0] + dx, candidatePoint[1] + dy];
      // Check against EVERY one of the neighbor's declared nodes (original + slots), not just its
      // original — a face's real partner across the shared edge is just as often one of the
      // neighbor's split slots (e.g. two adjacent bridge tiles), and checking only the original
      // silently missed that decided face entirely (GitHub issue #580 preset second-rotation
      // follow-up: after a first rotation re-stitches a bridge pair through both sides' slots, a
      // second rotation's geometry/safety checks read this same face as "not decided" and mis-owns
      // it back onto the neighbor's original node).
      const neighborForms = allNodesAt(neighbor, presetSplitPoints, form.level);
      const decided = neighborForms.some((nf) => {
        const entry = presetConnections.get(presetEdgeKey(form, nf));
        return entry && (entry.state === "passage" || entry.state === "one_way_forward" || entry.state === "one_way_backward");
      });
      if (decided) result.add(i);
    });
  }
  return result;
}

/** The candidate at `neighborPoint` that already has a DECIDED connection on exactly `targetFace`
 * (toward `point`), if any — mirrors post-edit's `selectExistingFaceOwner` (`postEditUtils.ts`). The
 * common case for two adjacent split points wired to each other (e.g. two neighboring "bridge"
 * tiles): rotating one moves a DIFFERENT one of its own nodes onto the face that already connects to
 * the other tile's node — the two nodes were already partners on this shared face before the
 * rotation, and remain so after, just via the rotated point's other node. Must be checked before
 * `canCompleteOppositePair`'s geometry guess: the existing partner's own `presetDecidedFaceIndicesOf`
 * already contains `targetFace`, so the geometry guard's "target face not already decided" check
 * would otherwise wrongly exclude it as "already occupied" — it isn't occupied by a THIRD party, it's
 * occupied by the very connection this rotation is re-keying. */
function selectExistingPresetFaceOwner(
  candidates: PresetEndpoint[],
  neighborPoint: [number, number],
  targetFace: number,
  presetConnections: Map<string, PresetConnectionEntry>,
  cfg: FieldConfig,
  presetSplitPoints: Record<string, number[]>,
): PresetEndpoint | null {
  const matches = candidates.filter((c) => presetDecidedFaceIndicesOf(neighborPoint, [c], presetConnections, cfg, presetSplitPoints).has(targetFace));
  return matches.length === 1 ? matches[0] : null;
}

/** Resolves which node of a (possibly split) `newNeighbor` a preset rotate's brand-new face should
 * connect to — the preset counterpart of post-edit's `resolveFaceOwner` (`postEditUtils.ts`), same
 * priority order: an already-standing decided connection on exactly this face
 * (`selectExistingPresetFaceOwner`) first, then geometry evidence (`canCompleteOppositePair`, does
 * this candidate's OWN other decided faces complete a bridge/diagonal pair with the new face), then
 * the neighbor's active UI slot or original node, restricted to candidates that do NOT already hold a
 * finished opposite pair (`isFinishedSplitPair` — a 0/1-decided-face candidate, or the only
 * node of a plain point, is always safe to extend). `assignedThisRotation` guards the geometry tier against the same neighbor node being
 * claimed by two different new faces within one multi-move rotation, same as the post-edit side.
 *
 * Returns `null` when EVERY candidate at `newNeighbor` already holds a finished pair (e.g. rotating
 * a bridge tile onto a neighbor that's itself fully wired on both its own nodes) — there is no safe
 * node to hand the new face to, and picking "the least bad" one would still corrupt it, so the
 * caller leaves this face disconnected (wall) rather than guess. */
function resolvePresetFaceOwner(
  point: [number, number],
  newNeighbor: [number, number],
  cfg: FieldConfig,
  presetConnections: Map<string, PresetConnectionEntry>,
  presetSplitPoints: Record<string, number[]>,
  presetActiveSplitNode: Record<string, PresetEndpoint>,
  assignedThisRotation: Map<string, number>,
  level: number | undefined,
): PresetEndpoint | null {
  const candidates = allNodesAt(newNeighbor, presetSplitPoints, level);
  const { offsets: neighborOffsets } = getNeighborData(cfg, newNeighbor[0], newNeighbor[1]);
  const degree = neighborOffsets.length;
  const targetFace = neighborOffsets.findIndex(([dx, dy]) => newNeighbor[0] + dx === point[0] && newNeighbor[1] + dy === point[1]);

  if (targetFace !== -1) {
    const existing = selectExistingPresetFaceOwner(candidates, newNeighbor, targetFace, presetConnections, cfg, presetSplitPoints);
    if (existing) return existing;

    const matches = candidates.filter((c) => canCompleteOppositePair(presetDecidedFaceIndicesOf(newNeighbor, [c], presetConnections, cfg, presetSplitPoints), targetFace, degree));
    if (matches.length === 1) {
      const owner = matches[0];
      const ownerKey = presetEndpointKey(owner);
      if (assignedThisRotation.get(ownerKey) === undefined) {
        assignedThisRotation.set(ownerKey, targetFace);
        return owner;
      }
    }
  }

  const safeCandidates = candidates.filter((c) => !isFinishedSplitPair(presetDecidedFaceIndicesOf(newNeighbor, [c], presetConnections, cfg, presetSplitPoints), degree, candidates.length));
  if (safeCandidates.length === 0) return null;

  const active = resolvePresetActiveEndpoint(newNeighbor, presetActiveSplitNode, level);
  const activeIsSafe = safeCandidates.some((c) => presetEndpointsEqual(c, active));
  if (activeIsSafe) return active;
  const activeMatchesUnsafe = candidates.some((c) => presetEndpointsEqual(c, active));
  return activeMatchesUnsafe ? safeCandidates[0] : active;
}

/** Rotates every geometric-face connection of a split point's nodes by one offset index
 * (clockwise/counter-clockwise, per `getNeighborData`'s fixed offset order) — a face's whole
 * state (wall/passage/one_way + direction) moves from its current neighbor to the next one around
 * the point, for every node of the point (original + every declared slot) at once. Teleports are
 * untouched — a teleport isn't tied to a geometric face/offset, only ordinary connections are.
 *
 * The OLD neighbor side of the lookup searches every one of the old neighbor's own declared nodes
 * (not just its original), preferring a decided (`passage`/one-way) entry over a `wall` one — same
 * tiering `resolvePresetPartnerAt` uses — so a connection to one of the old neighbor's SPLIT nodes
 * isn't silently missed (GitHub issue #580's preset-side counterpart). The NEW neighbor side is
 * resolved via `resolvePresetFaceOwner` (geometry evidence, then a bridge-safety-aware fallback),
 * not simply the new neighbor's original node.
 *
 * Refuses with `refusalReason: "outside_field"` if any face that currently carries a connection
 * would land on a neighbor outside the field — there'd be nowhere left to draw it. */
export function rotatePresetSplitPoint(
  presetConnections: Map<string, PresetConnectionEntry>,
  point: [number, number],
  slotIds: number[],
  direction: 1 | -1,
  cfg: FieldConfig,
  cellSet: Set<string>,
  presetSplitPoints: Record<string, number[]>,
  presetActiveSplitNode: Record<string, PresetEndpoint>,
  level?: number,
): SplitRotationResult<Map<string, PresetConnectionEntry>> {
  const { offsets } = getNeighborData(cfg, point[0], point[1]);
  const n = offsets.length;
  if (n === 0) return presetConnections;

  const endpoints: PresetEndpoint[] = [presetEndpoint(point, undefined, level), ...slotIds.map((slotId) => presetEndpoint(point, slotId, level))];

  type Move = { key: string; ep: PresetEndpoint; oldNeighborNode: PresetEndpoint; newNeighbor: [number, number]; entry: PresetConnectionEntry };
  const moves: Move[] = [];

  for (const ep of endpoints) {
    for (let i = 0; i < n; i++) {
      const neighbor: [number, number] = [point[0] + offsets[i][0], point[1] + offsets[i][1]];
      const oldNeighborCandidates = allNodesAt(neighbor, presetSplitPoints, level).map((c) => ({ forms: [c], identity: c }));
      const classifyPair = (target: PresetEndpoint, form: PresetEndpoint): PairState => {
        const e = presetConnections.get(presetEdgeKey(form, target));
        if (!e || e.state === "undefined") return "none";
        return e.state === "wall" ? "wall" : "decided";
      };
      const found = selectByTiering(oldNeighborCandidates, [ep], classifyPair);
      if (!found) continue;
      const oldNeighborNode = found.identity;
      const key = presetEdgeKey(ep, oldNeighborNode);
      const entry = presetConnections.get(key)!;

      const j = rotateFaceIndex(cfg, point[0], point[1], i, direction);
      const newNeighbor: [number, number] = [point[0] + offsets[j][0], point[1] + offsets[j][1]];
      if (!cellSet.has(`${newNeighbor[0]},${newNeighbor[1]}`)) {
        return refusedRotation(new Map(presetConnections), "outside_field");
      }

      moves.push({ key, ep, oldNeighborNode, newNeighbor, entry });
    }
  }

  const next = new Map(presetConnections);
  for (const { key } of moves) next.delete(key);

  // A `neighborEp` resolved via `selectExistingPresetFaceOwner` may already have a standing entry
  // toward ANY of `point`'s own forms (not necessarily the specific `ep` this move re-keys), since
  // the two points were already partners on this shared face before the rotation. Resolve every
  // move's owner and drop those standing entries FIRST, in one pass, before any rotated entry is
  // written — doing the delete inside the same loop that writes would wipe out an earlier move's
  // freshly-written entry whenever two moves resolve to the same owner (mirrors post-edit's
  // `rotateSplitPointNodes` fix for the same bug).
  const assignedThisRotation = new Map<string, number>();
  const resolvedOwners = moves.map((m) => resolvePresetFaceOwner(point, m.newNeighbor, cfg, presetConnections, presetSplitPoints, presetActiveSplitNode, assignedThisRotation, level));
  for (const neighborEp of resolvedOwners) {
    if (!neighborEp) continue;
    for (const ep of endpoints) next.delete(presetEdgeKey(neighborEp, ep));
  }

  // An old neighbor node that ISN'T picked up as `ep`'s new-face owner this rotation loses its
  // partner on the face that used to point at `point`. When that old neighbor is itself split (has
  // more than one declared node at its point), leaving the face merely absent from the map reads as
  // "undefined"/optional in the UI and silently turns one of its OTHER, unrelated decided faces into
  // part of an incomplete/broken bridge shape — so this must become an explicit wall instead. A
  // plain (non-split) old neighbor has nothing else to protect, so it keeps the old "just vanish"
  // behavior (structurally identical for a single-node point, and covered by existing tests). This
  // checks the exact (ep, oldNeighborNode) pair, not just whether oldNeighborNode is claimed by
  // SOME move — the same physical neighbor node can simultaneously lose one of point's nodes as its
  // old partner and gain a DIFFERENT one of point's nodes as its new partner within one rotation.
  const rewrittenPairKeys = new Set(moves.map(({ ep }, i) => resolvedOwners[i] && presetEdgeKey(ep, resolvedOwners[i]!)).filter((k): k is string => k !== null));
  for (const { ep, oldNeighborNode, entry } of moves) {
    if (rewrittenPairKeys.has(presetEdgeKey(ep, oldNeighborNode))) continue;
    if (allNodesAt(oldNeighborNode.point, presetSplitPoints, oldNeighborNode.level).length < 2) continue;
    const epIsLower = ep.point[0] < oldNeighborNode.point[0] || (ep.point[0] === oldNeighborNode.point[0] && ep.point[1] < oldNeighborNode.point[1]);
    const [wallFrom, wallTo] = epIsLower ? [ep, oldNeighborNode] : [oldNeighborNode, ep];
    next.set(presetEdgeKey(ep, oldNeighborNode), { from: wallFrom, to: wallTo, state: "wall", source: entry.source });
  }

  moves.forEach(({ ep, newNeighbor, entry }, i) => {
    const neighborEp = resolvedOwners[i];
    if (!neighborEp) return; // no safe node to hand this face to — leave it disconnected (wall)
    const newKey = presetEdgeKey(ep, neighborEp);
    const epIsLower = ep.point[0] < newNeighbor[0] || (ep.point[0] === newNeighbor[0] && ep.point[1] < newNeighbor[1]);
    const [newFrom, newTo] = epIsLower ? [ep, neighborEp] : [neighborEp, ep];

    // Direction is stored relative to canonical from/to, not to `ep` — re-derive it relative to
    // `ep` first (which side of the *old* entry it was, against the OLD neighbor node the
    // connection was actually found on), then rebuild against the *new* canonical order, so a
    // one-way passage keeps pointing the same way relative to `ep` even if canonical order flips
    // between the old and new neighbor.
    let state = entry.state;
    if (entry.state === "one_way_forward" || entry.state === "one_way_backward") {
      const epWasFrom = presetEndpointsEqual(entry.from, ep);
      const outOfEp = epWasFrom === (entry.state === "one_way_forward");
      const epIsNewFrom = presetEndpointsEqual(newFrom, ep);
      state = (epIsNewFrom === outOfEp) ? "one_way_forward" : "one_way_backward";
    }
    next.set(newKey, { from: newFrom, to: newTo, state, source: entry.source });
  });
  return next;
}

/** True if rotating `point`'s split nodes by `direction` would make a currently-recognized special
 * shape (bridge/diagonal/etc., `detectSplitSpecialShapeKind`) at one of `point`'s geometric
 * neighbors unrecognized (GitHub issue #588) — dry-runs the rotation (`rotatePresetSplitPoint` is
 * pure) and compares each split neighbor's own `faceKindsByNode` before/after via
 * `presetSplitNodeFaceKinds`. Only `point`'s immediate geometric neighbors can possibly be
 * affected — a rotation only ever re-keys entries touching `point`'s own nodes. A neighbor that
 * isn't itself split (fewer than 2 declared nodes), or wasn't recognized before the rotation, is
 * never a "break" regardless of what happens to it after. Mirrors post-edit's
 * `rotateSplitPointBreaksNeighborShape` (`postEditUtils.ts`). */
export function rotatePresetSplitPointBreaksNeighborShape(
  presetConnections: Map<string, PresetConnectionEntry>,
  point: [number, number],
  slotIds: number[],
  direction: 1 | -1,
  cfg: FieldConfig,
  cellSet: Set<string>,
  presetSplitPoints: Record<string, number[]>,
  presetActiveSplitNode: Record<string, PresetEndpoint>,
  level?: number,
): boolean {
  const after = rotatePresetSplitPoint(
    presetConnections, point, slotIds, direction, cfg, cellSet, presetSplitPoints, presetActiveSplitNode, level,
  );
  if (after.refusalReason) return false; // refused — nothing changes

  const { offsets } = getNeighborData(cfg, point[0], point[1]);
  for (const [dx, dy] of offsets) {
    const neighbor: [number, number] = [point[0] + dx, point[1] + dy];
    const neighborEndpoints = allNodesAt(neighbor, presetSplitPoints, level);
    if (neighborEndpoints.length < 2) continue; // not split — nothing to break
    const neighborBinding = splitShapeBinding(cfg, neighbor[0], neighbor[1]);

    const before = neighborEndpoints.map((ep) => presetSplitNodeFaceKinds(
      ep, neighbor, cfg, cellSet, presetConnections, presetSplitPoints, presetActiveSplitNode, level,
    ));
    if (detectSplitSpecialShapeKind(before, neighborBinding) === null) continue; // wasn't recognized before — nothing to break

    const afterKinds = neighborEndpoints.map((ep) => presetSplitNodeFaceKinds(
      ep, neighbor, cfg, cellSet, after, presetSplitPoints, presetActiveSplitNode, level,
    ));
    if (detectSplitSpecialShapeKind(afterKinds, neighborBinding) === null) return true;
  }
  return false;
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
