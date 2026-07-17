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

/** Multi-source tag namespacing (GitHub issue #169) — mirrors `SOURCE_SHIFT`/`SOURCE_MASK`/
 *  `LOCAL_TAG_MASK` in `maze-core/src/event_log/mod.rs`. Every merged tape's event tags are
 *  `(source_index << SOURCE_SHIFT) | local_tag`; `TAG_SCOPE` (0) is never namespaced. `nodeAt`
 *  (below) is the single place this unpacking happens — every decoder in this module keeps
 *  reading `record.tag` as a plain local wire tag, unaware of merging. */
export const SOURCE_SHIFT = 8;
export const SOURCE_MASK = 0xff00;
export const LOCAL_TAG_MASK = 0x00ff;

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

/** Kruskal event wire tags — mirrors `wire_tags` in `maze-core/src/generation/kruskal.rs`
 *  (GitHub issue #146). Independent numbering from `RB_TAG` — a tag is only meaningful together
 *  with the tape's `EventedEventKind` (see `DebugArenaHandle.algorithmKind` in `storeTypes.ts`),
 *  which selects which decoder a caller must use. */
export const KRUSKAL_TAG = {
  EDGES_SHUFFLED: 1,
  ROOTS_COMPARED: 2,
  EDGE_REJECTED: 3,
  EDGE_ADDED: 4,
  SETS_MERGED: 5,
  PRESET_UNIONS_APPLIED: 6,
  EDGE_SELECTED: 7,
} as const;

/** Wilson event wire tags — mirrors `wire_tags` in `maze-core/src/generation/wilson.rs`
 *  (GitHub issue #145). Independent numbering from `RB_TAG`/`KRUSKAL_TAG`, same as those two. */
export const WILSON_TAG = {
  WALK_START_PICKED: 1,
  STEP_TAKEN: 2,
  LOOP_ERASED: 3,
  WALK_DEAD_END: 4,
  EDGE_ADDED: 5,
  NODE_VISITED: 6,
  START_VISITED: 7,
} as const;

/** `CustomEdgeBased` event wire tags — mirrors `wire_tags` in
 *  `maze-core/src/generation/edge_based.rs` (GitHub issue #144). Independent numbering from
 *  `RB_TAG`/`KRUSKAL_TAG`/`WILSON_TAG`, same as those three. */
export const EDGE_BASED_TAG = {
  CORRIDOR_ROLL_SKIPPED: 1,
  CORRIDOR_ROLLED: 2,
  CORRIDOR_DEAD_NO_UNSEEN: 3,
  SRC_CHOSEN_BY_DEPTH_FIRST: 4,
  TELEPORT_ROLLED: 5,
  TELEPORT_ALREADY_ROLLED: 6,
  CYCLIC_ROLLED: 7,
  CANDIDATE_POOL_BUILT: 8,
  SRC_EXHAUSTED_EMPTY_POOL: 9,
  CYCLIC_CANDIDATES_COMPUTED: 10,
  CYCLIC_EDGE_ADDED: 11,
  CYCLIC_EDGE_REJECTED: 12,
  DST_WEIGHTS_COMPUTED: 13,
  DST_CHOSEN: 14,
  EDGE_ADDED: 15,
  EDGE_REJECTED: 16,
  PRESET_SKIPPED: 17,
  NODE_ACTIVATED: 18,
  SRC_EXHAUSTED: 19,
} as const;

/** `CustomVertexBased` event wire tags — mirrors `wire_tags` in
 *  `maze-core/src/generation/vertex_based.rs` (GitHub issue #143). Independent numbering from
 *  `RB_TAG`/`KRUSKAL_TAG`/`WILSON_TAG`/`EDGE_BASED_TAG`, same as those four. */
export const VERTEX_BASED_TAG = {
  TELEPORT_BRIDGE_ROLLED: 1,
  TELEPORT_BRIDGE_ADDED: 2,
  RESERVE_CANDIDATE_REJECTED: 3,
  RESERVE_CANDIDATE_CHOSEN: 4,
  RESERVE_EXHAUSTED: 5,
  BRIDGE_ADDED: 6,
  SRC_CHOSEN_FROM_FRONTIER: 7,
  TELEPORT_ROLLED: 8,
  CYCLIC_ROLLED: 9,
  CYCLIC_CANDIDATES_COMPUTED: 10,
  CYCLIC_EDGE_ADDED: 11,
  CORRIDOR_ROLLED: 12,
  CANDIDATE_CHOSEN: 13,
  JUNCTION_SLOT_ROLLED: 14,
  JUNCTION_CANDIDATES_CHOSEN: 15,
  EDGE_ADDED: 16,
  PRESET_NEIGHBOR_VISITED: 17,
  TELEPORT_CONNECT_ADDED: 18,
  NODE_VISITED: 19,
  NODE_QUEUED_TO_RESERVE: 20,
  START_VISITED: 21,
  JUNCTION_ROLL_SETUP: 22,
  SINGLE_CANDIDATE_SKIPS_DIRECTIONALITY: 23,
  NO_PARENT_SKIPS_DIRECTIONALITY: 24,
  DIRECTIONALITY_ROLLED: 25,
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
  /** Already unmasked to the source's own local wire tag (GitHub issue #169) — `TAG_SCOPE` for a
   *  scope node, otherwise the value `EncodeEventPayload::type_id()` originally produced, with
   *  any merge-added source-index prefix stripped. See `sourceIndex` for which source it's from. */
  tag: number;
  /** Positional index (0, 1, 2, ...) of the top-level source scope this node's tag was
   *  namespaced under during merging — meaningless outside this one parsed tape, never a stable
   *  cross-tape identifier (GitHub issue #169). `0` for a scope node, same as any source-0 event
   *  numerically (`0 << SOURCE_SHIFT === 0`) — callers needing to know a *scope* node's own
   *  source should use `topLevelSourceScopes` (below) rather than reading this field off a scope. */
  sourceIndex: number;
  payloadOffset: number;
  payloadLen: number;
}

function sentinelToNull(v: number): number | null {
  return v === NO_NODE ? null : v;
}

export interface MutatingEventAt<E> {
  event: E;
  /** Arena node-table index this event was decoded from — lets a caller resume a later scan
   *  right after this node (e.g. `applyRecursiveBacktracker`'s bounded resume). */
  nodeIndex: number;
}

/** Flat layer forward scan, generic over one algorithm's `decode`/`isMutating` pair: scans the
 *  node table from `startIndex`, skips `TAG_SCOPE` nodes, decodes each event's payload, keeps
 *  only mutating ones, stops once `limit` have been collected — the loop body every
 *  `mutatingXEventsWithIndex` function in this module shares, extracted per GitHub issue #168.
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

/** Reads and decodes one fixed-stride node record by index — used by both the flat and tree
 *  layers described in this module's doc comment. Unpacks the merge's source-index tag prefix
 *  (GitHub issue #169) here, once — `tag`/`sourceIndex` come back already split, so every
 *  decoder elsewhere in this module reads a plain local wire tag exactly like before merging
 *  existed, unaware `nodeAt` did any unpacking at all. `TAG_SCOPE` is never namespaced, so a
 *  scope node's raw tag and unpacked tag are always both `0`. */
export function nodeAt(tape: ParsedTape, index: number): NodeRecord {
  const base = index * NODE_RECORD_SIZE;
  const dv = tape.nodeTableView;
  const rawTag = dv.getUint16(base + 12, true);
  const tag = rawTag === TAG_SCOPE ? TAG_SCOPE : rawTag & LOCAL_TAG_MASK;
  const sourceIndex = rawTag === TAG_SCOPE ? 0 : (rawTag & SOURCE_MASK) >> SOURCE_SHIFT;
  return {
    parent: sentinelToNull(dv.getUint32(base + 0, true)),
    firstChild: sentinelToNull(dv.getUint32(base + 4, true)),
    nextSibling: sentinelToNull(dv.getUint32(base + 8, true)),
    tag,
    sourceIndex,
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

/** One top-level source scope in a merged tape's tree (GitHub issue #169) — the label + the
 *  arena index of that scope node itself (its own children are the source's original tree,
 *  starting one level deeper than before merging existed). */
export interface TopLevelSourceScope {
  scopeName: string;
  nodeIndex: number;
}

/** Walks the merged root's direct children (GitHub issue #169) — every tape produced since the
 *  merge exists has exactly this shape: node 0 is the merged root, and each of its children is
 *  one source's dedicated top-level scope, in the same order `sourceScopeNames`/
 *  `sourceEventKinds` (`mazeService.ts`) list them. A navigation/inspection helper — this module
 *  itself still dispatches to exactly one adapter today (see `algorithmRegistry.ts`'s doc
 *  comment); aggregating narration/apply across more than one source scope at once is out of
 *  scope until a real second source (#147) exists. */
/** Resolves a top-level source's own content-scan start index (GitHub issue #147). A real merged
 *  tape's `TopLevelSourceScope.nodeIndex` points at the scope *wrapper* node itself (a `TAG_SCOPE`
 *  node whose payload is just the scope's name) — every wrapper is laid out contiguously right
 *  after the merged root, *before* any source's actual content (`merge_tapes`, `maze-core/src/
 *  event_log/mod.rs`), so the wrapper's own `firstChild` is where that source's real events begin,
 *  a different (and for every source after the first, much later) arena index. Passing
 *  `nodeIndex` itself as a flat-scan bound previously let one source's decoder run over a
 *  different source's bytes (e.g. QC's scan started right after QC's own wrapper node, landing
 *  inside generation's content instead).
 *
 *  Some hand-built test fixtures use a legacy flat (pre-#169, unwrapped) tape shape where
 *  `nodeIndex` already points directly at the first real event, not a scope wrapper — this
 *  function stays a no-op for those (`tag !== TAG_SCOPE`), so both shapes work through the same
 *  call sites. */
export function sourceContentStart(tape: ParsedTape, nodeIndex: number): number {
  const record = nodeAt(tape, nodeIndex);
  if (record.tag !== TAG_SCOPE) return nodeIndex;
  return record.firstChild ?? tape.nodeCount;
}

export function topLevelSourceScopes(tape: ParsedTape): TopLevelSourceScope[] {
  const root = nodeAt(tape, 0);
  const result: TopLevelSourceScope[] = [];
  let next = root.firstChild;
  while (next !== null) {
    const record = nodeAt(tape, next);
    const bytes = tape.payload.subarray(record.payloadOffset, record.payloadOffset + record.payloadLen);
    result.push({ scopeName: textDecoder.decode(bytes), nodeIndex: next });
    next = record.nextSibling;
  }
  return result;
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

// --- Kruskal event decoding (GitHub issue #146) ---

export type KruskalEvent =
  | { kind: "EdgesShuffled"; edges: [bigint, bigint][] }
  | { kind: "EdgeSelected"; from: bigint; to: bigint }
  | { kind: "RootsCompared"; from: bigint; to: bigint; rootOfFrom: bigint; rootOfTo: bigint }
  | { kind: "EdgeRejected" }
  | { kind: "EdgeAdded"; from: bigint; to: bigint; bidirectional: boolean }
  | { kind: "SetsMerged"; rootA: bigint; rootB: bigint }
  | { kind: "PresetUnionsApplied"; pairs: [bigint, bigint][] };

/** The merged set's new root after a `SetsMerged` event — mirrors
 *  `KruskalEvent::merged_root` in `maze-core/src/generation/kruskal.rs`. A function, not a field
 *  on the event (the wire payload doesn't carry it — see that Rust method's doc comment), so both
 *  sides derive it identically from the same two pre-merge roots. */
export function kruskalMergedRoot(rootA: bigint, rootB: bigint): bigint {
  return rootA < rootB ? rootA : rootB;
}

/** Decodes one Kruskal event's binary payload. Contract: only called with `tag >= 1` (a real
 *  Kruskal wire tag) — callers filter out `TAG_SCOPE` before invoking this. Throws on an
 *  unrecognized tag or a `payload_len` that doesn't match the wire format — mirrors
 *  `decodeRecursiveBacktrackerEvent`'s error-on-mismatch contract (a malformed tape means a
 *  core/web build mismatch, which must surface immediately). */
export function decodeKruskalEvent(tag: number, bytes: Uint8Array): KruskalEvent {
  switch (tag) {
    case KRUSKAL_TAG.EDGE_SELECTED:
      expectLen(tag, bytes, 16);
      return { kind: "EdgeSelected", from: readNodeId(bytes, 0), to: readNodeId(bytes, 8) };
    case KRUSKAL_TAG.ROOTS_COMPARED:
      expectLen(tag, bytes, 32);
      return {
        kind: "RootsCompared",
        from: readNodeId(bytes, 0), to: readNodeId(bytes, 8),
        rootOfFrom: readNodeId(bytes, 16), rootOfTo: readNodeId(bytes, 24),
      };
    case KRUSKAL_TAG.SETS_MERGED:
      expectLen(tag, bytes, 16);
      return { kind: "SetsMerged", rootA: readNodeId(bytes, 0), rootB: readNodeId(bytes, 8) };
    case KRUSKAL_TAG.EDGE_REJECTED:
      expectLen(tag, bytes, 0);
      return { kind: "EdgeRejected" };
    case KRUSKAL_TAG.EDGE_ADDED:
      expectLen(tag, bytes, 17);
      return { kind: "EdgeAdded", from: readNodeId(bytes, 0), to: readNodeId(bytes, 8), bidirectional: bytes[16] !== 0 };
    case KRUSKAL_TAG.EDGES_SHUFFLED: {
      if (bytes.byteLength < 4) {
        throw new Error(`KruskalEvent: EdgesShuffled payload too short (${bytes.byteLength} bytes, need at least 4)`);
      }
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const count = dv.getUint32(0, true);
      const expected = 4 + count * 16;
      if (bytes.byteLength !== expected) {
        throw new Error(`KruskalEvent: EdgesShuffled payload_len ${bytes.byteLength} does not match 4 + count*16 (count=${count}, expected ${expected})`);
      }
      const edges: [bigint, bigint][] = [];
      for (let i = 0; i < count; i++) {
        edges.push([readNodeId(bytes, 4 + i * 16), readNodeId(bytes, 4 + i * 16 + 8)]);
      }
      return { kind: "EdgesShuffled", edges };
    }
    case KRUSKAL_TAG.PRESET_UNIONS_APPLIED: {
      if (bytes.byteLength < 4) {
        throw new Error(`KruskalEvent: PresetUnionsApplied payload too short (${bytes.byteLength} bytes, need at least 4)`);
      }
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const count = dv.getUint32(0, true);
      const expected = 4 + count * 16;
      if (bytes.byteLength !== expected) {
        throw new Error(`KruskalEvent: PresetUnionsApplied payload_len ${bytes.byteLength} does not match 4 + count*16 (count=${count}, expected ${expected})`);
      }
      const pairs: [bigint, bigint][] = [];
      for (let i = 0; i < count; i++) {
        pairs.push([readNodeId(bytes, 4 + i * 16), readNodeId(bytes, 4 + i * 16 + 8)]);
      }
      return { kind: "PresetUnionsApplied", pairs };
    }
    default:
      throw new Error(`KruskalEvent: unknown wire tag ${tag}`);
  }
}

/** Mirrors `DebugEvent::is_mutating`'s split for `KruskalEvent` in
 *  `maze-core/src/generation/kruskal.rs`. */
export function isMutatingKruskalEvent(event: KruskalEvent): boolean {
  return event.kind === "EdgeAdded" || event.kind === "SetsMerged";
}

export interface MutatingKruskalEventAt {
  event: KruskalEvent;
  /** Arena node-table index this event was decoded from — mirrors `MutatingRbEventAt.nodeIndex`. */
  nodeIndex: number;
}

/** Flat layer for Kruskal: forward scan over the node table, skipping scope nodes, decoding
 *  events, filtering to mutating ones only — mirrors `mutatingRbEventsWithIndex`. Kruskal
 *  produces no checkpoints (GitHub issue #146's scope), so unlike its RB counterpart this has no
 *  bounded-resume use case yet, but keeps the same `startIndex`/`limit` shape for consistency and
 *  so `applyKruskal` can reuse the same "keep collecting until limit" loop structure. */
export function mutatingKruskalEventsWithIndex(tape: ParsedTape, limit?: number, startIndex = 0, endIndex?: number): MutatingKruskalEventAt[] {
  return mutatingEventsWithIndex(tape, decodeKruskalEvent, isMutatingKruskalEvent, limit, startIndex, endIndex);
}

/** Convenience wrapper over `mutatingKruskalEventsWithIndex` for callers that only need the
 *  decoded events, not their arena indices — mirrors `mutatingRbEvents`. */
export function mutatingKruskalEvents(tape: ParsedTape, limit?: number, startIndex = 0, endIndex?: number): KruskalEvent[] {
  return mutatingKruskalEventsWithIndex(tape, limit, startIndex, endIndex).map((e) => e.event);
}

/** Minimal union-find over `bigint` ids (path compression + union by min), used only to
 *  reconstruct Kruskal's DSU groups for the debug replay (GitHub issue #146's DSU-groups
 *  extension) — not the same type as `maze-core`'s `Dsu` (that one operates on dense `usize`
 *  indices; this one operates directly on `NodeId`s, since the web side never builds the
 *  dense-index mapping the core algorithm uses internally). Roots are chosen by `union`'s own
 *  `min(a, b)` rule, mirroring `Dsu::union_by_min` — this must stay in sync with the core's
 *  `union_by_min` calls (`kruskal.rs`) for a replayed root to equal the value `RootsCompared`/
 *  `SetsMerged` events actually carried. */
class KruskalDsu {
  private parent = new Map<bigint, bigint>();

  private ensure(id: bigint): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: bigint): bigint {
    this.ensure(id);
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // Path compression: point every visited node directly at the root.
    let cur = id;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: bigint, b: bigint): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (ra < rb) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }

  /** Every id this DSU has ever seen (via `find`/`union`), each mapped to its current root. */
  groups(): Map<bigint, bigint> {
    const result = new Map<bigint, bigint>();
    for (const id of this.parent.keys()) result.set(id, this.find(id));
    return result;
  }

  /** Restores state from a previously-flattened `groups()` snapshot (GitHub issue #128's generic
   *  resume) — since `groups()` always returns fully path-compressed `id -> root` pairs, seeding
   *  `parent` directly from them (root entries point at themselves) reproduces the exact same
   *  flattened structure `find`/`union` would see, without replaying every original `union` call. */
  seed(id: bigint, root: bigint): void {
    this.parent.set(id, root);
  }
}

/** Locates the single `PresetUnionsApplied` event, if any — emitted once, directly under the
 *  root scope, before any `"edge N"` scope (see `kruskal.rs`'s `generate`). Absent when the run
 *  had no preset connections (`kruskal.rs` skips emitting it entirely rather than emitting an
 *  empty pairs list — see `KruskalEvent::PresetUnionsApplied`'s doc comment). A plain linear scan
 *  from the start, bounded by the position of the first scope node (so it never walks into
 *  per-edge event data), since this event is trace-only and not part of `mutatingKruskalEventsWithIndex`'s scan. */
function findPresetUnions(tape: ParsedTape): [bigint, bigint][] {
  for (let i = 0; i < tape.nodeCount; i++) {
    const record = nodeAt(tape, i);
    if (record.tag === TAG_SCOPE) {
      // Reached the first "edge N" scope — PresetUnionsApplied (if any) always precedes it.
      if (i > 0) break;
      continue;
    }
    const bytes = tape.payload.subarray(record.payloadOffset, record.payloadOffset + record.payloadLen);
    const event = decodeKruskalEvent(record.tag, bytes);
    if (event.kind === "PresetUnionsApplied") return event.pairs;
  }
  return [];
}

export interface KruskalApplyResult {
  edges: Edge[];
  /** Every node id seen so far (via `EdgeAdded`'s endpoints, `PresetUnionsApplied`'s pairs, or a
   *  `SetsMerged` root), mapped to its current DSU root at `step` — GitHub issue #146's DSU-groups
   *  extension. Two ids sharing the same value here are in the same connected component of the
   *  spanning tree Kruskal has built so far. Rebuilt from scratch on every call (see `applyKruskal`'s
   *  doc comment on why there's no `from`-based resume). */
  dsuGroups: Map<bigint, bigint>;
  step: number;
  nodeIndex: number;
}

/** Replays Kruskal `EdgeAdded`/`SetsMerged` events up to and including `targetStep` (the index,
 *  within the flat mutating-event sequence from `mutatingKruskalEvents`, of the last event to
 *  apply) — Kruskal's counterpart to `applyRecursiveBacktracker`, simplified: Kruskal declares no
 *  debug values (GitHub issue #131 is RB-only) and produces no checkpoints (#128 is RB-only), so
 *  there is no `debugValues` output and no `from`-based resume — every call replays from the
 *  tape's start. Always O(targetStep) rather than O(1) after a checkpoint, which is acceptable:
 *  Kruskal runs are dominated by their edge count (bounded by field size), not by the tens-of-
 *  thousands-of-events scale checkpointing was built for.
 *
 *  A bidirectional `EdgeAdded` contributes both `{from, to}` and `{to, from}` to `edges` — mirrors
 *  `applyRecursiveBacktracker`'s handling of the same field. `dsuGroups` starts from
 *  `PresetUnionsApplied`'s pairs (if any — see `findPresetUnions`), then folds in every `SetsMerged`
 *  up to `targetStep` via `KruskalDsu.union(rootA, rootB)`, mirroring the core's own
 *  `union_by_min` — so a replayed root always equals what the core actually computed. */
export function applyKruskal(tape: ParsedTape, targetStep: number, from?: KruskalApplyResult, startIndex = 0, endIndex?: number): KruskalApplyResult {
  validateStepShape("targetStep", targetStep);
  if (from) {
    validateStepShape("from.step", from.step);
    validateStepShape("from.nodeIndex", from.nodeIndex);
    if (from.step > targetStep) {
      throw new Error(`applyKruskal: from.step ${from.step} is ahead of targetStep ${targetStep}`);
    }
    if (from.step === targetStep) {
      return { edges: [...from.edges], dsuGroups: new Map(from.dsuGroups), step: targetStep, nodeIndex: from.nodeIndex };
    }
  }

  const scanStart = from ? from.nodeIndex + 1 : startIndex;
  const needed = targetStep - (from?.step ?? -1);
  const events = mutatingKruskalEventsWithIndex(tape, needed, scanStart, endIndex);
  if (events.length < needed) {
    const total = (from?.step ?? -1) + 1 + events.length;
    throw new Error(`targetStep ${targetStep} out of range [0, ${total})`);
  }

  const dsu = new KruskalDsu();
  if (from) {
    for (const [id, root] of from.dsuGroups) dsu.seed(id, root);
  } else {
    for (const [a, b] of findPresetUnions(tape)) dsu.union(a, b);
  }

  const edges = from ? [...from.edges] : [];
  for (const { event } of events) {
    if (event.kind === "EdgeAdded") {
      edges.push({ from: event.from, to: event.to });
      if (event.bidirectional) {
        edges.push({ from: event.to, to: event.from });
      }
      dsu.find(event.from);
      dsu.find(event.to);
    } else if (event.kind === "SetsMerged") {
      dsu.union(event.rootA, event.rootB);
    }
  }

  return { edges, dsuGroups: dsu.groups(), step: targetStep, nodeIndex: events[events.length - 1].nodeIndex };
}

// --- Wilson event decoding (GitHub issue #145) ---

export type WilsonEvent =
  | { kind: "StartVisited"; id: bigint }
  | { kind: "WalkStartPicked"; id: bigint }
  | { kind: "StepTaken"; from: bigint; to: bigint }
  | { kind: "LoopErased"; node: bigint }
  | { kind: "WalkDeadEnd" }
  | { kind: "EdgeAdded"; from: bigint; to: bigint; bidirectional: boolean }
  | { kind: "NodeVisited"; id: bigint };

/** Decodes one Wilson event's binary payload. Contract: only called with `tag >= 1` (a real
 *  Wilson wire tag) — callers filter out `TAG_SCOPE` before invoking this. Throws on an
 *  unrecognized tag or a `payload_len` that doesn't match the wire format — mirrors
 *  `decodeRecursiveBacktrackerEvent`/`decodeKruskalEvent`'s error-on-mismatch contract (a
 *  malformed tape means a core/web build mismatch, which must surface immediately). */
export function decodeWilsonEvent(tag: number, bytes: Uint8Array): WilsonEvent {
  switch (tag) {
    case WILSON_TAG.START_VISITED:
      expectLen(tag, bytes, 8);
      return { kind: "StartVisited", id: readNodeId(bytes, 0) };
    case WILSON_TAG.WALK_START_PICKED:
      expectLen(tag, bytes, 8);
      return { kind: "WalkStartPicked", id: readNodeId(bytes, 0) };
    case WILSON_TAG.STEP_TAKEN:
      expectLen(tag, bytes, 16);
      return { kind: "StepTaken", from: readNodeId(bytes, 0), to: readNodeId(bytes, 8) };
    case WILSON_TAG.LOOP_ERASED:
      expectLen(tag, bytes, 8);
      return { kind: "LoopErased", node: readNodeId(bytes, 0) };
    case WILSON_TAG.WALK_DEAD_END:
      expectLen(tag, bytes, 0);
      return { kind: "WalkDeadEnd" };
    case WILSON_TAG.EDGE_ADDED:
      expectLen(tag, bytes, 17);
      return { kind: "EdgeAdded", from: readNodeId(bytes, 0), to: readNodeId(bytes, 8), bidirectional: bytes[16] !== 0 };
    case WILSON_TAG.NODE_VISITED:
      expectLen(tag, bytes, 8);
      return { kind: "NodeVisited", id: readNodeId(bytes, 0) };
    default:
      throw new Error(`WilsonEvent: unknown wire tag ${tag}`);
  }
}

/** Mirrors `DebugEvent::is_mutating`'s split for `WilsonEvent` in
 *  `maze-core/src/generation/wilson.rs` — `WalkStartPicked`/`StepTaken`/`LoopErased` are mutating
 *  alongside `EdgeAdded`/`NodeVisited` because they change the walk's `next` map (the state
 *  `applyWilson`'s `"current_walk"` map debug value reconstructs below), not because they touch
 *  the graph. */
export function isMutatingWilsonEvent(event: WilsonEvent): boolean {
  return (
    event.kind === "StartVisited" ||
    event.kind === "WalkStartPicked" ||
    event.kind === "StepTaken" ||
    event.kind === "LoopErased" ||
    event.kind === "EdgeAdded" ||
    event.kind === "NodeVisited"
  );
}

export interface MutatingWilsonEventAt {
  event: WilsonEvent;
  /** Arena node-table index this event was decoded from — mirrors `MutatingRbEventAt.nodeIndex`. */
  nodeIndex: number;
}

/** Flat layer for Wilson: forward scan over the node table, skipping scope nodes, decoding
 *  events, filtering to mutating ones only — mirrors `mutatingKruskalEventsWithIndex`. Wilson
 *  produces no checkpoints (GitHub issue #128 is RB-only), same as Kruskal, so this keeps the
 *  same `startIndex`/`limit` shape purely for consistency, not because `applyWilson` resumes. */
export function mutatingWilsonEventsWithIndex(tape: ParsedTape, limit?: number, startIndex = 0, endIndex?: number): MutatingWilsonEventAt[] {
  return mutatingEventsWithIndex(tape, decodeWilsonEvent, isMutatingWilsonEvent, limit, startIndex, endIndex);
}

/** Convenience wrapper over `mutatingWilsonEventsWithIndex` for callers that only need the
 *  decoded events, not their arena indices — mirrors `mutatingKruskalEvents`. */
export function mutatingWilsonEvents(tape: ParsedTape, limit?: number, startIndex = 0, endIndex?: number): WilsonEvent[] {
  return mutatingWilsonEventsWithIndex(tape, limit, startIndex, endIndex).map((e) => e.event);
}

// `applyWilson` lives further down, after the Debug values section — it needs `VISITED` and
// `DebugValues`, declared there.

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
 *  `maze-core/src/event_log/mod.rs`. Affects rendering:
 *  - `"region"` — unordered set, no relationship between members (e.g. `"visited"`), rendered as
 *    independent per-node highlights. Reported via `insert`/`remove` on a single id.
 *  - `"sequence"` — ordered list where adjacent members are connected (e.g. `"recursion_stack"`,
 *    the DFS stack in push order), rendered as a chain of arrows between consecutive ids.
 *    Reported the same way as `"region"` (`insert`/`remove` on a single id) — only the rendering
 *    differs.
 *  - `"map"` — key-to-value pairs with overwrite-by-key semantics (e.g. Wilson's
 *    `"current_walk"`, GitHub issue #145's follow-up), rendered as an independent arrow from each
 *    key to its value. Reported via `set`/`clear` (see `DebugMapOp`), not `insert`/`remove` —
 *    `insert`/`remove` on a single id can't express "setting a key that already has a value
 *    replaces it".
 *  - `"vertex"` — a single, reassignable node id, not a `"region"` with one member (e.g. Wilson's
 *    `"walk_start"`/`"walk_head"`, GitHub issue #145's follow-up) — the slot is *replaced*
 *    wholesale rather than accumulating insert/remove entries. Reported via `set`/`clear` (see
 *    `DebugVertexOp`), same shape as `"map"` minus the value half of the pair. */
export type DebugValueKind = "region" | "sequence" | "map" | "vertex";

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
export function mutatingRbEventsWithIndex(tape: ParsedTape, limit?: number, startIndex = 0, endIndex?: number): MutatingRbEventAt[] {
  return mutatingEventsWithIndex(tape, decodeRecursiveBacktrackerEvent, isMutatingRbEvent, limit, startIndex, endIndex);
}

/** Convenience wrapper over `mutatingRbEventsWithIndex` for callers that only need the decoded
 *  events, not their arena indices — e.g. tests asserting the plain event sequence. The returned
 *  array's index is the `step` used by `applyRecursiveBacktracker`/`targetStep`. */
export function mutatingRbEvents(tape: ParsedTape, limit?: number, startIndex = 0, endIndex?: number): RecursiveBacktrackerEvent[] {
  return mutatingRbEventsWithIndex(tape, limit, startIndex, endIndex).map((e) => e.event);
}

// --- Apply ---

export interface Edge {
  from: bigint;
  to: bigint;
  /** Whether this edge is a `Teleport` connection rather than a `Basic` one — optional and unset
   *  for RB/Kruskal/Wilson (none of those algorithms produce teleport edges); set by
   *  `applyEdgeBased` from `EdgeAdded`/`CyclicEdgeAdded.teleport` (GitHub issue #144's
   *  teleport-rendering fix — `selectDebugMazeView` used to hardcode every reconstructed edge's
   *  `EdgeDto.kind` to `"basic"`, so a `CustomEdgeBased` teleport edge rendered as a plain
   *  passage in debug mode even though the underlying graph edge was `EdgeKind::Teleport`). */
  kind?: "basic" | "teleport";
}

/** Named debug-value id lists (GitHub issue #131), keyed by name — e.g.
 *  `debugValues.get("recursion_stack")`. `bigint[]`, not `Set<bigint>` — order matters for
 *  `DebugValueKind.Sequence` values (e.g. `"recursion_stack"`, rendered as a chain of arrows
 *  between consecutive ids in insertion order); `Region` values are unordered by nature but a
 *  duplicate-free array is still a valid representation. Never mutated in place by
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

/** Clones a `DebugMaps` map two levels deep (fresh outer `Map`, fresh inner `Map` per name) —
 *  same never-mutate-the-caller's-`from` discipline as `cloneDebugValues`. */
function cloneDebugMaps(maps: DebugMaps): DebugMaps {
  const result: DebugMaps = new Map();
  for (const [name, m] of maps) result.set(name, new Map(m));
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
  // `Set` mirror of each list, membership-only — makes `insert`'s dedup check O(1) instead of an
  // O(n) `Array.includes` scan. Without it, a monotonically-growing Region value (e.g. "visited",
  // one insert per node, never removed) makes this loop O(n²) over a run: every scrub/autoplay
  // tick re-scans a list approaching the full node count on every single insert (GitHub issue
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
// Snapshots are built entirely on the web side — the core has no notion of "snapshot" at all (it
// only ever produces the plain event tape). Algorithm-agnostic: `resolveDebugArenaMetadata` below
// knows nothing about `edges`/`debugValues`/`dsuGroups`/or any other concrete shape — it only
// knows "count mutating events" (`mutatingNodeIndices`, already generic across every adapter) and
// "snapshot the opaque result of `apply()` at this step" (`applySnapshot`, likewise generic). What
// a snapshot actually *contains* is entirely the calling adapter's own `TResult` — this module
// never inspects it.

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

/** Counts mutating events (`totalSteps`, via `countMutatingEvents` — a lightweight count with no
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

// --- Wilson apply (GitHub issue #145) ---
//
// Lives here, after `DebugValues`/`VISITED` (Debug values section) and `Edge` (Apply section)
// are declared, since `applyWilson` needs both.

/** Mirrors `WilsonEvent`'s `DebugValueDelta` impl (`"visited"`-only) in
 *  `maze-core/src/generation/wilson.rs`. */
function wilsonDebugValueDeltasFor(event: WilsonEvent): [string, DebugValueOp, bigint][] {
  return event.kind === "StartVisited" || event.kind === "NodeVisited" ? [[VISITED, "insert", event.id]] : [];
}

/** Set/clear operation on a named map debug value — mirrors `DebugMapOp` in
 *  `maze-core/src/event_log/mod.rs` (GitHub issue #145's follow-up). `"clear"` carries no
 *  key/value (mirrors the Rust enum's unit `Clear` variant not needing placeholder ids). */
export type DebugMapOp =
  | { op: "set"; key: bigint; value: bigint }
  | { op: "clear" };

export const CURRENT_WALK = "current_walk";

/** Mirrors `WilsonEvent`'s `DebugMapDelta` impl (`"current_walk"`) in
 *  `maze-core/src/generation/wilson.rs`: `StepTaken` sets `next[from] = to` (overwriting any
 *  prior value for `from`, exactly like `HashMap::insert`); `WalkStartPicked` clears the map so a
 *  new walk starts with an empty track; `LoopErased` needs no delta of its own (the preceding
 *  `StepTaken` already performed the overwrite). */
function wilsonDebugMapDeltasFor(event: WilsonEvent): [string, DebugMapOp][] {
  if (event.kind === "WalkStartPicked") return [[CURRENT_WALK, { op: "clear" }]];
  if (event.kind === "StepTaken") return [[CURRENT_WALK, { op: "set", key: event.from, value: event.to }]];
  return [];
}

/** Named map debug-value state (GitHub issue #145's follow-up), keyed by name — e.g.
 *  `debugMaps.get("current_walk")`. Mirrors `DebugValues`' role for `Insert`/`Remove`-based debug
 *  values, but for `Set`/`Clear`-based ones. Never mutated in place; a fresh `Map` is built
 *  whenever a delta is folded in, mirroring `debugValues`'/`edges`' own copy-on-write discipline. */
export type DebugMaps = Map<string, Map<bigint, bigint>>;

/** Set/clear operation on a named vertex debug value — mirrors `DebugVertexOp` in
 *  `maze-core/src/event_log/mod.rs` (GitHub issue #145's follow-up). `"clear"` carries no id
 *  (mirrors the Rust enum's unit `Clear` variant). */
export type DebugVertexOp =
  | { op: "set"; id: bigint }
  | { op: "clear" };

export const WALK_START = "walk_start";
export const WALK_HEAD = "walk_head";

/** Mirrors `WilsonEvent`'s `DebugVertexDelta` impl (`"walk_start"`/`"walk_head"`) in
 *  `maze-core/src/generation/wilson.rs`: `WalkStartPicked` sets both slots to the walk's origin
 *  (the head starts out equal to the start, before any step); each `StepTaken` then moves only
 *  `walk_head` to `to`. Deliberately *not* derived from `current_walk`'s `Map` state (e.g. "last
 *  key in insertion order") — a `HashMap::insert`-style overwrite of an existing key (which loop
 *  erasure causes) doesn't move that key's position, so "last key" can silently stop tracking the
 *  walk's actual current position once a walk revisits a node. */
function wilsonDebugVertexDeltasFor(event: WilsonEvent): [string, DebugVertexOp][] {
  if (event.kind === "WalkStartPicked") {
    return [[WALK_START, { op: "set", id: event.id }], [WALK_HEAD, { op: "set", id: event.id }]];
  }
  if (event.kind === "StepTaken") return [[WALK_HEAD, { op: "set", id: event.to }]];
  return [];
}

/** Named vertex debug-value state (GitHub issue #145's follow-up), keyed by name — e.g.
 *  `debugVertices.get("walk_head")`. Each entry is at most one id (or absent, if never set /
 *  cleared) — mirrors `DebugMaps`' role but for a single reassignable slot instead of a map. */
export type DebugVertices = Map<string, bigint | null>;

export interface WilsonApplyResult {
  edges: Edge[];
  /** `"visited"` only (GitHub issue #131) — mirrors `debugValues` on `ApplyResult`/`applyRecursiveBacktracker`. */
  debugValues: DebugValues;
  /** `"current_walk"` only (GitHub issue #145's follow-up) — the walk's `next` map (`from` node ->
   *  `to` node) at `step`, reset empty at every `WalkStartPicked`. See `wilsonDebugMapDeltasFor`'s
   *  doc comment for the exact replay rule. */
  debugMaps: DebugMaps;
  /** `"walk_start"`/`"walk_head"` (GitHub issue #145's follow-up) — see `wilsonDebugVertexDeltasFor`'s
   *  doc comment for the exact replay rule. */
  debugVertices: DebugVertices;
  step: number;
  nodeIndex: number;
}

/** Replays Wilson events up to and including `targetStep` (the index, within the flat
 *  mutating-event sequence from `mutatingWilsonEvents`, of the last event to apply) — Wilson's
 *  counterpart to `applyKruskal`: no checkpoints (GitHub issue #128 is RB-only), so every call
 *  replays from the tape's start, same as `applyKruskal`. Unlike `applyKruskal`, Wilson declares
 *  one `Insert`/`Remove`-based debug value (`"visited"`), one `Set`/`Clear`-based map
 *  (`"current_walk"`), and two `Set`/`Clear`-based vertices (`"walk_start"`/`"walk_head"`).
 *
 *  A bidirectional `EdgeAdded` contributes both `{from, to}` and `{to, from}` to `edges` — mirrors
 *  `applyRecursiveBacktracker`/`applyKruskal`'s handling of the same field. */
export function applyWilson(tape: ParsedTape, targetStep: number, from?: WilsonApplyResult, startIndex = 0, endIndex?: number): WilsonApplyResult {
  validateStepShape("targetStep", targetStep);
  if (from) {
    validateStepShape("from.step", from.step);
    validateStepShape("from.nodeIndex", from.nodeIndex);
    if (from.step > targetStep) {
      throw new Error(`applyWilson: from.step ${from.step} is ahead of targetStep ${targetStep}`);
    }
    if (from.step === targetStep) {
      return {
        edges: [...from.edges],
        debugValues: cloneDebugValues(from.debugValues),
        debugMaps: cloneDebugMaps(from.debugMaps),
        debugVertices: new Map(from.debugVertices),
        step: targetStep,
        nodeIndex: from.nodeIndex,
      };
    }
  }

  const scanStart = from ? from.nodeIndex + 1 : startIndex;
  const needed = targetStep - (from?.step ?? -1);
  const events = mutatingWilsonEventsWithIndex(tape, needed, scanStart, endIndex);
  if (events.length < needed) {
    const total = (from?.step ?? -1) + 1 + events.length;
    throw new Error(`targetStep ${targetStep} out of range [0, ${total})`);
  }

  const edges = from ? [...from.edges] : [];
  const debugValues: DebugValues = from ? cloneDebugValues(from.debugValues) : new Map();
  // Presence tracked per debug-value name (mirrors applyEdgeBased's own discipline) — Wilson
  // declares only one Insert/Remove-based value ("visited") today, but a single shared Set would
  // silently misbehave the moment a second one is added, so this doesn't take the VISITED-only
  // shortcut a single Set would tempt.
  const presence = new Map<string, Set<bigint>>();
  for (const [name, ids] of debugValues) presence.set(name, new Set(ids));
  const debugMaps: DebugMaps = from ? cloneDebugMaps(from.debugMaps) : new Map();
  const debugVertices: DebugVertices = from ? new Map(from.debugVertices) : new Map();

  for (const { event } of events) {
    if (event.kind === "EdgeAdded") {
      edges.push({ from: event.from, to: event.to });
      if (event.bidirectional) {
        edges.push({ from: event.to, to: event.from });
      }
    }
    for (const [name, op, id] of wilsonDebugValueDeltasFor(event)) {
      let ids = debugValues.get(name);
      if (!ids) {
        ids = [];
        debugValues.set(name, ids);
      }
      let seen = presence.get(name);
      if (!seen) {
        seen = new Set();
        presence.set(name, seen);
      }
      if (op === "insert") {
        if (!seen.has(id)) { seen.add(id); ids.push(id); }
      } else if (seen.delete(id)) {
        const at = ids.indexOf(id);
        if (at !== -1) ids.splice(at, 1);
      }
    }
    for (const [name, mapOp] of wilsonDebugMapDeltasFor(event)) {
      if (mapOp.op === "clear") {
        debugMaps.set(name, new Map());
      } else {
        let map = debugMaps.get(name);
        if (!map) {
          map = new Map();
          debugMaps.set(name, map);
        }
        map.set(mapOp.key, mapOp.value);
      }
    }
    for (const [name, vertexOp] of wilsonDebugVertexDeltasFor(event)) {
      debugVertices.set(name, vertexOp.op === "clear" ? null : vertexOp.id);
    }
  }

  return { edges, debugValues, debugMaps, debugVertices, step: targetStep, nodeIndex: events[events.length - 1].nodeIndex };
}

// --- CustomEdgeBased event decoding (GitHub issue #144) ---

export type EdgeBasedEvent =
  | { kind: "CorridorRollSkipped" }
  | { kind: "CorridorRolled"; prev: bigint; roll: number; corridorLength: number; continued: boolean }
  | { kind: "CorridorDeadNoUnseen"; prev: bigint }
  | { kind: "SrcChosenByDepthFirst"; src: bigint; activeLen: number; position: number; depthFirst: number }
  | { kind: "TeleportRolled"; src: bigint; roll: number; teleportChance: number; fired: boolean }
  | { kind: "TeleportAlreadyRolled"; src: bigint }
  | { kind: "CyclicRolled"; src: bigint; roll: number; cyclicity: number; fired: boolean }
  | { kind: "CandidatePoolBuilt"; src: bigint; geometric: boolean; candidates: bigint[] }
  | { kind: "SrcExhaustedEmptyPool"; src: bigint }
  | { kind: "CyclicCandidatesComputed"; src: bigint; geometric: boolean; candidates: bigint[] }
  | { kind: "CyclicEdgeAdded"; src: bigint; dst: bigint; teleport: boolean; bidirectional: boolean }
  | { kind: "CyclicEdgeRejected"; src: bigint; dst: bigint; teleport: boolean }
  | { kind: "DstWeightsComputed"; candidates: bigint[]; weights: number[]; branching: number; directionality: number; directionalityEligible: boolean }
  | { kind: "DstChosen"; dst: bigint; roll: number; totalWeight: number }
  | { kind: "EdgeAdded"; src: bigint; dst: bigint; teleport: boolean; bidirectional: boolean }
  | { kind: "EdgeRejected"; src: bigint; dst: bigint; teleport: boolean }
  | { kind: "PresetSkipped"; src: bigint; dst: bigint }
  | { kind: "NodeActivated"; node: bigint; parent: bigint | null; treeDepth: number }
  | { kind: "SrcExhausted"; src: bigint };

function readF64(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(offset, true);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

/** Reads a `u32`-length-prefixed `NodeId[]` starting at `offset` — mirrors the
 *  `push_ids`/`Vec<NodeId>` wire format in `EdgeBasedEvent::encode_payload`. Returns the decoded
 *  ids and the byte offset immediately past the list, so a caller reading further fields after a
 *  variable-length list (e.g. `DstWeightsComputed`'s `weights` after `candidates`) knows where to
 *  continue. */
function readNodeIdList(bytes: Uint8Array, offset: number): { ids: bigint[]; next: number } {
  const count = readU32(bytes, offset);
  const ids: bigint[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(readNodeId(bytes, offset + 4 + i * 8));
  }
  return { ids, next: offset + 4 + count * 8 };
}

/** Reads a `u32`-length-prefixed `f64[]` starting at `offset` — mirrors `push_f64s`'s wire format
 *  in `EdgeBasedEvent::encode_payload`. */
function readF64List(bytes: Uint8Array, offset: number): { values: number[]; next: number } {
  const count = readU32(bytes, offset);
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    values.push(readF64(bytes, offset + 4 + i * 8));
  }
  return { values, next: offset + 4 + count * 8 };
}

/** Reads an `Option<NodeId>` — a 1-byte presence flag followed by 8 bytes (`0` when absent) —
 *  mirrors `NodeActivated.parent`'s wire format (the only `Option<NodeId>` field in this enum). */
function readOptionalNodeId(bytes: Uint8Array, offset: number): bigint | null {
  return bytes[offset] === 0 ? null : readNodeId(bytes, offset + 1);
}

/** Decodes one `CustomEdgeBased` event's binary payload. Contract: only called with `tag >= 1` —
 *  callers filter out `TAG_SCOPE` first. Throws on an unrecognized tag or a `payload_len`
 *  mismatch for fixed-size variants — same error-on-mismatch contract as
 *  `decodeRecursiveBacktrackerEvent`/`decodeKruskalEvent`/`decodeWilsonEvent`. */
export function decodeEdgeBasedEvent(tag: number, bytes: Uint8Array): EdgeBasedEvent {
  switch (tag) {
    case EDGE_BASED_TAG.CORRIDOR_ROLL_SKIPPED:
      expectLen(tag, bytes, 0);
      return { kind: "CorridorRollSkipped" };
    case EDGE_BASED_TAG.CORRIDOR_ROLLED:
      expectLen(tag, bytes, 25);
      return {
        kind: "CorridorRolled",
        prev: readNodeId(bytes, 0),
        roll: readF64(bytes, 8),
        corridorLength: readF64(bytes, 16),
        continued: bytes[24] !== 0,
      };
    case EDGE_BASED_TAG.CORRIDOR_DEAD_NO_UNSEEN:
      expectLen(tag, bytes, 8);
      return { kind: "CorridorDeadNoUnseen", prev: readNodeId(bytes, 0) };
    case EDGE_BASED_TAG.SRC_CHOSEN_BY_DEPTH_FIRST:
      expectLen(tag, bytes, 24);
      return {
        kind: "SrcChosenByDepthFirst",
        src: readNodeId(bytes, 0),
        activeLen: readU32(bytes, 8),
        position: readU32(bytes, 12),
        depthFirst: readF64(bytes, 16),
      };
    case EDGE_BASED_TAG.TELEPORT_ROLLED:
      expectLen(tag, bytes, 25);
      return {
        kind: "TeleportRolled",
        src: readNodeId(bytes, 0),
        roll: readF64(bytes, 8),
        teleportChance: readF64(bytes, 16),
        fired: bytes[24] !== 0,
      };
    case EDGE_BASED_TAG.TELEPORT_ALREADY_ROLLED:
      expectLen(tag, bytes, 8);
      return { kind: "TeleportAlreadyRolled", src: readNodeId(bytes, 0) };
    case EDGE_BASED_TAG.CYCLIC_ROLLED:
      expectLen(tag, bytes, 25);
      return {
        kind: "CyclicRolled",
        src: readNodeId(bytes, 0),
        roll: readF64(bytes, 8),
        cyclicity: readF64(bytes, 16),
        fired: bytes[24] !== 0,
      };
    case EDGE_BASED_TAG.CANDIDATE_POOL_BUILT: {
      const src = readNodeId(bytes, 0);
      const geometric = bytes[8] !== 0;
      const { ids: candidates } = readNodeIdList(bytes, 9);
      return { kind: "CandidatePoolBuilt", src, geometric, candidates };
    }
    case EDGE_BASED_TAG.SRC_EXHAUSTED_EMPTY_POOL:
      expectLen(tag, bytes, 8);
      return { kind: "SrcExhaustedEmptyPool", src: readNodeId(bytes, 0) };
    case EDGE_BASED_TAG.CYCLIC_CANDIDATES_COMPUTED: {
      const src = readNodeId(bytes, 0);
      const geometric = bytes[8] !== 0;
      const { ids: candidates } = readNodeIdList(bytes, 9);
      return { kind: "CyclicCandidatesComputed", src, geometric, candidates };
    }
    case EDGE_BASED_TAG.CYCLIC_EDGE_ADDED:
      expectLen(tag, bytes, 18);
      return {
        kind: "CyclicEdgeAdded", src: readNodeId(bytes, 0), dst: readNodeId(bytes, 8),
        teleport: bytes[16] !== 0, bidirectional: bytes[17] !== 0,
      };
    case EDGE_BASED_TAG.CYCLIC_EDGE_REJECTED:
      expectLen(tag, bytes, 17);
      return { kind: "CyclicEdgeRejected", src: readNodeId(bytes, 0), dst: readNodeId(bytes, 8), teleport: bytes[16] !== 0 };
    case EDGE_BASED_TAG.DST_WEIGHTS_COMPUTED: {
      const { ids: candidates, next } = readNodeIdList(bytes, 0);
      const { values: weights, next: afterWeights } = readF64List(bytes, next);
      const branching = readF64(bytes, afterWeights);
      const directionality = readF64(bytes, afterWeights + 8);
      const directionalityEligible = bytes[afterWeights + 16] !== 0;
      return { kind: "DstWeightsComputed", candidates, weights, branching, directionality, directionalityEligible };
    }
    case EDGE_BASED_TAG.DST_CHOSEN:
      expectLen(tag, bytes, 24);
      return { kind: "DstChosen", dst: readNodeId(bytes, 0), roll: readF64(bytes, 8), totalWeight: readF64(bytes, 16) };
    case EDGE_BASED_TAG.EDGE_ADDED:
      expectLen(tag, bytes, 18);
      return {
        kind: "EdgeAdded", src: readNodeId(bytes, 0), dst: readNodeId(bytes, 8),
        teleport: bytes[16] !== 0, bidirectional: bytes[17] !== 0,
      };
    case EDGE_BASED_TAG.EDGE_REJECTED:
      expectLen(tag, bytes, 17);
      return { kind: "EdgeRejected", src: readNodeId(bytes, 0), dst: readNodeId(bytes, 8), teleport: bytes[16] !== 0 };
    case EDGE_BASED_TAG.PRESET_SKIPPED:
      expectLen(tag, bytes, 16);
      return { kind: "PresetSkipped", src: readNodeId(bytes, 0), dst: readNodeId(bytes, 8) };
    case EDGE_BASED_TAG.NODE_ACTIVATED:
      expectLen(tag, bytes, 21);
      return { kind: "NodeActivated", node: readNodeId(bytes, 0), parent: readOptionalNodeId(bytes, 8), treeDepth: readU32(bytes, 17) };
    case EDGE_BASED_TAG.SRC_EXHAUSTED:
      expectLen(tag, bytes, 8);
      return { kind: "SrcExhausted", src: readNodeId(bytes, 0) };
    default:
      throw new Error(`EdgeBasedEvent: unknown wire tag ${tag}`);
  }
}

/** Mirrors `DebugEvent::is_mutating`'s split for `EdgeBasedEvent` in
 *  `maze-core/src/generation/edge_based.rs`. */
export function isMutatingEdgeBasedEvent(event: EdgeBasedEvent): boolean {
  return (
    event.kind === "SrcExhaustedEmptyPool" ||
    event.kind === "CyclicEdgeAdded" ||
    event.kind === "CyclicEdgeRejected" ||
    event.kind === "EdgeAdded" ||
    event.kind === "EdgeRejected" ||
    event.kind === "NodeActivated" ||
    event.kind === "SrcExhausted"
  );
}

export interface MutatingEdgeBasedEventAt {
  event: EdgeBasedEvent;
  nodeIndex: number;
}

/** Flat layer for `CustomEdgeBased`: forward scan over the node table, skipping scope nodes,
 *  decoding events, filtering to mutating ones only — mirrors `mutatingWilsonEventsWithIndex`. No
 *  checkpoints (GitHub issue #128 is RB-only), same `startIndex`/`limit` shape for consistency. */
export function mutatingEdgeBasedEventsWithIndex(tape: ParsedTape, limit?: number, startIndex = 0, endIndex?: number): MutatingEdgeBasedEventAt[] {
  return mutatingEventsWithIndex(tape, decodeEdgeBasedEvent, isMutatingEdgeBasedEvent, limit, startIndex, endIndex);
}

/** Convenience wrapper over `mutatingEdgeBasedEventsWithIndex` for callers that only need the
 *  decoded events, not their arena indices. */
export function mutatingEdgeBasedEvents(tape: ParsedTape, limit?: number, startIndex = 0, endIndex?: number): EdgeBasedEvent[] {
  return mutatingEdgeBasedEventsWithIndex(tape, limit, startIndex, endIndex).map((e) => e.event);
}

export const ACTIVE = "active";

/** Mirrors `EdgeBasedEvent`'s `DebugValueDelta` impl (`"active"`/`"visited"`) in
 *  `maze-core/src/generation/edge_based.rs`: `NodeActivated` inserts into `"active"`;
 *  `SrcExhaustedEmptyPool`/`SrcExhausted` remove from `"active"` and insert into `"visited"`. */
function edgeBasedDebugValueDeltasFor(event: EdgeBasedEvent): [string, DebugValueOp, bigint][] {
  switch (event.kind) {
    case "NodeActivated":
      return [[ACTIVE, "insert", event.node]];
    case "SrcExhaustedEmptyPool":
    case "SrcExhausted":
      return [[ACTIVE, "remove", event.src], [VISITED, "insert", event.src]];
    default:
      return [];
  }
}

export interface EdgeBasedApplyResult {
  edges: Edge[];
  /** `"active"` and `"visited"` (both Region — `active`'s members don't form a connected
   *  traversal chain, so unlike RB's `Sequence`-kind `"recursion_stack"` they render as
   *  independent per-node highlights, not a chain) — mirrors `debugValues` on
   *  `ApplyResult`/`applyRecursiveBacktracker`. */
  debugValues: DebugValues;
  step: number;
  nodeIndex: number;
}

/** Replays `CustomEdgeBased` events up to and including `targetStep` — counterpart to
 *  `applyKruskal`/`applyWilson`: no checkpoints, every call replays from the tape's start.
 *  `EdgeRejected`/`CyclicEdgeRejected` are mutating (step-count-worthy, per the Rust side's
 *  `is_mutating` doc comment) but contribute no `edges`/`debugValues` delta of their own — a
 *  rejected attempt changes nothing reconstructable, only the step count advances. `EdgeAdded`/
 *  `CyclicEdgeAdded` carry an explicit `bidirectional` flag (the underlying `add_edge_kind`
 *  one-way coin flip isn't otherwise knowable from the event's other fields) — mirrors RB/
 *  Kruskal/Wilson's own `EdgeAdded.bidirectional` handling: a bidirectional edge contributes both
 *  `{from, to}` and `{to, from}` to `edges`, a one-way edge only the forward pair. */
export function applyEdgeBased(tape: ParsedTape, targetStep: number, from?: EdgeBasedApplyResult, startIndex = 0, endIndex?: number): EdgeBasedApplyResult {
  validateStepShape("targetStep", targetStep);
  if (from) {
    validateStepShape("from.step", from.step);
    validateStepShape("from.nodeIndex", from.nodeIndex);
    if (from.step > targetStep) {
      throw new Error(`applyEdgeBased: from.step ${from.step} is ahead of targetStep ${targetStep}`);
    }
    if (from.step === targetStep) {
      return { edges: [...from.edges], debugValues: cloneDebugValues(from.debugValues), step: targetStep, nodeIndex: from.nodeIndex };
    }
  }

  const scanStart = from ? from.nodeIndex + 1 : startIndex;
  const needed = targetStep - (from?.step ?? -1);
  const events = mutatingEdgeBasedEventsWithIndex(tape, needed, scanStart, endIndex);
  if (events.length < needed) {
    const total = (from?.step ?? -1) + 1 + events.length;
    throw new Error(`targetStep ${targetStep} out of range [0, ${total})`);
  }

  const edges = from ? [...from.edges] : [];
  const debugValues: DebugValues = from ? cloneDebugValues(from.debugValues) : new Map();
  // Presence tracked per debug-value name (unlike Wilson/RB's single `Set<bigint>`, which only
  // ever needs to track one Insert/Remove-based value at a time) — "active" and "visited" are
  // two independent id sets here, so a shared presence set would let an id's membership in one
  // wrongly gate insert/remove for the other.
  const presence = new Map<string, Set<bigint>>();
  for (const [name, ids] of debugValues) presence.set(name, new Set(ids));

  for (const { event } of events) {
    if (event.kind === "EdgeAdded" || event.kind === "CyclicEdgeAdded") {
      const kind = event.teleport ? "teleport" : "basic";
      edges.push({ from: event.src, to: event.dst, kind });
      if (event.bidirectional) {
        edges.push({ from: event.dst, to: event.src, kind });
      }
    }
    for (const [name, op, id] of edgeBasedDebugValueDeltasFor(event)) {
      let ids = debugValues.get(name);
      if (!ids) {
        ids = [];
        debugValues.set(name, ids);
      }
      let seen = presence.get(name);
      if (!seen) {
        seen = new Set();
        presence.set(name, seen);
      }
      if (op === "insert") {
        if (!seen.has(id)) { seen.add(id); ids.push(id); }
      } else if (seen.delete(id)) {
        const at = ids.indexOf(id);
        if (at !== -1) ids.splice(at, 1);
      }
    }
  }

  return { edges, debugValues, step: targetStep, nodeIndex: events[events.length - 1].nodeIndex };
}

// --- CustomVertexBased event decoding (GitHub issue #143) ---

export type VertexBasedEvent =
  | { kind: "TeleportBridgeRolled"; roll: number; teleportChance: number; fired: boolean }
  | { kind: "TeleportBridgeAdded"; src: bigint; dst: bigint; bidirectional: boolean }
  | { kind: "ReserveCandidateRejected"; node: bigint; alreadyVisited: boolean }
  | { kind: "ReserveCandidateChosen"; node: bigint }
  | { kind: "ReserveExhausted" }
  | { kind: "BridgeAdded"; src: bigint; dst: bigint; bidirectional: boolean }
  | { kind: "SrcChosenFromFrontier"; src: bigint; frontierLen: number; position: number; depthFirst: number }
  | { kind: "TeleportRolled"; src: bigint; roll: number; teleportChance: number; fired: boolean }
  | { kind: "CyclicRolled"; src: bigint; roll: number; cyclicity: number; fired: boolean }
  | { kind: "CyclicCandidatesComputed"; src: bigint; geometric: boolean; candidates: bigint[] }
  | { kind: "CyclicEdgeAdded"; src: bigint; dst: bigint; teleport: boolean; bidirectional: boolean }
  | { kind: "CorridorRolled"; roll: number; corridorChance: number; isCorridor: boolean }
  | { kind: "CandidateChosen"; src: bigint; dst: bigint; usedDirectionality: boolean }
  | { kind: "JunctionRollSetup"; max: number }
  | { kind: "JunctionSlotRolled"; slot: number; roll: number; branching: number; taken: boolean }
  | { kind: "JunctionCandidatesChosen"; src: bigint; candidates: bigint[] }
  | { kind: "EdgeAdded"; src: bigint; dst: bigint; bidirectional: boolean }
  | { kind: "PresetNeighborVisited"; src: bigint; dst: bigint }
  | { kind: "TeleportConnectAdded"; src: bigint; dst: bigint; bidirectional: boolean }
  | { kind: "NodeVisited"; node: bigint; parent: bigint }
  | { kind: "NodeQueuedToReserve"; node: bigint }
  | { kind: "StartVisited"; node: bigint }
  | { kind: "SingleCandidateSkipsDirectionality"; node: bigint }
  | { kind: "NoParentSkipsDirectionality"; node: bigint }
  | { kind: "DirectionalityRolled"; roll: number; directionality: number; fired: boolean; straightFound: boolean };

/** Decodes one `CustomVertexBased` event's binary payload. Contract: only called with `tag >= 1`
 *  — callers filter out `TAG_SCOPE` first. Throws on an unrecognized tag or a `payload_len`
 *  mismatch for fixed-size variants — same error-on-mismatch contract as
 *  `decodeRecursiveBacktrackerEvent`/`decodeKruskalEvent`/`decodeWilsonEvent`/`decodeEdgeBasedEvent`. */
export function decodeVertexBasedEvent(tag: number, bytes: Uint8Array): VertexBasedEvent {
  switch (tag) {
    case VERTEX_BASED_TAG.TELEPORT_BRIDGE_ROLLED:
      expectLen(tag, bytes, 17);
      return { kind: "TeleportBridgeRolled", roll: readF64(bytes, 0), teleportChance: readF64(bytes, 8), fired: bytes[16] !== 0 };
    case VERTEX_BASED_TAG.TELEPORT_BRIDGE_ADDED:
      expectLen(tag, bytes, 17);
      return { kind: "TeleportBridgeAdded", src: readNodeId(bytes, 0), dst: readNodeId(bytes, 8), bidirectional: bytes[16] !== 0 };
    case VERTEX_BASED_TAG.RESERVE_CANDIDATE_REJECTED:
      expectLen(tag, bytes, 9);
      return { kind: "ReserveCandidateRejected", node: readNodeId(bytes, 0), alreadyVisited: bytes[8] !== 0 };
    case VERTEX_BASED_TAG.RESERVE_CANDIDATE_CHOSEN:
      expectLen(tag, bytes, 8);
      return { kind: "ReserveCandidateChosen", node: readNodeId(bytes, 0) };
    case VERTEX_BASED_TAG.RESERVE_EXHAUSTED:
      expectLen(tag, bytes, 0);
      return { kind: "ReserveExhausted" };
    case VERTEX_BASED_TAG.BRIDGE_ADDED:
      expectLen(tag, bytes, 17);
      return { kind: "BridgeAdded", src: readNodeId(bytes, 0), dst: readNodeId(bytes, 8), bidirectional: bytes[16] !== 0 };
    case VERTEX_BASED_TAG.SRC_CHOSEN_FROM_FRONTIER:
      expectLen(tag, bytes, 24);
      return {
        kind: "SrcChosenFromFrontier",
        src: readNodeId(bytes, 0),
        frontierLen: readU32(bytes, 8),
        position: readU32(bytes, 12),
        depthFirst: readF64(bytes, 16),
      };
    case VERTEX_BASED_TAG.TELEPORT_ROLLED:
      expectLen(tag, bytes, 25);
      return {
        kind: "TeleportRolled",
        src: readNodeId(bytes, 0),
        roll: readF64(bytes, 8),
        teleportChance: readF64(bytes, 16),
        fired: bytes[24] !== 0,
      };
    case VERTEX_BASED_TAG.CYCLIC_ROLLED:
      expectLen(tag, bytes, 25);
      return {
        kind: "CyclicRolled",
        src: readNodeId(bytes, 0),
        roll: readF64(bytes, 8),
        cyclicity: readF64(bytes, 16),
        fired: bytes[24] !== 0,
      };
    case VERTEX_BASED_TAG.CYCLIC_CANDIDATES_COMPUTED: {
      const src = readNodeId(bytes, 0);
      const geometric = bytes[8] !== 0;
      const { ids: candidates } = readNodeIdList(bytes, 9);
      return { kind: "CyclicCandidatesComputed", src, geometric, candidates };
    }
    case VERTEX_BASED_TAG.CYCLIC_EDGE_ADDED:
      expectLen(tag, bytes, 18);
      return {
        kind: "CyclicEdgeAdded", src: readNodeId(bytes, 0), dst: readNodeId(bytes, 8),
        teleport: bytes[16] !== 0, bidirectional: bytes[17] !== 0,
      };
    case VERTEX_BASED_TAG.CORRIDOR_ROLLED:
      expectLen(tag, bytes, 17);
      return { kind: "CorridorRolled", roll: readF64(bytes, 0), corridorChance: readF64(bytes, 8), isCorridor: bytes[16] !== 0 };
    case VERTEX_BASED_TAG.CANDIDATE_CHOSEN:
      expectLen(tag, bytes, 17);
      return {
        kind: "CandidateChosen", src: readNodeId(bytes, 0), dst: readNodeId(bytes, 8), usedDirectionality: bytes[16] !== 0,
      };
    case VERTEX_BASED_TAG.JUNCTION_ROLL_SETUP:
      expectLen(tag, bytes, 4);
      return { kind: "JunctionRollSetup", max: readU32(bytes, 0) };
    case VERTEX_BASED_TAG.JUNCTION_SLOT_ROLLED:
      expectLen(tag, bytes, 21);
      return {
        kind: "JunctionSlotRolled", slot: readU32(bytes, 0), roll: readF64(bytes, 4), branching: readF64(bytes, 12), taken: bytes[20] !== 0,
      };
    case VERTEX_BASED_TAG.JUNCTION_CANDIDATES_CHOSEN: {
      const src = readNodeId(bytes, 0);
      const { ids: candidates } = readNodeIdList(bytes, 8);
      return { kind: "JunctionCandidatesChosen", src, candidates };
    }
    case VERTEX_BASED_TAG.EDGE_ADDED:
      expectLen(tag, bytes, 17);
      return { kind: "EdgeAdded", src: readNodeId(bytes, 0), dst: readNodeId(bytes, 8), bidirectional: bytes[16] !== 0 };
    case VERTEX_BASED_TAG.PRESET_NEIGHBOR_VISITED:
      expectLen(tag, bytes, 16);
      return { kind: "PresetNeighborVisited", src: readNodeId(bytes, 0), dst: readNodeId(bytes, 8) };
    case VERTEX_BASED_TAG.TELEPORT_CONNECT_ADDED:
      expectLen(tag, bytes, 17);
      return { kind: "TeleportConnectAdded", src: readNodeId(bytes, 0), dst: readNodeId(bytes, 8), bidirectional: bytes[16] !== 0 };
    case VERTEX_BASED_TAG.NODE_VISITED:
      expectLen(tag, bytes, 16);
      return { kind: "NodeVisited", node: readNodeId(bytes, 0), parent: readNodeId(bytes, 8) };
    case VERTEX_BASED_TAG.NODE_QUEUED_TO_RESERVE:
      expectLen(tag, bytes, 8);
      return { kind: "NodeQueuedToReserve", node: readNodeId(bytes, 0) };
    case VERTEX_BASED_TAG.START_VISITED:
      expectLen(tag, bytes, 8);
      return { kind: "StartVisited", node: readNodeId(bytes, 0) };
    case VERTEX_BASED_TAG.SINGLE_CANDIDATE_SKIPS_DIRECTIONALITY:
      expectLen(tag, bytes, 8);
      return { kind: "SingleCandidateSkipsDirectionality", node: readNodeId(bytes, 0) };
    case VERTEX_BASED_TAG.NO_PARENT_SKIPS_DIRECTIONALITY:
      expectLen(tag, bytes, 8);
      return { kind: "NoParentSkipsDirectionality", node: readNodeId(bytes, 0) };
    case VERTEX_BASED_TAG.DIRECTIONALITY_ROLLED:
      expectLen(tag, bytes, 18);
      return {
        kind: "DirectionalityRolled",
        roll: readF64(bytes, 0),
        directionality: readF64(bytes, 8),
        fired: bytes[16] !== 0,
        straightFound: bytes[17] !== 0,
      };
    default:
      throw new Error(`VertexBasedEvent: unknown wire tag ${tag}`);
  }
}

/** Mirrors `DebugEvent::is_mutating`'s split for `VertexBasedEvent` in
 *  `maze-core/src/generation/vertex_based.rs`. */
export function isMutatingVertexBasedEvent(event: VertexBasedEvent): boolean {
  return (
    event.kind === "TeleportBridgeAdded" ||
    event.kind === "BridgeAdded" ||
    event.kind === "CyclicEdgeAdded" ||
    event.kind === "EdgeAdded" ||
    event.kind === "PresetNeighborVisited" ||
    event.kind === "TeleportConnectAdded" ||
    event.kind === "NodeVisited" ||
    event.kind === "NodeQueuedToReserve" ||
    event.kind === "ReserveCandidateChosen" ||
    event.kind === "StartVisited" ||
    event.kind === "SrcChosenFromFrontier"
  );
}

export interface MutatingVertexBasedEventAt {
  event: VertexBasedEvent;
  nodeIndex: number;
}

/** Flat layer for `CustomVertexBased`: forward scan over the node table, skipping scope nodes,
 *  decoding events, filtering to mutating ones only — mirrors `mutatingEdgeBasedEventsWithIndex`.
 *  No checkpoints (GitHub issue #128 is RB-only), same `startIndex`/`limit` shape for consistency. */
export function mutatingVertexBasedEventsWithIndex(tape: ParsedTape, limit?: number, startIndex = 0, endIndex?: number): MutatingVertexBasedEventAt[] {
  return mutatingEventsWithIndex(tape, decodeVertexBasedEvent, isMutatingVertexBasedEvent, limit, startIndex, endIndex);
}

/** Convenience wrapper over `mutatingVertexBasedEventsWithIndex` for callers that only need the
 *  decoded events, not their arena indices. */
export function mutatingVertexBasedEvents(tape: ParsedTape, limit?: number, startIndex = 0, endIndex?: number): VertexBasedEvent[] {
  return mutatingVertexBasedEventsWithIndex(tape, limit, startIndex, endIndex).map((e) => e.event);
}

export const FRONTIER = "frontier";
export const RESERVE = "reserve";

/** Mirrors `VertexBasedEvent`'s `DebugValueDelta` impl (`"visited"`/`"frontier"`/`"reserve"`) in
 *  `maze-core/src/generation/vertex_based.rs`: `NodeVisited` inserts into `"visited"`/`"frontier"`
 *  and removes from `"reserve"` (a no-op remove when the node was never actually queued);
 *  `ReserveCandidateChosen` removes from `"reserve"`; `ReserveCandidateRejected` with
 *  `alreadyVisited: false` (the requeue branch) and `NodeQueuedToReserve` both insert into
 *  `"reserve"`; `SrcChosenFromFrontier` removes from `"frontier"` (the node just popped for
 *  processing). */
function vertexBasedDebugValueDeltasFor(event: VertexBasedEvent): [string, DebugValueOp, bigint][] {
  switch (event.kind) {
    case "NodeVisited":
      return [[VISITED, "insert", event.node], [FRONTIER, "insert", event.node], [RESERVE, "remove", event.node]];
    case "ReserveCandidateChosen":
      return [[RESERVE, "remove", event.node]];
    case "ReserveCandidateRejected":
      return event.alreadyVisited ? [] : [[RESERVE, "insert", event.node]];
    case "NodeQueuedToReserve":
      return [[RESERVE, "insert", event.node]];
    case "StartVisited":
      return [[VISITED, "insert", event.node], [FRONTIER, "insert", event.node]];
    case "SrcChosenFromFrontier":
      return [[FRONTIER, "remove", event.src]];
    default:
      return [];
  }
}

export interface VertexBasedApplyResult {
  edges: Edge[];
  /** `"visited"`, `"frontier"`, and `"reserve"` (all Region — none of the three form a connected
   *  traversal chain, so unlike RB's `Sequence`-kind `"recursion_stack"` they render as
   *  independent per-node highlights) — mirrors `debugValues` on
   *  `ApplyResult`/`applyRecursiveBacktracker`/`EdgeBasedApplyResult`. */
  debugValues: DebugValues;
  step: number;
  nodeIndex: number;
}

/** Replays `CustomVertexBased` events up to and including `targetStep` — counterpart to
 *  `applyEdgeBased`/`applyKruskal`/`applyWilson`: no checkpoints, every call replays from the
 *  tape's start. Every edge-add variant (`TeleportBridgeAdded`/`BridgeAdded`/`CyclicEdgeAdded`/
 *  `EdgeAdded`/`TeleportConnectAdded`) carries an explicit `bidirectional` flag — mirrors RB/
 *  Kruskal/Wilson/EdgeBased's own handling: a bidirectional edge contributes both `{from, to}` and
 *  `{to, from}` to `edges`, a one-way edge only the forward pair. `PresetNeighborVisited` and the
 *  step-count-worthy-but-edgeless mutating variants (`ReserveCandidateChosen`,
 *  `NodeQueuedToReserve`) contribute no `edges` entry of their own. */
export function applyVertexBased(tape: ParsedTape, targetStep: number, from?: VertexBasedApplyResult, startIndex = 0, endIndex?: number): VertexBasedApplyResult {
  validateStepShape("targetStep", targetStep);
  if (from) {
    validateStepShape("from.step", from.step);
    validateStepShape("from.nodeIndex", from.nodeIndex);
    if (from.step > targetStep) {
      throw new Error(`applyVertexBased: from.step ${from.step} is ahead of targetStep ${targetStep}`);
    }
    if (from.step === targetStep) {
      return { edges: [...from.edges], debugValues: cloneDebugValues(from.debugValues), step: targetStep, nodeIndex: from.nodeIndex };
    }
  }

  const scanStart = from ? from.nodeIndex + 1 : startIndex;
  const needed = targetStep - (from?.step ?? -1);
  const events = mutatingVertexBasedEventsWithIndex(tape, needed, scanStart, endIndex);
  if (events.length < needed) {
    const total = (from?.step ?? -1) + 1 + events.length;
    throw new Error(`targetStep ${targetStep} out of range [0, ${total})`);
  }

  const edges = from ? [...from.edges] : [];
  // Built as Set<bigint> per name, not Array, while replaying — "visited"/"frontier"/"reserve"
  // are Region-kind (order carries no meaning, see VertexBasedEvent's DebugValueDelta doc comment
  // in vertex_based.rs), so a Set gives O(1) insert/remove instead of the O(n) indexOf+splice a
  // growing/shrinking array would cost per delta. SrcChosenFromFrontier fires a frontier removal
  // on every single step, so this path runs at O(steps) removes per full replay — an O(n) removal
  // here would make replay O(n^2). Converted to the `bigint[]` the DebugValues type/UI expects
  // only once, after the loop. Seeded from `from.debugValues` when resuming, same discipline as
  // every other adapter's `presence` mirror.
  const sets = new Map<string, Set<bigint>>();
  if (from) {
    for (const [name, ids] of from.debugValues) sets.set(name, new Set(ids));
  }

  for (const { event } of events) {
    if (
      event.kind === "TeleportBridgeAdded" || event.kind === "BridgeAdded" ||
      event.kind === "CyclicEdgeAdded" || event.kind === "EdgeAdded" || event.kind === "TeleportConnectAdded"
    ) {
      const kind = (event.kind === "TeleportBridgeAdded" || event.kind === "TeleportConnectAdded" ||
        (event.kind === "CyclicEdgeAdded" && event.teleport)) ? "teleport" : "basic";
      edges.push({ from: event.src, to: event.dst, kind });
      if (event.bidirectional) {
        edges.push({ from: event.dst, to: event.src, kind });
      }
    }
    for (const [name, op, id] of vertexBasedDebugValueDeltasFor(event)) {
      let set = sets.get(name);
      if (!set) {
        set = new Set();
        sets.set(name, set);
      }
      if (op === "insert") {
        set.add(id);
      } else {
        set.delete(id);
      }
    }
  }

  const debugValues: DebugValues = new Map();
  for (const [name, set] of sets) {
    debugValues.set(name, [...set]);
  }

  return { edges, debugValues, step: targetStep, nodeIndex: events[events.length - 1].nodeIndex };
}

// --- Quality-control/repair event decoding (GitHub issue #147) ---

/** QC event wire tags — mirrors `wire_tags` in `maze-core/src/quality_control/event.rs`.
 *  Independent numbering from every generation algorithm's own `*_TAG` above, same as those five
 *  are independent of each other. */
export const QC_TAG = {
  ITERATION_STARTED: 1,
  CHECK_RAN: 2,
  ITERATION_LIMIT_REACHED: 5,
  ISSUES_MERGED: 24,

  DIRECTED_EDGE_ADDED: 6,
  BIDIRECTIONAL_EDGE_ADDED: 7,
  DIRECTED_TELEPORT_ADDED: 8,
  BIDIRECTIONAL_TELEPORT_ADDED: 9,
  EDGE_REMOVED: 10,
  EDGE_REMOVED_BETWEEN: 11,
  TELEPORT_REMOVED_WITH_REVERSE: 12,
  START_SET: 13,
  FINISH_SET: 14,

  DIRECTED_EDGE_DECLINED: 15,
  BIDIRECTIONAL_EDGE_DECLINED: 16,
  DIRECTED_TELEPORT_DECLINED: 17,
  BIDIRECTIONAL_TELEPORT_DECLINED: 18,
  EDGE_REMOVE_DECLINED: 19,
  EDGE_REMOVE_BETWEEN_DECLINED: 20,
  TELEPORT_REMOVE_WITH_REVERSE_DECLINED: 21,
  START_SET_DECLINED: 22,
  FINISH_SET_DECLINED: 23,

  DIRECTED_EDGE_PROPOSED: 25,
  BIDIRECTIONAL_EDGE_PROPOSED: 26,
  DIRECTED_TELEPORT_PROPOSED: 27,
  BIDIRECTIONAL_TELEPORT_PROPOSED: 28,
  EDGE_REMOVE_PROPOSED: 29,
  EDGE_REMOVE_BETWEEN_PROPOSED: 30,
  TELEPORT_REMOVE_WITH_REVERSE_PROPOSED: 31,
  START_SET_PROPOSED: 32,
  FINISH_SET_PROPOSED: 33,
} as const;

export type RepairLimitKind = "MaxIterations" | "TimeBudget";

/** Mirrors `IssuePayload` in `maze-core/src/quality_control/issue_payload.rs` — `None` for the 9
 *  of 11 `Issue` kinds with no structural edge/node payload (see that type's doc comment). */
export type IssuePayload =
  | { kind: "None" }
  | { kind: "InvalidLoop"; edges: Map<string, [bigint, bigint][][]> }
  | { kind: "RegionNeedsExpansion"; nodes: Map<string, bigint[][]> };

/** Mirrors `QcEvent` in `maze-core/src/quality_control/event.rs` — see that type's doc comment for
 *  the trace/mutating/declined split. `ruleId`/`checkId`/`issueKind` are the wire strings
 *  `Rule::id`/`Check::check_type_id`/`IssueKind::as_str` produce, not enums — same "plain string
 *  over the wire" choice already made for `EventedEventKind`/`DebugValueKind` at the WASM
 *  boundary. */
export type QcEvent =
  | { kind: "IterationStarted"; iteration: number }
  | { kind: "CheckRan"; checkId: string; issue: { issueKind: string; payload: IssuePayload; details: Map<string, string> } | null }
  | { kind: "IssuesMerged"; issueKind: string; payload: IssuePayload; details: Map<string, Map<string, string>> }
  | { kind: "IterationLimitReached"; limit: RepairLimitKind }
  | { kind: "DirectedEdgeAdded"; from: bigint; to: bigint }
  | { kind: "BidirectionalEdgeAdded"; a: bigint; b: bigint }
  | { kind: "DirectedTeleportAdded"; from: bigint; to: bigint }
  | { kind: "BidirectionalTeleportAdded"; a: bigint; b: bigint }
  | { kind: "EdgeRemoved"; from: bigint; to: bigint }
  | { kind: "EdgeRemovedBetween"; from: bigint; to: bigint }
  | { kind: "TeleportRemovedWithReverse"; from: bigint; to: bigint }
  | { kind: "StartSet"; id: bigint }
  | { kind: "FinishSet"; id: bigint }
  | { kind: "DirectedEdgeDeclined"; from: bigint; to: bigint }
  | { kind: "BidirectionalEdgeDeclined"; a: bigint; b: bigint }
  | { kind: "DirectedTeleportDeclined"; from: bigint; to: bigint }
  | { kind: "BidirectionalTeleportDeclined"; a: bigint; b: bigint }
  | { kind: "EdgeRemoveDeclined"; from: bigint; to: bigint }
  | { kind: "EdgeRemoveBetweenDeclined"; from: bigint; to: bigint }
  | { kind: "TeleportRemoveWithReverseDeclined"; from: bigint; to: bigint }
  | { kind: "StartSetDeclined"; id: bigint }
  | { kind: "FinishSetDeclined"; id: bigint }
  | { kind: "DirectedEdgeProposed"; from: bigint; to: bigint }
  | { kind: "BidirectionalEdgeProposed"; a: bigint; b: bigint }
  | { kind: "DirectedTeleportProposed"; from: bigint; to: bigint }
  | { kind: "BidirectionalTeleportProposed"; a: bigint; b: bigint }
  | { kind: "EdgeRemoveProposed"; from: bigint; to: bigint }
  | { kind: "EdgeRemoveBetweenProposed"; from: bigint; to: bigint }
  | { kind: "TeleportRemoveWithReverseProposed"; from: bigint; to: bigint }
  | { kind: "StartSetProposed"; id: bigint }
  | { kind: "FinishSetProposed"; id: bigint };

/** Reads a `u32`-length-prefixed UTF-8 string starting at `offset` — mirrors `write_str` in
 *  `maze-core/src/quality_control/event.rs`. Returns the decoded string and the byte offset
 *  immediately past it, mirroring `readNodeIdList`/`readF64List`'s `{ value, next }` shape. */
function readStr(bytes: Uint8Array, offset: number): { value: string; next: number } {
  const len = readU32(bytes, offset);
  const start = offset + 4;
  const value = textDecoder.decode(bytes.subarray(start, start + len));
  return { value, next: start + len };
}

/** Reads the `HashMap<String, Vec<Vec<[u32; 2]>>>` wire shape `write_str_keyed_edge_pairs`
 *  produces (`IssuePayload::InvalidLoop`'s `edges`). */
function readStrKeyedEdgePairs(bytes: Uint8Array, offset: number): { value: Map<string, [bigint, bigint][][]>; next: number } {
  const value = new Map<string, [bigint, bigint][][]>();
  const entryCount = readU32(bytes, offset);
  let pos = offset + 4;
  for (let i = 0; i < entryCount; i++) {
    const { value: key, next: afterKey } = readStr(bytes, pos);
    pos = afterKey;
    const cycleCount = readU32(bytes, pos);
    pos += 4;
    const cycles: [bigint, bigint][][] = [];
    for (let c = 0; c < cycleCount; c++) {
      const pairCount = readU32(bytes, pos);
      pos += 4;
      const pairs: [bigint, bigint][] = [];
      for (let p = 0; p < pairCount; p++) {
        const from = BigInt(readU32(bytes, pos));
        const to = BigInt(readU32(bytes, pos + 4));
        pairs.push([from, to]);
        pos += 8;
      }
      cycles.push(pairs);
    }
    value.set(key, cycles);
  }
  return { value, next: pos };
}

/** Reads the `HashMap<String, Vec<Vec<u32>>>` wire shape `write_str_keyed_node_lists` produces
 *  (`IssuePayload::RegionNeedsExpansion`'s `nodes`). */
function readStrKeyedNodeLists(bytes: Uint8Array, offset: number): { value: Map<string, bigint[][]>; next: number } {
  const value = new Map<string, bigint[][]>();
  const entryCount = readU32(bytes, offset);
  let pos = offset + 4;
  for (let i = 0; i < entryCount; i++) {
    const { value: key, next: afterKey } = readStr(bytes, pos);
    pos = afterKey;
    const regionCount = readU32(bytes, pos);
    pos += 4;
    const regions: bigint[][] = [];
    for (let r = 0; r < regionCount; r++) {
      const nodeCount = readU32(bytes, pos);
      pos += 4;
      const nodes: bigint[] = [];
      for (let n = 0; n < nodeCount; n++) {
        nodes.push(BigInt(readU32(bytes, pos)));
        pos += 4;
      }
      regions.push(nodes);
    }
    value.set(key, regions);
  }
  return { value, next: pos };
}

/** Reads one check's own raw display details (GitHub issue #171) — mirrors `write_details`
 *  (`HashMap<&'static str, String>`, e.g. `{"threshold" -> "10"}`). */
function readDetails(bytes: Uint8Array, offset: number): { value: Map<string, string>; next: number } {
  const value = new Map<string, string>();
  const entryCount = readU32(bytes, offset);
  let pos = offset + 4;
  for (let i = 0; i < entryCount; i++) {
    const { value: key, next: afterKey } = readStr(bytes, pos);
    const { value: val, next: afterVal } = readStr(bytes, afterKey);
    value.set(key, val);
    pos = afterVal;
  }
  return { value, next: pos };
}

/** Reads a merged issue's full details map, keyed by contributing check instance id (GitHub issue
 *  #171) — mirrors `write_details_map`. */
function readDetailsMap(bytes: Uint8Array, offset: number): { value: Map<string, Map<string, string>>; next: number } {
  const value = new Map<string, Map<string, string>>();
  const entryCount = readU32(bytes, offset);
  let pos = offset + 4;
  for (let i = 0; i < entryCount; i++) {
    const { value: checkId, next: afterKey } = readStr(bytes, pos);
    const { value: details, next: afterDetails } = readDetails(bytes, afterKey);
    value.set(checkId, details);
    pos = afterDetails;
  }
  return { value, next: pos };
}

/** Reads an `IssuePayload` starting at `offset` — mirrors `write_issue_payload`. */
function readIssuePayload(bytes: Uint8Array, offset: number): { value: IssuePayload; next: number } {
  const tag = bytes[offset];
  if (tag === 0) return { value: { kind: "None" }, next: offset + 1 };
  if (tag === 1) {
    const { value: edges, next } = readStrKeyedEdgePairs(bytes, offset + 1);
    return { value: { kind: "InvalidLoop", edges }, next };
  }
  if (tag === 2) {
    const { value: nodes, next } = readStrKeyedNodeLists(bytes, offset + 1);
    return { value: { kind: "RegionNeedsExpansion", nodes }, next };
  }
  throw new Error(`IssuePayload: unknown tag ${tag}`);
}

function decodeRepairLimitKind(byte: number): RepairLimitKind {
  if (byte === 0) return "MaxIterations";
  if (byte === 1) return "TimeBudget";
  throw new Error(`QcEvent: unknown RepairLimitKind byte ${byte}`);
}

/** Decodes one QC event's binary payload. Contract: only called with `tag >= 1` — callers filter
 *  out `TAG_SCOPE` first. Throws on an unrecognized tag, same error-on-mismatch contract as every
 *  other decoder in this module. `*Declined` variants (tags 15-23) decode byte-for-byte like their
 *  mutating mirror (tags 6-14). */
export function decodeQcEvent(tag: number, bytes: Uint8Array): QcEvent {
  switch (tag) {
    case QC_TAG.ITERATION_STARTED:
      expectLen(tag, bytes, 4);
      return { kind: "IterationStarted", iteration: readU32(bytes, 0) };
    case QC_TAG.CHECK_RAN: {
      const { value: checkId, next } = readStr(bytes, 0);
      const present = bytes[next];
      if (present === 0) return { kind: "CheckRan", checkId, issue: null };
      const { value: issueKind, next: afterKind } = readStr(bytes, next + 1);
      const { value: payload, next: afterPayload } = readIssuePayload(bytes, afterKind);
      const { value: details } = readDetails(bytes, afterPayload);
      return { kind: "CheckRan", checkId, issue: { issueKind, payload, details } };
    }
    case QC_TAG.ISSUES_MERGED: {
      const { value: issueKind, next } = readStr(bytes, 0);
      const { value: payload, next: afterPayload } = readIssuePayload(bytes, next);
      const { value: details } = readDetailsMap(bytes, afterPayload);
      return { kind: "IssuesMerged", issueKind, payload, details };
    }
    case QC_TAG.ITERATION_LIMIT_REACHED:
      expectLen(tag, bytes, 1);
      return { kind: "IterationLimitReached", limit: decodeRepairLimitKind(bytes[0]) };

    case QC_TAG.DIRECTED_EDGE_ADDED:
      expectLen(tag, bytes, 16);
      return { kind: "DirectedEdgeAdded", from: readNodeId(bytes, 0), to: readNodeId(bytes, 8) };
    case QC_TAG.DIRECTED_EDGE_DECLINED:
      expectLen(tag, bytes, 16);
      return { kind: "DirectedEdgeDeclined", from: readNodeId(bytes, 0), to: readNodeId(bytes, 8) };
    case QC_TAG.BIDIRECTIONAL_EDGE_ADDED:
      expectLen(tag, bytes, 16);
      return { kind: "BidirectionalEdgeAdded", a: readNodeId(bytes, 0), b: readNodeId(bytes, 8) };
    case QC_TAG.BIDIRECTIONAL_EDGE_DECLINED:
      expectLen(tag, bytes, 16);
      return { kind: "BidirectionalEdgeDeclined", a: readNodeId(bytes, 0), b: readNodeId(bytes, 8) };
    case QC_TAG.DIRECTED_TELEPORT_ADDED:
      expectLen(tag, bytes, 16);
      return { kind: "DirectedTeleportAdded", from: readNodeId(bytes, 0), to: readNodeId(bytes, 8) };
    case QC_TAG.DIRECTED_TELEPORT_DECLINED:
      expectLen(tag, bytes, 16);
      return { kind: "DirectedTeleportDeclined", from: readNodeId(bytes, 0), to: readNodeId(bytes, 8) };
    case QC_TAG.BIDIRECTIONAL_TELEPORT_ADDED:
      expectLen(tag, bytes, 16);
      return { kind: "BidirectionalTeleportAdded", a: readNodeId(bytes, 0), b: readNodeId(bytes, 8) };
    case QC_TAG.BIDIRECTIONAL_TELEPORT_DECLINED:
      expectLen(tag, bytes, 16);
      return { kind: "BidirectionalTeleportDeclined", a: readNodeId(bytes, 0), b: readNodeId(bytes, 8) };
    case QC_TAG.EDGE_REMOVED:
      expectLen(tag, bytes, 16);
      return { kind: "EdgeRemoved", from: readNodeId(bytes, 0), to: readNodeId(bytes, 8) };
    case QC_TAG.EDGE_REMOVE_DECLINED:
      expectLen(tag, bytes, 16);
      return { kind: "EdgeRemoveDeclined", from: readNodeId(bytes, 0), to: readNodeId(bytes, 8) };
    case QC_TAG.EDGE_REMOVED_BETWEEN:
      expectLen(tag, bytes, 16);
      return { kind: "EdgeRemovedBetween", from: readNodeId(bytes, 0), to: readNodeId(bytes, 8) };
    case QC_TAG.EDGE_REMOVE_BETWEEN_DECLINED:
      expectLen(tag, bytes, 16);
      return { kind: "EdgeRemoveBetweenDeclined", from: readNodeId(bytes, 0), to: readNodeId(bytes, 8) };
    case QC_TAG.TELEPORT_REMOVED_WITH_REVERSE:
      expectLen(tag, bytes, 16);
      return { kind: "TeleportRemovedWithReverse", from: readNodeId(bytes, 0), to: readNodeId(bytes, 8) };
    case QC_TAG.TELEPORT_REMOVE_WITH_REVERSE_DECLINED:
      expectLen(tag, bytes, 16);
      return { kind: "TeleportRemoveWithReverseDeclined", from: readNodeId(bytes, 0), to: readNodeId(bytes, 8) };
    case QC_TAG.START_SET:
      expectLen(tag, bytes, 8);
      return { kind: "StartSet", id: readNodeId(bytes, 0) };
    case QC_TAG.START_SET_DECLINED:
      expectLen(tag, bytes, 8);
      return { kind: "StartSetDeclined", id: readNodeId(bytes, 0) };
    case QC_TAG.FINISH_SET:
      expectLen(tag, bytes, 8);
      return { kind: "FinishSet", id: readNodeId(bytes, 0) };
    case QC_TAG.FINISH_SET_DECLINED:
      expectLen(tag, bytes, 8);
      return { kind: "FinishSetDeclined", id: readNodeId(bytes, 0) };

    case QC_TAG.DIRECTED_EDGE_PROPOSED:
      expectLen(tag, bytes, 16);
      return { kind: "DirectedEdgeProposed", from: readNodeId(bytes, 0), to: readNodeId(bytes, 8) };
    case QC_TAG.BIDIRECTIONAL_EDGE_PROPOSED:
      expectLen(tag, bytes, 16);
      return { kind: "BidirectionalEdgeProposed", a: readNodeId(bytes, 0), b: readNodeId(bytes, 8) };
    case QC_TAG.DIRECTED_TELEPORT_PROPOSED:
      expectLen(tag, bytes, 16);
      return { kind: "DirectedTeleportProposed", from: readNodeId(bytes, 0), to: readNodeId(bytes, 8) };
    case QC_TAG.BIDIRECTIONAL_TELEPORT_PROPOSED:
      expectLen(tag, bytes, 16);
      return { kind: "BidirectionalTeleportProposed", a: readNodeId(bytes, 0), b: readNodeId(bytes, 8) };
    case QC_TAG.EDGE_REMOVE_PROPOSED:
      expectLen(tag, bytes, 16);
      return { kind: "EdgeRemoveProposed", from: readNodeId(bytes, 0), to: readNodeId(bytes, 8) };
    case QC_TAG.EDGE_REMOVE_BETWEEN_PROPOSED:
      expectLen(tag, bytes, 16);
      return { kind: "EdgeRemoveBetweenProposed", from: readNodeId(bytes, 0), to: readNodeId(bytes, 8) };
    case QC_TAG.TELEPORT_REMOVE_WITH_REVERSE_PROPOSED:
      expectLen(tag, bytes, 16);
      return { kind: "TeleportRemoveWithReverseProposed", from: readNodeId(bytes, 0), to: readNodeId(bytes, 8) };
    case QC_TAG.START_SET_PROPOSED:
      expectLen(tag, bytes, 8);
      return { kind: "StartSetProposed", id: readNodeId(bytes, 0) };
    case QC_TAG.FINISH_SET_PROPOSED:
      expectLen(tag, bytes, 8);
      return { kind: "FinishSetProposed", id: readNodeId(bytes, 0) };
    default:
      throw new Error(`QcEvent: unknown wire tag ${tag}`);
  }
}

/** Mirrors `DebugEvent::is_mutating`'s split for `QcEvent` in
 *  `maze-core/src/quality_control/event.rs` — `true` for exactly the 9 mutation-mirror variants;
 *  every `*Declined` variant and every trace variant is `false`. */
export function isMutatingQcEvent(event: QcEvent): boolean {
  return (
    event.kind === "DirectedEdgeAdded" ||
    event.kind === "BidirectionalEdgeAdded" ||
    event.kind === "DirectedTeleportAdded" ||
    event.kind === "BidirectionalTeleportAdded" ||
    event.kind === "EdgeRemoved" ||
    event.kind === "EdgeRemovedBetween" ||
    event.kind === "TeleportRemovedWithReverse" ||
    event.kind === "StartSet" ||
    event.kind === "FinishSet"
  );
}

export interface MutatingQcEventAt {
  event: QcEvent;
  nodeIndex: number;
}

/** Flat layer for QC: forward scan over the node table, skipping scope nodes, decoding events,
 *  filtering to mutating ones only — mirrors `mutatingEdgeBasedEventsWithIndex`. No checkpoints
 *  (GitHub issue #128 is RB-only; QC's own tape is expected far shorter than a full generation
 *  tape — see the plan's "out of scope" section), same `startIndex`/`limit` shape for consistency
 *  with every other `mutatingXEventsWithIndex`. */
export function mutatingQcEventsWithIndex(tape: ParsedTape, limit?: number, startIndex = 0, endIndex?: number): MutatingQcEventAt[] {
  return mutatingEventsWithIndex(tape, decodeQcEvent, isMutatingQcEvent, limit, startIndex, endIndex);
}

/** Convenience wrapper over `mutatingQcEventsWithIndex` for callers that only need the decoded
 *  events, not their arena indices. */
export function mutatingQcEvents(tape: ParsedTape, limit?: number, startIndex = 0, endIndex?: number): QcEvent[] {
  return mutatingQcEventsWithIndex(tape, limit, startIndex, endIndex).map((e) => e.event);
}

export interface QcApplyResult {
  /** `edges`/`removedEdges` — QC's own contribution, expressed as an add/remove patch rather than
   *  a full edge list (unlike every generation adapter's `ApplyResult.edges`, which is a
   *  ground-truth full list built from scratch each replay). QC operates on an *existing* graph a
   *  generation source already built, so `mergeDebugMazeView` (`debugSelectors.ts`) needs to know
   *  which edges QC added on top of generation's own list and which it removed from it — a plain
   *  `edges` list alone can't express "remove this edge", only "these edges exist". */
  edges: Edge[];
  removedEdges: { from: bigint; to: bigint }[];
  start: bigint | null;
  finish: bigint | null;
  step: number;
  nodeIndex: number;
}

/** Replays QC's own mutating events, starting the underlying node-table scan at `startNodeIndex`
 *  (the QC top-level source scope's own arena index — see `topLevelSourceScopes`/
 *  `sourceScopeForNode` below) rather than index 0: QC is always merged as a source *after*
 *  generation (Contract A, `Specs/event_log.md`'s #147 section), so its own mutating events never
 *  start at the beginning of the merged tape. `targetStep` is relative to QC's own mutating-event
 *  stream (0-based, independent of however many generation steps preceded it) — the caller
 *  (`selectDebugMazeView`) is responsible for subtracting generation's own step count first.
 *
 *  Processes events **in order**, folding each add/remove into a running `Edge` accumulator keyed
 *  by `from:to` (not two independent append-only lists) — QC's own repair loop can plausibly add
 *  an edge in one iteration and remove that same edge in a later one within the same
 *  `[0, targetStep]` window (e.g. one strategy adds a shortcut, a later check flags it invalid,
 *  another strategy removes it); folding in order means a later remove correctly cancels an
 *  earlier add from *this same contribution*, and a later re-add correctly overrides an earlier
 *  remove, before this result is ever handed to `mergeDebugMazeView`. Only the *net* additions and
 *  removals relative to `[0, targetStep]`'s starting point (nothing from this source yet) are
 *  reported — `removedEdges` therefore only ever needs to reach into an *earlier* source's
 *  contribution (e.g. generation's own edge list), never cancel this same call's own `edges`.
 *
 *  `EdgeRemoved`/`TeleportRemovedWithReverse` carry the removed edge's `(from, to)` (GitHub issue
 *  #171's follow-up fix — resolved on the Rust side from the graph immediately before removal,
 *  since the wire's own `EdgeId` alone is meaningless off-graph) and participate in the keyed
 *  accumulator exactly like `EdgeRemovedBetween`. */
export function applyQc(tape: ParsedTape, targetStep: number, from?: QcApplyResult, startNodeIndex = 0): QcApplyResult {
  validateStepShape("targetStep", targetStep);
  if (from) {
    validateStepShape("from.step", from.step);
    validateStepShape("from.nodeIndex", from.nodeIndex);
    if (from.step > targetStep) {
      throw new Error(`applyQc: from.step ${from.step} is ahead of targetStep ${targetStep}`);
    }
    if (from.step === targetStep) {
      return { edges: [...from.edges], removedEdges: [...from.removedEdges], start: from.start, finish: from.finish, step: targetStep, nodeIndex: from.nodeIndex };
    }
  }

  const scanStart = from ? from.nodeIndex + 1 : startNodeIndex;
  const needed = targetStep - (from?.step ?? -1);
  const events = mutatingQcEventsWithIndex(tape, needed, scanStart);
  if (events.length < needed) {
    const total = (from?.step ?? -1) + 1 + events.length;
    throw new Error(`targetStep ${targetStep} out of range [0, ${total})`);
  }

  // Keyed by `from:to`, in event order — `net.set(key, edge)` on add, `net.delete(key)` on
  // remove, so a later event always overrides an earlier one for the same pair, regardless of
  // whether it's add-then-remove or remove-then-(re-)add. Seeded from `from`'s own net state when
  // resuming — `from.edges`/`from.removedEdges` are already the flattened `[0, from.step]` result,
  // so re-keying them back into `net`/`removedFromEarlierSources` reproduces the same accumulator
  // a from-scratch replay up to `from.step` would have built.
  const net = new Map<string, Edge>(from ? from.edges.map((e) => [`${e.from}:${e.to}`, e]) : undefined);
  const removedFromEarlierSources = new Set<string>(from ? from.removedEdges.map((e) => `${e.from}:${e.to}`) : undefined);
  let start: bigint | null = from?.start ?? null;
  let finish: bigint | null = from?.finish ?? null;

  const add = (from: bigint, to: bigint, kind: "basic" | "teleport") => {
    const key = `${from}:${to}`;
    net.set(key, { from, to, kind });
    removedFromEarlierSources.delete(key);
  };
  const remove = (from: bigint, to: bigint) => {
    const key = `${from}:${to}`;
    if (net.has(key)) {
      net.delete(key);
    } else {
      removedFromEarlierSources.add(key);
    }
  };

  for (const { event } of events) {
    switch (event.kind) {
      case "DirectedEdgeAdded":
        add(event.from, event.to, "basic");
        break;
      case "BidirectionalEdgeAdded":
        add(event.a, event.b, "basic");
        add(event.b, event.a, "basic");
        break;
      case "DirectedTeleportAdded":
        add(event.from, event.to, "teleport");
        break;
      case "BidirectionalTeleportAdded":
        add(event.a, event.b, "teleport");
        add(event.b, event.a, "teleport");
        break;
      case "EdgeRemovedBetween":
      case "EdgeRemoved":
      case "TeleportRemovedWithReverse":
        remove(event.from, event.to);
        break;
      case "StartSet":
        start = event.id;
        break;
      case "FinishSet":
        finish = event.id;
        break;
      default:
        break;
    }
  }

  const edges = [...net.values()];
  const removedEdges = [...removedFromEarlierSources].map((key) => {
    const [from, to] = key.split(":");
    return { from: BigInt(from), to: BigInt(to) };
  });

  return { edges, removedEdges, start, finish, step: targetStep, nodeIndex: events[events.length - 1].nodeIndex };
}

/** Given any arena node index, walks `.parent` up to the nearest top-level source scope and
 *  returns it — the single place this walk happens (Contract B, `Specs/event_log.md`'s #147
 *  section): `debugTreeSelectors.ts`/`DebugEventTree.tsx` call this instead of walking
 *  `record.parent` themselves, so "which source does this node belong to" has exactly one
 *  implementation. Throws if `nodeIndex` is the merged root itself (index 0) or otherwise has no
 *  top-level-scope ancestor — every real node produced by `merge_tapes` has one by construction. */
export function sourceScopeForNode(tape: ParsedTape, nodeIndex: number): TopLevelSourceScope {
  if (nodeIndex === 0) {
    throw new Error("sourceScopeForNode: node 0 is the merged root itself, not a member of any source scope");
  }
  let current = nodeAt(tape, nodeIndex);
  let currentIndex = nodeIndex;
  while (current.parent !== null && current.parent !== 0) {
    currentIndex = current.parent;
    current = nodeAt(tape, currentIndex);
  }
  if (current.parent !== 0) {
    throw new Error(`sourceScopeForNode: node ${nodeIndex} has no top-level-scope ancestor under the merged root`);
  }
  const bytes = tape.payload.subarray(current.payloadOffset, current.payloadOffset + current.payloadLen);
  return { scopeName: textDecoder.decode(bytes), nodeIndex: currentIndex };
}
