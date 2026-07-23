import { splitRefsEqual, splitRefKey, type SplitRef } from "./postEditEndpoint";

/** One endpoint of a preset connection/teleport/lock/marker reference (GitHub issue #231) — the
 * preset-stage counterpart of `PostEditEndpoint`. Unlike post-edit, presets never hold a resolved
 * `NodeId` (they run before generation, before any node exists) — the only identity available is
 * a point plus an optional slot. `slotId: undefined` is not a wildcard/"any node" — it's a
 * specific, meaningful value: "the point's original node", the same role an absent entry in
 * `postEditActiveSplitNode` plays for post-edit (see `postEditEndpoint.ts`'s module doc comment).
 * `slotId: <number>` addresses one of the point's extra nodes, declared via `presetSplitPoints`
 * (see `presetConnectionsSlice.ts`) and applied to the `Field` before any preset is resolved
 * (`Specs/preset-connections.md`'s "Split nodes" section). */
export interface PresetEndpoint {
  point: [number, number];
  slotId?: number;
}

export function presetEndpoint(point: [number, number], slotId?: number): PresetEndpoint {
  return slotId === undefined ? { point } : { point, slotId };
}

/** Structural equality: both fields must match literally, including `slotId: undefined ===
 * undefined` (two "original node" endpoints at the same point are equal). Not implemented via
 * `SplitRef`'s comparator — that type never represents "no slot", so a separate (small) function
 * is needed for the optional-slot case. */
export function presetEndpointsEqual(a: PresetEndpoint, b: PresetEndpoint): boolean {
  return a.point[0] === b.point[0] && a.point[1] === b.point[1] && a.slotId === b.slotId;
}

/** True if `ep` addresses the same slot as `ref` (a declared split node) — used to find/remove
 * preset entries referencing a specific split node being removed, mirroring post-edit's
 * `endpointsEqual`-based cleanup in `removeSplitNode`. */
export function presetEndpointIsSplit(ep: PresetEndpoint, ref: SplitRef): boolean {
  return ep.slotId !== undefined && splitRefsEqual({ point: ep.point, slotId: ep.slotId }, ref);
}

/** Stable string key: "3,5" for the original node, "3,5:7" for slot 7. No "n"/"s" prefix disjoint
 * scheme like `endpointKey` needs — a preset endpoint has only one shape (point + optional slot),
 * not a `node`/`split` discriminated union. */
export function presetEndpointKey(ep: PresetEndpoint): string {
  return ep.slotId === undefined ? `${ep.point[0]},${ep.point[1]}` : splitRefKey({ point: ep.point, slotId: ep.slotId });
}

/** `PresetEndpoint` → the WASM/`GenerateConfig` wire DTO's endpoint shape. Not a passthrough: the
 * TS-side field is `slotId`, the wire field is `slot` (matches Rust's `PresetEndpointDto`, which
 * derives `Deserialize` with no per-field rename). */
export function presetEndpointToDto(ep: PresetEndpoint): { point: [number, number]; slot?: number } {
  return ep.slotId === undefined ? { point: ep.point } : { point: ep.point, slot: ep.slotId };
}
