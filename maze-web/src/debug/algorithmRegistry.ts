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
  type ParsedTape, type ApplyFrom, type NodeView,
  type PresetSetupEvent, type RecursiveBacktrackerEvent, type KruskalEvent, type WilsonEvent, type EdgeBasedEvent, type VertexBasedEvent, type QcEvent, type IssuePayload,
  type PresetSetupApplyResult, type ApplyResult, type KruskalApplyResult, type WilsonApplyResult, type EdgeBasedApplyResult, type VertexBasedApplyResult, type QcApplyResult,
  decodePresetSetupEvent, isMutatingPresetSetupEvent, mutatingPresetSetupEventsWithIndex, applyPresetSetup,
  decodeRecursiveBacktrackerEvent, isMutatingRbEvent, mutatingRbEventsWithIndex, applyRecursiveBacktracker,
  decodeKruskalEvent, isMutatingKruskalEvent, mutatingKruskalEventsWithIndex, applyKruskal, kruskalMergedRoot,
  decodeWilsonEvent, isMutatingWilsonEvent, mutatingWilsonEventsWithIndex, applyWilson,
  decodeEdgeBasedEvent, isMutatingEdgeBasedEvent, mutatingEdgeBasedEventsWithIndex, applyEdgeBased,
  decodeVertexBasedEvent, isMutatingVertexBasedEvent, mutatingVertexBasedEventsWithIndex, applyVertexBased, VERTEX_BASED_TAG,
  decodeQcEvent, isMutatingQcEvent, mutatingQcEventsWithIndex, applyQc, sourceScopeForNode, topLevelSourceScopes,
  resolveDebugArenaMetadata, countMutatingEvents, type DebugArenaMetadata, type TopLevelSourceScope,
} from "./eventTape";
import type { EventedEventKind } from "../wasm/mazeService";
import { resolveCheckLabel, resolveStrategyLabel } from "../components/features/qualityI18n";
import { resolveIssueSourceLabel } from "../components/issueRegistry";
import * as m from "~/paraglide/messages";

/** One piece of a tokenized narration line — mirrors the `Token` union in `DebugEventTree.tsx`
 *  (re-exported from there to avoid a duplicate declaration; kept here as the type every
 *  adapter's `narrationTokensFor` returns). */
export type Token =
  | { kind: "text"; text: string }
  | { kind: "node"; id: bigint }
  | { kind: "edge"; from: bigint; to: bigint; bidirectional: boolean }
  | { kind: "cycle"; edges: [bigint, bigint][] }
  | { kind: "region"; nodes: bigint[] }
  | { kind: "issue"; issueKind: string; target: IssueHighlightTarget | null; reasons: string[] };

/** Structural highlight data an `issue` token carries, when the underlying `IssuePayload` (see
 *  `eventTape.ts`) resolved to one — `null` for the majority of issue kinds with no structural
 *  edge/node data (mirrors `IssuePayload::None`). Reuses the same shape `cycle`/`region` tokens
 *  already carry rather than inventing a third representation. */
export type IssueHighlightTarget =
  | { kind: "cycle"; edges: [bigint, bigint][] }
  | { kind: "region"; nodes: bigint[] };

/** Flattens an `IssuePayload` (per-source-check-keyed) into one combined highlight target — used
 *  for the debug tree's own issue bubble, which (unlike Analytics' `IssueBubble`) has no per-check
 *  bubble breakdown to key into: `CheckRan`/`IssuesMerged` narrate one issue per event, so every
 *  contributing check's own cycles/regions are shown together. */
function issueHighlightTarget(payload: IssuePayload): IssueHighlightTarget | null {
  switch (payload.kind) {
    case "None":
      return null;
    case "InvalidLoop": {
      const edges = [...payload.edges.values()].flat(2);
      return edges.length > 0 ? { kind: "cycle", edges } : null;
    }
    case "RegionNeedsExpansion":
    case "RegionNeedsShrink": {
      const nodes = [...payload.nodes.values()].flat(2);
      return nodes.length > 0 ? { kind: "region", nodes } : null;
    }
    case "InvalidTeleport": {
      // Reuses the "cycle" shape — a teleport group's edges are highlighted exactly like a
      // cycle's edges (see `IssueHighlightTarget`'s doc comment).
      const edges = [...payload.groups.values()].flat(2);
      return edges.length > 0 ? { kind: "cycle", edges } : null;
    }
    case "InvalidOneWay": {
      // Reuses the "cycle" shape, same rationale as InvalidTeleport above.
      const edges = [...payload.groups.values()].flat(2);
      return edges.length > 0 ? { kind: "cycle", edges } : null;
    }
    case "InvalidSplitTile": {
      // Reuses the "region" shape — `RegionHighlightRenderer`'s per-group perimeter reads as a
      // border around each individual flagged cell regardless of whether the group's cells are
      // actually connected, so a flat split-tile node list draws correctly here even though it
      // has no region structure of its own (unlike RegionNeedsExpansion's real SCC regions).
      const nodes = [...payload.nodes.values()].flat();
      return nodes.length > 0 ? { kind: "region", nodes } : null;
    }
  }
}

/** Resolves one contributing check's own "reason" text for an `issue` token's modal (GitHub issue
 *  #171) — `resolveIssueSourceLabel` (`issueRegistry.ts`, the same function `IssueBubble` calls)
 *  keyed by the check's *type* id (resolved from its instance id via `titleLookup.checkTypeId`,
 *  same as `checkLabelFor`), falling back to the issue kind's generic label when the instance
 *  can't be resolved (e.g. the check was removed after this tape was generated) — there's no
 *  type id to pick a `DETAIL_LABELS` formatter with in that case. */
function issueReasonFor(issueKind: string, checkId: string, details: Map<string, string>, titleLookup?: ScopeTitleLookup): string {
  const typeId = titleLookup?.checkTypeId(checkId);
  if (typeId === undefined) return resolveIssueSourceLabel(issueKind, checkId, undefined);
  return resolveIssueSourceLabel(issueKind, typeId, Object.fromEntries(details));
}

/** Builds an `issue` token's `reasons` list from one or more `(checkId, details)` contributions —
 *  `CheckRan` always passes exactly one (this event narrates a single check), `IssuesMerged` one
 *  per contributing check (GitHub issue #171, mirrors `IssuesBlock` rendering one bubble per
 *  `source_checks` entry for a merged `IssueDto`). Deduplicates identical resolved strings — two
 *  checks of the same type with the same params/details would otherwise repeat the same reason
 *  twice for no informational gain. */
function issueReasons(
  issueKind: string,
  contributions: { checkId: string; details: Map<string, string> }[],
  titleLookup?: ScopeTitleLookup,
): string[] {
  const resolved = contributions.map(({ checkId, details }) => issueReasonFor(issueKind, checkId, details, titleLookup));
  return [...new Set(resolved)];
}

/** Shape shared by every algorithm's adapter. Parameterized by the concrete event type `E`
 *  (`RecursiveBacktrackerEvent`/`KruskalEvent`/`WilsonEvent`) so `decodeEvent`/`isMutatingEvent`/
 *  `narrationTokensFor` stay fully typed at every call site — no `unknown`/`any` laundering, and by
 *  `TResult` (`ApplyResult`/`KruskalApplyResult`/etc, GitHub issue #128's generalization) so
 *  `resolveMetadata`'s cached snapshots stay typed too. */
export interface BaseAlgorithmAdapter<E, TResult extends { step: number; nodeIndex: number } = { step: number; nodeIndex: number }> {
  /** debugTreeSelectors.ts: flat-layer mutating-event node indices, for `buildStepIndex`.
   *  `startIndex`/`endIndex` (GitHub issue #147, default the whole tape) bound the underlying
   *  node-table scan to `[startIndex, endIndex)` — needed when this adapter's source isn't the
   *  tape's only top-level scope, so its own scan neither re-walks an earlier source's bytes nor
   *  runs into a later source's bytes using this adapter's own tag set (a real, previously-hit bug:
   *  scanning generation unbounded past its own range decoded QC's `IterationStarted` tag as RB's
   *  numerically-colliding `VertexSelected` tag). */
  mutatingNodeIndices(tape: ParsedTape, startIndex?: number, endIndex?: number): number[];
  /** generateConfigBuilder.ts: totalSteps + checkpointFroms for a freshly-parsed tape, computed
   *  generically by `resolveDebugArenaMetadata` (GitHub issue #128) — every adapter's own
   *  implementation is a thin closure over its own `mutatingNodeIndices`/`apply`, unaware that the
   *  snapshot-caching logic itself is shared. `startIndex`/`endIndex` (GitHub issue #147, default
   *  the whole tape) bound the scan to this source's own range — same rationale as
   *  `mutatingNodeIndices`' own doc comment: an unbounded scan of one source runs into a later
   *  source's bytes and mis-decodes them. */
  resolveMetadata(tape: ParsedTape, startIndex?: number, endIndex?: number): DebugArenaMetadata<TResult>;
  decodeEvent(tag: number, bytes: Uint8Array): E;
  isMutatingEvent(event: E): boolean;
  /** DebugEventTree.tsx: narration tokens for one decoded event. `titleLookup` (GitHub issue
   *  #147) — see `scopeLabel`'s doc comment below; every adapter ignores it today, kept on the
   *  shared signature for parity with `scopeLabel`'s own parameter (a future event type carrying
   *  a rule/stage id in its own narration text would need it without a signature change). */
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
 *  id, same as before a title lookup existed.
 *
 *  `checkTypeId` (GitHub issue #171) resolves `QcEvent.CheckRan.checkId` (a check *instance* id,
 *  the composite `"{rule_id}:{local_id}"` routing key — see that field's doc comment in
 *  `event.rs`) to its check *type* id (`CheckInstance.typeId`) via the same live store config,
 *  mirroring `IssueDto.source_check_types`' role for the analytics panel — `resolveCheckLabel`
 *  needs a type id, not an instance id, to find a display label. `undefined` (instance not found
 *  — e.g. the check was removed after this tape was generated) falls back to showing the raw
 *  instance id. */
export interface ScopeTitleLookup {
  stageTitle(stageId: string): string | undefined;
  ruleTitle(ruleId: string): string | undefined;
  checkTypeId(instanceId: string): string | undefined;
}

/** Every adapter's `apply` now takes an optional `from` of its own result type (GitHub issue
 *  #128's generalization — snapshot-based resume is no longer RB-only) — passing back a previous
 *  call's result resumes the underlying scan right after it instead of replaying from the start.
 *  `resolveDebugArenaMetadata` (`eventTape.ts`) is the generic caller that builds/consumes these
 *  snapshots without knowing what's actually inside a given `TResult`. */
export interface PresetSetupAdapter extends BaseAlgorithmAdapter<PresetSetupEvent, PresetSetupApplyResult> {
  apply(tape: ParsedTape, targetStep: number, from: PresetSetupApplyResult | undefined, startNodeIndex: number, endIndex?: number): PresetSetupApplyResult;
}
export interface RbAdapter extends BaseAlgorithmAdapter<RecursiveBacktrackerEvent, ApplyResult> {
  apply(tape: ParsedTape, targetStep: number, from?: ApplyFrom, startIndex?: number, endIndex?: number): ApplyResult;
}
export interface KruskalAdapter extends BaseAlgorithmAdapter<KruskalEvent, KruskalApplyResult> {
  apply(tape: ParsedTape, targetStep: number, from?: KruskalApplyResult, startIndex?: number, endIndex?: number): KruskalApplyResult;
}
export interface WilsonAdapter extends BaseAlgorithmAdapter<WilsonEvent, WilsonApplyResult> {
  apply(tape: ParsedTape, targetStep: number, from?: WilsonApplyResult, startIndex?: number, endIndex?: number): WilsonApplyResult;
}
export interface EdgeBasedAdapter extends BaseAlgorithmAdapter<EdgeBasedEvent, EdgeBasedApplyResult> {
  apply(tape: ParsedTape, targetStep: number, from?: EdgeBasedApplyResult, startIndex?: number, endIndex?: number): EdgeBasedApplyResult;
}
export interface VertexBasedAdapter extends BaseAlgorithmAdapter<VertexBasedEvent, VertexBasedApplyResult> {
  apply(tape: ParsedTape, targetStep: number, from?: VertexBasedApplyResult, startIndex?: number, endIndex?: number): VertexBasedApplyResult;
}
/** QC's `apply` additionally takes a required `startNodeIndex` (GitHub issue #147) — unlike every
 *  generation adapter, which defaults to scanning from the tape's start (index 0) since generation
 *  is always the first-and-only source before #147, QC is always merged as a *later* source
 *  (Contract A, `Specs/event_log.md`'s #147 section): its own mutating events never start at arena
 *  index 0, so a from-scratch call (`from` absent) needs to know where its own top-level source
 *  scope begins. A resumed call (`from` present) ignores `startNodeIndex` — `from.nodeIndex + 1`
 *  is already the correct scan start. */
export interface QcAdapter extends BaseAlgorithmAdapter<QcEvent, QcApplyResult> {
  apply(tape: ParsedTape, targetStep: number, from: QcApplyResult | undefined, startNodeIndex: number): QcApplyResult;
}

const STEP_SCOPE_RE = /^(?:step|edge|walk) (\d+)$/;

function numberedScopeIndex(scopeName: string): number {
  const match = STEP_SCOPE_RE.exec(scopeName);
  return match ? Number(match[1]) : 0;
}

/** Preset setup's events (GitHub issue #225) — see `PresetSetupEvent`'s own doc comment for why
 *  this is a standalone, algorithm-agnostic source rather than an event duplicated into every
 *  instrumented algorithm's own event enum. One narration per connection kind, mirroring
 *  `build_preset_state`'s own three cases (`Wall` blocks a pair without adding anything, so it
 *  emits nothing here). */
function narrationTokensForPresetSetup(event: PresetSetupEvent): Token[] {
  switch (event.kind) {
    case "PassageEstablished":
      return [{ kind: "text", text: m["debug.tree.passage_established"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: true }];
    case "OneWayEstablished":
      return [{ kind: "text", text: m["debug.tree.one_way_established"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "TeleportEstablished":
      return [{ kind: "text", text: m["debug.tree.teleport_established"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: event.twoWay }];
  }
}

const PRESET_SETUP_ADAPTER: PresetSetupAdapter = {
  mutatingNodeIndices: (tape, startIndex = 0, endIndex) => mutatingPresetSetupEventsWithIndex(tape, undefined, startIndex, endIndex).map((e) => e.nodeIndex),
  resolveMetadata: (tape, startIndex = 0, endIndex) => resolveDebugArenaMetadata(
    tape,
    (t, s, e) => countMutatingEvents(t, decodePresetSetupEvent, isMutatingPresetSetupEvent, s, e),
    (step, previous) => applyPresetSetup(tape, step, previous, startIndex, endIndex),
    startIndex, endIndex,
  ),
  decodeEvent: decodePresetSetupEvent,
  isMutatingEvent: isMutatingPresetSetupEvent,
  narrationTokensFor: narrationTokensForPresetSetup,
  // This source never opens a nested scope (its events sit directly under its own top-level
  // scope, as flat siblings) — scopeLabel is never actually called for it, but every adapter
  // carries one for interface parity.
  scopeLabel: (name) => name,
  apply: (tape, targetStep, from, startNodeIndex = 0, endIndex) => applyPresetSetup(tape, targetStep, from, startNodeIndex, endIndex),
};

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
  resolveMetadata: (tape, startIndex = 0, endIndex) => resolveDebugArenaMetadata(
    tape,
    (t, s, e) => countMutatingEvents(t, decodeRecursiveBacktrackerEvent, isMutatingRbEvent, s, e),
    (step, previous) => applyRecursiveBacktracker(tape, step, previous, startIndex, endIndex),
    startIndex, endIndex,
  ),
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
  resolveMetadata: (tape, startIndex = 0, endIndex) => resolveDebugArenaMetadata(
    tape,
    (t, s, e) => countMutatingEvents(t, decodeKruskalEvent, isMutatingKruskalEvent, s, e),
    (step, previous) => applyKruskal(tape, step, previous, startIndex, endIndex),
    startIndex, endIndex,
  ),
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
  resolveMetadata: (tape, startIndex = 0, endIndex) => resolveDebugArenaMetadata(
    tape,
    (t, s, e) => countMutatingEvents(t, decodeWilsonEvent, isMutatingWilsonEvent, s, e),
    (step, previous) => applyWilson(tape, step, previous, startIndex, endIndex),
    startIndex, endIndex,
  ),
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
    case "CyclicAlreadyRolled":
      return [{ kind: "text", text: m["debug.tree.cyclic_already_rolled"]() }];
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
  resolveMetadata: (tape, startIndex = 0, endIndex) => resolveDebugArenaMetadata(
    tape,
    (t, s, e) => countMutatingEvents(t, decodeEdgeBasedEvent, isMutatingEdgeBasedEvent, s, e),
    (step, previous) => applyEdgeBased(tape, step, previous, startIndex, endIndex),
    startIndex, endIndex,
  ),
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
    case "SplitRolled":
      return [{
        kind: "text",
        text: !event.fired
          ? m["debug.tree.split_rolled_not_fired"]({ param: fmt(event.splitChance), roll: fmt(event.roll) })
          : event.eligible
            ? m["debug.tree.split_rolled_fired_eligible"]({ param: fmt(event.splitChance), roll: fmt(event.roll) })
            : m["debug.tree.split_rolled_fired_ineligible"]({ param: fmt(event.splitChance), roll: fmt(event.roll) }),
      }];
    case "SplitNodesCreated":
      return [{
        kind: "text",
        text: event.pattern !== null
          ? m["debug.tree.split_nodes_created_pattern"]({ count: event.nodes.length, pattern: event.pattern })
          : m["debug.tree.split_nodes_created_non_pattern"]({ count: event.nodes.length }),
      }, { kind: "region", nodes: event.nodes }];
    case "SplitCyclicRolled":
      return [{
        kind: "text",
        text: event.fired
          ? m["debug.tree.split_cyclic_rolled_fired"]({ param: fmt(event.cyclicity), roll: fmt(event.roll) })
          : m["debug.tree.split_cyclic_rolled_not_fired"]({ param: fmt(event.cyclicity), roll: fmt(event.roll) }),
      }];
    case "PatternAdaptationsComputed":
      return [{ kind: "text", text: m["debug.tree.pattern_adaptations_computed"]({ pattern: event.pattern, count: event.count }) }];
    case "PatternAdaptationChosen":
      return [{ kind: "text", text: m["debug.tree.pattern_adaptation_chosen"]({ pattern: event.pattern, rotation: event.rotation, mirror: event.mirror ? "yes" : "no" }) }];
    case "SplitTeleportRolled":
      return event.fired && event.anchor !== null
        ? [{ kind: "text", text: m["debug.tree.split_teleport_rolled_fired"]({ param: fmt(event.teleportChance), roll: fmt(event.roll) }) + " " }, { kind: "node", id: event.anchor }]
        : [{ kind: "text", text: m["debug.tree.split_teleport_rolled_not_fired"]({ param: fmt(event.teleportChance), roll: fmt(event.roll) }) }];
    case "SplitStartReassigned":
      return [{ kind: "text", text: m["debug.tree.split_start_reassigned"]() + " " }, { kind: "node", id: event.reassignedTo }];
    case "SplitParentEdgeRelocated":
      return [{ kind: "text", text: m["debug.tree.split_parent_edge_relocated"]() + " " }, { kind: "edge", from: event.parent, to: event.takenBy, bidirectional: false }];
  }
}

const VERTEX_BASED_ADAPTER: VertexBasedAdapter = {
  mutatingNodeIndices: (tape, startIndex = 0, endIndex) => mutatingVertexBasedEventsWithIndex(tape, undefined, startIndex, endIndex).map((e) => e.nodeIndex),
  resolveMetadata: (tape, startIndex = 0, endIndex) => resolveDebugArenaMetadata(
    tape,
    (t, s, e) => countMutatingEvents(t, decodeVertexBasedEvent, isMutatingVertexBasedEvent, s, e),
    (step, previous) => applyVertexBased(tape, step, previous, startIndex, endIndex),
    startIndex, endIndex,
  ),
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

/** Resolves a check instance id's display label via `titleLookup.checkTypeId` (GitHub issue
 *  #171) then `resolveCheckLabel` — falls back to the raw instance id when `titleLookup` is
 *  absent or the instance isn't found in the live store config (same fallback shape every other
 *  `titleLookup`-driven resolution in this module uses). Returns the label unquoted — callers wrap
 *  it in `quoted()` themselves, same as every other `rule`/`stage`/`strategy` resolver in this
 *  module, so quoting stays a call-site decision rather than baked into the resolver. */
function checkLabelFor(checkId: string, titleLookup?: ScopeTitleLookup): string {
  const typeId = titleLookup?.checkTypeId(checkId);
  return typeId !== undefined ? resolveCheckLabel(typeId, checkId) : checkId;
}

/** QC's counterpart to `narrationTokensForRb`/etc. (GitHub issue #147). `issueKind` is a plain
 *  wire string (not localized) — a stable core identifier; the `issue` token narrates it via
 *  `resolveIssue` (see `issueHighlightTarget`'s call site) rather than showing it raw, mirroring
 *  how `checkId` below is resolved rather than shown as its wire string. `ruleId` is resolved
 *  through `titleLookup` to its current user-facing title first (same resolution `scopeLabel`
 *  applies to a `"rule <id>"` scope's own label — see that doc comment for why this is resolved
 *  live rather than sent across the wire), falling back to the raw id when `titleLookup` is absent
 *  or doesn't recognize it. `checkId` is a check *instance* id (GitHub issue #171, matches
 *  `IssueDto.source_checks`' own keys) — resolved to its type id via `titleLookup.checkTypeId`
 *  then to a display label via `resolveCheckLabel` (`checkLabelFor`, above), mirroring how
 *  `IssuesBlock` resolves the same instance id through `IssueDto.source_check_types`. There is no
 *  dedicated "dispatch result" event/narration line — a rule's applied/proposed outcome is instead
 *  read off the `"apply requests"` scope's own label (see `QC_ADAPTER.scopeLabel`'s doc comment),
 *  mirroring `CustomVertexBased`'s `"junction_count"` scope label precedent. */
function narrationTokensForQc(event: QcEvent, titleLookup?: ScopeTitleLookup): Token[] {
  switch (event.kind) {
    case "IterationStarted":
      return [{ kind: "text", text: m["debug.tree.qc.iteration_started"]({ iteration: event.iteration + 1 }) }];
    case "CheckRan": {
      const checkLabel = quoted(checkLabelFor(event.checkId, titleLookup));
      return event.issue
        ? [
            { kind: "text", text: m["debug.tree.qc.check_ran_found"]({ checkId: checkLabel }) + " " },
            {
              kind: "issue", issueKind: event.issue.issueKind,
              target: issueHighlightTarget(event.issue.payload),
              reasons: issueReasons(event.issue.issueKind, [{ checkId: event.checkId, details: event.issue.details }], titleLookup),
            },
          ]
        : [{ kind: "text", text: m["debug.tree.qc.check_ran_clean"]({ checkId: checkLabel }) }];
    }
    case "IssuesMerged":
      return [
        { kind: "text", text: m["debug.tree.qc.issues_merged"]() + " " },
        {
          kind: "issue", issueKind: event.issueKind,
          target: issueHighlightTarget(event.payload),
          reasons: issueReasons(
            event.issueKind,
            [...event.details].map(([checkId, details]) => ({ checkId, details })),
            titleLookup,
          ),
        },
      ];
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
      return [{ kind: "text", text: m["debug.tree.qc.edge_removed"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "EdgeRemovedBetween":
      return [{ kind: "text", text: m["debug.tree.qc.edge_removed_between"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "EdgeRemovedWithReverse":
      return [{ kind: "text", text: m["debug.tree.qc.edge_removed_with_reverse"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: true }];
    case "TeleportRemovedWithReverse":
      return [{ kind: "text", text: m["debug.tree.qc.teleport_removed_with_reverse"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: true }];
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
      return [{ kind: "text", text: m["debug.tree.qc.edge_remove_declined"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "EdgeRemoveBetweenDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.edge_remove_between_declined"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "EdgeRemoveWithReverseDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.edge_remove_with_reverse_declined"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: true }];
    case "TeleportRemoveWithReverseDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.teleport_remove_with_reverse_declined"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: true }];
    case "StartSetDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.start_set_declined"]() + " " }, { kind: "node", id: event.id }];
    case "FinishSetDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.finish_set_declined"]() + " " }, { kind: "node", id: event.id }];
    case "DirectedEdgeProposed":
      return [{ kind: "text", text: m["debug.tree.qc.directed_edge_proposed"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "BidirectionalEdgeProposed":
      return [{ kind: "text", text: m["debug.tree.qc.bidirectional_edge_proposed"]() + " " }, { kind: "edge", from: event.a, to: event.b, bidirectional: true }];
    case "DirectedTeleportProposed":
      return [{ kind: "text", text: m["debug.tree.qc.directed_teleport_proposed"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "BidirectionalTeleportProposed":
      return [{ kind: "text", text: m["debug.tree.qc.bidirectional_teleport_proposed"]() + " " }, { kind: "edge", from: event.a, to: event.b, bidirectional: true }];
    case "EdgeRemoveProposed":
      return [{ kind: "text", text: m["debug.tree.qc.edge_remove_proposed"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "EdgeRemoveBetweenProposed":
      return [{ kind: "text", text: m["debug.tree.qc.edge_remove_between_proposed"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "EdgeRemoveWithReverseProposed":
      return [{ kind: "text", text: m["debug.tree.qc.edge_remove_with_reverse_proposed"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: true }];
    case "TeleportRemoveWithReverseProposed":
      return [{ kind: "text", text: m["debug.tree.qc.teleport_remove_with_reverse_proposed"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: true }];
    case "StartSetProposed":
      return [{ kind: "text", text: m["debug.tree.qc.start_set_proposed"]() + " " }, { kind: "node", id: event.id }];
    case "FinishSetProposed":
      return [{ kind: "text", text: m["debug.tree.qc.finish_set_proposed"]() + " " }, { kind: "node", id: event.id }];
    case "NodeRemoved":
      return [{ kind: "text", text: m["debug.tree.qc.node_removed"]() + " " }, { kind: "node", id: event.id }];
    case "NodeRemoveDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.node_remove_declined"]() + " " }, { kind: "node", id: event.id }];
    case "NodeRemoveProposed":
      return [{ kind: "text", text: m["debug.tree.qc.node_remove_proposed"]() + " " }, { kind: "node", id: event.id }];
    case "StrategyFailed":
      return [{ kind: "text", text: m["debug.tree.qc.strategy_failed"]({ strategyId: quoted(resolveStrategyLabel(event.strategyId)) }) }];
    case "SplitNodeAdded":
      return [{ kind: "text", text: m["debug.tree.qc.split_node_added"]({ count: event.newNodes.length }) + " " }, { kind: "node", id: event.at }];
    case "SplitNodeAddDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.split_node_add_declined"]() + " " }, { kind: "node", id: event.at }];
    case "SplitNodeAddProposed":
      return [{ kind: "text", text: m["debug.tree.qc.split_node_add_proposed"]({ count: event.nodes.length }) + " " }, { kind: "node", id: event.at }];
  }
}

const QC_STAGE_SCOPE_RE = /^stage (.+)$/;
const QC_ITERATION_SCOPE_RE = /^iteration (\d+)$/;
const QC_RULE_SCOPE_RE = /^rule (.+)$/;
const QC_STRATEGY_SCOPE_RE = /^strategy (.+)$/;

const QC_ADAPTER: QcAdapter = {
  mutatingNodeIndices: (tape, startIndex = 0, endIndex) => mutatingQcEventsWithIndex(tape, undefined, startIndex, endIndex).map((e) => e.nodeIndex),
  resolveMetadata: (tape, startIndex = 0, endIndex) => resolveDebugArenaMetadata(
    tape,
    (t, s, e) => countMutatingEvents(t, decodeQcEvent, isMutatingQcEvent, s, e),
    (step, previous) => applyQc(tape, step, previous, startIndex),
    startIndex, endIndex,
  ),
  decodeEvent: decodeQcEvent,
  isMutatingEvent: isMutatingQcEvent,
  narrationTokensFor: narrationTokensForQc,
  // "stage <id>"/"iteration N"/"rule <id>"/"strategy <id>"/"apply requests" are the only five
  // scope shapes QC produces (see maze-core/src/quality_control/stage.rs's
  // run_repair/check_and_dispatch and rule.rs's check_and_repair_typed). Stage/rule ids are opaque
  // (core has no concept of their user-facing title, only their id) — `titleLookup` resolves each
  // to its current title from the live store config; a missing lookup or an id no longer present
  // in it (e.g. deleted after this tape was generated) falls back to showing the raw id, same as
  // before a title lookup existed. A strategy's id, unlike a stage/rule's, has a fixed display
  // name (not a per-instance user-editable one) — resolved via `resolveStrategyLabel`
  // (`qualityI18n.ts`, the same registry `FeaturesPanel`'s strategy picker reads), quoted the same
  // way a stage/rule title is, falling back to the raw id when the registry doesn't recognize it.
  // "apply requests" is a fixed, non-parameterized scope name (mirrors Wilson's "search"/"commit")
  // — checked before the numbered/id-carrying regexes above, which wouldn't match it. Its own
  // applied/total tally is read off its direct children (mutating events = applied, every event =
  // proposed — a QC scope's only children are ever mutating/`*Declined` events, never nested
  // scopes), mirroring `CustomVertexBased`'s `"junction_count"` scope label precedent — there is
  // no dedicated `QcEvent` carrying this count directly.
  scopeLabel: (name, children, titleLookup) => {
    if (name === "apply requests") {
      let applied = 0;
      let total = 0;
      for (const child of children) {
        const payload = child.payload();
        if (payload.kind !== "event") continue;
        total += 1;
        if (isMutatingQcEvent(decodeQcEvent(payload.tag, payload.bytes))) applied += 1;
      }
      return m["debug.tree.qc.apply_requests_scope"]({ applied, total });
    }
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
    const strategyMatch = QC_STRATEGY_SCOPE_RE.exec(name);
    if (strategyMatch) {
      const strategyId = strategyMatch[1];
      return m["debug.tree.qc.strategy_scope"]({ strategyId: quoted(resolveStrategyLabel(strategyId)) });
    }
    return name;
  },
  apply: applyQc,
};

export type AnyAdapter = PresetSetupAdapter | RbAdapter | KruskalAdapter | WilsonAdapter | EdgeBasedAdapter | VertexBasedAdapter | QcAdapter;

/** Non-overloaded dispatch, shared by `adapterFor`'s per-kind overloads below and by any caller
 *  (e.g. `adapterForNode`, `generateConfigBuilder.ts`) that only has a plain `EventedEventKind`
 *  union value at hand, not a literal — a union argument can't select a specific overload of
 *  `adapterFor`. */
export function adapterForKind(kind: EventedEventKind): AnyAdapter {
  switch (kind) {
    case "preset_setup": return PRESET_SETUP_ADAPTER;
    case "recursive_backtracker": return RB_ADAPTER;
    case "kruskal": return KRUSKAL_ADAPTER;
    case "wilson": return WILSON_ADAPTER;
    case "edge_based": return EDGE_BASED_ADAPTER;
    case "vertex_based": return VERTEX_BASED_ADAPTER;
    case "quality_control": return QC_ADAPTER;
  }
}

export function adapterFor(kind: "preset_setup"): PresetSetupAdapter;
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
