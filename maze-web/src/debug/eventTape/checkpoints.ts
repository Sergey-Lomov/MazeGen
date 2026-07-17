/** Intermediate snapshot checkpoints (GitHub issue #128).
 *
 *  Snapshots are built entirely on the web side — the core has no notion of "snapshot" at all (it
 *  only ever produces the plain event tape). Algorithm-agnostic: `resolveDebugArenaMetadata`
 *  knows nothing about `edges`/`debugValues`/`dsuGroups`/or any other concrete shape — it only
 *  knows "count mutating events" (a caller-supplied `countMutating`) and "snapshot the opaque
 *  result of `apply()` at this step" (a caller-supplied `applySnapshot`). What a snapshot actually
 *  *contains* is entirely the calling adapter's own `TResult` — this module never inspects it. */

import type { ParsedTape } from "./wire";

/** Mutating events between cached snapshots (mirrors the pacing the old core mechanism used) — a
 *  tunable constant, not user-facing config: frequent enough that a resumed replay never walks
 *  more than this many events from the nearest snapshot, sparse enough that the cached snapshot
 *  list itself stays small. */
const CHECKPOINT_INTERVAL = 500;

/** One cached snapshot — an opaque `apply()` result plus the `step` it was taken at. `TResult` is
 *  whichever adapter produced it (`ApplyResult`/`KruskalApplyResult`/`WilsonApplyResult`/etc) —
 *  this type itself carries no assumption about what's inside. */
export interface Snapshot<TResult> {
  step: number;
  result: TResult;
}

export interface DebugArenaMetadata<TResult> {
  totalSteps: number;
  checkpointFroms: Snapshot<TResult>[];
}

/** Counts mutating events (`totalSteps`, via a lightweight `countMutating` count with no
 *  array/object materialization) and, every `CHECKPOINT_INTERVAL` of them, calls `applySnapshot`
 *  to cache that step's `apply()` result — replacing the old core-produced checkpoint buffer
 *  (GitHub issue #128) with an equivalent computed here from the plain event tape, for *any*
 *  instrumented algorithm, not just Recursive Backtracker. Call once when a tape's debug arena is
 *  built (see `generateConfigBuilder.ts`), not on every scrub — the result is small (one entry per
 *  `CHECKPOINT_INTERVAL` mutating events) and reused for the arena's whole lifetime.
 *
 *  `applySnapshot(step, previous)` is a thin closure over one adapter's own `apply` (see each
 *  adapter's `resolveMetadata` in `algorithmRegistry.ts`) — `previous` is the last cached snapshot
 *  (if any), so each new snapshot resumes from the previous one instead of replaying from the
 *  tape's start, keeping this whole scan O(totalSteps) rather than O(totalSteps²/CHECKPOINT_INTERVAL).
 *
 *  Does *not* collect debug-value names (GitHub issue #131) — those come from the WASM response's
 *  static `debugValueNames` (`GenerateResult::debug_value_names()`, mirroring the algorithm's own
 *  declaration), not from scanning which deltas this particular run happened to emit. A trivial
 *  run that never triggers a delta would otherwise silently omit a name the algorithm still
 *  declares — see `Specs/event_log.md`'s Generic Debug Values section. */
export function resolveDebugArenaMetadata<TResult extends { step: number; nodeIndex: number }>(
  tape: ParsedTape,
  countMutating: (tape: ParsedTape, startIndex?: number, endIndex?: number) => number,
  applySnapshot: (step: number, previous: TResult | undefined) => TResult,
  startIndex = 0,
  endIndex = tape.nodeCount,
): DebugArenaMetadata<TResult> {
  const totalSteps = countMutating(tape, startIndex, endIndex);
  const checkpointFroms: Snapshot<TResult>[] = [];
  let previous: TResult | undefined;
  for (let step = CHECKPOINT_INTERVAL - 1; step < totalSteps; step += CHECKPOINT_INTERVAL) {
    previous = applySnapshot(step, previous);
    checkpointFroms.push({ step, result: previous });
  }
  return { totalSteps, checkpointFroms };
}

/** Binary-searches `checkpointFroms` (as produced by `resolveDebugArenaMetadata`, sorted by
 *  ascending `step`) for the entry with the greatest `step <= targetStep`, or `null` if none
 *  precedes it. Step-keyed, not arena-node-indexed — matches what every adapter's `apply` needs,
 *  since `from`/`targetStep` are indices into the flat mutating-event sequence. Generic over
 *  `TResult` — this function never inspects what's inside a snapshot, only its `step`. */
export function nearestCheckpointFromAtOrBefore<TResult>(checkpointFroms: Snapshot<unknown>[], targetStep: number): TResult | null {
  let lo = 0;
  let hi = checkpointFroms.length - 1;
  let result: TResult | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (checkpointFroms[mid].step <= targetStep) {
      result = checkpointFroms[mid].result as TResult;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}
