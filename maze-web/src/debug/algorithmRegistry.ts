/** Single dispatch point for everything that varies per instrumented algorithm (GitHub issue
 *  #163) — replaces the if/else chains on `EventedEventKind` that used to be duplicated across
 *  `debugTreeSelectors.ts`, `debugSelectors.ts`, `generateConfigBuilder.ts`, and
 *  `DebugEventTree.tsx`. Every field here is a thin wrapper around an already-existing decode/
 *  apply/narration function in `eventTape.ts` — this module owns no decode/apply/narration logic
 *  of its own, only the routing.
 *
 *  Call sites that still need to branch on `algorithmKind` (only `debugSelectors.ts`'s
 *  `selectDebugMazeView`, whose result shape genuinely differs per algorithm — `dsuGroups` for
 *  Kruskal, `debugMaps`/`debugVertices` for Wilson) must do so only to pick which adapter to use
 *  and how to unpack its `apply()` result — never by calling `applyKruskal`/`applyWilson`/
 *  `applyRecursiveBacktracker`/`decodeKruskalEvent`/etc. directly. `adapterFor` is the only
 *  entry point into those functions from outside this module and `eventTape.ts` itself. */

import {
  type ParsedTape, type ParsedCheckpoints, type ApplyFrom,
  type RecursiveBacktrackerEvent, type KruskalEvent, type WilsonEvent, type EdgeBasedEvent,
  type ApplyResult, type KruskalApplyResult, type WilsonApplyResult, type EdgeBasedApplyResult,
  decodeRecursiveBacktrackerEvent, isMutatingRbEvent, mutatingRbEventsWithIndex, applyRecursiveBacktracker,
  decodeKruskalEvent, isMutatingKruskalEvent, mutatingKruskalEventsWithIndex, mutatingKruskalEvents, applyKruskal, kruskalMergedRoot,
  decodeWilsonEvent, isMutatingWilsonEvent, mutatingWilsonEventsWithIndex, mutatingWilsonEvents, applyWilson,
  decodeEdgeBasedEvent, isMutatingEdgeBasedEvent, mutatingEdgeBasedEventsWithIndex, mutatingEdgeBasedEvents, applyEdgeBased,
  resolveDebugArenaMetadata, parseCheckpoints, type DebugArenaMetadata,
} from "./eventTape";
import type { EventedEventKind } from "../wasm/mazeService";
import * as m from "~/paraglide/messages";

/** One piece of a tokenized narration line — mirrors the `Token` union in `DebugEventTree.tsx`
 *  (re-exported from there to avoid a duplicate declaration; kept here as the type every
 *  adapter's `narrationTokensFor` returns). */
export type Token =
  | { kind: "text"; text: string }
  | { kind: "node"; id: bigint }
  | { kind: "edge"; from: bigint; to: bigint; bidirectional: boolean }
  | { kind: "cycle"; edges: [bigint, bigint][] }
  | { kind: "region"; nodes: bigint[] };

/** Shape shared by every algorithm's adapter. Parameterized by the concrete event type `E`
 *  (`RecursiveBacktrackerEvent`/`KruskalEvent`/`WilsonEvent`) so `decodeEvent`/`isMutatingEvent`/
 *  `narrationTokensFor` stay fully typed at every call site — no `unknown`/`any` laundering. */
export interface BaseAlgorithmAdapter<E> {
  /** debugTreeSelectors.ts: flat-layer mutating-event node indices, for `buildStepIndex`. */
  mutatingNodeIndices(tape: ParsedTape): number[];
  /** generateConfigBuilder.ts: totalSteps + checkpointFroms for a freshly-parsed tape. */
  resolveMetadata(tape: ParsedTape, checkpoints: ParsedCheckpoints | null): DebugArenaMetadata;
  decodeEvent(tag: number, bytes: Uint8Array): E;
  isMutatingEvent(event: E): boolean;
  /** DebugEventTree.tsx: narration tokens for one decoded event. */
  narrationTokensFor(event: E): Token[];
  /** DebugEventTree.tsx: label for a scope row (e.g. "step N"/"edge N"/"walk N", or Wilson's
   *  fixed "search"/"commit" names) — the raw arena scope name in, the localized label out. */
  scopeLabel(scopeName: string): string;
}

/** RB is the only algorithm with checkpoint-based resume (GitHub issue #128 stays RB-only) — its
 *  `apply` takes an optional `from` no other adapter has. */
export interface RbAdapter extends BaseAlgorithmAdapter<RecursiveBacktrackerEvent> {
  apply(tape: ParsedTape, targetStep: number, from?: ApplyFrom): ApplyResult;
}
export interface KruskalAdapter extends BaseAlgorithmAdapter<KruskalEvent> {
  apply(tape: ParsedTape, targetStep: number): KruskalApplyResult;
}
export interface WilsonAdapter extends BaseAlgorithmAdapter<WilsonEvent> {
  apply(tape: ParsedTape, targetStep: number): WilsonApplyResult;
}
export interface EdgeBasedAdapter extends BaseAlgorithmAdapter<EdgeBasedEvent> {
  apply(tape: ParsedTape, targetStep: number): EdgeBasedApplyResult;
}

const STEP_SCOPE_RE = /^(?:step|edge|walk) (\d+)$/;

function numberedScopeIndex(scopeName: string): number {
  const match = STEP_SCOPE_RE.exec(scopeName);
  return match ? Number(match[1]) : 0;
}

function narrationTokensForRb(event: RecursiveBacktrackerEvent): Token[] {
  switch (event.kind) {
    case "VertexSelected": return [{ kind: "text", text: m["debug.tree.vertex_selected"]() + " " }, { kind: "node", id: event.id }];
    case "CandidatesComputed": return [{ kind: "text", text: m["debug.tree.candidates_computed"]({ count: event.ids.length }) }];
    case "DeadEnd": return [{ kind: "text", text: m["debug.tree.dead_end"]() }];
    case "CandidateChosen": return [{ kind: "text", text: m["debug.tree.candidate_chosen"]() + " " }, { kind: "node", id: event.id }];
    case "EdgeAdded":
      return [{ kind: "text", text: m["debug.tree.edge_added"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: event.bidirectional }];
    case "VertexVisited": return [{ kind: "text", text: m["debug.tree.vertex_visited"]() + " " }, { kind: "node", id: event.id }];
    case "VertexPopped": return [{ kind: "text", text: m["debug.tree.vertex_popped"]() + " " }, { kind: "node", id: event.id }];
    case "VertexPushed": return [{ kind: "text", text: m["debug.tree.vertex_pushed"]() + " " }, { kind: "node", id: event.id }];
  }
}

const RB_ADAPTER: RbAdapter = {
  mutatingNodeIndices: (tape) => mutatingRbEventsWithIndex(tape).map((e) => e.nodeIndex),
  resolveMetadata: (tape, checkpoints) => resolveDebugArenaMetadata(tape, checkpoints ?? parseCheckpoints(new Uint8Array(0), new Uint8Array(0))),
  decodeEvent: decodeRecursiveBacktrackerEvent,
  isMutatingEvent: isMutatingRbEvent,
  narrationTokensFor: narrationTokensForRb,
  scopeLabel: (name) => m["debug.tree.step_scope"]({ index: numberedScopeIndex(name) }),
  apply: applyRecursiveBacktracker,
};

/** Kruskal's counterpart to `narrationTokensForRb` (GitHub issue #146). Per explicit user
 *  feedback, narration must make the edge/root relationship explicit, and state the comparison's
 *  outcome in words rather than leaving the reader to infer it from which event follows. */
function narrationTokensForKruskal(event: KruskalEvent): Token[] {
  switch (event.kind) {
    case "EdgesShuffled": return [{ kind: "text", text: m["debug.tree.edges_shuffled"]({ count: event.edges.length }) }];
    case "EdgeSelected":
      return [{ kind: "text", text: m["debug.tree.edge_selected"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "RootsCompared": {
      const rootsEqual = event.rootOfFrom === event.rootOfTo;
      return [
        { kind: "text", text: m["debug.tree.root_of"]() + " " }, { kind: "node", id: event.from },
        { kind: "text", text: " = " }, { kind: "node", id: event.rootOfFrom },
        { kind: "text", text: ", " + m["debug.tree.root_of"]() + " " }, { kind: "node", id: event.to },
        { kind: "text", text: " = " }, { kind: "node", id: event.rootOfTo },
        { kind: "text", text: ". " + (rootsEqual ? m["debug.tree.roots_equal"]() : m["debug.tree.roots_different"]()) },
      ];
    }
    case "EdgeRejected":
      return [{ kind: "text", text: m["debug.tree.edge_rejected"]() }];
    case "EdgeAdded":
      return [{ kind: "text", text: m["debug.tree.edge_added"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: event.bidirectional }];
    case "SetsMerged": {
      const newRoot = kruskalMergedRoot(event.rootA, event.rootB);
      return [
        { kind: "text", text: m["debug.tree.sets_merged"]() + " " }, { kind: "node", id: event.rootA },
        { kind: "text", text: " / " }, { kind: "node", id: event.rootB },
        { kind: "text", text: ". " + m["debug.tree.new_root"]() + " " }, { kind: "node", id: newRoot },
      ];
    }
    case "PresetUnionsApplied":
      return [{ kind: "text", text: m["debug.tree.preset_unions_applied"]({ count: event.pairs.length }) }];
  }
}

const KRUSKAL_ADAPTER: KruskalAdapter = {
  mutatingNodeIndices: (tape) => mutatingKruskalEventsWithIndex(tape).map((e) => e.nodeIndex),
  resolveMetadata: (tape) => ({ totalSteps: mutatingKruskalEvents(tape).length, checkpointFroms: [] }),
  decodeEvent: decodeKruskalEvent,
  isMutatingEvent: isMutatingKruskalEvent,
  narrationTokensFor: narrationTokensForKruskal,
  scopeLabel: (name) => m["debug.tree.edge_scope"]({ index: numberedScopeIndex(name) }),
  apply: applyKruskal,
};

/** Wilson's counterpart to `narrationTokensForRb`/`narrationTokensForKruskal` (GitHub issue
 *  #145). `"walk N"` scopes contain exactly two fixed, non-numbered nested scopes — `"search"`
 *  and `"commit"` — handled by `scopeLabel` below, not here. */
function narrationTokensForWilson(event: WilsonEvent): Token[] {
  switch (event.kind) {
    case "StartVisited": return [{ kind: "text", text: m["debug.tree.start_visited"]() + " " }, { kind: "node", id: event.id }];
    case "WalkStartPicked": return [{ kind: "text", text: m["debug.tree.walk_start_picked"]() + " " }, { kind: "node", id: event.id }];
    case "StepTaken":
      return [{ kind: "text", text: m["debug.tree.step_taken"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "LoopErased": return [{ kind: "text", text: m["debug.tree.loop_erased"]() + " " }, { kind: "node", id: event.node }];
    case "WalkDeadEnd": return [{ kind: "text", text: m["debug.tree.walk_dead_end"]() }];
    case "EdgeAdded":
      return [{ kind: "text", text: m["debug.tree.edge_added"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: event.bidirectional }];
    case "NodeVisited": return [{ kind: "text", text: m["debug.tree.vertex_visited"]() + " " }, { kind: "node", id: event.id }];
  }
}

const WILSON_ADAPTER: WilsonAdapter = {
  mutatingNodeIndices: (tape) => mutatingWilsonEventsWithIndex(tape).map((e) => e.nodeIndex),
  resolveMetadata: (tape) => ({ totalSteps: mutatingWilsonEvents(tape).length, checkpointFroms: [] }),
  decodeEvent: decodeWilsonEvent,
  isMutatingEvent: isMutatingWilsonEvent,
  narrationTokensFor: narrationTokensForWilson,
  // Wilson's "search"/"commit" are fixed, non-numbered scope names (GitHub issue #145's
  // follow-up) — checked before the numbered-scope regex, which wouldn't match them.
  scopeLabel: (name) => {
    if (name === "search") return m["debug.tree.search_scope"]();
    if (name === "commit") return m["debug.tree.commit_scope"]();
    return m["debug.tree.walk_scope"]({ index: numberedScopeIndex(name) });
  },
  apply: applyWilson,
};

/** Formats a roll/param `f64` for narration display, rounded to 2 decimal places for
 *  readability — the exact value is still available in the underlying wire data for any
 *  consumer that needs it (per explicit user decision, narration itself only needs 2 digits). */
function fmt(value: number): string {
  return value.toFixed(2);
}

/** `CustomEdgeBased`'s counterpart to `narrationTokensForRb`/`narrationTokensForKruskal`/
 *  `narrationTokensForWilson` (GitHub issue #144). Every "step N" scope is flat (no nested
 *  sub-scopes, unlike Wilson's search/commit) — mirrors Kruskal's shape, just with many more
 *  decision-level trace events per step, per the issue's granularity requirement. Roll/param
 *  values are rendered via `fmt` (2 decimals) directly in the narration text, per explicit user
 *  request (e.g. "Corridor chance 0.30, roll 0.20 (< 0.30) → continuing corridor from"). */
function narrationTokensForEdgeBased(event: EdgeBasedEvent): Token[] {
  switch (event.kind) {
    case "CorridorRollSkipped":
      return [{ kind: "text", text: m["debug.tree.corridor_roll_skipped"]() }];
    case "CorridorRolled":
      return event.continued
        ? [{ kind: "text", text: m["debug.tree.corridor_rolled_continue"]({ param: fmt(event.corridorLength), roll: fmt(event.roll) }) + " " }, { kind: "node", id: event.prev }]
        : [{ kind: "text", text: m["debug.tree.corridor_rolled_stop"]({ param: fmt(event.corridorLength), roll: fmt(event.roll) }) }];
    case "CorridorDeadNoUnseen":
      return [{ kind: "text", text: m["debug.tree.corridor_dead_no_unseen"]() + " " }, { kind: "node", id: event.prev }];
    case "SrcChosenByDepthFirst":
      return [
        { kind: "text", text: m["debug.tree.src_chosen_by_depth_first"]({ param: fmt(event.depthFirst), position: event.position, total: event.activeLen }) + " " },
        { kind: "node", id: event.src },
      ];
    case "TeleportRolled":
      return [{
        kind: "text",
        text: event.fired
          ? m["debug.tree.teleport_rolled_fired"]({ param: fmt(event.teleportChance), roll: fmt(event.roll) })
          : m["debug.tree.teleport_rolled_not_fired"]({ param: fmt(event.teleportChance), roll: fmt(event.roll) }),
      }];
    case "TeleportAlreadyRolled":
      return [{ kind: "text", text: m["debug.tree.teleport_already_rolled"]() }];
    case "CyclicRolled":
      return [{
        kind: "text",
        text: event.fired
          ? m["debug.tree.cyclic_rolled_fired"]({ param: fmt(event.cyclicity), roll: fmt(event.roll) })
          : m["debug.tree.cyclic_rolled_not_fired"]({ param: fmt(event.cyclicity), roll: fmt(event.roll) }),
      }];
    case "CandidatePoolBuilt":
      return [{
        kind: "text",
        text: event.geometric
          ? m["debug.tree.candidate_pool_built_geometric"]({ count: event.candidates.length })
          : m["debug.tree.candidate_pool_built_teleport"]({ count: event.candidates.length }),
      }];
    case "SrcExhaustedEmptyPool":
      return [{ kind: "text", text: m["debug.tree.src_exhausted_empty_pool"]() }];
    case "CyclicCandidatesComputed":
      return [{
        kind: "text",
        text: event.geometric
          ? m["debug.tree.cyclic_candidates_computed_geometric"]({ count: event.candidates.length })
          : m["debug.tree.cyclic_candidates_computed_teleport"]({ count: event.candidates.length }),
      }];
    case "CyclicEdgeAdded":
      return [{ kind: "text", text: m["debug.tree.cyclic_edge_added"]() + " " }, { kind: "edge", from: event.src, to: event.dst, bidirectional: event.bidirectional }];
    case "CyclicEdgeRejected":
      return [{ kind: "text", text: m["debug.tree.cyclic_edge_rejected"]() + " " }, { kind: "edge", from: event.src, to: event.dst, bidirectional: false }];
    case "DstWeightsComputed":
      return [{
        kind: "text",
        text: m["debug.tree.dst_weights_computed"]({
          param: fmt(event.branching),
          param2: fmt(event.directionality),
          eligible: event.directionalityEligible ? m["debug.tree.directionality_eligible"]() : m["debug.tree.directionality_not_eligible"](),
          count: event.candidates.length,
        }),
      }];
    case "DstChosen":
      return [{ kind: "text", text: m["debug.tree.dst_chosen"]({ roll: fmt(event.roll), total: fmt(event.totalWeight) }) + " " }, { kind: "node", id: event.dst }];
    case "EdgeAdded":
      return [{ kind: "text", text: m["debug.tree.edge_added"]() + " " }, { kind: "edge", from: event.src, to: event.dst, bidirectional: event.bidirectional }];
    case "EdgeRejected":
      return [{ kind: "text", text: m["debug.tree.edge_rejected_edge_based"]() + " " }, { kind: "edge", from: event.src, to: event.dst, bidirectional: false }];
    case "PresetSkipped":
      return [{ kind: "text", text: m["debug.tree.preset_skipped"]() + " " }, { kind: "edge", from: event.src, to: event.dst, bidirectional: false }];
    case "NodeActivated":
      return [{ kind: "text", text: m["debug.tree.node_activated"]() + " " }, { kind: "node", id: event.node }];
    case "SrcExhausted":
      return [{ kind: "text", text: m["debug.tree.src_exhausted"]() + " " }, { kind: "node", id: event.src }];
  }
}

const EDGE_BASED_ADAPTER: EdgeBasedAdapter = {
  mutatingNodeIndices: (tape) => mutatingEdgeBasedEventsWithIndex(tape).map((e) => e.nodeIndex),
  resolveMetadata: (tape) => ({ totalSteps: mutatingEdgeBasedEvents(tape).length, checkpointFroms: [] }),
  decodeEvent: decodeEdgeBasedEvent,
  isMutatingEvent: isMutatingEdgeBasedEvent,
  narrationTokensFor: narrationTokensForEdgeBased,
  scopeLabel: (name) => m["debug.tree.step_scope_edge_based"]({ index: numberedScopeIndex(name) }),
  apply: applyEdgeBased,
};

export function adapterFor(kind: "recursive_backtracker"): RbAdapter;
export function adapterFor(kind: "kruskal"): KruskalAdapter;
export function adapterFor(kind: "wilson"): WilsonAdapter;
export function adapterFor(kind: "edge_based"): EdgeBasedAdapter;
export function adapterFor(kind: EventedEventKind): RbAdapter | KruskalAdapter | WilsonAdapter | EdgeBasedAdapter {
  switch (kind) {
    case "recursive_backtracker": return RB_ADAPTER;
    case "kruskal": return KRUSKAL_ADAPTER;
    case "wilson": return WILSON_ADAPTER;
    case "edge_based": return EDGE_BASED_ADAPTER;
  }
}
