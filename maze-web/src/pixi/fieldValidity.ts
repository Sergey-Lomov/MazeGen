import { encodePoint } from "./tessellationProjection";
import { presetEndpointFromKey, presetEndpoint, type PresetEndpoint } from "./presetEndpoint";
import {
  resolveCells, type ResolveFieldAt,
  type PresetConnectionEntry, type PresetTeleportEntry, type PresetVerticalPassageEntry, type PresetElevatorEntry,
  type PresetVerticalPassageEndpointHit, type PresetElevatorEndpointHit,
} from "./fieldEditUtils";

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
        for (const [x, y] of resolveCells(field.cfg, field.customPoints, field.smooth)) set.add(encodePoint(x, y));
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
  for (const [x, y] of resolveCells(field.cfg, field.customPoints, field.smooth)) set.add(encodePoint(x, y));
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

/** Whether a single preset endpoint is outside its own floor's field. */
export function computeInvalidEndpoint(
  endpoint: PresetEndpoint | null,
  resolveFieldAt: ResolveFieldAt,
): boolean {
  const getFieldSet = fieldSetCache(resolveFieldAt);
  return endpoint != null && !pointInField(getFieldSet, endpoint.point, endpoint.level);
}

/** Keys of explicitly locked nodes outside their floor's field. */
export function computeInvalidLockedNodeKeys(
  lockedNodes: Map<string, unknown>,
  resolveFieldAt: ResolveFieldAt,
): Set<string> {
  const getFieldSet = fieldSetCache(resolveFieldAt);
  const invalid = new Set<string>();
  for (const key of lockedNodes.keys()) {
    const endpoint = presetEndpointFromKey(key);
    if (!endpoint || !pointInField(getFieldSet, endpoint.point, endpoint.level)) invalid.add(key);
  }
  return invalid;
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

/** A dragged vertical-passage/elevator endpoint failed to resolve on one of its OTHER floors
 * (GitHub issue #566) — reported so the caller can show the user which floor/coordinate rejected
 * the move, then discard the whole gesture (both editors revert on failure, never a partial move). */
export interface VerticalDragFailure {
  level: number;
  point: [number, number];
}

/** Moves BOTH ends of a preset vertical passage to the dragged endpoint's new `(x, y)` (GitHub
 * issue #566) — a vertical passage's two ends are the same (x, y) column on different floors, so
 * moving only the dragged end (the pre-fix behavior) desyncs the passage's own coordinates. Fails
 * (returns the original `passages` unchanged, plus the failing floor/point) when the new point
 * doesn't exist on the OTHER end's own floor field — the caller is expected to revert the whole
 * drag gesture on failure, never apply a partial move.
 *
 * `ownEndpoint`/`otherEndpoint` (GitHub issue #594, parity with post-edit's
 * `resolveVerticalPassageMove` from GitHub issue #567) override the plain `presetEndpoint(point,
 * undefined, ...)` this function would otherwise build for either end — used once the caller has
 * checked both landing points against `presetSplitPoints` (`tryMovePresetVerticalPassageEndpoint`)
 * and, for any that turned out split, the user has explicitly picked a node via
 * `PresetSplitTargetDialog`. Omitted for a plain, non-split landing point — original behavior. */
export function moveVerticalPassageEndpoint(
  passages: PresetVerticalPassageEntry[],
  hit: PresetVerticalPassageEndpointHit,
  point: [number, number],
  resolveFieldAt: ResolveFieldAt,
  ownEndpoint?: PresetEndpoint,
  otherEndpoint?: PresetEndpoint,
): { passages: PresetVerticalPassageEntry[]; failure?: VerticalDragFailure } {
  const entry = passages.find((p) => p.id === hit.id);
  if (!entry) return { passages };
  const otherEnd = hit.end === "from" ? entry.to : entry.from;
  const otherLevel = otherEnd.level ?? 0;
  if (!cellExistsAt(resolveFieldAt, point, otherLevel)) {
    return { passages, failure: { level: otherLevel, point } };
  }
  const ownLevel = hit.end === "from" ? entry.from.level : entry.to.level;
  const updated: PresetVerticalPassageEntry = {
    ...entry,
    [hit.end]: ownEndpoint ?? presetEndpoint(point, undefined, ownLevel),
    [hit.end === "from" ? "to" : "from"]: otherEndpoint ?? presetEndpoint(point, undefined, otherLevel),
  };
  return { passages: passages.map((p) => (p.id === hit.id ? updated : p)) };
}

/** Moves EVERY floor endpoint of a preset elevator to the dragged endpoint's new `(x, y)` (GitHub
 * issue #566) — mirrors `moveVerticalPassageEndpoint`, but an elevator's whole fan shares one
 * column, so a drag on any one floor's marker must re-target every other floor's own endpoint to
 * the same point too. Fails (unchanged `elevators`, plus the first floor that rejects the point, in
 * ascending floor order) when the new point doesn't exist on any of the OTHER floors' own fields.
 *
 * `overridesByLevel` (GitHub issue #594, parity with post-edit's `resolveElevatorMove` from GitHub
 * issue #567) — a level -> already-resolved `PresetEndpoint` map for any floor (the dragged one
 * included) whose landing point turned out split and got an explicit user pick via
 * `PresetSplitTargetDialog`; that floor's own entry is used verbatim instead of the plain
 * `presetEndpoint(point, undefined, ...)` default. A level with no override entry keeps original
 * behavior. */
export function moveElevatorEndpoint(
  elevators: PresetElevatorEntry[],
  hit: PresetElevatorEndpointHit,
  point: [number, number],
  resolveFieldAt: ResolveFieldAt,
  overridesByLevel?: ReadonlyMap<number, PresetEndpoint>,
): { elevators: PresetElevatorEntry[]; failure?: VerticalDragFailure } {
  const entry = elevators.find((e) => e.id === hit.id);
  if (!entry) return { elevators };
  const otherFloors = entry.floors
    .map((f) => f.level ?? 0)
    .filter((level) => level !== hit.level)
    .sort((a, b) => a - b);
  for (const level of otherFloors) {
    if (!cellExistsAt(resolveFieldAt, point, level)) return { elevators, failure: { level, point } };
  }
  const updated: PresetElevatorEntry = {
    ...entry,
    floors: entry.floors.map((f) => overridesByLevel?.get(f.level ?? 0) ?? presetEndpoint(point, undefined, f.level)),
  };
  return { elevators: elevators.map((e) => (e.id === hit.id ? updated : e)) };
}
