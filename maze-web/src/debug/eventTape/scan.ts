/** Flat layer — linear forward scan over the node table, ignoring parent/firstChild/nextSibling
 *  entirely. This is what every algorithm's `applyX` function (`recursiveBacktracker.ts`,
 *  `kruskal.ts`, `wilson.ts`, `edgeBased.ts`, `vertexBased.ts`, `qc.ts`) uses; the tree layer
 *  (`tree.ts`) is unused here. */

import { nodeAt, TAG_SCOPE, type ParsedTape } from "./wire";

export interface MutatingEventAt<E> {
  event: E;
  /** Arena node-table index this event was decoded from — lets a caller resume a later scan
   *  right after this node (e.g. an `applyX` function's bounded resume). */
  nodeIndex: number;
}

/** Flat layer forward scan, generic over one algorithm's `decode`/`isMutating` pair: scans the
 *  node table from `startIndex`, skips `TAG_SCOPE` nodes, decodes each event's payload, keeps
 *  only mutating ones, stops once `limit` have been collected — the loop body every
 *  `mutatingXEventsWithIndex` function shares, extracted per GitHub issue #168.
 *
 *  `startIndex` (default 0) and `limit` bound the *node-table* scan: the scan starts at arena
 *  index `startIndex` and stops as soon as `limit` mutating events have been collected since
 *  then — a real run can produce tens of thousands of events, per `Specs/event_log.md`'s WASM
 *  Boundary section, so avoiding both the already-known prefix and the unneeded tail matters.
 *
 *  `endIndex` (GitHub issue #147, exclusive, defaults to `tape.nodeCount`) additionally caps the
 *  scan at a fixed arena index regardless of how many mutating events have been found — needed
 *  when scanning one source's own range in a multi-source merged tape without already knowing
 *  that source's own mutating-event count: `limit` alone can't express "stop at this source's
 *  boundary, whatever else lies past it", since a caller may not yet know how many mutating
 *  events that source itself contains (that's exactly what this scan is computing). Without this,
 *  an unbounded scan of one source runs straight into the next source's own node range and
 *  mis-decodes its bytes as if they belonged to this decoder's own tag set (e.g. a QC
 *  `IterationStarted` tag numerically colliding with an RB `VertexSelected` tag). */
export function mutatingEventsWithIndex<E>(
  tape: ParsedTape,
  decode: (tag: number, bytes: Uint8Array) => E,
  isMutating: (event: E) => boolean,
  limit?: number,
  startIndex = 0,
  endIndex = tape.nodeCount,
): MutatingEventAt<E>[] {
  const result: MutatingEventAt<E>[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    if (limit !== undefined && result.length >= limit) break;
    const record = nodeAt(tape, i);
    if (record.tag === TAG_SCOPE) continue;
    const bytes = tape.payload.subarray(record.payloadOffset, record.payloadOffset + record.payloadLen);
    const event = decode(record.tag, bytes);
    if (isMutating(event)) result.push({ event, nodeIndex: i });
  }
  return result;
}

/** Counts mutating events over `[startIndex, endIndex)` without materializing a
 *  `MutatingEventAt<E>[]` array or allocating a `{event, nodeIndex}` per hit — same decode/
 *  is-mutating cost as `mutatingEventsWithIndex` (an event still has to be decoded to know whether
 *  it's mutating), but `resolveDebugArenaMetadata`'s `totalSteps` count (GitHub issue #128) only
 *  ever needs the count, so this skips the throwaway array/object allocations that would otherwise
 *  dominate for a large tape (tens of thousands of events). */
export function countMutatingEvents<E>(
  tape: ParsedTape,
  decode: (tag: number, bytes: Uint8Array) => E,
  isMutating: (event: E) => boolean,
  startIndex = 0,
  endIndex = tape.nodeCount,
): number {
  let count = 0;
  for (let i = startIndex; i < endIndex; i++) {
    const record = nodeAt(tape, i);
    if (record.tag === TAG_SCOPE) continue;
    const bytes = tape.payload.subarray(record.payloadOffset, record.payloadOffset + record.payloadLen);
    if (isMutating(decode(record.tag, bytes))) count++;
  }
  return count;
}
