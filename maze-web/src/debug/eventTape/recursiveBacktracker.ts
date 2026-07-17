// --- Recursive Backtracker event decoding + replay ---

import { expectLen, nodeAt, readNodeId, TAG_SCOPE, type ParsedTape } from "./wire";
import { mutatingEventsWithIndex, type MutatingEventAt } from "./scan";
import {
  cloneDebugValues, foldDebugValueDelta, validateStepShape,
  type DebugValueOp, type DebugValues, type Edge,
} from "./applyShared";

export const RB_TAG = {
  VERTEX_SELECTED: 1,
  CANDIDATES_COMPUTED: 2,
  DEAD_END: 3,
  CANDIDATE_CHOSEN: 4,
  EDGE_ADDED: 5,
  VERTEX_VISITED: 6,
  VERTEX_POPPED: 7,
  VERTEX_PUSHED: 8,
} as const;

export type RecursiveBacktrackerEvent =
  | { kind: "VertexSelected"; id: bigint }
  | { kind: "CandidatesComputed"; ids: bigint[] }
  | { kind: "DeadEnd" }
  | { kind: "CandidateChosen"; id: bigint }
  | { kind: "EdgeAdded"; from: bigint; to: bigint; bidirectional: boolean }
  | { kind: "VertexVisited"; id: bigint }
  | { kind: "VertexPopped"; id: bigint }
  | { kind: "VertexPushed"; id: bigint };

/** Decodes one RB event's binary payload. Contract: only called with `tag >= 1` (a real RB wire
 *  tag) — callers (e.g. `mutatingRbEvents`) filter out `TAG_SCOPE` before invoking this; it never
 *  needs to know about scope nodes. Throws on an unrecognized tag or a `payload_len` that doesn't
 *  match the wire format (fixed size per variant — 17 bytes for `EdgeAdded` (GitHub issue #135:
 *  two `NodeId`s plus a 1-byte `bidirectional` flag), or the `4 + count * 8` formula for
 *  `CandidatesComputed`) — a malformed tape means a core/web build mismatch, which must surface
 *  immediately rather than silently produce a wrong reconstructed state. */
export function decodeRecursiveBacktrackerEvent(tag: number, bytes: Uint8Array): RecursiveBacktrackerEvent {
  switch (tag) {
    case RB_TAG.VERTEX_SELECTED:
      expectLen(tag, bytes, 8);
      return { kind: "VertexSelected", id: readNodeId(bytes, 0) };
    case RB_TAG.CANDIDATE_CHOSEN:
      expectLen(tag, bytes, 8);
      return { kind: "CandidateChosen", id: readNodeId(bytes, 0) };
    case RB_TAG.VERTEX_VISITED:
      expectLen(tag, bytes, 8);
      return { kind: "VertexVisited", id: readNodeId(bytes, 0) };
    case RB_TAG.VERTEX_POPPED:
      expectLen(tag, bytes, 8);
      return { kind: "VertexPopped", id: readNodeId(bytes, 0) };
    case RB_TAG.VERTEX_PUSHED:
      expectLen(tag, bytes, 8);
      return { kind: "VertexPushed", id: readNodeId(bytes, 0) };
    case RB_TAG.EDGE_ADDED:
      expectLen(tag, bytes, 17);
      return { kind: "EdgeAdded", from: readNodeId(bytes, 0), to: readNodeId(bytes, 8), bidirectional: bytes[16] !== 0 };
    case RB_TAG.DEAD_END:
      expectLen(tag, bytes, 0);
      return { kind: "DeadEnd" };
    case RB_TAG.CANDIDATES_COMPUTED: {
      if (bytes.byteLength < 4) {
        throw new Error(`RecursiveBacktrackerEvent: CandidatesComputed payload too short (${bytes.byteLength} bytes, need at least 4)`);
      }
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const count = dv.getUint32(0, true);
      const expected = 4 + count * 8;
      if (bytes.byteLength !== expected) {
        throw new Error(`RecursiveBacktrackerEvent: CandidatesComputed payload_len ${bytes.byteLength} does not match 4 + count*8 (count=${count}, expected ${expected})`);
      }
      const ids: bigint[] = [];
      for (let i = 0; i < count; i++) {
        ids.push(readNodeId(bytes, 4 + i * 8));
      }
      return { kind: "CandidatesComputed", ids };
    }
    default:
      throw new Error(`RecursiveBacktrackerEvent: unknown wire tag ${tag}`);
  }
}

/** Mirrors `DebugEvent::is_mutating`'s split for `RecursiveBacktrackerEvent` in
 *  `maze-core/src/generation/recursive_backtracker.rs`. */
export function isMutatingRbEvent(event: RecursiveBacktrackerEvent): boolean {
  return event.kind === "EdgeAdded" || event.kind === "VertexVisited" || event.kind === "VertexPopped" || event.kind === "VertexPushed";
}

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
  return mutatingEventsWithIndex(tape, decodeRecursiveBacktrackerEvent, isMutatingRbEvent, limit, startIndex, endIndex);
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
export function applyRecursiveBacktracker(tape: ParsedTape, targetStep: number, from?: ApplyFrom, endIndex?: number): ApplyResult {
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
    if (anchor.tag === TAG_SCOPE || !isMutatingRbEvent(decodeRecursiveBacktrackerEvent(anchor.tag, tape.payload.subarray(anchor.payloadOffset, anchor.payloadOffset + anchor.payloadLen)))) {
      throw new Error(`applyRecursiveBacktracker: from.nodeIndex ${from.nodeIndex} does not point at a mutating event`);
    }
    // `from` already *is* the answer when it lands exactly on targetStep — the scan below would
    // ask for 0 new events and index into an empty array. No new events to decode either way.
    if (from.step === targetStep) {
      return { edges: [...from.edges], debugValues: cloneDebugValues(from.debugValues), step: targetStep, nodeIndex: from.nodeIndex };
    }
  }

  const scanStart = from ? from.nodeIndex + 1 : 0;
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
