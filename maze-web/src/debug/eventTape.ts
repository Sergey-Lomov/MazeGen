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

// --- Debug values (GitHub issue #131) ---

/** A named, session-specific set of node ids an algorithm evolves over the run (e.g. Recursive
 *  Backtracker's `"recursion_stack"`) — mirrors `DebugValueOp`/`DebugValueDelta` in
 *  `maze-core/src/event_log/mod.rs`. Deliberately derived from the *existing* mutating events
 *  (`VertexPushed`/`VertexPopped`) rather than a separate wire event — see that trait's doc
 *  comment for why (no extra mutating events inflating step numbering, no payload duplication). */
export type DebugValueOp = "insert" | "remove";

export const RECURSION_STACK = "recursion_stack";
export const VISITED = "visited";

/** Semantic shape of a debug value's id collection — mirrors `DebugValueKind` in
 *  `maze-core/src/event_log/mod.rs`. Affects rendering, not how deltas are reported (both kinds
 *  still use `insert`/`remove` on a single id):
 *  - `"region"` — unordered set, no relationship between members (e.g. `"visited"`), rendered as
 *    independent per-node highlights.
 *  - `"sequence"` — ordered list where adjacent members are connected (e.g. `"recursion_stack"`,
 *    the DFS stack in push order), rendered as a chain of arrows between consecutive ids. */
export type DebugValueKind = "region" | "sequence";

/** One debug value the instrumented algorithm declares — name plus its rendering kind. Mirrors
 *  the wire pair `GenerateResult::debugValueNames()`/`debugValueKinds()` return (parallel
 *  arrays, zipped together on the JS side — see `mazeService.ts`). */
export interface DebugValueDescriptor {
  name: string;
  kind: DebugValueKind;
}

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

/** Named debug-value id lists (GitHub issue #131), keyed by name — e.g.
 *  `debugValues.get("recursion_stack")`. `bigint[]`, not `Set<bigint>` — order matters for
 *  `DebugValueKind.Sequence` values (e.g. `"recursion_stack"`, rendered as a chain of arrows
 *  between consecutive ids in insertion order); `Region` values are unordered by nature but a
 *  duplicate-free array is still a valid representation, mirroring the Rust side's
 *  `CheckpointTracker::debug_values: BTreeMap<&str, Vec<NodeId>>`. Never mutated in place by
 *  `applyRecursiveBacktracker`; a fresh `Map`/`Array` is built whenever a delta is folded in,
 *  mirroring `edges`' own copy-on-write discipline. */
export type DebugValues = Map<string, bigint[]>;

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

/** Clones a `DebugValues` map one level deep (fresh `Map` and fresh arrays) — used whenever
 *  `applyRecursiveBacktracker` folds in new deltas on top of an existing `from.debugValues`, so
 *  the caller-supplied `from` is never mutated in place (same discipline as `edges`). */
function cloneDebugValues(values: DebugValues): DebugValues {
  const result: DebugValues = new Map();
  for (const [name, ids] of values) result.set(name, [...ids]);
  return result;
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
    // `from` already *is* the answer when it lands exactly on targetStep — the scan below would
    // ask for 0 new events and index into an empty array. No new events to decode either way.
    if (from.step === targetStep) {
      return { edges: [...from.edges], debugValues: cloneDebugValues(from.debugValues), step: targetStep, nodeIndex: from.nodeIndex };
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
  const debugValues = from ? cloneDebugValues(from.debugValues) : new Map<string, bigint[]>();
  // `Set` mirror of each list, membership-only — makes `insert`'s dedup check O(1) instead of an
  // O(n) `Array.includes` scan. Without it, a monotonically-growing Region value (e.g. "visited",
  // one insert per node, never removed) makes this loop O(n²) over a run: every scrub/autoplay
  // tick re-scans a list approaching the full node count on every single insert. Mirrors the same
  // fix applied to `CheckpointTracker::record` on the Rust side (`DebugValueList`, GitHub issue
  // #142's follow-up) — built fresh here (not carried in `ApplyFrom`/`DebugValues` itself) so the
  // public `bigint[]` shape every consumer (store selectors, render overlays) depends on doesn't
  // change; it's discarded once this function returns.
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
      let ids = debugValues.get(name);
      let present = presence.get(name);
      if (!ids) {
        ids = [];
        debugValues.set(name, ids);
        present = new Set();
        presence.set(name, present);
      }
      if (op === "insert") {
        if (!present!.has(id)) { present!.add(id); ids.push(id); }
      } else {
        if (present!.delete(id)) {
          const at = ids.indexOf(id);
          if (at !== -1) ids.splice(at, 1);
        }
      }
    }
  }

  return { edges, debugValues, step: targetStep, nodeIndex: newEvents[newEvents.length - 1].nodeIndex };
}

// --- Intermediate snapshot checkpoints (GitHub issue #128) ---
//
// A separate flat buffer pair (table + payload), produced by `CheckpointLog::encode()`
// (`maze-core/src/event_log/checkpoint.rs`) — deliberately independent of the node table/payload
// above, mirroring that Rust type's independence from `EventLog`/`DebugTape`. This module only
// parses the buffer and exposes the step-keyed lookup (`nearestCheckpointFromAtOrBefore`, since
// checkpoints are stored keyed by arena `nodeIndex` but `applyRecursiveBacktracker` needs `step`
// — see `resolveCheckpointFroms` below) — the actual wiring into `applyRecursiveBacktracker`/
// `ApplyFrom` lives in `store/debugSelectors.ts`'s `selectDebugMazeView`, not in this module.

/** Byte size of one encoded checkpoint record — mirrors `CHECKPOINT_RECORD_SIZE` in
 *  `maze-core/src/event_log/checkpoint.rs`. */
export const CHECKPOINT_RECORD_SIZE = 12;

export interface ParsedCheckpoints {
  table: Uint8Array;
  payload: Uint8Array;
  tableView: DataView;
  checkpointCount: number;
}

export function parseCheckpoints(table: Uint8Array, payload: Uint8Array): ParsedCheckpoints {
  return {
    table,
    payload,
    tableView: new DataView(table.buffer, table.byteOffset, table.byteLength),
    checkpointCount: table.byteLength / CHECKPOINT_RECORD_SIZE,
  };
}

export interface Checkpoint {
  nodeIndex: number;
  edges: Edge[];
  debugValues: DebugValues;
}

/** Decodes one checkpoint's payload: a `u32` LE length prefix followed by that many
 *  `(from: u64, to: u64)` edge pairs, then a `u32` LE count of named debug-value sets, each a
 *  `u32` LE name length + UTF-8 name bytes + `u32` LE id count + that many `u64` LE ids — mirrors
 *  the encoding `CheckpointTracker::record` writes in
 *  `maze-core/src/generation/recursive_backtracker.rs`. Returns the byte offset immediately past
 *  the decoded payload alongside the decoded value, so `checkpointAt` doesn't need to duplicate
 *  the edges-length arithmetic to find where the debug-values section starts. */
function decodeCheckpointPayload(payload: Uint8Array, offset: number, len: number): { edges: Edge[]; debugValues: DebugValues } {
  const bytes = payload.subarray(offset, offset + len);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;

  const edgeCount = dv.getUint32(pos, true);
  pos += 4;
  const edges: Edge[] = [];
  for (let i = 0; i < edgeCount; i++) {
    edges.push({ from: dv.getBigUint64(pos, true), to: dv.getBigUint64(pos + 8, true) });
    pos += 16;
  }

  const debugValues: DebugValues = new Map();
  const setCount = dv.getUint32(pos, true);
  pos += 4;
  const textDecoder2 = new TextDecoder();
  for (let i = 0; i < setCount; i++) {
    const nameLen = dv.getUint32(pos, true);
    pos += 4;
    const name = textDecoder2.decode(bytes.subarray(pos, pos + nameLen));
    pos += nameLen;
    const idCount = dv.getUint32(pos, true);
    pos += 4;
    const ids: bigint[] = [];
    for (let j = 0; j < idCount; j++) {
      ids.push(dv.getBigUint64(pos, true));
      pos += 8;
    }
    debugValues.set(name, ids);
  }

  return { edges, debugValues };
}

/** Reads and decodes one fixed-stride checkpoint record by index. */
export function checkpointAt(tape: ParsedCheckpoints, index: number): Checkpoint {
  const base = index * CHECKPOINT_RECORD_SIZE;
  const dv = tape.tableView;
  const nodeIndex = dv.getUint32(base + 0, true);
  const offset = dv.getUint32(base + 4, true);
  const len = dv.getUint32(base + 8, true);
  const { edges, debugValues } = decodeCheckpointPayload(tape.payload, offset, len);
  return { nodeIndex, edges, debugValues };
}

// --- Checkpoint-accelerated apply ---
//
// `applyRecursiveBacktracker`'s `targetStep`/`ApplyFrom.step` are indices into the flat
// mutating-event sequence (`mutatingRbEvents`), not arena node indices — so a checkpoint (keyed
// by arena `nodeIndex`) can't be handed to `applyRecursiveBacktracker` as `from` until its
// `nodeIndex` is translated into the matching `step`. `resolveCheckpointFroms` does that
// translation via a single forward scan over the tape, producing ready-to-use `ApplyFrom` values
// sorted by ascending `step` (same order as ascending `nodeIndex`, since arena index and
// mutating-event order grow together) — `nearestCheckpointFromAtOrBefore` then binary-searches
// that small array directly by `step`, with no further tape scanning. `generateConfigBuilder.ts`
// itself doesn't call `resolveCheckpointFroms` directly — it uses `resolveDebugArenaMetadata`
// (below), which folds this same translation into the scan that also computes `totalSteps`.

/** Resolves every checkpoint in `checkpoints` into an `ApplyFrom` ready to pass into
 *  `applyRecursiveBacktracker` — computing each checkpoint's `step` (its position in the flat
 *  mutating-event sequence) via one forward scan over `tape`. Call once when a tape's debug arena
 *  is built (see `generateConfigBuilder.ts`), not on every scrub — the result is small (one entry
 *  per `CHECKPOINT_INTERVAL` mutating events) and reused for the arena's whole lifetime.
 *
 *  Stops scanning early once every checkpoint has been resolved — cheaper than
 *  `resolveDebugArenaMetadata` below when the caller doesn't also need `totalSteps` (e.g. tests),
 *  but `generateConfigBuilder.ts` should prefer `resolveDebugArenaMetadata` since it needs both. */
export function resolveCheckpointFroms(tape: ParsedTape, checkpoints: ParsedCheckpoints): ApplyFrom[] {
  const result: ApplyFrom[] = [];
  if (checkpoints.checkpointCount === 0) return result;

  let nextCheckpoint = 0;
  let step = 0;
  for (let i = 0; i < tape.nodeCount && nextCheckpoint < checkpoints.checkpointCount; i++) {
    const record = nodeAt(tape, i);
    if (record.tag === TAG_SCOPE) continue;
    const bytes = tape.payload.subarray(record.payloadOffset, record.payloadOffset + record.payloadLen);
    const event = decodeRecursiveBacktrackerEvent(record.tag, bytes);
    if (!isMutatingRbEvent(event)) continue;

    while (nextCheckpoint < checkpoints.checkpointCount) {
      const checkpoint = checkpointAt(checkpoints, nextCheckpoint);
      if (checkpoint.nodeIndex !== i) break;
      result.push({ edges: checkpoint.edges, debugValues: checkpoint.debugValues, step, nodeIndex: i });
      nextCheckpoint++;
    }
    step++;
  }
  return result;
}

export interface DebugArenaMetadata {
  totalSteps: number;
  checkpointFroms: ApplyFrom[];
}

/** Combines what used to be two independent full-tape forward scans — `mutatingRbEvents(tape).length`
 *  (to compute `totalSteps`) and `resolveCheckpointFroms` (to compute `checkpointFroms`) — into one
 *  pass, each of which decodes every node-table record exactly once. Building a debug arena for a
 *  large run (tens of thousands of mutating events) used to pay this decode cost twice; this pays
 *  it once. Semantically identical to calling `mutatingRbEvents(tape).length` and
 *  `resolveCheckpointFroms(tape, checkpoints)` separately (when `checkpoints.checkpointCount === 0`,
 *  behaves exactly like counting alone). The intended, and only, caller is
 *  `generateConfigBuilder.ts`'s debug-arena construction, which always needs both values together.
 *
 *  Does *not* collect debug-value names (GitHub issue #131) — those come from the WASM response's
 *  static `debugValueNames` (`GenerateResult::debug_value_names()`, mirroring the algorithm's own
 *  declaration), not from scanning which deltas this particular run happened to emit. A trivial
 *  run that never triggers a delta would otherwise silently omit a name the algorithm still
 *  declares — see `Specs/event_log.md`'s Generic Debug Values section. */
export function resolveDebugArenaMetadata(tape: ParsedTape, checkpoints: ParsedCheckpoints): DebugArenaMetadata {
  const checkpointFroms: ApplyFrom[] = [];
  let nextCheckpoint = 0;
  let step = 0;

  for (let i = 0; i < tape.nodeCount; i++) {
    const record = nodeAt(tape, i);
    if (record.tag === TAG_SCOPE) continue;
    const bytes = tape.payload.subarray(record.payloadOffset, record.payloadOffset + record.payloadLen);
    const event = decodeRecursiveBacktrackerEvent(record.tag, bytes);
    if (!isMutatingRbEvent(event)) continue;

    while (nextCheckpoint < checkpoints.checkpointCount) {
      const checkpoint = checkpointAt(checkpoints, nextCheckpoint);
      if (checkpoint.nodeIndex !== i) break;
      checkpointFroms.push({ edges: checkpoint.edges, debugValues: checkpoint.debugValues, step, nodeIndex: i });
      nextCheckpoint++;
    }
    step++;
  }
  return { totalSteps: step, checkpointFroms };
}

/** Binary-searches `checkpointFroms` (as produced by `resolveCheckpointFroms`, sorted by
 *  ascending `step`) for the entry with the greatest `step <= targetStep`, or `null` if none
 *  precedes it. Step-keyed, not arena-node-indexed — matches what `applyRecursiveBacktracker`
 *  callers need, since `from`/`targetStep` are indices into the flat mutating-event sequence. */
export function nearestCheckpointFromAtOrBefore(checkpointFroms: ApplyFrom[], targetStep: number): ApplyFrom | null {
  let lo = 0;
  let hi = checkpointFroms.length - 1;
  let result: ApplyFrom | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (checkpointFroms[mid].step <= targetStep) {
      result = checkpointFroms[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}
