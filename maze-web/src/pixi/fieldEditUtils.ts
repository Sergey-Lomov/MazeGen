import { TILE_SIZE } from "./constants";
import { TRI_TILE_SIZE } from "./triGeometry";
import { makeProjection, encodePoint, decodePoint } from "./tessellationProjection";
import { configAllCells } from "./tessellationCells";
import { getCellNeighborOffsets, getSharedEdgeSegment, getNeighborData } from "./tessellationGeometry";
import type { PresetConnectionState } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { presetEndpoint, presetEndpointsEqual, presetEndpointKey, type PresetEndpoint } from "./presetEndpoint";

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
 * "belongs to one floor" filter. Re-keys each surviving entry via the plain, level-agnostic
 * `edgeKey` (dropping `presetConnections`' own `presetEdgeKey`, which folds `level` into the
 * string) — `presetSelectors.ts`'s wall-group/split-passage builders look entries up by
 * `edgeKey([x,y],[nx,ny])`, so a level-suffixed key here would silently never match on any floor
 * but 0, reading every non-floor-0 preset as undecided despite the entry being present and correct. */
export function presetConnectionsOnLevel(
  presetConnections: Map<string, PresetConnectionEntry>,
  level: number | undefined,
): Map<string, PresetConnectionEntry> {
  const result = new Map<string, PresetConnectionEntry>();
  for (const entry of presetConnections.values()) {
    if ((entry.from.level ?? 0) === (level ?? 0) && (entry.to.level ?? 0) === (level ?? 0)) {
      result.set(edgeKey(entry.from.point, entry.to.point), entry);
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

/** Builds a `level -> Set<encodePoint>` field-cell-set cache lazily, one entry per level actually
 * queried — shared by every function below that needs repeated per-level field-membership checks
 * without recomputing `resolveCells`/`encodePoint` per entry. */
function fieldSetCache(resolveFieldAt: ResolveFieldAt): (level: number | undefined) => Set<number> | undefined {
  const cache = new Map<number, Set<number> | undefined>();
  return (level) => {
    const key = level ?? 0;
    if (!cache.has(key)) {
      const field = resolveFieldAt(level);
      if (!field) {
        cache.set(key, undefined);
      } else {
        const set = new Set<number>();
        for (const [x, y] of resolveCells(field.cfg, field.customPoints)) set.add(encodePoint(x, y));
        cache.set(key, set);
      }
    }
    return cache.get(key);
  };
}

function pointInField(getFieldSet: (level: number | undefined) => Set<number> | undefined, point: [number, number], level: number | undefined): boolean {
  const set = getFieldSet(level);
  return set !== undefined && set.has(encodePoint(point[0], point[1]));
}

/** Whether `point` has a cell on floor `level` — the single-lookup form of `pointInField`, for
 * callers checking one point on one floor (elevator floor-picker rows, vertical-passage direction
 * availability) rather than scanning a whole preset collection. Not cached across calls; fine for
 * the handful of lookups a dialog/click handler needs. */
export function cellExistsAt(resolveFieldAt: ResolveFieldAt, point: [number, number], level: number | undefined): boolean {
  const field = resolveFieldAt(level);
  if (!field) return false;
  const set = new Set<number>();
  for (const [x, y] of resolveCells(field.cfg, field.customPoints)) set.add(encodePoint(x, y));
  return set.has(encodePoint(point[0], point[1]));
}

export function computeInvalidKeys(
  presetConnections: Map<string, PresetConnectionEntry>,
  resolveFieldAt: ResolveFieldAt,
): Set<string> {
  const getFieldSet = fieldSetCache(resolveFieldAt);
  const invalid = new Set<string>();
  for (const [key, entry] of presetConnections) {
    const aIn = pointInField(getFieldSet, entry.from.point, entry.from.level);
    const bIn = pointInField(getFieldSet, entry.to.point, entry.to.level);
    if (!aIn || !bIn) invalid.add(key);
  }
  return invalid;
}

/** Single-floor variant — used by the renderer, which caches one floor's own cells already
 * (`getCachedCellSet`) and only ever redraws the active floor. `cells` implicitly means "the
 * active floor's cells"; an entry addressing a *different* level is always treated as outside this
 * floor's own field (its validity is judged elsewhere, against its own floor's cells) — so this
 * variant is only correct for filtering/highlighting entries already known to belong to the floor
 * `cells` came from, not for computing global invalidity across every floor. */
export function computeInvalidKeysFromCells(
  presetConnections: Map<string, PresetConnectionEntry>,
  cells: [number, number][],
  activeLevel?: number,
): Set<string> {
  const fieldSet = new Set<number>();
  for (const [x, y] of cells) fieldSet.add(encodePoint(x, y));

  const invalid = new Set<string>();
  for (const [key, entry] of presetConnections) {
    if ((entry.from.level ?? 0) !== (activeLevel ?? 0) || (entry.to.level ?? 0) !== (activeLevel ?? 0)) continue;
    const aIn = fieldSet.has(encodePoint(entry.from.point[0], entry.from.point[1]));
    const bIn = fieldSet.has(encodePoint(entry.to.point[0], entry.to.point[1]));
    if (!aIn || !bIn) invalid.add(key);
  }
  return invalid;
}

export function computeInvalidMarkers(
  presetStart: PresetEndpoint | null,
  presetFinish: PresetEndpoint | null,
  resolveFieldAt: ResolveFieldAt,
): { start: boolean; finish: boolean } {
  const getFieldSet = fieldSetCache(resolveFieldAt);
  return {
    start: presetStart != null && !pointInField(getFieldSet, presetStart.point, presetStart.level),
    finish: presetFinish != null && !pointInField(getFieldSet, presetFinish.point, presetFinish.level),
  };
}

export function computeInvalidTeleportIds(
  teleports: PresetTeleportEntry[],
  resolveFieldAt: ResolveFieldAt,
): Set<number> {
  const getFieldSet = fieldSetCache(resolveFieldAt);
  const invalid = new Set<number>();
  for (const t of teleports) {
    const aIn = pointInField(getFieldSet, t.from.point, t.from.level);
    const bIn = pointInField(getFieldSet, t.to.point, t.to.level);
    if (!aIn || !bIn) invalid.add(t.id);
  }
  return invalid;
}

/** Same "either endpoint outside its own floor's field" criterion as `computeInvalidTeleportIds`,
 * for preset vertical passages (GitHub issue #357). */
export function computeInvalidVerticalPassageIds(
  passages: PresetVerticalPassageEntry[],
  resolveFieldAt: ResolveFieldAt,
): Set<number> {
  const getFieldSet = fieldSetCache(resolveFieldAt);
  const invalid = new Set<number>();
  for (const p of passages) {
    const aIn = pointInField(getFieldSet, p.from.point, p.from.level);
    const bIn = pointInField(getFieldSet, p.to.point, p.to.level);
    if (!aIn || !bIn) invalid.add(p.id);
  }
  return invalid;
}

/** An elevator is invalid if any of its `floors` endpoints is outside its own floor's field, or if
 * fewer than two endpoints remain resolvable (an elevator with a single floor connects nothing) —
 * mirrors `PresetElevator`'s own core-side "fewer than two resolved endpoints connects nothing"
 * fallback (`preset_state.rs`), surfaced here as invalidity instead of a silent no-op so the user
 * sees it flagged rather than a preset that quietly does nothing at generation time. */
export function computeInvalidElevatorIds(
  elevators: PresetElevatorEntry[],
  resolveFieldAt: ResolveFieldAt,
): Set<number> {
  const getFieldSet = fieldSetCache(resolveFieldAt);
  const invalid = new Set<number>();
  for (const e of elevators) {
    const inField = e.floors.filter((f) => pointInField(getFieldSet, f.point, f.level));
    if (inField.length !== e.floors.length || inField.length < 2) invalid.add(e.id);
  }
  return invalid;
}

/** Invalid split-declaration points (GitHub issue #231) — same "point outside the current field"
 * criterion as `computeInvalidKeys`/`computeInvalidTeleportIds`/`computeInvalidMarkers`, applied
 * to `presetSplitPoints`'s keys instead. Needed separately because a declared split point can be
 * an orphan (no preset/teleport/marker referencing it) — the only way an invalid point could reach
 * the WASM `split_points` payload without going through one of the other three checks first.
 * Each key is `"x,y"` (floor 0) or `"x,y@level"` (GitHub issue #340, see `splitPointsCore.ts`'s
 * `pointKey`) — parsed back into `(point, level)` before checking that level's own field. */
export function computeInvalidSplitPoints(
  presetSplitPoints: Record<string, number[]>,
  resolveFieldAt: ResolveFieldAt,
): Set<string> {
  const getFieldSet = fieldSetCache(resolveFieldAt);
  const invalid = new Set<string>();
  for (const key of Object.keys(presetSplitPoints)) {
    const [pointPart, levelPart] = key.split("@");
    const [x, y] = pointPart.split(",").map(Number);
    const level = levelPart === undefined ? undefined : Number(levelPart);
    if (!pointInField(getFieldSet, [x, y], level)) invalid.add(key);
  }
  return invalid;
}

interface SegmentHit {
  distSq: number;
  /** Fraction along the segment (0 = v0, 1 = v1) of the closest point to the query position. */
  t: number;
}

function closestPointOnSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): SegmentHit {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { distSq: (px - ax) * (px - ax) + (py - ay) * (py - ay), t: 0 };
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return { distSq: (px - cx) * (px - cx) + (py - cy) * (py - cy), t };
}

/** Fraction of a segment's length, at each end, treated as a dead zone: hover/drag hit-testing
 * ignores the segment there so the cursor must clearly enter its interior before it registers.
 * Without this, passing near a grid vertex while dragging along one edge would register a hit on
 * a perpendicular edge meeting at that same vertex (#188). Only applied when `deadZone` is passed
 * to `pickEdgeAtPosition` — a plain (non-drag) click must still be able to hit an edge whose
 * nearest point is close to a vertex, so pointerdown call sites opt out. */
const EDGE_ENDPOINT_DEAD_ZONE_FRACTION = 0.2;

export function pickEdgeAtPosition(
  viewportX: number,
  viewportY: number,
  cfg: TessellationConfig,
  cells: [number, number][],
  cellSet?: Set<number>,
  deadZone = false,
): FieldEdge | null {
  const proj = makeProjection(cfg);
  const cell = proj.screenToGrid(viewportX, viewportY);

  if (!cellSet) {
    cellSet = new Set<number>();
    for (const [x, y] of cells) cellSet.add(encodePoint(x, y));
  }

  const isTriangle = cfg.type === "triangle_rect" || cfg.type === "triangle_triangle"
    || cfg.type === "triangle_hexagon" || cfg.type === "tri_custom";
  const isHex = cfg.type === "hex_parallelogram" || cfg.type === "hex_hexagon" || cfg.type === "hex_custom";
  // Cell-center-to-nearest-side distance, as a fraction of the tile's own edge-length scale, is
  // much smaller for triangles/hexagons (incenter-to-side ≈ 0.29 * side for an equilateral
  // triangle; hexagon center-to-side is the apothem, ≈ 0.87 * (side/2) ≈ 0.43 * side) than for a
  // square (center-to-side = TILE_SIZE/2 = 0.5 * TILE_SIZE) — a single `side * 0.4`-style threshold
  // tuned for one shape puts another shape's own cell center inside the edge-hit zone, so a
  // dead-center click is misread as an edge click (GitHub issue #340 follow-up). Each shape's own
  // threshold stays strictly under its own center-to-side ratio.
  const threshold = isTriangle || isHex ? TRI_TILE_SIZE * 0.12 : TILE_SIZE * 0.08;
  const thresholdSq = threshold * threshold;

  let bestKey: string | null = null;
  let bestFrom: [number, number] | null = null;
  let bestTo: [number, number] | null = null;
  let bestDist = Infinity;

  const candidates: [number, number][] = [[cell.x, cell.y]];
  for (const [dx, dy] of getCellNeighborOffsets(cfg, cell.x, cell.y))
    candidates.push([cell.x + dx, cell.y + dy]);

  const checked = new Set<string>();
  for (const [cx, cy] of candidates) {
    if (!cellSet.has(encodePoint(cx, cy))) continue;
    for (const [dx, dy] of getCellNeighborOffsets(cfg, cx, cy)) {
      const nx = cx + dx, ny = cy + dy;
      if (!cellSet.has(encodePoint(nx, ny))) continue;
      const key = edgeKey([cx, cy], [nx, ny]);
      if (checked.has(key)) continue;
      checked.add(key);

      const seg = getSharedEdgeSegment([cx, cy], [nx, ny], cfg);
      if (!seg) continue;
      const hit = closestPointOnSegment(viewportX, viewportY, seg.v0.x, seg.v0.y, seg.v1.x, seg.v1.y);
      if (deadZone && (hit.t < EDGE_ENDPOINT_DEAD_ZONE_FRACTION || hit.t > 1 - EDGE_ENDPOINT_DEAD_ZONE_FRACTION)) continue;
      const distSq = hit.distSq;
      if (distSq < thresholdSq && distSq < bestDist) {
        bestDist = distSq;
        bestKey = key;
        const [from, to] = canonicalize([cx, cy], [nx, ny]);
        bestFrom = from;
        bestTo = to;
      }
    }
  }

  if (bestKey && bestFrom && bestTo) {
    return { key: bestKey, from: bestFrom, to: bestTo };
  }
  return null;
}

/** True if `(viewportX, viewportY)` falls in some edge's own dead zone (within
 * `EDGE_ENDPOINT_DEAD_ZONE_FRACTION` of one of its endpoints, and within `pickEdgeAtPosition`'s own
 * per-shape `threshold` of the segment) — i.e. `pickEdgeAtPosition(..., deadZone=true)` returned
 * `null` specifically *because* the cursor is near a shared vertex, not because it's simply too far
 * from every edge. Used by tools with a dual edge/point mode (preset's "clear", post-edit's
 * "reset") to withhold the point/cell fallback there too — otherwise the vertex dead zone (meant to
 * avoid hair-triggering a perpendicular edge, #188) silently becomes "picks the cell instead",
 * which is not what the dead zone is for. */
export function isInEdgeVertexDeadZone(
  viewportX: number,
  viewportY: number,
  cfg: TessellationConfig,
  cells: [number, number][],
  cellSet?: Set<number>,
): boolean {
  const proj = makeProjection(cfg);
  const cell = proj.screenToGrid(viewportX, viewportY);

  if (!cellSet) {
    cellSet = new Set<number>();
    for (const [x, y] of cells) cellSet.add(encodePoint(x, y));
  }

  const isTriangle = cfg.type === "triangle_rect" || cfg.type === "triangle_triangle"
    || cfg.type === "triangle_hexagon" || cfg.type === "tri_custom";
  const isHex = cfg.type === "hex_parallelogram" || cfg.type === "hex_hexagon" || cfg.type === "hex_custom";
  const threshold = isTriangle || isHex ? TRI_TILE_SIZE * 0.12 : TILE_SIZE * 0.08;
  const thresholdSq = threshold * threshold;

  const candidates: [number, number][] = [[cell.x, cell.y]];
  for (const [dx, dy] of getCellNeighborOffsets(cfg, cell.x, cell.y))
    candidates.push([cell.x + dx, cell.y + dy]);

  const checked = new Set<string>();
  for (const [cx, cy] of candidates) {
    if (!cellSet.has(encodePoint(cx, cy))) continue;
    for (const [dx, dy] of getCellNeighborOffsets(cfg, cx, cy)) {
      const nx = cx + dx, ny = cy + dy;
      if (!cellSet.has(encodePoint(nx, ny))) continue;
      const key = edgeKey([cx, cy], [nx, ny]);
      if (checked.has(key)) continue;
      checked.add(key);

      const seg = getSharedEdgeSegment([cx, cy], [nx, ny], cfg);
      if (!seg) continue;
      const hit = closestPointOnSegment(viewportX, viewportY, seg.v0.x, seg.v0.y, seg.v1.x, seg.v1.y);
      if (hit.distSq >= thresholdSq) continue;
      if (hit.t < EDGE_ENDPOINT_DEAD_ZONE_FRACTION || hit.t > 1 - EDGE_ENDPOINT_DEAD_ZONE_FRACTION) return true;
    }
  }
  return false;
}

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
