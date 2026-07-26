/** Shared, endpoint-type-agnostic logic for managing a tessellation point's extra ("split") nodes
 * — the slot-list bookkeeping behind both post-edit's `postEditDraftSplitPoints` (GitHub issue
 * #221) and preset connections' `presetSplitPoints` (GitHub issue #231). Deliberately knows only
 * "does this slot exist and which one is active" — nothing about edges, teleports, presets, or
 * any other data that might reference a slot. Cleaning up those references when a slot is removed
 * is the caller's job (`postEditSlice.ts`'s `removeSplitNode`, `presetConnectionsSlice.ts`'s
 * `removePresetSplitNode`), done as a separate step after calling `removeSlot` here.
 *
 * Parameterized over the endpoint type `E` (`PostEditEndpoint` for post-edit, `PresetEndpoint` for
 * presets) via small adapter functions each caller supplies, since the two sides disagree on what
 * "no slot" looks like (`PostEditEndpoint`'s `{kind:"node"}` vs `PresetEndpoint`'s
 * `{slotId: undefined}`) and how to build/inspect a split reference. */

export type SplitPoints = Record<string, number[]>;

function pointKey(point: [number, number]): string {
  return `${point[0]},${point[1]}`;
}

/** Derives a fresh `SplitPoints` map straight from a node list (`state.nodes`, GitHub issue #236's
 *  `NodeDto.i`) — needed because a tile can arrive already split without any prior
 *  `postEditDraftSplitPoints`/`presetSplitPoints` entry (GitHub issue #222's generator-driven
 *  automatic split, on top of the pre-existing manual `split_points`/preset-stage declarations from
 *  #221/#231): the generator mints extra nodes at a point during its own run, with no corresponding
 *  slot ever registered on the web side.
 *
 *  Slot ids are `n.i - 1` for every node with `i > 0` (`i = 0` is always the point's original node
 *  — never a "slot", see `ManageSplitNodesDialog`'s `originalNodeId`/`originalEndpoint`) — read
 *  directly from each node's own stable `i`, **not** recomputed from its position/count among the
 *  point's nodes. Position-based numbering breaks the moment a non-last split node has ever been
 *  removed (`state.nodes` after a `confirmPostEdit` following a `removeSplitNode` reflects that
 *  removal, but `i` itself never shifts to fill the resulting hole — see `NodeDto.i`'s doc comment)
 *  — using `i` directly keeps this call correct whether it runs right after a fresh generation or
 *  after `resetPostEdit` on already-edited state. */
export function deriveSplitPointsFromNodes(nodes: { x: number; y: number; i: number }[]): SplitPoints {
  const result: SplitPoints = {};
  for (const n of nodes) {
    if (n.i === 0) continue;
    const key = pointKey([n.x, n.y]);
    (result[key] ??= []).push(n.i - 1);
  }
  return result;
}

/** Mints the next slotId for `point` (`max(existing) + 1`, or `0` if none yet — uniqueness is only
 * needed within a point, see `postEditDraftSplitPoints`'s doc comment) and appends it. */
export function addSlot(
  splitPoints: SplitPoints,
  point: [number, number],
): { splitPoints: SplitPoints; slotId: number } {
  const key = pointKey(point);
  const existing = splitPoints[key] ?? [];
  const slotId = existing.length === 0 ? 0 : Math.max(...existing) + 1;
  return { splitPoints: { ...splitPoints, [key]: [...existing, slotId] }, slotId };
}

/** Removes `slotId` from `point`'s list, and clears `activeMap[key]` if it currently points at the
 * removed slot. Does not touch anything outside `splitPoints`/`activeMap` — see module doc
 * comment. `isSlot(entry, point, slotId)` tells whether `activeMap`'s current entry for this point
 * addresses the slot being removed. */
export function removeSlot<E>(
  splitPoints: SplitPoints,
  activeMap: Record<string, E>,
  point: [number, number],
  slotId: number,
  isSlot: (entry: E, point: [number, number], slotId: number) => boolean,
): { splitPoints: SplitPoints; activeMap: Record<string, E> } {
  const key = pointKey(point);
  const existing = splitPoints[key] ?? [];
  const nextSlots = existing.filter((s) => s !== slotId);
  const nextSplitPoints = { ...splitPoints };
  if (nextSlots.length === 0) delete nextSplitPoints[key];
  else nextSplitPoints[key] = nextSlots;

  const nextActive = { ...activeMap };
  const current = nextActive[key];
  if (current !== undefined && isSlot(current, point, slotId)) {
    delete nextActive[key];
  }

  return { splitPoints: nextSplitPoints, activeMap: nextActive };
}

/** Cycles `activeMap[point]` through original -> slot[0] -> slot[1] -> ... -> back to original (no
 * entry). No-op for a point with no split nodes. `slotOfActive(entry)` returns the currently
 * active slotId, or `undefined` if the entry addresses the original node (or there is no entry).
 * `makeSplit(point, slotId)` builds the entry for a given slot. */
export function cycleActive<E>(
  splitPoints: SplitPoints,
  activeMap: Record<string, E>,
  point: [number, number],
  makeSplit: (point: [number, number], slotId: number) => E,
  slotOfActive: (entry: E | undefined) => number | undefined,
): Record<string, E> {
  const key = pointKey(point);
  const slots = splitPoints[key];
  if (!slots || slots.length === 0) return activeMap;
  const sorted = [...slots].sort((a, b) => a - b);
  const currentSlotIndex = sorted.indexOf(slotOfActive(activeMap[key]) ?? -1);
  const nextIndex = currentSlotIndex + 1;
  const nextActive = { ...activeMap };
  if (nextIndex >= sorted.length) {
    delete nextActive[key];
  } else {
    nextActive[key] = makeSplit(point, sorted[nextIndex]);
  }
  return nextActive;
}

/** Sets `activeMap[point]` directly. `isDefault(endpoint)` tells whether `endpoint` addresses the
 * original node — such an endpoint clears the entry (absence already means "original node"). */
export function setActive<E>(
  activeMap: Record<string, E>,
  point: [number, number],
  endpoint: E,
  isDefault: (entry: E) => boolean,
): Record<string, E> {
  const key = pointKey(point);
  const nextActive = { ...activeMap };
  if (isDefault(endpoint)) {
    delete nextActive[key];
  } else {
    nextActive[key] = endpoint;
  }
  return nextActive;
}
