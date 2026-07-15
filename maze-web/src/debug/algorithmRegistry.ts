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
  type RecursiveBacktrackerEvent, type KruskalEvent, type WilsonEvent,
  type ApplyResult, type KruskalApplyResult, type WilsonApplyResult,
  decodeRecursiveBacktrackerEvent, isMutatingRbEvent, mutatingRbEventsWithIndex, applyRecursiveBacktracker,
  decodeKruskalEvent, isMutatingKruskalEvent, mutatingKruskalEventsWithIndex, mutatingKruskalEvents, applyKruskal, kruskalMergedRoot,
  decodeWilsonEvent, isMutatingWilsonEvent, mutatingWilsonEventsWithIndex, mutatingWilsonEvents, applyWilson,
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

export function adapterFor(kind: "recursive_backtracker"): RbAdapter;
export function adapterFor(kind: "kruskal"): KruskalAdapter;
export function adapterFor(kind: "wilson"): WilsonAdapter;
export function adapterFor(kind: EventedEventKind): RbAdapter | KruskalAdapter | WilsonAdapter {
  switch (kind) {
    case "recursive_backtracker": return RB_ADAPTER;
    case "kruskal": return KRUSKAL_ADAPTER;
    case "wilson": return WILSON_ADAPTER;
  }
}
