// --- Recursive Backtracker event replay (decoding lives in generated/recursiveBacktracker.ts) ---

import { nodeAt, TAG_SCOPE, type ParsedTape } from "./wire";
import { mutatingEventsWithIndex, type MutatingEventAt } from "./scan";
import {
  cloneDebugValues, foldDebugValueDelta, validateStepShape,
  type DebugValueOp, type DebugValues, type Edge,
} from "./applyShared";
import {
  decodeRecursiveBacktrackerEvent, isMutatingRecursiveBacktrackerEvent,
  type RecursiveBacktrackerEvent,
} from "./generated/recursiveBacktracker";

export type { RecursiveBacktrackerEvent } from "./generated/recursiveBacktracker";
export { decodeRecursiveBacktrackerEvent, isMutatingRecursiveBacktrackerEvent, RECURSIVE_BACKTRACKER_EVENT_TAG } from "./generated/recursiveBacktracker";

export const RECURSION_STACK = "recursion_stack";
export const VISITED = "visited";

/** Mirrors `RecursiveBacktrackerEvent::debug_value_deltas()` in
 *  `maze-core/src/generation/recursive_backtracker.rs` — must be kept in sync by hand (no shared
 *  codegen, same as the rest of this module's wire mirroring). */
export function debugValueDeltasFor(event: RecursiveBacktrackerEvent): [string, DebugValueOp, bigint][] {
  switch (event.kind) {
    case "VertexPushed":
      return [[RECURSION_STACK, "insert", event.id]];
    case "VertexPopped":
      return [[RECURSION_STACK, "remove", event.id]];
    case "VertexVisited":
      return [[VISITED, "insert", event.id]];
    default:
      return [];
  }
}

export type MutatingRbEventAt = MutatingEventAt<RecursiveBacktrackerEvent>;

/** Flat layer: forward scan over the node table, skipping scope nodes, decoding events,
 *  filtering to mutating ones only — mirrors `DebugTape::mutating_events()`. Each result also
 *  carries the arena node-table index it came from (see `MutatingRbEventAt`), so a bounded
 *  resume (see `applyRecursiveBacktracker`) can pick up scanning right after a previous call's
 *  last event without re-decoding anything before it.
 *
 *  `startIndex` (default 0) and `limit` bound the *node-table* scan: the scan starts at arena
 *  index `startIndex` and stops as soon as `limit` mutating events have been collected since
 *  then — a real run can produce tens of thousands of events, per `Specs/event_log.md`'s WASM
 *  Boundary section, so avoiding both the already-known prefix and the unneeded tail matters. */
export function mutatingRbEventsWithIndex(tape: ParsedTape, limit?: number, startIndex = 0, endIndex?: number): MutatingRbEventAt[] {
  return mutatingEventsWithIndex(tape, decodeRecursiveBacktrackerEvent, isMutatingRecursiveBacktrackerEvent, limit, startIndex, endIndex);
}

/** Convenience wrapper over `mutatingRbEventsWithIndex` for callers that only need the decoded
 *  events, not their arena indices — e.g. tests asserting the plain event sequence. The returned
 *  array's index is the `step` used by `applyRecursiveBacktracker`/`targetStep`. */
export function mutatingRbEvents(tape: ParsedTape, limit?: number, startIndex = 0, endIndex?: number): RecursiveBacktrackerEvent[] {
  return mutatingRbEventsWithIndex(tape, limit, startIndex, endIndex).map((e) => e.event);
}

export interface ApplyFrom {
  edges: Edge[];
  debugValues: DebugValues;
  step: number;
  /** Arena node-table index of the mutating event at `step` — lets `applyRecursiveBacktracker`
   *  resume the underlying node-table scan right after this node instead of re-scanning from
   *  the start of the tape. Always equal to the `nodeIndex` of the corresponding `ApplyResult`
   *  (i.e. pass a previous call's result straight back in as `from`, unmodified). */
  nodeIndex: number;
}

export interface ApplyResult {
  edges: Edge[];
  debugValues: DebugValues;
  step: number;
  /** Arena node-table index of the mutating event at `step` — pass back as `from.nodeIndex` to
   *  resume from this point without re-scanning the tape's already-known prefix. */
  nodeIndex: number;
}

/** Replays Recursive Backtracker `EdgeAdded` events up to and including `targetStep` (the index,
 *  within the flat mutating-event sequence from `mutatingRbEvents`, of the last event to apply).
 *  `from`, if given, resumes from an already-known state (`edges` accumulated up through
 *  `from.step`, scan resumed right after `from.nodeIndex`) instead of replaying from the start —
 *  this is the nearest-snapshot lookup entry point future checkpointing (a separate issue) will
 *  plug into without an API reshape. `from` is never mutated; a new array is always returned.
 *
 *  Bounded on both ends: the node-table scan starts at `from.nodeIndex + 1` (or 0 without `from`)
 *  and stops once `targetStep - (from?.step ?? -1)` new mutating events have been collected — so
 *  neither the already-known prefix nor the tape's tail past `targetStep` is ever decoded. This
 *  is what makes resuming from a previous step cheap independent of how large `targetStep` itself
 *  is — a real run can produce tens of thousands of events (`Specs/event_log.md`'s WASM Boundary
 *  section), so a UI scrubbing forward one step at a time must not re-pay the cost of decoding
 *  everything before the step it's already at.
 *
 *  A bidirectional `EdgeAdded` (GitHub issue #135) contributes both `{from, to}` and `{to, from}`
 *  to `edges` — RB always opens passages in both directions, and the event now carries that fact
 *  explicitly rather than this module assuming it. */
export function applyRecursiveBacktracker(tape: ParsedTape, targetStep: number, from?: ApplyFrom, startIndex = 0, endIndex?: number): ApplyResult {
  validateStepShape("targetStep", targetStep);
  if (from) {
    validateStepShape("from.step", from.step);
    validateStepShape("from.nodeIndex", from.nodeIndex);
    if (from.step > targetStep) {
      throw new Error(`applyRecursiveBacktracker: from.step ${from.step} is ahead of targetStep ${targetStep}`);
    }
    if (from.nodeIndex >= tape.nodeCount) {
      throw new Error(`applyRecursiveBacktracker: from.nodeIndex ${from.nodeIndex} out of range [0, ${tape.nodeCount})`);
    }
    // `nodeAt(tape, from.nodeIndex)` must actually be the mutating event at from.step — a
    // mismatched `from` (not obtained from a previous applyRecursiveBacktracker/mutatingRbEvents
    // call on this same tape) would otherwise resume scanning from a meaningless position without
    // any error, silently producing a wrong result. Cheap to check: one record read.
    const anchor = nodeAt(tape, from.nodeIndex);
    if (anchor.tag === TAG_SCOPE || !isMutatingRecursiveBacktrackerEvent(decodeRecursiveBacktrackerEvent(anchor.tag, tape.payload.subarray(anchor.payloadOffset, anchor.payloadOffset + anchor.payloadLen)))) {
      throw new Error(`applyRecursiveBacktracker: from.nodeIndex ${from.nodeIndex} does not point at a mutating event`);
    }
    // `from` already *is* the answer when it lands exactly on targetStep — the scan below would
    // ask for 0 new events and index into an empty array. No new events to decode either way.
    if (from.step === targetStep) {
      return { edges: [...from.edges], debugValues: cloneDebugValues(from.debugValues), step: targetStep, nodeIndex: from.nodeIndex };
    }
  }

  const scanStart = from ? from.nodeIndex + 1 : startIndex;
  const needed = targetStep - (from?.step ?? -1);
  const newEvents = mutatingRbEventsWithIndex(tape, needed, scanStart, endIndex);
  if (newEvents.length < needed) {
    const total = (from?.step ?? -1) + 1 + newEvents.length;
    throw new Error(`targetStep ${targetStep} out of range [0, ${total})`);
  }

  const edges = from ? [...from.edges] : [];
  const debugValues = from ? cloneDebugValues(from.debugValues) : new Map<string, bigint[]>();
  const presence = new Map<string, Set<bigint>>();
  for (const [name, ids] of debugValues) presence.set(name, new Set(ids));

  for (const { event } of newEvents) {
    if (event.kind === "EdgeAdded") {
      edges.push({ from: event.from, to: event.to });
      if (event.bidirectional) {
        edges.push({ from: event.to, to: event.from });
      }
    }
    for (const [name, op, id] of debugValueDeltasFor(event)) {
      foldDebugValueDelta(debugValues, presence, name, op, id);
    }
  }

  return { edges, debugValues, step: targetStep, nodeIndex: newEvents[newEvents.length - 1].nodeIndex };
}
