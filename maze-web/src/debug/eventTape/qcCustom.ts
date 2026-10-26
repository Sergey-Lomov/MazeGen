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
 *  `MutationCommand::ReplacePointNodes` (GitHub issue #247). `kind` added in issue #281, needed
 *  once `RemoveSplitStrategy` started redistributing Teleport edges through this same command. */
export type SplitNodeEdgeDirection = "Forward" | "Backward" | "Passage";
export type SplitNodeEdgeKind = "Basic" | "Teleport";
export interface SplitNodeEdge {
  target: bigint;
  direction: SplitNodeEdgeDirection;
  kind: SplitNodeEdgeKind;
}

/** Mirrors `IssuePayload` in `maze-core/src/quality_control/issue_payload.rs` — `None` for the
 *  `Issue` kinds with no structural edge/node payload (see that type's doc comment). */
export type IssuePayload =
  | { kind: "None" }
  | { kind: "InvalidLoop"; edges: Map<string, EdgeGroup[]> }
  | { kind: "RegionNeedsExpansion"; nodes: Map<string, RegionGroup[]> }
  | { kind: "RegionNeedsShrink"; nodes: Map<string, RegionGroup[]> }
  | { kind: "InvalidTeleport"; groups: Map<string, EdgeGroup[]> }
  | { kind: "InvalidOneWay"; groups: Map<string, EdgeGroup[]> }
  | { kind: "InvalidSplitTile"; groups: Map<string, SplitGroup[]> }
  | { kind: "InvalidSplitRoute"; routes: Map<string, [bigint, bigint, boolean][][]> }
  | { kind: "ExcessiveSccCount"; presetLocked: Map<string, boolean> }
  | { kind: "InvalidVerticalPassage"; groups: Map<string, EdgeGroup[]> }
  | { kind: "InvalidElevator"; groups: Map<string, EdgeGroup[]> }
  | { kind: "InvalidElevatorStop"; nodes: Map<string, RegionGroup[]> }
  | { kind: "AreaDeficit"; areas: Map<string, (number | null)[]> }
  | { kind: "MissingElevatorStopCount"; groups: Map<string, MissingElevatorStopsGroup[]> }
  | { kind: "InvalidCrossElementGroup"; groups: Map<string, CrossElementEntry[][]> }
  | { kind: "IndeterminateDistance"; pairs: UndecidedPair[] };

/** Mirrors `IssueUndecidedPairPayload` in `maze-core/src/quality_control/issue_payload/types.rs` —
 *  one pair a geometric check could not decide (GitHub issue #838): a representative node per side
 *  and whether the cause is a topological-only fold (`unsupported`) rather than a distance bracket
 *  straddling the threshold. */
export interface UndecidedPair {
  nodes: [bigint, bigint];
  unsupported: boolean;
}

/** Mirrors `IssueEdgeGroupPayload` in `maze-core/src/quality_control/issue_payload.rs` — one
 *  flagged cycle/group's base-graph edges paired with whether every one of them is
 *  preset-protected (GitHub issue #245): repair can never fix a `presetLocked: true` element. */
export interface EdgeGroup {
  edges: [bigint, bigint][];
  presetLocked: boolean;
}

/** Mirrors `IssueRegionPayload` in `maze-core/src/quality_control/issue_payload.rs` — one flagged
 *  region's member node ids paired with whether it's preset-locked (GitHub issue #245's region
 *  extension). */
export interface RegionGroup {
  region: bigint[];
  presetLocked: boolean;
}

/** Mirrors `IssueSplitTilePayload` in `maze-core/src/quality_control/issue_payload.rs` — one
 *  tile's own node list paired with whether the whole tile is preset-locked. */
export interface SplitTile {
  nodes: bigint[];
  presetLocked: boolean;
}

/** Mirrors `IssueSplitGroupPayload` in `maze-core/src/quality_control/issue_payload.rs` — one
 *  flagged split-tile "instance" (a single tile or a genuine multi-tile group), paired with
 *  whether every tile in it is preset-locked (GitHub issue #245's split extension). */
export interface SplitGroup {
  tiles: SplitTile[];
  presetLocked: boolean;
}

/** Mirrors `IssueMissingElevatorStopsPayload` in `maze-core/src/quality_control/issue_payload/types.rs`
 *  — one flagged elevator's stop-deficit: its live edge fan, how many stops are still requested,
 *  and available floor candidates as node ids (GitHub issue #402). */
export interface MissingElevatorStopsGroup {
  edges: [bigint, bigint][];
  missing: number;
  available: bigint[];
  presetLocked: boolean;
}

/** Reads the `HashMap<String, Vec<IssueEdgeGroupPayload>>` wire shape `write_str_keyed_edge_pairs`
 *  produces (`IssuePayload::InvalidLoop`'s `edges`) — each group is its edge-pair list followed by
 *  one trailing `preset_locked` byte (`write_edge_group_payload`). */
function readStrKeyedEdgePairs(bytes: Uint8Array, offset: number): { value: Map<string, EdgeGroup[]>; next: number } {
  const value = new Map<string, EdgeGroup[]>();
  const entryCount = readU32(bytes, offset);
  let pos = offset + 4;
  for (let i = 0; i < entryCount; i++) {
    const { value: key, next: afterKey } = readStr(bytes, pos);
    pos = afterKey;
    const cycleCount = readU32(bytes, pos);
    pos += 4;
    const cycles: EdgeGroup[] = [];
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
      const presetLocked = bytes[pos] !== 0;
      pos += 1;
      cycles.push({ edges: pairs, presetLocked });
    }
    value.set(key, cycles);
  }
  return { value, next: pos };
}

/** Reads the `HashMap<String, Vec<IssueRegionPayload>>` wire shape `write_str_keyed_node_lists`
 *  produces (`IssuePayload::RegionNeedsExpansion`/`RegionNeedsShrink`'s `nodes`) — each region is
 *  its node id list followed by one trailing `preset_locked` byte (GitHub issue #245's region
 *  extension), mirroring `readStrKeyedEdgePairs`'s own trailing flag. */
function readStrKeyedNodeLists(bytes: Uint8Array, offset: number): { value: Map<string, RegionGroup[]>; next: number } {
  const value = new Map<string, RegionGroup[]>();
  const entryCount = readU32(bytes, offset);
  let pos = offset + 4;
  for (let i = 0; i < entryCount; i++) {
    const { value: key, next: afterKey } = readStr(bytes, pos);
    pos = afterKey;
    const regionCount = readU32(bytes, pos);
    pos += 4;
    const regions: RegionGroup[] = [];
    for (let r = 0; r < regionCount; r++) {
      const nodeCount = readU32(bytes, pos);
      pos += 4;
      const nodes: bigint[] = [];
      for (let n = 0; n < nodeCount; n++) {
        nodes.push(BigInt(readU32(bytes, pos)));
        pos += 4;
      }
      const presetLocked = bytes[pos] !== 0;
      pos += 1;
      regions.push({ region: nodes, presetLocked });
    }
    value.set(key, regions);
  }
  return { value, next: pos };
}

/** Reads one `IssueSplitTilePayload` — a node-id list (length-prefixed `u32`s) followed by a
 *  trailing 1-byte `preset_locked` flag, mirroring `write_split_tile_payload`. */
function readSplitTile(bytes: Uint8Array, offset: number): { value: SplitTile; next: number } {
  const nodeCount = readU32(bytes, offset);
  let pos = offset + 4;
  const nodes: bigint[] = [];
  for (let n = 0; n < nodeCount; n++) {
    nodes.push(BigInt(readU32(bytes, pos)));
    pos += 4;
  }
  const presetLocked = bytes[pos] !== 0;
  pos += 1;
  return { value: { nodes, presetLocked }, next: pos };
}

/** Reads the `HashMap<String, Vec<IssueSplitGroupPayload>>` wire shape
 *  `write_str_keyed_split_groups` produces (`IssuePayload::InvalidSplitTile`'s `groups`) — each
 *  entry is a length-prefixed list of tiles (`readSplitTile`'s shape) followed by a trailing
 *  1-byte group-level `preset_locked` flag. */
function readStrKeyedSplitGroups(bytes: Uint8Array, offset: number): { value: Map<string, SplitGroup[]>; next: number } {
  const value = new Map<string, SplitGroup[]>();
  const entryCount = readU32(bytes, offset);
  let pos = offset + 4;
  for (let i = 0; i < entryCount; i++) {
    const { value: key, next: afterKey } = readStr(bytes, pos);
    pos = afterKey;
    const groupCount = readU32(bytes, pos);
    pos += 4;
    const groups: SplitGroup[] = [];
    for (let g = 0; g < groupCount; g++) {
      const tileCount = readU32(bytes, pos);
      pos += 4;
      const tiles: SplitTile[] = [];
      for (let t = 0; t < tileCount; t++) {
        const { value: tile, next } = readSplitTile(bytes, pos);
        tiles.push(tile);
        pos = next;
      }
      const presetLocked = bytes[pos] !== 0;
      pos += 1;
      groups.push({ tiles, presetLocked });
    }
    value.set(key, groups);
  }
  return { value, next: pos };
}

/** Reads the `HashMap<String, bool>` wire shape `write_str_keyed_bools` produces
 *  (`IssuePayload::ExcessiveSccCount`'s `preset_locked`) — one 1-byte flag per key, no nested
 *  lists (this issue carries no per-region highlight data of its own). */
function readStrKeyedBools(bytes: Uint8Array, offset: number): { value: Map<string, boolean>; next: number } {
  const value = new Map<string, boolean>();
  const entryCount = readU32(bytes, offset);
  let pos = offset + 4;
  for (let i = 0; i < entryCount; i++) {
    const { value: key, next: afterKey } = readStr(bytes, pos);
    pos = afterKey;
    value.set(key, bytes[pos] !== 0);
    pos += 1;
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
 *  (0=Forward, 1=Backward, 2=Passage), one byte for `kind` (0=Basic, 1=Teleport — issue #281),
 *  followed by the 8-byte `target` node id. */
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
      const kindByte = bytes[pos + 1];
      const kind: SplitNodeEdgeKind = kindByte === 0 ? "Basic" : "Teleport";
      const target = readNodeId(bytes, pos + 2);
      edges.push({ target, direction, kind });
      pos += 10;
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

/** Reads the `HashMap<String, Vec<Option<u32>>>` wire shape `write_str_keyed_area_deficits`
 *  produces (`IssuePayload::AreaDeficit`'s `areas`) — one presence byte per entry (0 = `null`, no
 *  floor to highlight; 1 = a floor index, its `levels_ordered()` position, as a plain `number`
 *  since it's a floor index, not a `NodeId`). */
function readStrKeyedAreaDeficits(bytes: Uint8Array, offset: number): { value: Map<string, (number | null)[]>; next: number } {
  const value = new Map<string, (number | null)[]>();
  const entryCount = readU32(bytes, offset);
  let pos = offset + 4;
  for (let i = 0; i < entryCount; i++) {
    const { value: key, next: afterKey } = readStr(bytes, pos);
    pos = afterKey;
    const areaCount = readU32(bytes, pos);
    pos += 4;
    const areas: (number | null)[] = [];
    for (let a = 0; a < areaCount; a++) {
      const present = bytes[pos];
      pos += 1;
      if (present === 0) {
        areas.push(null);
      } else {
        areas.push(readU32(bytes, pos));
        pos += 4;
      }
    }
    value.set(key, areas);
  }
  return { value, next: pos };
}

/** Mirrors `CrossElementPayloadEntry` in `maze-core/src/quality_control/issue_payload/types.rs` —
 *  one logical element of a flagged cross-element proximity pair (GitHub issue #376). `kind` is
 *  `"teleport"` / `"one_way"` / `"vertical_passage"` / `"elevator_stop"` / `"split"` / `"start"` /
 *  `"finish"`; only the geometry field matching `kind` is populated (`elevator_stop` populates just
 *  `nodes` — the flagged stop cell; its fan edges reach every other floor so `edges` stays empty).
 *  `removable` is `false` for start / finish. */
export interface CrossElementEntry {
  kind: string;
  edges: [bigint, bigint][];
  nodes: bigint[];
  tile: SplitTile | null;
  removable: boolean;
  presetLocked: boolean;
}

/** Reads the `HashMap<String, Vec<Vec<CrossElementPayloadEntry>>>` wire shape
 *  `write_str_keyed_cross_element_groups` produces (`IssuePayload::InvalidCrossElementGroup`'s
 *  `groups`) — each entry is a length-prefixed list of pairs, each pair a length-prefixed list of
 *  entries (`write_cross_element_entry`: `kind` string, edge-pair list, node list, an optional
 *  tile behind a presence byte, then `removable` and `preset_locked` bytes). */
function readStrKeyedCrossElementGroups(bytes: Uint8Array, offset: number): { value: Map<string, CrossElementEntry[][]>; next: number } {
  const value = new Map<string, CrossElementEntry[][]>();
  const entryCount = readU32(bytes, offset);
  let pos = offset + 4;
  for (let i = 0; i < entryCount; i++) {
    const { value: key, next: afterKey } = readStr(bytes, pos);
    pos = afterKey;
    const pairCount = readU32(bytes, pos);
    pos += 4;
    const pairs: CrossElementEntry[][] = [];
    for (let g = 0; g < pairCount; g++) {
      const memberCount = readU32(bytes, pos);
      pos += 4;
      const members: CrossElementEntry[] = [];
      for (let m = 0; m < memberCount; m++) {
        const { value: kind, next: afterKind } = readStr(bytes, pos);
        pos = afterKind;
        const edgeCount = readU32(bytes, pos);
        pos += 4;
        const edges: [bigint, bigint][] = [];
        for (let e = 0; e < edgeCount; e++) {
          edges.push([BigInt(readU32(bytes, pos)), BigInt(readU32(bytes, pos + 4))]);
          pos += 8;
        }
        const nodeCount = readU32(bytes, pos);
        pos += 4;
        const nodes: bigint[] = [];
        for (let n = 0; n < nodeCount; n++) {
          nodes.push(BigInt(readU32(bytes, pos)));
          pos += 4;
        }
        let tile: SplitTile | null = null;
        const hasTile = bytes[pos] !== 0;
        pos += 1;
        if (hasTile) {
          const { value: t, next } = readSplitTile(bytes, pos);
          tile = t;
          pos = next;
        }
        const removable = bytes[pos] !== 0;
        pos += 1;
        const presetLocked = bytes[pos] !== 0;
        pos += 1;
        members.push({ kind, edges, nodes, tile, removable, presetLocked });
      }
      pairs.push(members);
    }
    value.set(key, pairs);
  }
  return { value, next: pos };
}

/** Reads the `HashMap<String, Vec<IssueMissingElevatorStopsPayload>>` wire shape
 *  `write_str_keyed_missing_elevator_stops` produces (`IssuePayload::MissingElevatorStopCount`'s
 *  `groups`) — each entry is its edge-pair list (`write_edge_pairs`'s shape), a 4-byte `missing`
 *  count, a length-prefixed `available` node-id list, then a trailing `preset_locked` byte. */
function readStrKeyedMissingElevatorStops(bytes: Uint8Array, offset: number): { value: Map<string, MissingElevatorStopsGroup[]>; next: number } {
  const value = new Map<string, MissingElevatorStopsGroup[]>();
  const entryCount = readU32(bytes, offset);
  let pos = offset + 4;
  for (let i = 0; i < entryCount; i++) {
    const { value: key, next: afterKey } = readStr(bytes, pos);
    pos = afterKey;
    const groupCount = readU32(bytes, pos);
    pos += 4;
    const groups: MissingElevatorStopsGroup[] = [];
    for (let g = 0; g < groupCount; g++) {
      const pairCount = readU32(bytes, pos);
      pos += 4;
      const edges: [bigint, bigint][] = [];
      for (let p = 0; p < pairCount; p++) {
        const from = BigInt(readU32(bytes, pos));
        const to = BigInt(readU32(bytes, pos + 4));
        edges.push([from, to]);
        pos += 8;
      }
      const missing = readU32(bytes, pos);
      pos += 4;
      const availableCount = readU32(bytes, pos);
      pos += 4;
      const available: bigint[] = [];
      for (let a = 0; a < availableCount; a++) {
        available.push(BigInt(readU32(bytes, pos)));
        pos += 4;
      }
      const presetLocked = bytes[pos] !== 0;
      pos += 1;
      groups.push({ edges, missing, available, presetLocked });
    }
    value.set(key, groups);
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
    const { value: groups, next } = readStrKeyedSplitGroups(bytes, offset + 1);
    return { value: { kind: "InvalidSplitTile", groups }, next };
  }
  if (tag === 7) {
    const { value: routes, next } = readStrKeyedRoutes(bytes, offset + 1);
    return { value: { kind: "InvalidSplitRoute", routes }, next };
  }
  if (tag === 8) {
    const { value: presetLocked, next } = readStrKeyedBools(bytes, offset + 1);
    return { value: { kind: "ExcessiveSccCount", presetLocked }, next };
  }
  if (tag === 9) {
    const { value: groups, next } = readStrKeyedEdgePairs(bytes, offset + 1);
    return { value: { kind: "InvalidVerticalPassage", groups }, next };
  }
  if (tag === 10) {
    const { value: groups, next } = readStrKeyedEdgePairs(bytes, offset + 1);
    return { value: { kind: "InvalidElevator", groups }, next };
  }
  if (tag === 11) {
    const { value: nodes, next } = readStrKeyedNodeLists(bytes, offset + 1);
    return { value: { kind: "InvalidElevatorStop", nodes }, next };
  }
  if (tag === 12) {
    const { value: areas, next } = readStrKeyedAreaDeficits(bytes, offset + 1);
    return { value: { kind: "AreaDeficit", areas }, next };
  }
  if (tag === 13) {
    const { value: groups, next } = readStrKeyedMissingElevatorStops(bytes, offset + 1);
    return { value: { kind: "MissingElevatorStopCount", groups }, next };
  }
  if (tag === 14) {
    const { value: groups, next } = readStrKeyedCrossElementGroups(bytes, offset + 1);
    return { value: { kind: "InvalidCrossElementGroup", groups }, next };
  }
  if (tag === 15) {
    const count = readU32(bytes, offset + 1);
    let pos = offset + 5;
    const pairs: UndecidedPair[] = [];
    for (let i = 0; i < count; i++) {
      const a = BigInt(readU32(bytes, pos));
      const b = BigInt(readU32(bytes, pos + 4));
      pairs.push({ nodes: [a, b], unsupported: bytes[pos + 8] !== 0 });
      pos += 9;
    }
    return { value: { kind: "IndeterminateDistance", pairs }, next: pos };
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
