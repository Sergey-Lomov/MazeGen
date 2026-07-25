// --- CustomVertexBased event decoding + replay (GitHub issue #143) ---

import { expectLen, readF64, readNodeId, readNodeIdList, readU32, type ParsedTape } from "./wire";
import { mutatingEventsWithIndex, type MutatingEventAt } from "./scan";
import { cloneDebugValues, validateStepShape, type DebugValueOp, type DebugValues, type Edge } from "./applyShared";
import { VISITED } from "./recursiveBacktracker";

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
  SPLIT_ROLLED: 26,
  SPLIT_NODES_CREATED: 27,
  SPLIT_CYCLIC_ROLLED: 28,
  PATTERN_ADAPTATIONS_COMPUTED: 29,
  PATTERN_ADAPTATION_CHOSEN: 30,
  SPLIT_TELEPORT_ROLLED: 31,
  SPLIT_START_REASSIGNED: 32,
  SPLIT_PARENT_EDGE_RELOCATED: 33,
} as const;

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
  | { kind: "DirectionalityRolled"; roll: number; directionality: number; fired: boolean; straightFound: boolean }
  | { kind: "SplitRolled"; src: bigint; roll: number; splitChance: number; fired: boolean; eligible: boolean }
  | { kind: "SplitNodesCreated"; src: bigint; nodes: bigint[]; pattern: number | null }
  | { kind: "SplitCyclicRolled"; src: bigint; roll: number; cyclicity: number; fired: boolean }
  | { kind: "PatternAdaptationsComputed"; src: bigint; pattern: number; count: number }
  | { kind: "PatternAdaptationChosen"; src: bigint; pattern: number; rotation: number; mirror: boolean }
  | { kind: "SplitTeleportRolled"; roll: number; teleportChance: number; fired: boolean; anchor: bigint | null }
  | { kind: "SplitStartReassigned"; original: bigint; reassignedTo: bigint }
  | { kind: "SplitParentEdgeRelocated"; parent: bigint; src: bigint; takenBy: bigint };

/** Decodes one `CustomVertexBased` event's binary payload. Contract: only called with `tag >= 1`
 *  — callers filter out `TAG_SCOPE` first. Throws on an unrecognized tag or a `payload_len`
 *  mismatch for fixed-size variants — same error-on-mismatch contract as every other decoder. */
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
    case VERTEX_BASED_TAG.SPLIT_ROLLED:
      expectLen(tag, bytes, 26);
      return {
        kind: "SplitRolled",
        src: readNodeId(bytes, 0),
        roll: readF64(bytes, 8),
        splitChance: readF64(bytes, 16),
        fired: bytes[24] !== 0,
        eligible: bytes[25] !== 0,
      };
    case VERTEX_BASED_TAG.SPLIT_NODES_CREATED: {
      const src = readNodeId(bytes, 0);
      const { ids: nodes, next } = readNodeIdList(bytes, 8);
      const hasPattern = bytes[next] !== 0;
      const pattern = hasPattern ? readU32(bytes, next + 1) : null;
      return { kind: "SplitNodesCreated", src, nodes, pattern };
    }
    case VERTEX_BASED_TAG.SPLIT_CYCLIC_ROLLED:
      expectLen(tag, bytes, 25);
      return {
        kind: "SplitCyclicRolled",
        src: readNodeId(bytes, 0),
        roll: readF64(bytes, 8),
        cyclicity: readF64(bytes, 16),
        fired: bytes[24] !== 0,
      };
    case VERTEX_BASED_TAG.PATTERN_ADAPTATIONS_COMPUTED:
      expectLen(tag, bytes, 16);
      return {
        kind: "PatternAdaptationsComputed",
        src: readNodeId(bytes, 0),
        pattern: readU32(bytes, 8),
        count: readU32(bytes, 12),
      };
    case VERTEX_BASED_TAG.PATTERN_ADAPTATION_CHOSEN:
      expectLen(tag, bytes, 17);
      return {
        kind: "PatternAdaptationChosen",
        src: readNodeId(bytes, 0),
        pattern: readU32(bytes, 8),
        rotation: readU32(bytes, 12),
        mirror: bytes[16] !== 0,
      };
    case VERTEX_BASED_TAG.SPLIT_TELEPORT_ROLLED: {
      expectLen(tag, bytes, 26);
      const fired = bytes[16] !== 0;
      const hasAnchor = bytes[17] !== 0;
      const anchor = hasAnchor ? readNodeId(bytes, 18) : null;
      return {
        kind: "SplitTeleportRolled",
        roll: readF64(bytes, 0),
        teleportChance: readF64(bytes, 8),
        fired,
        anchor,
      };
    }
    case VERTEX_BASED_TAG.SPLIT_START_REASSIGNED:
      expectLen(tag, bytes, 16);
      return { kind: "SplitStartReassigned", original: readNodeId(bytes, 0), reassignedTo: readNodeId(bytes, 8) };
    case VERTEX_BASED_TAG.SPLIT_PARENT_EDGE_RELOCATED:
      expectLen(tag, bytes, 24);
      return { kind: "SplitParentEdgeRelocated", parent: readNodeId(bytes, 0), src: readNodeId(bytes, 8), takenBy: readNodeId(bytes, 16) };
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
    event.kind === "SrcChosenFromFrontier" ||
    event.kind === "SplitNodesCreated" ||
    event.kind === "SplitStartReassigned" ||
    event.kind === "SplitParentEdgeRelocated"
  );
}

export type MutatingVertexBasedEventAt = MutatingEventAt<VertexBasedEvent>;

/** Flat layer for `CustomVertexBased`: forward scan over the node table, skipping scope nodes,
 *  decoding events, filtering to mutating ones only. No checkpoints (GitHub issue #128 is
 *  RB-only), same `startIndex`/`limit` shape for consistency. */
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
    case "SplitNodesCreated":
      // Only the newly minted nodes (index 0 is `src`, already visited by whatever brought it
      // into this step) need a delta here — mirrors `VertexBasedEvent::debug_value_deltas` in
      // `vertex_based.rs`. Whether a node also enters `frontier` is decided by its own later
      // `NodeVisited` (or never, for a zero-connection pattern node).
      return event.nodes.slice(1).map((n) => [VISITED, "insert", n] as [string, DebugValueOp, bigint]);
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
  /** Node ids minted mid-run by a `SplitNodesCreated` event seen so far (GitHub issue #222) — every
   *  such node is absent from the field until its own creation step, unlike every other node
   *  (present from the arena's start). `DebugMazeView`'s final node list must exclude a split node
   *  before this set contains it, or the tile reads as an already-split point (with no connections
   *  yet) many steps before the split actually happened, rendering as fully closed. `src` itself
   *  (index 0 of `SplitNodesCreated.nodes`) is never added here — it already existed. */
  createdNodes: bigint[];
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
      return { edges: [...from.edges], debugValues: cloneDebugValues(from.debugValues), createdNodes: [...from.createdNodes], step: targetStep, nodeIndex: from.nodeIndex };
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
  const createdNodes = from ? [...from.createdNodes] : [];
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
    if (event.kind === "SplitNodesCreated") {
      createdNodes.push(...event.nodes.slice(1)); // index 0 is `src`, already existed
    }
    if (event.kind === "SplitParentEdgeRelocated") {
      // Every existing edge entry between `parent` and `src` (either direction — a bidirectional
      // Passage face has two, a one-way face just one) is relocated to `takenBy` with the same
      // direction/kind, mirroring apply_pattern_adaptation's own remove-then-recreate in Rust.
      for (let i = edges.length - 1; i >= 0; i--) {
        const e = edges[i];
        if (e.from === event.parent && e.to === event.src) {
          edges[i] = { ...e, to: event.takenBy };
        } else if (e.from === event.src && e.to === event.parent) {
          edges[i] = { ...e, from: event.takenBy };
        }
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

  return { edges, debugValues, createdNodes, step: targetStep, nodeIndex: events[events.length - 1].nodeIndex };
}
