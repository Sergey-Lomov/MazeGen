// --- Quality-control/repair event decoding + replay (GitHub issue #147) ---

import { expectLen, readNodeId, readU32, readStr, type ParsedTape } from "./wire";
import { mutatingEventsWithIndex, type MutatingEventAt } from "./scan";
import { validateStepShape, type Edge } from "./applyShared";

/** QC event wire tags — mirrors `wire_tags` in `maze-core/src/quality_control/event.rs`.
 *  Independent numbering from every generation algorithm's own `*_TAG`. */
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

  PRESET_SEEDED: 34,
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
  | { kind: "FinishSetProposed"; id: bigint }
  | { kind: "PresetSeeded"; edges: { from: bigint; to: bigint; bidirectional: boolean }[] };

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

    case QC_TAG.PRESET_SEEDED: {
      const count = readU32(bytes, 0);
      expectLen(tag, bytes, 4 + count * 17);
      const edges: { from: bigint; to: bigint; bidirectional: boolean }[] = [];
      for (let i = 0; i < count; i++) {
        const offset = 4 + i * 17;
        edges.push({
          from: readNodeId(bytes, offset),
          to: readNodeId(bytes, offset + 8),
          bidirectional: bytes[offset + 16] !== 0,
        });
      }
      return { kind: "PresetSeeded", edges };
    }
    default:
      throw new Error(`QcEvent: unknown wire tag ${tag}`);
  }
}

/** Mirrors `DebugEvent::is_mutating`'s split for `QcEvent` in
 *  `maze-core/src/quality_control/event.rs` — `true` for the 9 mutation-mirror variants plus
 *  `PresetSeeded`; every `*Declined` variant and every trace variant is `false`. */
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
    event.kind === "FinishSet" ||
    event.kind === "PresetSeeded"
  );
}

export type MutatingQcEventAt = MutatingEventAt<QcEvent>;

/** Flat layer for QC: forward scan over the node table, skipping scope nodes, decoding events,
 *  filtering to mutating ones only. No checkpoints (GitHub issue #128 is RB-only; QC's own tape
 *  is expected far shorter than a full generation tape — see the plan's "out of scope" section),
 *  same `startIndex`/`limit` shape for consistency with every other `mutatingXEventsWithIndex`. */
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
 *  `sourceScopeForNode` in `tree.ts`) rather than index 0: QC is always merged as a source *after*
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
      case "PresetSeeded":
        for (const edge of event.edges) {
          add(edge.from, edge.to, "basic");
          if (edge.bidirectional) add(edge.to, edge.from, "basic");
        }
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
