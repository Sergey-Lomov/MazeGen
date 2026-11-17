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
  type PresetSetupEvent, type RecursiveBacktrackerEvent, type KruskalEvent, type WilsonEvent, type VertexBasedEvent, type QcEvent,
  type PresetSetupApplyResult, type ApplyResult, type KruskalApplyResult, type WilsonApplyResult, type VertexBasedApplyResult, type QcApplyResult,
  decodePresetSetupEvent, isMutatingPresetSetupEvent, mutatingPresetSetupEventsWithIndex, applyPresetSetup,
  decodeRecursiveBacktrackerEvent, isMutatingRecursiveBacktrackerEvent, mutatingRbEventsWithIndex, applyRecursiveBacktracker,
  decodeKruskalEvent, isMutatingKruskalEvent, mutatingKruskalEventsWithIndex, applyKruskal,
  decodeWilsonEvent, isMutatingWilsonEvent, mutatingWilsonEventsWithIndex, applyWilson,
  decodeVertexBasedEvent, isMutatingVertexBasedEvent, mutatingVertexBasedEventsWithIndex, applyVertexBased, VERTEX_BASED_EVENT_TAG,
  decodeQcEvent, isMutatingQcEvent, mutatingQcEventsWithIndex, applyQc, sourceScopeForNode, topLevelSourceScopes,
  resolveDebugArenaMetadata, countMutatingEvents, type DebugArenaMetadata, type TopLevelSourceScope,
} from "./eventTape";
import type { EventedEventKind } from "../wasm/mazeService";
import { resolveStrategyLabel } from "../components/features/qualityI18n";
import * as m from "~/paraglide/messages";
import { quoted, narrationTokensForPresetSetup, narrationTokensForRb, narrationTokensForKruskal, narrationTokensForWilson, narrationTokensForVertexBased, narrationTokensForQc, numberedScopeIndex, QC_STAGE_SCOPE_RE, QC_ITERATION_SCOPE_RE, QC_RULE_SCOPE_RE, QC_STRATEGY_SCOPE_RE, IssueHighlightTarget } from "./algorithmNarration";

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

const RB_ADAPTER: RbAdapter = {
  mutatingNodeIndices: (tape, startIndex = 0, endIndex) => mutatingRbEventsWithIndex(tape, undefined, startIndex, endIndex).map((e) => e.nodeIndex),
  resolveMetadata: (tape, startIndex = 0, endIndex) => resolveDebugArenaMetadata(
    tape,
    (t, s, e) => countMutatingEvents(t, decodeRecursiveBacktrackerEvent, isMutatingRecursiveBacktrackerEvent, s, e),
    (step, previous) => applyRecursiveBacktracker(tape, step, previous, startIndex, endIndex),
    startIndex, endIndex,
  ),
  decodeEvent: decodeRecursiveBacktrackerEvent,
  isMutatingEvent: isMutatingRecursiveBacktrackerEvent,
  narrationTokensFor: narrationTokensForRb,
  scopeLabel: (name, _children) => m["debug.tree.step_scope"]({ index: numberedScopeIndex(name) }),
  apply: applyRecursiveBacktracker,
};

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
        if (payload.kind === "event" && payload.tag === VERTEX_BASED_EVENT_TAG.JUNCTION_SLOT_ROLLED) {
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

export type AnyAdapter = PresetSetupAdapter | RbAdapter | KruskalAdapter | WilsonAdapter | VertexBasedAdapter | QcAdapter;

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
    case "vertex_based": return VERTEX_BASED_ADAPTER;
    case "quality_control": return QC_ADAPTER;
  }
}

export function adapterFor(kind: "preset_setup"): PresetSetupAdapter;
export function adapterFor(kind: "recursive_backtracker"): RbAdapter;
export function adapterFor(kind: "kruskal"): KruskalAdapter;
export function adapterFor(kind: "wilson"): WilsonAdapter;
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
