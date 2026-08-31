import { TILE_SIZE } from "./constants";
import { makeProjection, encodePoint, decodePoint } from "./tessellationProjection";
import { configAllCells } from "./tessellationCells";
import { getCellNeighborOffsets, getNeighborData } from "./tessellationGeometry";
import type { PresetConnectionState } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { presetEndpoint, presetEndpointsEqual, presetEndpointKey, type PresetEndpoint } from "./presetEndpoint";
import type { SplitFaceKind } from "./splitFaceLayout";

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

export type PresetConnectionTool = "wall" | "passage" | "reset" | "one_way" | "set_start" | "set_finish" | "lock_in" | "lock_out" | "full_lock" | "gen_source" | "teleport_one_way" | "teleport_two_way" | "vertical_passage_one_way" | "vertical_passage_two_way" | "elevator" | "manage_split_nodes" | "clear";

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

const TELEPORT_ENDPOINT_HIT_RADIUS = TILE_SIZE * 0.3;

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

export function pickTeleportEndpointAt(
  viewportX: number,
  viewportY: number,
  cfg: TessellationConfig,
  teleports: PresetTeleportEntry[],
): PresetTeleportEndpointHit | null {
  const proj = makeProjection(cfg);
  const thresholdSq = TELEPORT_ENDPOINT_HIT_RADIUS * TELEPORT_ENDPOINT_HIT_RADIUS;
  let best: PresetTeleportEndpointHit | null = null;
  let bestDistSq = Infinity;
  for (const t of teleports) {
    for (const end of ["from", "to"] as const) {
      const [cx, cy] = end === "from" ? t.from.point : t.to.point;
      const { x: px, y: py } = proj.gridToScreen(cx, cy);
      const dx = px - viewportX;
      const dy = py - viewportY;
      const distSq = dx * dx + dy * dy;
      if (distSq < thresholdSq && distSq < bestDistSq) {
        bestDistSq = distSq;
        best = { id: t.id, end };
      }
    }
  }
  return best;
}

/** Same hit-test as `pickTeleportEndpointAt`, for vertical passages — only ever tests the endpoint
 * on the *active* floor (the caller pre-filters `passages` to the active level's own `from`, same
 * as `teleportsOnLevel`), so only that one endpoint's screen position is ever checked per entry. */
export function pickVerticalPassageEndpointAt(
  viewportX: number,
  viewportY: number,
  cfg: TessellationConfig,
  passages: PresetVerticalPassageEntry[],
  activeLevel: number | undefined,
): PresetVerticalPassageEndpointHit | null {
  const proj = makeProjection(cfg);
  const thresholdSq = TELEPORT_ENDPOINT_HIT_RADIUS * TELEPORT_ENDPOINT_HIT_RADIUS;
  let best: PresetVerticalPassageEndpointHit | null = null;
  let bestDistSq = Infinity;
  for (const p of passages) {
    for (const end of ["from", "to"] as const) {
      const ep = end === "from" ? p.from : p.to;
      if ((ep.level ?? 0) !== (activeLevel ?? 0)) continue;
      const { x: px, y: py } = proj.gridToScreen(ep.point[0], ep.point[1]);
      const dx = px - viewportX;
      const dy = py - viewportY;
      const distSq = dx * dx + dy * dy;
      if (distSq < thresholdSq && distSq < bestDistSq) {
        bestDistSq = distSq;
        best = { id: p.id, end };
      }
    }
  }
  return best;
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
): PresetTeleportEntry[] {
  return teleports.map(t => {
    if (t.id !== hit.id) return t;
    // Moving to a different cell drops any slot the endpoint previously addressed — the slot
    // belonged to the old point, not the new one.
    return { ...t, [hit.end]: presetEndpoint(cell) };
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

export function moveVerticalPassageEndpoint(
  passages: PresetVerticalPassageEntry[],
  hit: PresetVerticalPassageEndpointHit,
  endpoint: PresetEndpoint,
): PresetVerticalPassageEntry[] {
  return passages.map(p => {
    if (p.id !== hit.id) return p;
    return { ...p, [hit.end]: endpoint };
  });
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

export function resolveCells(cfg: TessellationConfig, customPoints?: Set<number>): [number, number][] {
  if (customPoints && customPoints.size > 0)
    return Array.from(customPoints).map(k => decodePoint(k) as [number, number]);
  return configAllCells(cfg);
}

/** Per-floor field cells (GitHub issue #340) — `level === undefined` (floor 0) or any other level
 * index resolves to that floor's own `(cfg, customPoints)` pair via `resolveFieldAt`. Every
 * multi-floor validity/auto-lock function below takes a `resolveFieldAt` callback instead of a
 * single `cfg`, since a flat, maze-wide preset collection can hold entries for several floors at
 * once, each with its own field shape (`FloorFieldConfig`, GitHub issue #338). */
export type ResolveFieldAt = (level: number | undefined) => { cfg: TessellationConfig; customPoints?: Set<number> } | undefined;

/** One floor's own field, for `computeAutoLockedNodes`'s multi-floor walk (GitHub issue #340) —
 * `level` is that floor's 0-based index (matches `PresetEndpoint.level`; the first entry is
 * implicitly floor 0). */
export interface LevelField {
  level: number | undefined;
  cfg: TessellationConfig;
  customPoints?: Set<number>;
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
  for (const { level, cfg, customPoints } of fields) {
    const cells = resolveCells(cfg, customPoints);
    const cellSet = new Set<number>();
    for (const [x, y] of cells) cellSet.add(encodePoint(x, y));

    for (const [x, y] of cells) {
      const offsets = getCellNeighborOffsets(cfg, x, y);
      const pointKey = level === undefined ? `${x},${y}` : `${x},${y}@${level}`;
      const slots = presetSplitPoints[pointKey] ?? [];
      const endpoints = [presetEndpoint([x, y], undefined, level), ...slots.map((slotId) => presetEndpoint([x, y], slotId, level))];

      let allDefined = true;
      let hasInteriorEdge = false;
      for (const [dx, dy] of offsets) {
        const nx = x + dx, ny = y + dy;
        if (!cellSet.has(encodePoint(nx, ny))) continue;
        hasInteriorEdge = true;
        const neighbor = presetEndpoint([nx, ny], undefined, level);
        for (const ep of endpoints) {
          const key = presetEdgeKey(ep, neighbor);
          const entry = presetConnections.get(key);
          if (!entry || entry.state === "undefined") { allDefined = false; break; }
        }
        if (!allDefined) break;
      }
      if (hasInteriorEdge && allDefined) result.add(pointKey);
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
  const candidates = allNodesAt(neighborPoint, presetSplitPoints, level);

  // A `passage`/one-way entry is a real connection and wins outright. A `wall` entry only counts
  // as a fallback match (recorded lower priority) — a blueprint explicitly writes `wall` on every
  // face it doesn't use (see `applyPresetSplitBlueprint`), so the *first* candidate found with an
  // explicit `wall` isn't necessarily the neighbor's real connecting node; a later candidate might
  // still hold the real `passage`. Only fall through to a `wall` match if no candidate has a
  // `passage`/one-way entry at all.
  let wallFallback: PresetEndpoint | null = null;
  for (const candidate of candidates) {
    for (const from of pointOldEndpoints) {
      const entry = presetConnections.get(presetEdgeKey(from, candidate));
      if (!entry || entry.state === "undefined") continue;
      if (entry.state === "wall") { wallFallback ??= candidate; continue; }
      return candidate;
    }
  }
  return wallFallback ?? resolvePresetActiveEndpoint(neighborPoint, activeMap, level);
}

/** Every node currently declared at `point` on `level` (original plus every declared slot, per
 * `presetSplitPoints`) — used both by `resolvePresetPartnerAt` (the neighbor's full candidate set)
 * and by `applyPresetSplitBlueprint` (to explicitly wall off every neighbor node the blueprint's
 * resolved partner didn't pick, so a face doesn't silently leave one of the neighbor's other nodes
 * undecided — GitHub issue #243 follow-up). */
export function allNodesAt(point: [number, number], presetSplitPoints: Record<string, number[]>, level?: number): PresetEndpoint[] {
  const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
  const slots = presetSplitPoints[key] ?? [];
  return [presetEndpoint(point, undefined, level), ...slots.map((slotId) => presetEndpoint(point, slotId, level))];
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
  cfg: TessellationConfig,
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

/** Rotates every geometric-face connection of a split point's nodes by one offset index
 * (clockwise/counter-clockwise, per `getNeighborData`'s fixed offset order) — a face's whole
 * state (wall/passage/one_way + direction) moves from its current neighbor to the next one around
 * the point, for every node of the point (original + every declared slot) at once. Teleports are
 * untouched — a teleport isn't tied to a geometric face/offset, only ordinary connections are.
 *
 * Refuses (returns the input map unchanged) if any face that currently carries a connection would
 * land on a neighbor outside the field — there'd be nowhere left to draw it. */
export function rotatePresetSplitPoint(
  presetConnections: Map<string, PresetConnectionEntry>,
  point: [number, number],
  slotIds: number[],
  direction: 1 | -1,
  cfg: TessellationConfig,
  cellSet: Set<string>,
  level?: number,
): Map<string, PresetConnectionEntry> {
  const { offsets } = getNeighborData(cfg, point[0], point[1]);
  const n = offsets.length;
  if (n === 0) return presetConnections;

  const endpoints: PresetEndpoint[] = [presetEndpoint(point, undefined, level), ...slotIds.map((slotId) => presetEndpoint(point, slotId, level))];

  type Move = { key: string; ep: PresetEndpoint; neighbor: [number, number]; entry: PresetConnectionEntry };
  const moves: Move[] = [];

  for (const ep of endpoints) {
    for (let i = 0; i < n; i++) {
      const neighbor: [number, number] = [point[0] + offsets[i][0], point[1] + offsets[i][1]];
      const key = presetEdgeKey(ep, presetEndpoint(neighbor, undefined, level));
      const entry = presetConnections.get(key);
      if (!entry) continue;

      const j = (i + direction + n) % n;
      const newNeighbor: [number, number] = [point[0] + offsets[j][0], point[1] + offsets[j][1]];
      if (!cellSet.has(`${newNeighbor[0]},${newNeighbor[1]}`)) return presetConnections; // boundary — refuse entirely

      moves.push({ key, ep, neighbor: newNeighbor, entry });
    }
  }

  const next = new Map(presetConnections);
  for (const { key } of moves) next.delete(key);
  for (const { ep, neighbor, entry } of moves) {
    const neighborEp = presetEndpoint(neighbor, undefined, level);
    const newKey = presetEdgeKey(ep, neighborEp);
    const epIsLower = ep.point[0] < neighbor[0] || (ep.point[0] === neighbor[0] && ep.point[1] < neighbor[1]);
    const [newFrom, newTo] = epIsLower ? [ep, neighborEp] : [neighborEp, ep];

    // Direction is stored relative to canonical from/to, not to `ep` — re-derive it relative to
    // `ep` first (which side of the *old* entry it was), then rebuild against the *new* canonical
    // order, so a one-way passage keeps pointing the same way relative to `ep` even if canonical
    // order flips between the old and new neighbor.
    let state = entry.state;
    if (entry.state === "one_way_forward" || entry.state === "one_way_backward") {
      const epWasFrom = presetEndpointsEqual(entry.from, ep);
      const outOfEp = epWasFrom === (entry.state === "one_way_forward");
      const epIsNewFrom = presetEndpointsEqual(newFrom, ep);
      state = (epIsNewFrom === outOfEp) ? "one_way_forward" : "one_way_backward";
    }
    next.set(newKey, { from: newFrom, to: newTo, state, source: entry.source });
  }
  return next;
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

export function applyTool(
  connections: Map<string, PresetConnectionEntry>,
  edge: FieldEdge,
  tool: PresetConnectionTool,
  defaultEdgeState: PresetConnectionClientState = "undefined",
  activeMap: Record<string, PresetEndpoint> = {},
  level?: number,
): Map<string, PresetConnectionEntry> {
  const from = resolvePresetActiveEndpoint(edge.from, activeMap, level);
  const to = resolvePresetActiveEndpoint(edge.to, activeMap, level);
  const key = presetEdgeKey(from, to);
  if (tool === "reset") {
    return materializeReset(connections, { key, from: edge.from, to: edge.to }, defaultEdgeState, from, to);
  }
  const next = new Map(connections);
  if (tool === "one_way") {
    const current = connections.get(key);
    if (current?.state === "one_way_forward") {
      next.set(key, { from, to, state: "one_way_backward", source: "user" });
    } else if (current?.state === "one_way_backward") {
      next.set(key, { from, to, state: "one_way_forward", source: "user" });
    } else {
      next.set(key, { from, to, state: "one_way_forward", source: "user" });
    }
    return next;
  }
  const state: PresetConnectionState = tool === "wall" ? "wall" : "passage";
  next.set(key, { from, to, state, source: "user" });
  return next;
}

export { pickEdgeAtPosition, isInEdgeVertexDeadZone } from "./edgeHitTesting";
export {
  cellExistsAt, computeInvalidKeys, computeInvalidKeysFromCells, computeInvalidMarkers,
  computeInvalidTeleportIds, computeInvalidVerticalPassageIds, computeInvalidElevatorIds, computeInvalidSplitPoints,
} from "./fieldValidity";
