// --- CustomVertexBased event replay (GitHub issue #143; decoding lives in generated/vertexBased.ts) ---

import { type ParsedTape } from "./wire";
import { mutatingEventsWithIndex, type MutatingEventAt } from "./scan";
import { cloneDebugValues, validateStepShape, type DebugValueOp, type DebugValues, type Edge } from "./applyShared";
import { VISITED } from "./recursiveBacktracker";
import { decodeVertexBasedEvent, isMutatingVertexBasedEvent, type VertexBasedEvent } from "./generated/vertexBased";

export type { VertexBasedEvent } from "./generated/vertexBased";
export { decodeVertexBasedEvent, isMutatingVertexBasedEvent, VERTEX_BASED_EVENT_TAG } from "./generated/vertexBased";

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
    if (event.kind === "VerticalPassageAdded") {
      if (!event.oneWay) {
        edges.push({ from: event.src, to: event.dst, kind: "vertical_passage" });
        edges.push({ from: event.dst, to: event.src, kind: "vertical_passage" });
      } else if (event.upward) {
        edges.push({ from: event.src, to: event.dst, kind: "vertical_passage" });
      } else {
        // `upward: false` (`vertex_based.rs`'s `add_vertical_passage_edge`) swaps the real
        // directed edge to `dst -> src` — `src`/`dst` here are only the resolved target-pair
        // *values*, not the actual edge direction, so this must mirror that swap or a one-way
        // downward passage replays backwards (GitHub issue #337/#347 regression).
        edges.push({ from: event.dst, to: event.src, kind: "vertical_passage" });
      }
    }
    if (event.kind === "ElevatorAdded") {
      // Fan reconstruction (GitHub issue #337): `ElevatorAdded` carries the participating node set,
      // not individual edges — `edgesAdded` (may be fewer than the full each-to-each fan on a
      // preset conflict, see `vertex_based.rs`'s ElevatorAdded doc comment) can't tell us *which*
      // pairs were skipped, so this reconstructs the full fan. Only over-renders on the rare preset-
      // conflict case, same tradeoff already accepted elsewhere in this replay layer.
      for (let i = 0; i < event.nodes.length; i++) {
        for (let j = i + 1; j < event.nodes.length; j++) {
          edges.push({ from: event.nodes[i], to: event.nodes[j], kind: "elevator" });
          edges.push({ from: event.nodes[j], to: event.nodes[i], kind: "elevator" });
        }
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
