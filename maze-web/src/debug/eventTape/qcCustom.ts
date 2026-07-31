// Hand-written custom-field decoders for QcEvent (registered in codegen/src/codecs.rs as
// IssuePayloadCodec/SplitNodeEdgesCodec/DetailsMapCodec/IssueKindCodec/RepairLimitKindCodec/
// CheckIssueCodec/DetailsMapMapCodec) — mirrors the matching `write_*` functions in
// `maze-core/src/quality_control/event.rs`. None of `QcEvent`'s nested `HashMap`/enum-payload
// fields are standard wire types, so the generated `decodeQcEvent` calls these by name instead of
// inlining their bytes.

import { readNodeId, readStr, readU32 } from "./wire";

export type RepairLimitKind = "MaxIterations" | "TimeBudget";

/** Mirrors `repair::SplitNodeEdgeDirection`/`SplitNodeEdge` in `maze-core/src/repair/command.rs`
 *  — one new node's edge to an already-existing graph node, minted by
 *  `MutationCommand::ReplacePointNodes` (GitHub issue #247). */
export type SplitNodeEdgeDirection = "Forward" | "Backward" | "Passage";
export interface SplitNodeEdge {
  target: bigint;
  direction: SplitNodeEdgeDirection;
}

/** Mirrors `IssuePayload` in `maze-core/src/quality_control/issue_payload.rs` — `None` for the
 *  `Issue` kinds with no structural edge/node payload (see that type's doc comment). */
export type IssuePayload =
  | { kind: "None" }
  | { kind: "InvalidLoop"; edges: Map<string, [bigint, bigint][][]> }
  | { kind: "RegionNeedsExpansion"; nodes: Map<string, bigint[][]> }
  | { kind: "RegionNeedsShrink"; nodes: Map<string, bigint[][]> }
  | { kind: "InvalidTeleport"; groups: Map<string, [bigint, bigint][][]> }
  | { kind: "InvalidOneWay"; groups: Map<string, [bigint, bigint][][]> }
  | { kind: "InvalidSplitTile"; nodes: Map<string, bigint[]> }
  | { kind: "InvalidSplitRoute"; routes: Map<string, [bigint, bigint, boolean][][]> };

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

/** Reads the `HashMap<String, Vec<u32>>` wire shape `write_str_keyed_flat_node_lists` produces
 *  (`IssuePayload::InvalidSplitTile`'s `nodes` — flat, no region-grouping level unlike
 *  `RegionNeedsExpansion`). */
function readStrKeyedFlatNodeLists(bytes: Uint8Array, offset: number): { value: Map<string, bigint[]>; next: number } {
  const value = new Map<string, bigint[]>();
  const entryCount = readU32(bytes, offset);
  let pos = offset + 4;
  for (let i = 0; i < entryCount; i++) {
    const { value: key, next: afterKey } = readStr(bytes, pos);
    pos = afterKey;
    const nodeCount = readU32(bytes, pos);
    pos += 4;
    const nodes: bigint[] = [];
    for (let n = 0; n < nodeCount; n++) {
      nodes.push(BigInt(readU32(bytes, pos)));
      pos += 4;
    }
    value.set(key, nodes);
  }
  return { value, next: pos };
}

/** Reads the `HashMap<String, Vec<Vec<(u32, u32, bool)>>>` wire shape `write_str_keyed_routes`
 *  produces (`IssuePayload::InvalidSplitRoute`'s `routes`) — one ordered edge-triple sequence per
 *  route, order preserved exactly as encoded (a route is a path, not a set, unlike every other
 *  `readStrKeyed*` helper above). */
function readStrKeyedRoutes(bytes: Uint8Array, offset: number): { value: Map<string, [bigint, bigint, boolean][][]>; next: number } {
  const value = new Map<string, [bigint, bigint, boolean][][]>();
  const entryCount = readU32(bytes, offset);
  let pos = offset + 4;
  for (let i = 0; i < entryCount; i++) {
    const { value: key, next: afterKey } = readStr(bytes, pos);
    pos = afterKey;
    const routeCount = readU32(bytes, pos);
    pos += 4;
    const routes: [bigint, bigint, boolean][][] = [];
    for (let r = 0; r < routeCount; r++) {
      const edgeCount = readU32(bytes, pos);
      pos += 4;
      const edges: [bigint, bigint, boolean][] = [];
      for (let e = 0; e < edgeCount; e++) {
        const from = BigInt(readU32(bytes, pos));
        const to = BigInt(readU32(bytes, pos + 4));
        const isSplit = bytes[pos + 8] !== 0;
        edges.push([from, to, isSplit]);
        pos += 9;
      }
      routes.push(edges);
    }
    value.set(key, routes);
  }
  return { value, next: pos };
}

/** Reads the `Vec<Vec<SplitNodeEdge>>` wire shape `write_split_nodes` produces — one new node's
 *  edge list per entry (entry 0 the new slot-0), each edge as one byte for `direction`
 *  (0=Forward, 1=Backward, 2=Passage) followed by the 8-byte `target` node id. */
export function readSplitNodes(bytes: Uint8Array, offset: number): { value: SplitNodeEdge[][]; next: number } {
  const nodeCount = readU32(bytes, offset);
  let pos = offset + 4;
  const nodes: SplitNodeEdge[][] = [];
  for (let s = 0; s < nodeCount; s++) {
    const edgeCount = readU32(bytes, pos);
    pos += 4;
    const edges: SplitNodeEdge[] = [];
    for (let e = 0; e < edgeCount; e++) {
      const directionByte = bytes[pos];
      const direction: SplitNodeEdgeDirection = directionByte === 0 ? "Forward" : directionByte === 1 ? "Backward" : "Passage";
      const target = readNodeId(bytes, pos + 1);
      edges.push({ target, direction });
      pos += 9;
    }
    nodes.push(edges);
  }
  return { value: nodes, next: pos };
}

/** Reads one check's own raw display details (GitHub issue #171) — mirrors `write_details`
 *  (`HashMap<&'static str, String>`, e.g. `{"threshold" -> "10"}`). */
export function readDetails(bytes: Uint8Array, offset: number): { value: Map<string, string>; next: number } {
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
export function readDetailsMap(bytes: Uint8Array, offset: number): { value: Map<string, Map<string, string>>; next: number } {
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
export function readIssuePayload(bytes: Uint8Array, offset: number): { value: IssuePayload; next: number } {
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
  if (tag === 3) {
    const { value: nodes, next } = readStrKeyedNodeLists(bytes, offset + 1);
    return { value: { kind: "RegionNeedsShrink", nodes }, next };
  }
  if (tag === 4) {
    const { value: groups, next } = readStrKeyedEdgePairs(bytes, offset + 1);
    return { value: { kind: "InvalidTeleport", groups }, next };
  }
  if (tag === 5) {
    const { value: groups, next } = readStrKeyedEdgePairs(bytes, offset + 1);
    return { value: { kind: "InvalidOneWay", groups }, next };
  }
  if (tag === 6) {
    const { value: nodes, next } = readStrKeyedFlatNodeLists(bytes, offset + 1);
    return { value: { kind: "InvalidSplitTile", nodes }, next };
  }
  if (tag === 7) {
    const { value: routes, next } = readStrKeyedRoutes(bytes, offset + 1);
    return { value: { kind: "InvalidSplitRoute", routes }, next };
  }
  throw new Error(`IssuePayload: unknown tag ${tag}`);
}

/** Reads an `IssueKind` — mirrors `write_issue_kind` (`IssueKind::as_str()`, a length-prefixed
 *  UTF-8 string, same wire shape as any other `String` field but referenced by its own codec since
 *  the Rust-side field type is `IssueKind`, not `String`). */
export function readIssueKind(bytes: Uint8Array, offset: number): { value: string; next: number } {
  return readStr(bytes, offset);
}

/** Reads a `RepairLimitKind` — mirrors `write_repair_limit_kind` (a single discriminant byte). */
export function readRepairLimitKind(bytes: Uint8Array, offset: number): { value: RepairLimitKind; next: number } {
  const byte = bytes[offset];
  if (byte === 0) return { value: "MaxIterations", next: offset + 1 };
  if (byte === 1) return { value: "TimeBudget", next: offset + 1 };
  throw new Error(`RepairLimitKind: unknown byte ${byte}`);
}

/** Reads `CheckRan`'s `issue` field — a presence byte, then (if present) the check's issue
 *  `kind`/`payload`/per-check `details` as one atomic unit — mirrors `write_check_issue`. Not
 *  split into 3 separate standard fields: this single named codec covers the whole field, the same
 *  way its Rust counterpart does (see that function's own doc comment). */
export function readCheckIssue(bytes: Uint8Array, offset: number): { value: { issueKind: string; payload: IssuePayload; details: Map<string, string> } | null; next: number } {
  const present = bytes[offset];
  if (present === 0) return { value: null, next: offset + 1 };
  const { value: issueKind, next: afterKind } = readIssueKind(bytes, offset + 1);
  const { value: payload, next: afterPayload } = readIssuePayload(bytes, afterKind);
  const { value: details, next } = readDetails(bytes, afterPayload);
  return { value: { issueKind, payload, details }, next };
}
