// --- CustomEdgeBased event replay (GitHub issue #144; decoding lives in generated/edgeBased.ts) ---

import { type ParsedTape } from "./wire";
import { mutatingEventsWithIndex, type MutatingEventAt } from "./scan";
import { cloneDebugValues, foldDebugValueDelta, validateStepShape, type DebugValueOp, type DebugValues, type Edge } from "./applyShared";
import { VISITED } from "./recursiveBacktracker";
import { decodeEdgeBasedEvent, isMutatingEdgeBasedEvent, type EdgeBasedEvent } from "./generated/edgeBased";

export type { EdgeBasedEvent } from "./generated/edgeBased";
export { decodeEdgeBasedEvent, isMutatingEdgeBasedEvent, EDGE_BASED_EVENT_TAG } from "./generated/edgeBased";

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
