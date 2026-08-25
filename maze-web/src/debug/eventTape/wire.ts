/** Wire-format primitives shared by every algorithm's decoder in this directory: the flat
 *  node-table record layout, multi-source tag namespacing, and the fixed-width readers every
 *  `decodeXEvent` function builds on. TS mirror of `maze-core/src/event_log/mod.rs`'s Rust
 *  constants; both sides must be updated together on a wire-format change, there is no shared
 *  codegen. */

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

export interface ParsedTape {
  nodeTable: Uint8Array;
  payload: Uint8Array;
  /** DataView over `nodeTable`, named distinctly from the tree layer's `nodeView()` function to
   *  avoid the two being confused at a call site. */
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
   *  source should use `topLevelSourceScopes` (`tree.ts`) rather than reading this field off a scope. */
  sourceIndex: number;
  payloadOffset: number;
  payloadLen: number;
}

function sentinelToNull(v: number): number | null {
  return v === NO_NODE ? null : v;
}

/** Reads and decodes one fixed-stride node record by index — used by both the flat and tree
 *  layers. Unpacks the merge's source-index tag prefix (GitHub issue #169) here, once — `tag`/
 *  `sourceIndex` come back already split, so every decoder elsewhere reads a plain local wire tag
 *  exactly like before merging existed, unaware `nodeAt` did any unpacking at all. `TAG_SCOPE` is
 *  never namespaced, so a scope node's raw tag and unpacked tag are always both `0`. */
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

export const textDecoder = new TextDecoder();

export function expectLen(tag: number, bytes: Uint8Array, expected: number): void {
  if (bytes.byteLength !== expected) {
    throw new Error(`payload: tag ${tag} payload_len ${bytes.byteLength} does not match expected ${expected}`);
  }
}

export function readNodeId(bytes: Uint8Array, offset: number): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true);
}

export function readF64(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(offset, true);
}

export function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

export function readBool(bytes: Uint8Array, offset: number): boolean {
  return bytes[offset] !== 0;
}

/** Reads a `u32`-length-prefixed `NodeId[]` starting at `offset` — mirrors the
 *  `push_ids`/`Vec<NodeId>` wire format in `VertexBasedEvent::encode_payload`. Returns the decoded
 *  ids and the byte offset immediately past the list, so a caller reading further fields after a
 *  variable-length list (e.g. `DstWeightsComputed`'s `weights` after `candidates`) knows where to
 *  continue. */
export function readNodeIdList(bytes: Uint8Array, offset: number): { ids: bigint[]; next: number } {
  const count = readU32(bytes, offset);
  const ids: bigint[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(readNodeId(bytes, offset + 4 + i * 8));
  }
  return { ids, next: offset + 4 + count * 8 };
}

/** Reads a `u32`-length-prefixed `f64[]` starting at `offset` — mirrors `push_f64s`'s wire format
 *  in `VertexBasedEvent::encode_payload`. */
export function readF64List(bytes: Uint8Array, offset: number): { values: number[]; next: number } {
  const count = readU32(bytes, offset);
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    values.push(readF64(bytes, offset + 4 + i * 8));
  }
  return { values, next: offset + 4 + count * 8 };
}

/** Reads an `Option<NodeId>` — a 1-byte presence flag followed by 8 bytes (`0` when absent) —
 *  mirrors `SplitTeleportRolled.anchor`'s wire format in `VertexBasedEvent`. */
export function readOptionalNodeId(bytes: Uint8Array, offset: number): bigint | null {
  return bytes[offset] === 0 ? null : readNodeId(bytes, offset + 1);
}

/** Reads an `Option<usize>` — a 1-byte presence flag followed by a `u32` LE (`0` when absent) —
 *  mirrors `VertexBasedEvent::SplitNodesCreated.pattern`'s wire format (the only `Option<usize>`
 *  field in any source so far). Distinct from `readOptionalNodeId`: the value here is 4 bytes
 *  wide, not 8. */
export function readOptionalUsize(bytes: Uint8Array, offset: number): number | null {
  return bytes[offset] === 0 ? null : readU32(bytes, offset + 1);
}

/** Reads a `u32`-length-prefixed UTF-8 string starting at `offset` — mirrors `write_str` in
 *  `maze-core/src/quality_control/event.rs`. Returns the decoded string and the byte offset
 *  immediately past it, mirroring `readNodeIdList`/`readF64List`'s `{ value, next }` shape. */
export function readStr(bytes: Uint8Array, offset: number): { value: string; next: number } {
  const len = readU32(bytes, offset);
  const start = offset + 4;
  const value = textDecoder.decode(bytes.subarray(start, start + len));
  return { value, next: start + len };
}
