// --- CustomEdgeBased event decoding + replay (GitHub issue #144) ---

import {
  expectLen, readF64, readNodeId, readNodeIdList, readF64List, readOptionalNodeId, readU32,
  type ParsedTape,
} from "./wire";
import { mutatingEventsWithIndex, type MutatingEventAt } from "./scan";
import { cloneDebugValues, foldDebugValueDelta, validateStepShape, type DebugValueOp, type DebugValues, type Edge } from "./applyShared";
import { VISITED } from "./recursiveBacktracker";

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
  CYCLIC_ALREADY_ROLLED: 20,
} as const;

export type EdgeBasedEvent =
  | { kind: "CorridorRollSkipped" }
  | { kind: "CorridorRolled"; prev: bigint; roll: number; corridorLength: number; continued: boolean }
  | { kind: "CorridorDeadNoUnseen"; prev: bigint }
  | { kind: "SrcChosenByDepthFirst"; src: bigint; activeLen: number; position: number; depthFirst: number }
  | { kind: "TeleportRolled"; src: bigint; roll: number; teleportChance: number; fired: boolean }
  | { kind: "TeleportAlreadyRolled"; src: bigint }
  | { kind: "CyclicRolled"; src: bigint; roll: number; cyclicity: number; fired: boolean }
  | { kind: "CyclicAlreadyRolled"; src: bigint }
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

/** Decodes one `CustomEdgeBased` event's binary payload. Contract: only called with `tag >= 1` —
 *  callers filter out `TAG_SCOPE` first. Throws on an unrecognized tag or a `payload_len`
 *  mismatch for fixed-size variants — same error-on-mismatch contract as every other decoder. */
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
    case EDGE_BASED_TAG.CYCLIC_ALREADY_ROLLED:
      expectLen(tag, bytes, 8);
      return { kind: "CyclicAlreadyRolled", src: readNodeId(bytes, 0) };
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

export type MutatingEdgeBasedEventAt = MutatingEventAt<EdgeBasedEvent>;

/** Flat layer for `CustomEdgeBased`: forward scan over the node table, skipping scope nodes,
 *  decoding events, filtering to mutating ones only. No checkpoints (GitHub issue #128 is
 *  RB-only), same `startIndex`/`limit` shape for consistency. */
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
      foldDebugValueDelta(debugValues, presence, name, op, id);
    }
  }

  return { edges, debugValues, step: targetStep, nodeIndex: events[events.length - 1].nodeIndex };
}
