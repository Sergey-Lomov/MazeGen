/** Web-side replay engine for the debug event tape (GitHub issue #125). Turns the two flat
 *  buffers produced by `DebugTape::encode()` (`maze-core/src/event_log/mod.rs`, see GitHub issue
 *  #124 and `Specs/event_log.md`) into "maze state at step N" — pure logic, no store/UI wiring.
 *
 *  Two independent layers, deliberately not mixed:
 *  - flat layer (`nodeAt`, `mutatingRbEvents`) — linear forward scan over the node table,
 *    ignoring parent/firstChild/nextSibling entirely. This is what `applyRecursiveBacktracker`
 *    uses.
 *  - tree layer (`nodeView`, `.parent()`/`.children()`) — walks parent/firstChild/nextSibling,
 *    for a future structural viewer (#126+); unused by `applyRecursiveBacktracker`.
 */

// --- Wire format constants (TS mirror of maze-core/src/event_log/mod.rs's Rust constants; both
// sides must be updated together on a wire-format change, there is no shared codegen). ---

export const TAG_SCOPE = 0;
export const NO_NODE = 0xffffffff;
export const NODE_RECORD_SIZE = 22;

/** RB event wire tags — mirrors `wire_tags` in `maze-core/src/generation/recursive_backtracker.rs`. */
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

// --- Flat + tree node record access ---

export interface ParsedTape {
  nodeTable: Uint8Array;
  payload: Uint8Array;
  /** DataView over `nodeTable`, named distinctly from the module's `nodeView()` function below
   *  to avoid the two being confused at a call site. */
  nodeTableView: DataView;
  nodeCount: number;
}

export function parseTape(nodeTable: Uint8Array, payload: Uint8Array): ParsedTape {
  return {
    nodeTable,
    payload,
    nodeTableView: new DataView(nodeTable.buffer, nodeTable.byteOffset, nodeTable.byteLength),
    nodeCount: nodeTable.byteLength / NODE_RECORD_SIZE,
  };
}

export interface NodeRecord {
  parent: number | null;
  firstChild: number | null;
  nextSibling: number | null;
  tag: number;
  payloadOffset: number;
  payloadLen: number;
}

function sentinelToNull(v: number): number | null {
  return v === NO_NODE ? null : v;
}

/** Reads and decodes one fixed-stride node record by index — used by both the flat and tree
 *  layers described in this module's doc comment. */
export function nodeAt(tape: ParsedTape, index: number): NodeRecord {
  const base = index * NODE_RECORD_SIZE;
  const dv = tape.nodeTableView;
  return {
    parent: sentinelToNull(dv.getUint32(base + 0, true)),
    firstChild: sentinelToNull(dv.getUint32(base + 4, true)),
    nextSibling: sentinelToNull(dv.getUint32(base + 8, true)),
    tag: dv.getUint16(base + 12, true),
    payloadOffset: dv.getUint32(base + 14, true),
    payloadLen: dv.getUint32(base + 18, true),
  };
}

const textDecoder = new TextDecoder();

export type NodePayload =
  | { kind: "scope"; name: string }
  | { kind: "event"; tag: number; bytes: Uint8Array };

export interface NodeView {
  index: number;
  payload(): NodePayload;
  parent(): NodeView | null;
  children(): NodeView[];
}

/** Tree-layer handle onto one arena node — mirrors Rust's `NodeView`/`NodePayload`. Not used by
 *  `applyRecursiveBacktracker` (see module doc comment); only for a future structural viewer. */
export function nodeView(tape: ParsedTape, index: number): NodeView {
  return nodeViewFromRecord(tape, index, nodeAt(tape, index));
}

/** Builds a `NodeView` from an already-decoded record, so a caller that has just read a record
 *  for its own purposes (e.g. `children()` below, walking siblings via `nextSibling`) doesn't
 *  pay for decoding the same 22-byte record a second time through a fresh `nodeAt` call. */
function nodeViewFromRecord(tape: ParsedTape, index: number, record: NodeRecord): NodeView {
  const payloadBytes = tape.payload.subarray(record.payloadOffset, record.payloadOffset + record.payloadLen);
  return {
    index,
    payload(): NodePayload {
      return record.tag === TAG_SCOPE
        ? { kind: "scope", name: textDecoder.decode(payloadBytes) }
        : { kind: "event", tag: record.tag, bytes: payloadBytes };
    },
    parent(): NodeView | null {
      return record.parent === null ? null : nodeView(tape, record.parent);
    },
    children(): NodeView[] {
      const result: NodeView[] = [];
      let next = record.firstChild;
      while (next !== null) {
        const childRecord = nodeAt(tape, next);
        result.push(nodeViewFromRecord(tape, next, childRecord));
        next = childRecord.nextSibling;
      }
      return result;
    },
  };
}

// --- Recursive Backtracker event decoding ---

export type RecursiveBacktrackerEvent =
  | { kind: "VertexSelected"; id: bigint }
  | { kind: "CandidatesComputed"; ids: bigint[] }
  | { kind: "DeadEnd" }
  | { kind: "CandidateChosen"; id: bigint }
  | { kind: "EdgeAdded"; from: bigint; to: bigint; bidirectional: boolean }
  | { kind: "VertexVisited"; id: bigint }
  | { kind: "VertexPopped"; id: bigint }
  | { kind: "VertexPushed"; id: bigint };

function readNodeId(bytes: Uint8Array, offset: number): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true);
}

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

function expectLen(tag: number, bytes: Uint8Array, expected: number): void {
  if (bytes.byteLength !== expected) {
    throw new Error(`RecursiveBacktrackerEvent: tag ${tag} payload_len ${bytes.byteLength} does not match expected ${expected}`);
  }
}

/** Mirrors `DebugEvent::is_mutating`'s split for `RecursiveBacktrackerEvent` in
 *  `maze-core/src/generation/recursive_backtracker.rs`. */
export function isMutatingRbEvent(event: RecursiveBacktrackerEvent): boolean {
  return event.kind === "EdgeAdded" || event.kind === "VertexVisited" || event.kind === "VertexPopped" || event.kind === "VertexPushed";
}

export interface MutatingRbEventAt {
  event: RecursiveBacktrackerEvent;
  /** Arena node-table index this event was decoded from — lets a caller (see
   *  `applyRecursiveBacktracker`) resume a later scan right after this node. */
  nodeIndex: number;
}

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
export function mutatingRbEventsWithIndex(tape: ParsedTape, limit?: number, startIndex = 0): MutatingRbEventAt[] {
  const result: MutatingRbEventAt[] = [];
  for (let i = startIndex; i < tape.nodeCount; i++) {
    if (limit !== undefined && result.length >= limit) break;
    const record = nodeAt(tape, i);
    if (record.tag === TAG_SCOPE) continue;
    const bytes = tape.payload.subarray(record.payloadOffset, record.payloadOffset + record.payloadLen);
    const event = decodeRecursiveBacktrackerEvent(record.tag, bytes);
    if (isMutatingRbEvent(event)) result.push({ event, nodeIndex: i });
  }
  return result;
}

/** Convenience wrapper over `mutatingRbEventsWithIndex` for callers that only need the decoded
 *  events, not their arena indices — e.g. tests asserting the plain event sequence. The returned
 *  array's index is the `step` used by `applyRecursiveBacktracker`/`targetStep`. */
export function mutatingRbEvents(tape: ParsedTape, limit?: number, startIndex = 0): RecursiveBacktrackerEvent[] {
  return mutatingRbEventsWithIndex(tape, limit, startIndex).map((e) => e.event);
}

// --- Apply ---

export interface Edge {
  from: bigint;
  to: bigint;
}

export interface ApplyFrom {
  edges: Edge[];
  step: number;
  /** Arena node-table index of the mutating event at `step` — lets `applyRecursiveBacktracker`
   *  resume the underlying node-table scan right after this node instead of re-scanning from
   *  the start of the tape. Always equal to the `nodeIndex` of the corresponding `ApplyResult`
   *  (i.e. pass a previous call's result straight back in as `from`, unmodified). */
  nodeIndex: number;
}

export interface ApplyResult {
  edges: Edge[];
  step: number;
  /** Arena node-table index of the mutating event at `step` — pass back as `from.nodeIndex` to
   *  resume from this point without re-scanning the tape's already-known prefix. */
  nodeIndex: number;
}

function validateStepShape(name: string, step: number): void {
  if (!Number.isInteger(step) || step < 0) {
    throw new Error(`${name} ${step} must be a non-negative integer`);
  }
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
export function applyRecursiveBacktracker(tape: ParsedTape, targetStep: number, from?: ApplyFrom): ApplyResult {
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
  }

  const scanStart = from ? from.nodeIndex + 1 : 0;
  const needed = targetStep - (from?.step ?? -1);
  const newEvents = mutatingRbEventsWithIndex(tape, needed, scanStart);
  if (newEvents.length < needed) {
    const total = (from?.step ?? -1) + 1 + newEvents.length;
    throw new Error(`targetStep ${targetStep} out of range [0, ${total})`);
  }

  const edges = from ? [...from.edges] : [];
  for (const { event } of newEvents) {
    if (event.kind === "EdgeAdded") {
      edges.push({ from: event.from, to: event.to });
      if (event.bidirectional) {
        edges.push({ from: event.to, to: event.from });
      }
    }
  }

  return { edges, step: targetStep, nodeIndex: newEvents[newEvents.length - 1].nodeIndex };
}
