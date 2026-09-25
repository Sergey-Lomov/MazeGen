import { splitRefsEqual, splitRefKey, type SplitRef } from "./postEditEndpoint";

/** One endpoint of a preset connection/teleport/lock/marker reference (GitHub issue #231) — the
 * preset-stage counterpart of `PostEditEndpoint`. Unlike post-edit, presets never hold a resolved
 * `NodeId` (they run before generation, before any node exists) — the only identity available is
 * a point plus an optional slot. `slotId: undefined` is not a wildcard/"any node" — it's a
 * specific, meaningful value: "the point's original node", the same role an absent entry in
 * `postEditActiveSplitNode` plays for post-edit (see `postEditEndpoint.ts`'s module doc comment).
 * `slotId: <number>` addresses one of the point's extra nodes, declared via `presetSplitPoints`
 * (see `presetConnectionsSlice.ts`) and applied to the `Field` before any preset is resolved
 * (`Specs/preset-connections.md`'s "Split nodes" section).
 *
 * `level` (GitHub issue #340) is the endpoint's floor, as a 0-based `level_fields`/
 * `levels_ordered()` index — `undefined` means floor 0 (the maze's bottom floor), same
 * "undefined = default" convention `slotId` already uses. Every preset entry (edge, teleport,
 * lock, split point, marker) lives in one flat, maze-wide collection — an entry's floor is part of
 * its own coordinate (x, y, level), not which per-floor bucket it's stored under. This is what
 * lets a single entry span two floors (a future vertical-passage/elevator edge) without an
 * ownership question about whose bucket it belongs to. */
export interface PresetEndpoint {
  point: [number, number];
  slotId?: number;
  level?: number;
}

export function presetEndpoint(point: [number, number], slotId?: number, level?: number): PresetEndpoint {
  return { point, ...(slotId !== undefined ? { slotId } : {}), ...(level !== undefined ? { level } : {}) };
}

/** Drops `level` from an endpoint already known to be on the current floor — `buildPresetNodePositions`
 * keys split-point nodes without a `level` suffix, so every caller resolving a marker through
 * `presetEndpointScreenPos`/`nodePositions` must match against a level-less copy first (GitHub issue
 * #589). */
export function withoutLevel(ep: PresetEndpoint): PresetEndpoint {
  return { point: ep.point, slotId: ep.slotId };
}

/** Structural equality: every field must match literally, including `slotId`/`level` both being
 * `undefined` (two "original node, floor 0" endpoints at the same point are equal). Not
 * implemented via `SplitRef`'s comparator — that type never represents "no slot", so a separate
 * (small) function is needed for the optional-slot/level case. */
export function presetEndpointsEqual(a: PresetEndpoint, b: PresetEndpoint): boolean {
  return a.point[0] === b.point[0] && a.point[1] === b.point[1] && a.slotId === b.slotId && a.level === b.level;
}

/** True if `ep` addresses the same slot as `ref` (a declared split node) — used to find/remove
 * preset entries referencing a specific split node being removed, mirroring post-edit's
 * `endpointsEqual`-based cleanup in `removeSplitNode`. Level-agnostic by design: `ref` (a
 * `SplitRef`) has no level field, so this only ever compares point+slot — callers needing an
 * exact match (including level) should use `presetEndpointsEqual` instead. */
export function presetEndpointIsSplit(ep: PresetEndpoint, ref: SplitRef): boolean {
  return ep.slotId !== undefined && splitRefsEqual({ point: ep.point, slotId: ep.slotId }, ref);
}

/** Stable string key: "3,5" for the original node on floor 0, "3,5:7" for slot 7 on floor 0,
 * "3,5@2" / "3,5:7@2" once `level` is set — the `@` suffix only appears for a non-floor-0 level, so
 * every pre-#340 key (single-floor projects) stays byte-identical. */
export function presetEndpointKey(ep: PresetEndpoint): string {
  const base = ep.slotId === undefined ? `${ep.point[0]},${ep.point[1]}` : splitRefKey({ point: ep.point, slotId: ep.slotId });
  return ep.level === undefined ? base : `${base}@${ep.level}`;
}

/** Parses a `presetEndpointKey` back to an endpoint. Used by render/validation paths that receive
 * the flat lock/auto-lock maps rather than endpoint objects. */
export function presetEndpointFromKey(key: string): PresetEndpoint | null {
  const [pointSlot, levelPart] = key.split("@");
  const [pointPart, slotPart] = pointSlot.split(":");
  const [x, y] = pointPart.split(",").map(Number);
  const slotId = slotPart === undefined ? undefined : Number(slotPart);
  const level = levelPart === undefined ? undefined : Number(levelPart);
  if (![x, y, slotId, level].every((value) => value === undefined || Number.isInteger(value))) return null;
  return presetEndpoint([x, y], slotId, level);
}

/** `PresetEndpoint` → the WASM/`GenerateConfig` wire DTO's endpoint shape. Not a passthrough: the
 * TS-side field is `slotId`, the wire field is `slot` (matches Rust's `PresetEndpointDto`, which
 * derives `Deserialize` with no per-field rename); `level` passes through unchanged (same field
 * name on both sides). */
export function presetEndpointToDto(ep: PresetEndpoint): { point: [number, number]; slot?: number; level?: number } {
  return {
    point: ep.point,
    ...(ep.slotId !== undefined ? { slot: ep.slotId } : {}),
    ...(ep.level !== undefined ? { level: ep.level } : {}),
  };
}

/** Remaps a single level index through `swap` — used when two floors trade array positions
 * (`moveFloor`, GitHub issue #340) so every preset entry's `level` keeps pointing at the same
 * floor it did before the move, not the same array slot. `undefined` (floor 0) round-trips
 * through 0 and back to `undefined` when floor 0 itself is one of the swapped indices. */
export function remapLevel(level: number | undefined, swap: [number, number]): number | undefined {
  const [a, b] = swap;
  const current = level ?? 0;
  const next = current === a ? b : current === b ? a : current;
  return next === 0 ? undefined : next;
}

export function remapPresetEndpointLevel(ep: PresetEndpoint, swap: [number, number]): PresetEndpoint {
  const level = remapLevel(ep.level, swap);
  return level === ep.level ? ep : { ...ep, level };
}

/** Remaps a `"x,y"` / `"x,y@level"` map key (`lockedNodes`/`presetSplitPoints`/
 * `presetActiveSplitNode`) through the same `swap` `remapLevel` applies to a `PresetEndpoint.level`
 * (GitHub issue #340's `moveFloor` follow-up). */
export function remapLevelKey(key: string, swap: [number, number]): string {
  const [pointPart, levelPart] = key.split("@");
  const level = remapLevel(levelPart === undefined ? undefined : Number(levelPart), swap);
  return level === undefined ? pointPart : `${pointPart}@${level}`;
}
