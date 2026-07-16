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
  type ParsedTape, type ParsedCheckpoints, type ApplyFrom, type NodeView,
  type RecursiveBacktrackerEvent, type KruskalEvent, type WilsonEvent, type EdgeBasedEvent, type VertexBasedEvent, type QcEvent,
  type ApplyResult, type KruskalApplyResult, type WilsonApplyResult, type EdgeBasedApplyResult, type VertexBasedApplyResult, type QcApplyResult,
  decodeRecursiveBacktrackerEvent, isMutatingRbEvent, mutatingRbEventsWithIndex, applyRecursiveBacktracker,
  decodeKruskalEvent, isMutatingKruskalEvent, mutatingKruskalEventsWithIndex, applyKruskal, kruskalMergedRoot,
  decodeWilsonEvent, isMutatingWilsonEvent, mutatingWilsonEventsWithIndex, applyWilson,
  decodeEdgeBasedEvent, isMutatingEdgeBasedEvent, mutatingEdgeBasedEventsWithIndex, applyEdgeBased,
  decodeVertexBasedEvent, isMutatingVertexBasedEvent, mutatingVertexBasedEventsWithIndex, applyVertexBased, VERTEX_BASED_TAG,
  decodeQcEvent, isMutatingQcEvent, mutatingQcEventsWithIndex, applyQc, sourceScopeForNode, topLevelSourceScopes,
  resolveDebugArenaMetadata, parseCheckpoints, type DebugArenaMetadata, type TopLevelSourceScope,
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
  /** debugTreeSelectors.ts: flat-layer mutating-event node indices, for `buildStepIndex`.
   *  `startIndex`/`endIndex` (GitHub issue #147, default the whole tape) bound the underlying
   *  node-table scan to `[startIndex, endIndex)` — needed when this adapter's source isn't the
   *  tape's only top-level scope, so its own scan neither re-walks an earlier source's bytes nor
   *  runs into a later source's bytes using this adapter's own tag set (a real, previously-hit bug:
   *  scanning generation unbounded past its own range decoded QC's `IterationStarted` tag as RB's
   *  numerically-colliding `VertexSelected` tag). */
  mutatingNodeIndices(tape: ParsedTape, startIndex?: number, endIndex?: number): number[];
  /** generateConfigBuilder.ts: totalSteps + checkpointFroms for a freshly-parsed tape.
   *  `startIndex`/`endIndex` (GitHub issue #147, default the whole tape) bound the scan to this
   *  source's own range — same rationale as `mutatingNodeIndices`' own doc comment: an unbounded
   *  scan of one source runs into a later source's bytes and mis-decodes them. */
  resolveMetadata(tape: ParsedTape, checkpoints: ParsedCheckpoints | null, startIndex?: number, endIndex?: number): DebugArenaMetadata;
  decodeEvent(tag: number, bytes: Uint8Array): E;
  isMutatingEvent(event: E): boolean;
  /** DebugEventTree.tsx: narration tokens for one decoded event. `titleLookup` (GitHub issue
   *  #147) — see `scopeLabel`'s doc comment below; every non-QC adapter ignores it, QC uses it to
   *  resolve `RuleChecked`/`RepairDispatched`'s `ruleId` to its current title the same way
   *  `scopeLabel` resolves a `"rule <id>"` scope's own label. */
  narrationTokensFor(event: E, titleLookup?: ScopeTitleLookup): Token[];
  /** DebugEventTree.tsx: label for a scope row (e.g. "step N"/"edge N"/"walk N", or Wilson's
   *  fixed "search"/"commit" names) — the raw arena scope name in, the localized label out.
   *  `children` is this scope's own direct children only (never the whole tape) — lets a label
   *  read a summary value out of its own contents (e.g. VertexBased's "junction_count" scope
   *  reading the final tally off its last `JunctionSlotRolled` child, GitHub issue #143's
   *  follow-up) without any adapter needing arena-wide access. `titleLookup` (GitHub issue #147)
   *  resolves a QC stage/rule id to its current user-facing title from the live store config —
   *  `undefined` for every non-QC adapter's own call sites, which ignore the parameter entirely;
   *  wire scope names stay the opaque, stable `id` (core has no concept of a rule's display name,
   *  only its `id` — see `maze-core/src/quality_control/`), so this is resolved fresh from the
   *  current config each render rather than round-tripped through the wire, matching the fact that
   *  a renamed/deleted rule after generation already can't retroactively update anything baked
   *  into the tape either way. */
  scopeLabel(scopeName: string, children: NodeView[], titleLookup?: ScopeTitleLookup): string;
}

/** Resolves a QC stage/rule `id` (as embedded verbatim in `"stage <id>"`/`"rule <id>"` scope
 *  names, `maze-core/src/quality_control/engine.rs`/`stage.rs`) to its current user-facing title
 *  from the live store config (`MazeStore.stages`/`rules`) — see `QC_ADAPTER.scopeLabel`'s doc
 *  comment for why this is resolved live rather than sent across the wire. `undefined` (id not
 *  found — e.g. the rule/stage was deleted after this tape was generated) falls back to the raw
 *  id, same as before a title lookup existed. */
export interface ScopeTitleLookup {
  stageTitle(stageId: string): string | undefined;
  ruleTitle(ruleId: string): string | undefined;
}

/** RB is the only algorithm with checkpoint-based resume (GitHub issue #128 stays RB-only) — its
 *  `apply` takes an optional `from` no other adapter has. */
export interface RbAdapter extends BaseAlgorithmAdapter<RecursiveBacktrackerEvent> {
  apply(tape: ParsedTape, targetStep: number, from?: ApplyFrom, endIndex?: number): ApplyResult;
}
export interface KruskalAdapter extends BaseAlgorithmAdapter<KruskalEvent> {
  apply(tape: ParsedTape, targetStep: number, startIndex?: number, endIndex?: number): KruskalApplyResult;
}
export interface WilsonAdapter extends BaseAlgorithmAdapter<WilsonEvent> {
  apply(tape: ParsedTape, targetStep: number, startIndex?: number, endIndex?: number): WilsonApplyResult;
}
export interface EdgeBasedAdapter extends BaseAlgorithmAdapter<EdgeBasedEvent> {
  apply(tape: ParsedTape, targetStep: number, startIndex?: number, endIndex?: number): EdgeBasedApplyResult;
}
export interface VertexBasedAdapter extends BaseAlgorithmAdapter<VertexBasedEvent> {
  apply(tape: ParsedTape, targetStep: number, startIndex?: number, endIndex?: number): VertexBasedApplyResult;
}
/** QC's `apply` takes a required `startNodeIndex` (GitHub issue #147) — unlike every generation
 *  adapter, which always replays from the tape's start (index 0) since generation is always the
 *  first-and-only source before #147, QC is always merged as a *later* source (Contract A,
 *  `Specs/event_log.md`'s #147 section): its own mutating events never start at arena index 0, so
 *  its `apply` needs to know where its own top-level source scope begins. */
export interface QcAdapter extends BaseAlgorithmAdapter<QcEvent> {
  apply(tape: ParsedTape, targetStep: number, startNodeIndex: number): QcApplyResult;
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
  mutatingNodeIndices: (tape, startIndex = 0, endIndex) => mutatingRbEventsWithIndex(tape, undefined, startIndex, endIndex).map((e) => e.nodeIndex),
  resolveMetadata: (tape, checkpoints, startIndex = 0, endIndex) => resolveDebugArenaMetadata(tape, checkpoints ?? parseCheckpoints(new Uint8Array(0), new Uint8Array(0)), startIndex, endIndex),
  decodeEvent: decodeRecursiveBacktrackerEvent,
  isMutatingEvent: isMutatingRbEvent,
  narrationTokensFor: narrationTokensForRb,
  scopeLabel: (name, _children) => m["debug.tree.step_scope"]({ index: numberedScopeIndex(name) }),
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
  mutatingNodeIndices: (tape, startIndex = 0, endIndex) => mutatingKruskalEventsWithIndex(tape, undefined, startIndex, endIndex).map((e) => e.nodeIndex),
  resolveMetadata: (tape, _checkpoints, startIndex = 0, endIndex) => ({ totalSteps: mutatingKruskalEventsWithIndex(tape, undefined, startIndex, endIndex).length, checkpointFroms: [] }),
  decodeEvent: decodeKruskalEvent,
  isMutatingEvent: isMutatingKruskalEvent,
  narrationTokensFor: narrationTokensForKruskal,
  scopeLabel: (name, _children) => m["debug.tree.edge_scope"]({ index: numberedScopeIndex(name) }),
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
  mutatingNodeIndices: (tape, startIndex = 0, endIndex) => mutatingWilsonEventsWithIndex(tape, undefined, startIndex, endIndex).map((e) => e.nodeIndex),
  resolveMetadata: (tape, _checkpoints, startIndex = 0, endIndex) => ({ totalSteps: mutatingWilsonEventsWithIndex(tape, undefined, startIndex, endIndex).length, checkpointFroms: [] }),
  decodeEvent: decodeWilsonEvent,
  isMutatingEvent: isMutatingWilsonEvent,
  narrationTokensFor: narrationTokensForWilson,
  // Wilson's "search"/"commit" are fixed, non-numbered scope names (GitHub issue #145's
  // follow-up) — checked before the numbered-scope regex, which wouldn't match them.
  scopeLabel: (name, _children) => {
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
  mutatingNodeIndices: (tape, startIndex = 0, endIndex) => mutatingEdgeBasedEventsWithIndex(tape, undefined, startIndex, endIndex).map((e) => e.nodeIndex),
  resolveMetadata: (tape, _checkpoints, startIndex = 0, endIndex) => ({ totalSteps: mutatingEdgeBasedEventsWithIndex(tape, undefined, startIndex, endIndex).length, checkpointFroms: [] }),
  decodeEvent: decodeEdgeBasedEvent,
  isMutatingEvent: isMutatingEdgeBasedEvent,
  narrationTokensFor: narrationTokensForEdgeBased,
  scopeLabel: (name, _children) => m["debug.tree.step_scope_edge_based"]({ index: numberedScopeIndex(name) }),
  apply: applyEdgeBased,
};

/** `CustomVertexBased`'s counterpart to `narrationTokensForRb`/`.../Kruskal`/`.../Wilson`/
 *  `.../EdgeBased` (GitHub issue #143). Every `"step N"` scope is flat, mirroring
 *  Kruskal/EdgeBased's shape, except when the frontier empties out mid-run: then a fixed,
 *  non-numbered `"reserve_search"` sub-scope opens (mirroring Wilson's fixed `"search"`/`"commit"`
 *  names) to hold the reserve-candidate scan's possibly-several rejected/chosen events — handled
 *  by `scopeLabel` below, not here. Roll/param values are rendered via `fmt` (2 decimals) directly
 *  in the narration text, mirroring EdgeBased's own convention. */
function narrationTokensForVertexBased(event: VertexBasedEvent): Token[] {
  switch (event.kind) {
    case "TeleportBridgeRolled":
      return [{
        kind: "text",
        text: event.fired
          ? m["debug.tree.teleport_bridge_rolled_fired"]({ param: fmt(event.teleportChance), roll: fmt(event.roll) })
          : m["debug.tree.teleport_bridge_rolled_not_fired"]({ param: fmt(event.teleportChance), roll: fmt(event.roll) }),
      }];
    case "TeleportBridgeAdded":
      return [{ kind: "text", text: m["debug.tree.teleport_bridge_added"]() + " " }, { kind: "edge", from: event.src, to: event.dst, bidirectional: event.bidirectional }];
    case "ReserveCandidateRejected":
      return [{
        kind: "text",
        text: event.alreadyVisited ? m["debug.tree.reserve_candidate_rejected_visited"]() : m["debug.tree.reserve_candidate_rejected_unreachable"](),
      }, { kind: "node", id: event.node }];
    case "ReserveCandidateChosen":
      return [{ kind: "text", text: m["debug.tree.reserve_candidate_chosen"]() + " " }, { kind: "node", id: event.node }];
    case "ReserveExhausted":
      return [{ kind: "text", text: m["debug.tree.reserve_exhausted"]() }];
    case "BridgeAdded":
      return [{ kind: "text", text: m["debug.tree.bridge_added"]() + " " }, { kind: "edge", from: event.src, to: event.dst, bidirectional: event.bidirectional }];
    case "SrcChosenFromFrontier":
      return [
        // position is a 0-based array index on the wire (0 = oldest); +1 for a 1-based display,
        // so "position N of total" reads naturally (e.g. the newest/highest-priority entry shows
        // as "total of total", not "total-1 of total" looking like it wasn't the max).
        { kind: "text", text: m["debug.tree.src_chosen_from_frontier"]({ param: fmt(event.depthFirst), position: event.position + 1, total: event.frontierLen }) + " " },
        { kind: "node", id: event.src },
      ];
    case "TeleportRolled":
      return [{
        kind: "text",
        text: event.fired
          ? m["debug.tree.teleport_rolled_fired"]({ param: fmt(event.teleportChance), roll: fmt(event.roll) })
          : m["debug.tree.teleport_rolled_not_fired"]({ param: fmt(event.teleportChance), roll: fmt(event.roll) }),
      }];
    case "CyclicRolled":
      return [{
        kind: "text",
        text: event.fired
          ? m["debug.tree.cyclic_rolled_fired"]({ param: fmt(event.cyclicity), roll: fmt(event.roll) })
          : m["debug.tree.cyclic_rolled_not_fired"]({ param: fmt(event.cyclicity), roll: fmt(event.roll) }),
      }];
    case "CyclicCandidatesComputed":
      return [{
        kind: "text",
        text: event.geometric
          ? m["debug.tree.cyclic_candidates_computed_geometric"]({ count: event.candidates.length })
          : m["debug.tree.cyclic_candidates_computed_teleport"]({ count: event.candidates.length }),
      }];
    case "CyclicEdgeAdded":
      return [{ kind: "text", text: m["debug.tree.cyclic_edge_added"]() + " " }, { kind: "edge", from: event.src, to: event.dst, bidirectional: event.bidirectional }];
    case "CorridorRolled":
      return [{
        kind: "text",
        text: event.isCorridor
          ? m["debug.tree.corridor_rolled_vertex_based_corridor"]({ param: fmt(event.corridorChance), roll: fmt(event.roll) })
          : m["debug.tree.corridor_rolled_vertex_based_junction"]({ param: fmt(event.corridorChance), roll: fmt(event.roll) }),
      }];
    case "SingleCandidateSkipsDirectionality":
      return [{ kind: "text", text: m["debug.tree.single_candidate_skips_directionality"]() }];
    case "NoParentSkipsDirectionality":
      return [{ kind: "text", text: m["debug.tree.no_parent_skips_directionality"]() }];
    case "DirectionalityRolled":
      return [{
        kind: "text",
        text: !event.fired
          ? m["debug.tree.directionality_rolled_not_fired"]({ param: fmt(event.directionality), roll: fmt(event.roll) })
          : event.straightFound
            ? m["debug.tree.directionality_rolled_fired_straight_found"]({ param: fmt(event.directionality), roll: fmt(event.roll) })
            : m["debug.tree.directionality_rolled_fired_no_straight"]({ param: fmt(event.directionality), roll: fmt(event.roll) }),
      }];
    case "CandidateChosen":
      return [{ kind: "text", text: m["debug.tree.candidate_chosen_vertex_based"]() + " " }, { kind: "edge", from: event.src, to: event.dst, bidirectional: false }];
    case "JunctionRollSetup":
      return [{ kind: "text", text: m["debug.tree.junction_roll_setup"]({ max: event.max, mandatory: 2, optional: event.max - 2 }) }];
    case "JunctionSlotRolled":
      return [{
        kind: "text",
        text: event.taken
          ? m["debug.tree.junction_slot_rolled_taken"]({ param: fmt(event.branching), roll: fmt(event.roll) })
          : m["debug.tree.junction_slot_rolled_not_taken"]({ param: fmt(event.branching), roll: fmt(event.roll) }),
      }];
    case "JunctionCandidatesChosen":
      return [{ kind: "text", text: m["debug.tree.junction_candidates_chosen"]({ count: event.candidates.length }) + " " }, { kind: "region", nodes: event.candidates }];
    case "EdgeAdded":
      return [{ kind: "text", text: m["debug.tree.edge_added"]() + " " }, { kind: "edge", from: event.src, to: event.dst, bidirectional: event.bidirectional }];
    case "PresetNeighborVisited":
      return [{ kind: "text", text: m["debug.tree.preset_skipped"]() + " " }, { kind: "edge", from: event.src, to: event.dst, bidirectional: false }];
    case "TeleportConnectAdded":
      return [{ kind: "text", text: m["debug.tree.teleport_connect_added"]() + " " }, { kind: "edge", from: event.src, to: event.dst, bidirectional: event.bidirectional }];
    case "NodeVisited":
      return [{ kind: "text", text: m["debug.tree.node_added_to_visited_and_frontier"]() + " " }, { kind: "node", id: event.node }];
    case "NodeQueuedToReserve":
      return [{ kind: "text", text: m["debug.tree.node_queued_to_reserve"]() + " " }, { kind: "node", id: event.node }];
    case "StartVisited":
      return [{ kind: "text", text: m["debug.tree.start_added_to_visited_and_frontier"]() + " " }, { kind: "node", id: event.node }];
  }
}

const VERTEX_BASED_ADAPTER: VertexBasedAdapter = {
  mutatingNodeIndices: (tape, startIndex = 0, endIndex) => mutatingVertexBasedEventsWithIndex(tape, undefined, startIndex, endIndex).map((e) => e.nodeIndex),
  resolveMetadata: (tape, _checkpoints, startIndex = 0, endIndex) => ({ totalSteps: mutatingVertexBasedEventsWithIndex(tape, undefined, startIndex, endIndex).length, checkpointFroms: [] }),
  decodeEvent: decodeVertexBasedEvent,
  isMutatingEvent: isMutatingVertexBasedEvent,
  narrationTokensFor: narrationTokensForVertexBased,
  // "reserve_search"/"junction_count" are fixed, non-numbered scope names (GitHub issue #143's
  // follow-up, mirroring Wilson's "search"/"commit") — checked before the numbered-scope regex,
  // which wouldn't match them. "junction_count"'s label additionally folds its own
  // JunctionSlotRolled children into a final tally (2 mandatory + every taken:true roll) — the
  // scope's own contents are the only source of truth for this number, so no separate summary
  // event needs to carry it.
  scopeLabel: (name, children) => {
    if (name === "reserve_search") return m["debug.tree.reserve_search_scope"]();
    if (name === "junction_count") {
      let count = 2;
      for (const child of children) {
        const payload = child.payload();
        if (payload.kind === "event" && payload.tag === VERTEX_BASED_TAG.JUNCTION_SLOT_ROLLED) {
          const event = decodeVertexBasedEvent(payload.tag, payload.bytes);
          if (event.kind === "JunctionSlotRolled" && event.taken) count += 1;
        }
      }
      return m["debug.tree.junction_count_scope"]({ count });
    }
    return m["debug.tree.step_scope"]({ index: numberedScopeIndex(name) });
  },
  apply: applyVertexBased,
};

/** Wraps a resolved rule/stage title (or the raw id, when `titleLookup` is absent or doesn't
 *  recognize it — see `ScopeTitleLookup`'s doc comment) in `"…"` quotes, so it reads as a distinct
 *  name rather than running into the surrounding narration text with no separator (e.g. "Rule
 *  Waypoints: issue found" reads as "Rule Waypoints" being one phrase; "Rule "Waypoints": issue
 *  found" doesn't). Applied uniformly everywhere a title is interpolated — scope labels and
 *  narration text alike — so quoting is never a per-template decision. */
function quoted(title: string): string {
  return `"${title}"`;
}

/** QC's counterpart to `narrationTokensForRb`/etc. (GitHub issue #147). `issueKind` is a plain
 *  wire string (not localized) — a stable core identifier; narration surrounds it with localized
 *  text but doesn't translate it, mirroring how node/edge ids never get translated either.
 *  `ruleId` is resolved through `titleLookup` to its current user-facing title first (same
 *  resolution `scopeLabel` applies to a `"rule <id>"` scope's own label — see that doc comment for
 *  why this is resolved live rather than sent across the wire), falling back to the raw id when
 *  `titleLookup` is absent or doesn't recognize it. */
function narrationTokensForQc(event: QcEvent, titleLookup?: ScopeTitleLookup): Token[] {
  const ruleTitle = (ruleId: string) => quoted(titleLookup?.ruleTitle(ruleId) ?? ruleId);
  switch (event.kind) {
    case "IterationStarted":
      return [{ kind: "text", text: m["debug.tree.qc.iteration_started"]({ iteration: event.iteration + 1 }) }];
    case "RuleChecked":
      return event.issue
        ? [{ kind: "text", text: m["debug.tree.qc.rule_checked_found"]({ ruleId: ruleTitle(event.ruleId), issueKind: event.issue.issueKind }) }]
        : [{ kind: "text", text: m["debug.tree.qc.rule_checked_clean"]({ ruleId: ruleTitle(event.ruleId) }) }];
    case "RepairDispatched":
      return [{
        kind: "text",
        text: event.result === "Fixed"
          ? m["debug.tree.qc.repair_dispatched_fixed"]({ ruleId: ruleTitle(event.ruleId), applied: event.applied, proposed: event.proposed })
          : m["debug.tree.qc.repair_dispatched_failed"]({ ruleId: ruleTitle(event.ruleId), applied: event.applied, proposed: event.proposed }),
      }];
    case "IterationNoProgress":
      return [{ kind: "text", text: m["debug.tree.qc.iteration_no_progress"]() }];
    case "IterationLimitReached":
      return [{
        kind: "text",
        text: event.limit === "MaxIterations"
          ? m["debug.tree.qc.iteration_limit_reached_max_iterations"]()
          : m["debug.tree.qc.iteration_limit_reached_time_budget"](),
      }];
    case "DirectedEdgeAdded":
      return [{ kind: "text", text: m["debug.tree.qc.directed_edge_added"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "BidirectionalEdgeAdded":
      return [{ kind: "text", text: m["debug.tree.qc.bidirectional_edge_added"]() + " " }, { kind: "edge", from: event.a, to: event.b, bidirectional: true }];
    case "DirectedTeleportAdded":
      return [{ kind: "text", text: m["debug.tree.qc.directed_teleport_added"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "BidirectionalTeleportAdded":
      return [{ kind: "text", text: m["debug.tree.qc.bidirectional_teleport_added"]() + " " }, { kind: "edge", from: event.a, to: event.b, bidirectional: true }];
    case "EdgeRemoved":
      return [{ kind: "text", text: m["debug.tree.qc.edge_removed"]() + " " }, { kind: "node", id: event.id }];
    case "EdgeRemovedBetween":
      return [{ kind: "text", text: m["debug.tree.qc.edge_removed_between"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "TeleportRemovedWithReverse":
      return [{ kind: "text", text: m["debug.tree.qc.teleport_removed_with_reverse"]() + " " }, { kind: "node", id: event.id }];
    case "StartSet":
      return [{ kind: "text", text: m["debug.tree.qc.start_set"]() + " " }, { kind: "node", id: event.id }];
    case "FinishSet":
      return [{ kind: "text", text: m["debug.tree.qc.finish_set"]() + " " }, { kind: "node", id: event.id }];
    case "DirectedEdgeDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.directed_edge_declined"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "BidirectionalEdgeDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.bidirectional_edge_declined"]() + " " }, { kind: "edge", from: event.a, to: event.b, bidirectional: true }];
    case "DirectedTeleportDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.directed_teleport_declined"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "BidirectionalTeleportDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.bidirectional_teleport_declined"]() + " " }, { kind: "edge", from: event.a, to: event.b, bidirectional: true }];
    case "EdgeRemoveDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.edge_remove_declined"]() + " " }, { kind: "node", id: event.id }];
    case "EdgeRemoveBetweenDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.edge_remove_between_declined"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "TeleportRemoveWithReverseDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.teleport_remove_with_reverse_declined"]() + " " }, { kind: "node", id: event.id }];
    case "StartSetDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.start_set_declined"]() + " " }, { kind: "node", id: event.id }];
    case "FinishSetDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.finish_set_declined"]() + " " }, { kind: "node", id: event.id }];
  }
}

const QC_STAGE_SCOPE_RE = /^stage (.+)$/;
const QC_ITERATION_SCOPE_RE = /^iteration (\d+)$/;
const QC_RULE_SCOPE_RE = /^rule (.+)$/;

const QC_ADAPTER: QcAdapter = {
  mutatingNodeIndices: (tape, startIndex = 0, endIndex) => mutatingQcEventsWithIndex(tape, undefined, startIndex, endIndex).map((e) => e.nodeIndex),
  resolveMetadata: (tape, _checkpoints, startIndex = 0, endIndex) => ({ totalSteps: mutatingQcEventsWithIndex(tape, undefined, startIndex, endIndex).length, checkpointFroms: [] }),
  decodeEvent: decodeQcEvent,
  isMutatingEvent: isMutatingQcEvent,
  narrationTokensFor: narrationTokensForQc,
  // "stage <id>"/"iteration N"/"rule <id>" are the only three scope shapes QC produces (see
  // maze-core/src/quality_control/stage.rs's run_repair/dispatch). Stage/rule ids are opaque
  // (core has no concept of their user-facing title, only their id) — `titleLookup` resolves each
  // to its current title from the live store config; a missing lookup or an id no longer present
  // in it (e.g. deleted after this tape was generated) falls back to showing the raw id, same as
  // before a title lookup existed.
  scopeLabel: (name, _children, titleLookup) => {
    const stageMatch = QC_STAGE_SCOPE_RE.exec(name);
    if (stageMatch) {
      const stageId = stageMatch[1];
      return m["debug.tree.qc.stage_scope"]({ stageId: quoted(titleLookup?.stageTitle(stageId) ?? stageId) });
    }
    const iterationMatch = QC_ITERATION_SCOPE_RE.exec(name);
    if (iterationMatch) return m["debug.tree.qc.iteration_scope"]({ iteration: Number(iterationMatch[1]) });
    const ruleMatch = QC_RULE_SCOPE_RE.exec(name);
    if (ruleMatch) {
      const ruleId = ruleMatch[1];
      return m["debug.tree.qc.rule_scope"]({ ruleId: quoted(titleLookup?.ruleTitle(ruleId) ?? ruleId) });
    }
    return name;
  },
  apply: applyQc,
};

export type AnyAdapter = RbAdapter | KruskalAdapter | WilsonAdapter | EdgeBasedAdapter | VertexBasedAdapter | QcAdapter;

/** Non-overloaded dispatch, shared by `adapterFor`'s per-kind overloads below and by any caller
 *  (e.g. `adapterForNode`, `generateConfigBuilder.ts`) that only has a plain `EventedEventKind`
 *  union value at hand, not a literal — a union argument can't select a specific overload of
 *  `adapterFor`. */
export function adapterForKind(kind: EventedEventKind): AnyAdapter {
  switch (kind) {
    case "recursive_backtracker": return RB_ADAPTER;
    case "kruskal": return KRUSKAL_ADAPTER;
    case "wilson": return WILSON_ADAPTER;
    case "edge_based": return EDGE_BASED_ADAPTER;
    case "vertex_based": return VERTEX_BASED_ADAPTER;
    case "quality_control": return QC_ADAPTER;
  }
}

export function adapterFor(kind: "recursive_backtracker"): RbAdapter;
export function adapterFor(kind: "kruskal"): KruskalAdapter;
export function adapterFor(kind: "wilson"): WilsonAdapter;
export function adapterFor(kind: "edge_based"): EdgeBasedAdapter;
export function adapterFor(kind: "vertex_based"): VertexBasedAdapter;
export function adapterFor(kind: "quality_control"): QcAdapter;
export function adapterFor(kind: EventedEventKind): AnyAdapter {
  return adapterForKind(kind);
}

// `topLevelSourceScopes(tape)` is deterministic for a given `ParsedTape` (arena bytes never
// mutate in place — a fresh generate() always produces a new tape object) — cached per-tape so
// `adapterForNode`, called once per visible tree row by `DebugEventTree.tsx`'s `rowTokens`,
// doesn't re-walk the merged root's children and re-allocate the scopes array on every single
// row. Same caching shape as `debugTreeSelectors.ts`'s `stepIndexCache`/`coordIndexCache`.
const topLevelScopesCache = new WeakMap<ParsedTape, TopLevelSourceScope[]>();
function cachedTopLevelSourceScopes(tape: ParsedTape): TopLevelSourceScope[] {
  const cached = topLevelScopesCache.get(tape);
  if (cached) return cached;
  const scopes = topLevelSourceScopes(tape);
  topLevelScopesCache.set(tape, scopes);
  return scopes;
}

/** Resolves the right adapter for an arbitrary arena node by walking up to its top-level source
 *  scope first (Contract B, `Specs/event_log.md`'s #147 section) — the single place a caller needs
 *  to go from "a node somewhere in a multi-source merged tape" to "which decoder/apply/narration
 *  function owns it", without walking `record.parent` itself. `sourceEventKinds` is the tape's own
 *  parallel `DebugTape.sourceEventKinds` list (same order as `topLevelSourceScopes`, GitHub issue
 *  #169) — resolving the *kind* still needs this list since a scope's name alone (`"generation"`)
 *  doesn't carry which concrete algorithm ran. */
export function adapterForNode(
  tape: ParsedTape,
  nodeIndex: number,
  sourceEventKinds: readonly EventedEventKind[],
): AnyAdapter {
  const scope = sourceScopeForNode(tape, nodeIndex);
  const scopes = cachedTopLevelSourceScopes(tape);
  const sourceIndex = scopes.findIndex((s) => s.nodeIndex === scope.nodeIndex);
  if (sourceIndex === -1 || sourceIndex >= sourceEventKinds.length) {
    throw new Error(`adapterForNode: no sourceEventKinds entry for scope "${scope.scopeName}" (node ${nodeIndex})`);
  }
  return adapterForKind(sourceEventKinds[sourceIndex]);
}
