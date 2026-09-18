import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, ChevronUp } from "lucide-react";
import { useMazeStore } from "../store/mazeStore";
import {
  buildStepIndex, flattenVisibleRows, allRenderableRows, resolveHighlightTarget, buildNodeCoordIndex,
  buildSearchMatches, nearestVisibleAncestor, displayStepForRow, nodeIndexForStep, stepForNode,
  resolveBubbleFloor, resolveIssueBubbleFloors, type TreeRow,
} from "../debug/debugTreeSelectors";
import { nodeAt, nodeView, topLevelSourceScopes, type ParsedTape } from "../debug/eventTape";
import { adapterForNode, type Token, type BaseAlgorithmAdapter, type ScopeTitleLookup } from "../debug/algorithmRegistry";
import { buildDebugRowText, normalizeSearchText, bubbleLabel } from "../debug/debugRowText";
import type { EventedEventKind } from "../wasm/mazeService";
import type { HoveredDebugRef } from "../store/storeTypes";
import { DebugRefBubble } from "./DebugRefBubble";
import { ui, typography, muted, spacing, indent, radius, inset } from "../styles/theme";
import * as m from "~/paraglide/messages";
import { resolveIssueLabel } from "./features/qualityI18n";
import { useLocale } from "../i18n/useLocale";

export { bubbleLabel } from "../debug/debugRowText";

const ROW_MIN_HEIGHT = 26;
const INDENT_PX = indent.tree;
const STEP_COL_WIDTH = 46;
const ROW_BODY_PADDING_LEFT = spacing.rowGap;
const ROW_BODY_PADDING_RIGHT = spacing.rowGap;
const DISCLOSURE_WIDTH = 14;
const TEXT_GAP = 4;
// typography.body: fontSize 14px — average glyph width for a proportional sans-serif font is
// roughly 0.55-0.6x the font size; used only to pre-size virtualized rows before they're
// measured, not for actual layout.
const AVG_CHAR_WIDTH_PX = 8;
const ROW_LINE_HEIGHT_PX = 17;
const ROW_VERTICAL_PADDING_PX = ROW_MIN_HEIGHT - 16;
// A ref bubble (border + padding around its "(x,y)"-shaped label) renders visibly wider than the
// same character count of plain text — this many extra "chars" are added per bubble token when
// pre-sizing a row, so the pre-mount estimate leans slightly wide rather than narrow. Rows are
// re-measured via `measureElement` once mounted (see below), so this only needs to avoid being
// grossly too small, not be exact.
const BUBBLE_CHAR_OVERHEAD = 4;

/** Estimates a row's rendered height from its wrapped text line count, before it's ever mounted. */
function estimateRowHeight(tokens: Token[], depth: number, containerWidth: number): number {
  const availableWidth =
    containerWidth - STEP_COL_WIDTH - ROW_BODY_PADDING_LEFT - depth * INDENT_PX
    - DISCLOSURE_WIDTH - TEXT_GAP - ROW_BODY_PADDING_RIGHT;
  const charsPerLine = Math.max(1, Math.floor(availableWidth / AVG_CHAR_WIDTH_PX));
  const charCount = tokens.reduce((sum, t) => sum + (t.kind === "text" ? t.text.length : bubbleLabel(t).length + BUBBLE_CHAR_OVERHEAD), 0);
  const lineCount = Math.max(1, Math.ceil(charCount / charsPerLine));
  return Math.max(ROW_MIN_HEIGHT, lineCount * ROW_LINE_HEIGHT_PX + ROW_VERTICAL_PADDING_PX);
}

/** Runs one adapter's full scope-label / decode+narrate pipeline for a row. Generic over the
 *  adapter so the decoded event's type flows from `decodeEvent` straight into
 *  `narrationTokensFor`/`isMutatingEvent` on the *same* concrete adapter — no `unknown` laundering
 *  at the decode/narrate boundary (GitHub issue #163's review). */
function rowTokensFor<E>(adapter: BaseAlgorithmAdapter<E>, tape: ParsedTape, row: TreeRow, titleLookup: ScopeTitleLookup): { tokens: Token[]; mutating: boolean } {
  if (row.payload.kind === "scope") {
    const children = nodeView(tape, row.nodeIndex).children();
    return { tokens: [{ kind: "text", text: adapter.scopeLabel(row.payload.name, children, titleLookup) }], mutating: false };
  }
  const event = adapter.decodeEvent(row.payload.tag, row.payload.bytes);
  return { tokens: adapter.narrationTokensFor(event, titleLookup), mutating: adapter.isMutatingEvent(event) };
}

/** Dispatches to the right row's own source adapter (GitHub issue #147, generalizing #163's single-
 *  algorithm dispatch to a possibly-multi-source tape) — resolves per row via `adapterForNode`
 *  (Contract B, `Specs/event_log.md`'s #147 section) rather than one algorithm kind for the whole
 *  tree, since a merged tape's rows may now belong to different top-level sources (generation vs.
 *  QC). `adapterForNode` returns `AnyAdapter`, a union over six concrete adapter types — TS can't
 *  instantiate `rowTokensFor<E>`'s single type parameter from a union value directly (it would have
 *  to pick one `E` for every possible member at once, which is unsound in general). The cast to
 *  `BaseAlgorithmAdapter<unknown>` here is safe in this specific case because `rowTokensFor` never
 *  constructs an `E` itself — it only decodes a payload into `E` via `adapter.decodeEvent` and
 *  immediately feeds that same value back into `adapter.narrationTokensFor`/`isMutatingEvent` on the
 *  *same* adapter instance, so whichever concrete `E` the runtime adapter actually uses stays
 *  internally consistent regardless of what the static type parameter says. */
const SOURCE_SCOPE_LABEL: Record<EventedEventKind, () => string> = {
  preset_setup: () => m["debug.tree.source_scope.preset_setup"](),
  recursive_backtracker: () => m["debug.tree.source_scope.generation"](),
  kruskal: () => m["debug.tree.source_scope.generation"](),
  wilson: () => m["debug.tree.source_scope.generation"](),
  vertex_based: () => m["debug.tree.source_scope.generation"](),
  quality_control: () => m["debug.tree.source_scope.quality_control"](),
};

function rowTokens(
  tape: ParsedTape,
  row: TreeRow,
  sourceEventKinds: readonly EventedEventKind[],
  topLevelScopeKinds: ReadonlyMap<number, EventedEventKind>,
  titleLookup: ScopeTitleLookup,
): { tokens: Token[]; mutating: boolean } {
  // A top-level source scope's label names *which source* this subtree came from ("Generation"/
  // "Quality Control"), not a step within it — no per-algorithm adapter's own `scopeLabel` was
  // ever designed to name this node (it only ever saw "step N"/"edge N"/... scope names before
  // GitHub issue #147 made a second, non-generation top-level source exist), so this is resolved
  // directly from `topLevelScopeKinds` instead of falling through to `adapter.scopeLabel`.
  const topLevelKind = topLevelScopeKinds.get(row.nodeIndex);
  if (topLevelKind !== undefined) {
    return { tokens: [{ kind: "text", text: SOURCE_SCOPE_LABEL[topLevelKind]() }], mutating: false };
  }
  const adapter = adapterForNode(tape, row.nodeIndex, sourceEventKinds) as BaseAlgorithmAdapter<unknown>;
  return rowTokensFor(adapter, tape, row, titleLookup);
}

export function DebugEventTree() {
  const debugArena = useMazeStore((s) => s.debugArena);
  const debugStep = useMazeStore((s) => s.debugStep);
  const debugFocusToken = useMazeStore((s) => s.debugFocusToken);
  const debugFocusNodeIndex = useMazeStore((s) => s.debugFocusNodeIndex);
  const debugSearchQuery = useMazeStore((s) => s.debugSearchQuery);
  const setDebugSearchQuery = useMazeStore((s) => s.setDebugSearchQuery);
  const focusDebugNode = useMazeStore((s) => s.focusDebugNode);
  const setDebugStep = useMazeStore((s) => s.setDebugStep);
  const stages = useMazeStore((s) => s.stages);
  const rules = useMazeStore((s) => s.rules);
  const multiFloor = useMazeStore((s) => s.floors.length > 1);
  const { locale } = useLocale();
  // Resolved live from the current store config, not from the tape (core has no concept of a
  // rule/stage's display title, only its opaque `id` — see `ScopeTitleLookup`'s doc comment).
  // `r.name` is `null` for a rule with no custom name — falls back to the issue kind's own
  // live-locale label, same as `useQualityViewModel`'s VM resolves it (GitHub issue #556).
  const titleLookup: ScopeTitleLookup = useMemo(() => {
    const stageTitles = new Map(stages.map((s) => [s.id, s.name]));
    const ruleTitles = new Map(rules.map((r) => [r.id, r.name ?? resolveIssueLabel(r.kind)]));
    // Composite `"{ruleId}:{localId}"` -> typeId (GitHub issue #171) — matches the wire's own
    // check-instance routing key (`maze-wasm/src/runner.rs`'s `build_qc_and_repair_with_types`),
    // same as `IssueDto.source_check_types` resolves for the analytics panel.
    const checkTypeIds = new Map<string, string>(
      rules.flatMap((r) => (r.checks ?? []).map((c) => [`${r.id}:${c.localId}`, c.typeId] as [string, string])),
    );
    return {
      stageTitle: (id) => stageTitles.get(id),
      ruleTitle: (id) => ruleTitles.get(id),
      checkTypeId: (instanceId) => checkTypeIds.get(instanceId),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `locale` isn't read directly, but
    // `resolveIssueLabel` reads the current paraglide locale internally.
  }, [stages, rules, locale]);

  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  // Set right before a step-col click sets debugStep — tells the auto-scroll effect below to
  // skip scrolling, since the user is already looking at that row and a jump would be jarring.
  const skipNextScrollRef = useRef(false);
  // The row the user actually clicked (GitHub issue #166) — decoupled from `debugStep`-driven
  // highlighting. A trace-only row's click jumps `debugStep` to its *nearest preceding* mutating
  // step, but the row that should stay highlighted is the one clicked, not that mutating step's
  // own row. `null` means "no override" — fall back to the step-based target. Cleared whenever
  // `debugStep` changes for any reason other than this row-click itself (playback controls,
  // scrubber, a fresh generate()) via `lastClickedStepRef` below.
  const [clickedNodeIndex, setClickedNodeIndex] = useState<number | null>(null);
  const lastClickedStepRef = useRef<number | null>(null);

  const tape = debugArena?.tape ?? null;
  const sourceEventKinds = useMemo(() => debugArena?.sources.map((s) => s.kind) ?? ["recursive_backtracker" as const], [debugArena]);
  const topLevelScopeKinds = useMemo(
    () => new Map(debugArena?.sources.map((s) => [s.nodeIndex, s.kind] as const) ?? []),
    [debugArena],
  );
  const stepIndexSources = useMemo(
    () => debugArena?.sources.map((s) => ({ kind: s.kind, nodeIndex: s.nodeIndex })),
    [debugArena],
  );
  // Each top-level source scope's own former-root merge artifact (GitHub issue #169's wrapping,
  // #147's regression fix) — see `flattenVisibleRows`'s doc comment for why these must never get
  // their own row.
  const transparentNodeIndices = useMemo(() => {
    if (!tape) return new Set<number>();
    const result = new Set<number>();
    for (const scope of topLevelSourceScopes(tape)) {
      const formerRoot = nodeAt(tape, scope.nodeIndex).firstChild;
      if (formerRoot !== null) result.add(formerRoot);
    }
    return result;
  }, [tape]);

  // Resets `expanded` to a fresh, empty Set on every new tape (rather than adding on top of
  // whatever was there before) — node indices are only meaningful within the tape that produced
  // them, so carrying a previous tape's expanded-row indices into a new one is stale state, not a
  // feature: a coincidentally-matching index in the new tape would silently inherit an
  // expand/collapse decision the user never made on this run.
  useLayoutEffect(() => {
    if (!tape) return;
    setExpanded(() => new Set());
    // Only re-run when the tape identity itself changes (a fresh generate()) — expanding/
    // collapsing individual rows afterward must not re-trigger this reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tape]);
  const stepIndex = useMemo(() => (tape ? buildStepIndex(tape, stepIndexSources) : null), [tape, stepIndexSources]);
  const coordIndex = useMemo(
    // `allNodes` (GitHub issue #271) is only the ledger of nodes minted mid-run (preset split,
    // pattern-mode split, QC/repair mint) — it deliberately excludes the field's original base
    // nodes (see `DebugGenerationState`'s doc comment: they're never removed, so they're always in
    // `nodes` already). Concatenating both here is what makes the union actually a union.
    () => (debugArena ? buildNodeCoordIndex([...debugArena.nodes, ...debugArena.allNodes]) : null),
    [debugArena],
  );
  const coords = useMemo(() => (coordIndex ? (id: bigint) => coordIndex.get(id) : () => null), [coordIndex]);

  // Bubble click -> floor switch (GitHub issue #350): resolved from the same `coordIndex` used for
  // bubble labels, against `activeFloorId`'s own array position (`floors` is bottom-to-top, per
  // `Specs/floors.md` — `activeFloorIndex` here matches `NodeDto.level`'s own convention).
  const floors = useMazeStore((s) => s.floors);
  const activeFloorId = useMazeStore((s) => s.activeFloorId);
  const setActiveFloorId = useMazeStore((s) => s.setActiveFloorId);
  const activeFloorIndex = floors.findIndex((f) => f.id === activeFloorId);
  const onBubbleClick = useMemo(() => {
    if (!multiFloor) return undefined;
    return (target: HoveredDebugRef) => {
      const floorIndex = resolveBubbleFloor(target, coords, activeFloorIndex);
      if (floorIndex !== null && floors[floorIndex]) setActiveFloorId(floors[floorIndex].id);
    };
  }, [multiFloor, coords, activeFloorIndex, floors, setActiveFloorId]);
  // An `issue` bubble's own row of `L{n}` floor badges (GitHub issue #467, superseding the single
  // badge of GitHub issue #350) — `DebugRefBubble` only reads this for `target.kind === "issue"`,
  // every other bubble kind already shows its floor via the label's own `Lf:x:y` prefix. Lists
  // every distinct floor the issue's structural payload touches (deduplicated, ascending), matching
  // the Analytics `IssueBubble`'s own `IssueFloorBadges` behavior — a floor-scoped canvas highlight
  // only shows the active floor's entities, so this is where a user discovers the same issue also
  // has entities on another floor. `undefined` on a single-floor maze (nothing to badge).
  const resolveTargetFloors = useMemo(
    () => (multiFloor ? (target: HoveredDebugRef) => resolveIssueBubbleFloors(target, coords) : undefined),
    [multiFloor, coords],
  );

  const { rows, labels, rowIndexByNodeIndex } = useMemo(() => {
    if (!tape) {
      return { rows: [] as TreeRow[], labels: [] as { tokens: Token[]; mutating: boolean }[], rowIndexByNodeIndex: new Map<number, number>() };
    }
    const rows = flattenVisibleRows(tape, expanded, transparentNodeIndices);
    const labels = rows.map((row) => rowTokens(tape, row, sourceEventKinds, topLevelScopeKinds, titleLookup));
    const rowIndexByNodeIndex = new Map(rows.map((r, i) => [r.nodeIndex, i]));
    return { rows, labels, rowIndexByNodeIndex };
  }, [tape, expanded, sourceEventKinds, topLevelScopeKinds, transparentNodeIndices, titleLookup]);

  const stepBasedHighlight = useMemo(() => {
    if (!tape || !stepIndex || !debugArena || debugArena.sources.length === 0) return null;
    return resolveHighlightTarget(tape, stepIndex, debugStep, rowIndexByNodeIndex, debugArena.sources[0].nodeIndex);
  }, [tape, stepIndex, debugStep, rowIndexByNodeIndex, debugArena]);
  // A row click's own node wins over the step-based target (see `clickedNodeIndex`'s doc comment)
  // as long as it's still visible under the current expand/collapse state — otherwise falls back
  // to the step-based target the same way a stale `debugStep` target would.
  const highlightedNodeIndex =
    clickedNodeIndex !== null && rowIndexByNodeIndex.has(clickedNodeIndex) ? clickedNodeIndex : stepBasedHighlight;

  // Search index (GitHub issue #482): canonical plain text of *every* renderable row — collapsed
  // scopes included, since a match inside a collapsed scope must still be findable — built once per
  // tape/config, not per keystroke. `allRenderableRows` gets the real `transparentNodeIndices` (not
  // its default) so each merged source's former-root artifact isn't indexed as a bogus row. Same
  // dep set as `labels` plus `transparentNodeIndices`/`coords`/`multiFloor`.
  const searchIndex = useMemo(() => {
    if (!tape) return [] as { nodeIndex: number; text: string }[];
    return allRenderableRows(tape, transparentNodeIndices).map((row) => {
      const { tokens } = rowTokens(tape, row, sourceEventKinds, topLevelScopeKinds, titleLookup);
      return { nodeIndex: row.nodeIndex, text: normalizeSearchText(buildDebugRowText(tokens, coords, multiFloor)) };
    });
  }, [tape, transparentNodeIndices, sourceEventKinds, topLevelScopeKinds, titleLookup, coords, multiFloor]);

  const normalizedQuery = normalizeSearchText(debugSearchQuery.trim());
  const matches = useMemo(() => buildSearchMatches(searchIndex, normalizedQuery), [searchIndex, normalizedQuery]);
  const matchNodeIndexSet = useMemo(() => new Set(matches), [matches]);

  // A row gets the search dot if it matches *or* any node in its subtree matches (so a collapsed
  // scope still signals "there's a hit in here") — every matched node plus all its arena ancestors.
  const matchOrAncestorSet = useMemo(() => {
    const set = new Set<number>();
    if (!tape) return set;
    for (const nodeIndex of matches) {
      let current: number | null = nodeIndex;
      while (current !== null && !set.has(current)) {
        set.add(current);
        current = nodeAt(tape, current).parent;
      }
    }
    return set;
  }, [tape, matches]);

  // Raw current-match anchor — set only by search navigation (`navigate` below). Resolved to an
  // effective value in `effectiveCurrentNodeIndex`, which also handles "query just changed" and
  // "external click landed on a match".
  const [currentMatchNodeIndex, setCurrentMatchNodeIndex] = useState<number | null>(null);
  const effectiveCurrentNodeIndex = useMemo(() => {
    if (currentMatchNodeIndex !== null && matchNodeIndexSet.has(currentMatchNodeIndex)) return currentMatchNodeIndex;
    if (highlightedNodeIndex !== null && matchNodeIndexSet.has(highlightedNodeIndex)) return highlightedNodeIndex;
    return matches[0] ?? null;
  }, [currentMatchNodeIndex, matchNodeIndexSet, highlightedNodeIndex, matches]);

  const matchCount = matches.length;
  const currentMatchOrdinal =
    effectiveCurrentNodeIndex !== null ? matches.indexOf(effectiveCurrentNodeIndex) + 1 : 0;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    // Without this, TanStack Virtual's measured-size cache is keyed by plain index — collapsing
    // a scope shifts every following row to a lower index, so a row can inherit another row's
    // stale (e.g. two-line-tall) cached height until it happens to be re-measured. Keying by
    // nodeIndex ties each cached size to the row it was actually measured from.
    getItemKey: (index) => rows[index].nodeIndex,
    // Estimates wrapped line count from text length instead of assuming ROW_MIN_HEIGHT — keeps
    // getTotalSize() close to the real content height even for unmeasured rows, so the native
    // scrollbar thumb doesn't drift behind the cursor while it's being dragged.
    estimateSize: (index) => {
      const containerWidth = scrollRef.current?.clientWidth ?? 0;
      return estimateRowHeight(labels[index].tokens, rows[index].depth, containerWidth);
    },
    // Row text now wraps instead of being ellipsis-truncated, so height varies — measure the
    // actual rendered element rather than assuming a fixed row height.
    measureElement: (el) => el.getBoundingClientRect().height,
    overscan: 20,
  });

  // A focus request (step-label click via `focusDebugStep`, or a search-match jump via
  // `focusDebugNode` — GitHub issue #482) must force a specific row into view, unlike ordinary
  // playback sync — `resolveHighlightTarget`/`nearestVisibleAncestor` deliberately walk up to the
  // nearest *already-visible* ancestor and stop there without expanding anything, so if the target
  // row's scope chain is collapsed, a plain re-scroll just re-centers on that same collapsed
  // ancestor with no visible change. Set (not cleared) here on every `debugFocusToken` bump,
  // cleared once the scroll effect below has actually scrolled for it — gates that effect's
  // reaction to `expanded` changes so an ordinary manual expand/collapse never re-triggers a scroll.
  const pendingFocusScrollRef = useRef(false);
  const lastFocusTokenRef = useRef(debugFocusToken);
  if (lastFocusTokenRef.current !== debugFocusToken) {
    lastFocusTokenRef.current = debugFocusToken;
    pendingFocusScrollRef.current = true;
  }
  // A search prev/next jump in flight (`navigate`): the row it selected and the `debugStep` it
  // moved to. The focus effect re-runs while it expands the target's collapsed ancestors (each
  // `setExpanded` commits and re-fires the effect via its `expanded` dep, returning early before
  // the scroll) — on those intermediate runs `debugStep` already holds the jump's target value, so
  // without this the effect's "debugStep changed for a non-click reason -> drop the selection"
  // branch would clear the just-navigated row. The ref pins `clickedNodeIndex` to `nodeIndex`
  // until `debugStep` has settled on `step`, then clears.
  const navPendingRef = useRef<{ nodeIndex: number; step: number } | null>(null);

  // Distinguishes "this run was caused by debugStep/debugFocusToken changing" (always allowed to
  // scroll) from "this run was caused only by `expanded` changing" (allowed to scroll only while a
  // focus-scroll is pending — see below) — `expanded` is a dep of the effect below purely so it
  // can re-check after its own `setExpanded` call, not to license scrolling on every manual toggle.
  const lastScrollTriggerRef = useRef<{ debugStep: number; token: number }>({ debugStep, token: debugFocusToken });

  useLayoutEffect(() => {
    const navPending = navPendingRef.current;
    if (navPending !== null) {
      // A search prev/next jump: keep its row selected across the effect's re-runs while it
      // expands collapsed ancestors; only stop shielding once `debugStep` has settled on the
      // jump's target step.
      setClickedNodeIndex(navPending.nodeIndex);
      lastClickedStepRef.current = navPending.step;
      if (debugStep === navPending.step) navPendingRef.current = null;
    } else if (lastClickedStepRef.current !== debugStep) {
      // `debugStep` changed for a reason other than a row click in this tree (playback controls,
      // scrubber, a fresh generate()) — the click-selected row no longer applies.
      setClickedNodeIndex(null);
      lastClickedStepRef.current = null;
    } else {
      lastClickedStepRef.current = null;
    }

    if (skipNextScrollRef.current) {
      skipNextScrollRef.current = false;
      return;
    }

    const triggeredByStepOrToken =
      lastScrollTriggerRef.current.debugStep !== debugStep || lastScrollTriggerRef.current.token !== debugFocusToken;
    lastScrollTriggerRef.current = { debugStep, token: debugFocusToken };

    if (!triggeredByStepOrToken && !pendingFocusScrollRef.current) return;

    // The row a pending focus request targets: an explicit arena node (`focusDebugNode`, e.g. a
    // search-match jump to a scope/trace row that has no `debugStep` of its own) takes priority;
    // `null` (`focusDebugStep`) means "the current step's own row".
    const focusTargetNodeIndex =
      debugFocusNodeIndex ??
      (stepIndex && debugStep < stepIndex.stepToNodeIndex.length ? nodeIndexForStep(stepIndex, debugStep) : null);
    const wasFocusScroll = pendingFocusScrollRef.current;

    if (pendingFocusScrollRef.current && tape && focusTargetNodeIndex !== null) {
      // Expand every collapsed ancestor of the focus target before scrolling — otherwise the
      // scroll target below resolves (via `nearestVisibleAncestor`) to the nearest already-visible
      // ancestor instead of the real target row. Only done for an explicit focus request, never on
      // ordinary playback/scrubber steps. `setExpanded` triggers a new render/commit; this effect
      // is also keyed on `expanded` (see deps below) so it re-runs once that commit lands, at
      // which point `missing` is empty and this branch falls through to the scroll below.
      const ancestors: number[] = [];
      let current: number | null = nodeAt(tape, focusTargetNodeIndex).parent;
      while (current !== null) {
        ancestors.push(current);
        current = nodeAt(tape, current).parent;
      }
      const missing = ancestors.filter((idx) => !expanded.has(idx));
      if (missing.length > 0) {
        setExpanded((prev) => new Set([...prev, ...missing]));
        return;
      }
    }
    pendingFocusScrollRef.current = false;

    if (wasFocusScroll && tape && focusTargetNodeIndex !== null) {
      // Focus-scroll: ancestors are expanded now (branch above), so `nearestVisibleAncestor`
      // returns the target row itself.
      const rowIdx = rowIndexByNodeIndex.get(nearestVisibleAncestor(tape, focusTargetNodeIndex, rowIndexByNodeIndex));
      if (rowIdx !== undefined) virtualizer.scrollToIndex(rowIdx, { align: "center" });
      return;
    }

    // Playback-scroll: follow the step-based highlight, no auto-expand.
    if (highlightedNodeIndex === null) return;
    const rowIdx = rowIndexByNodeIndex.get(highlightedNodeIndex);
    if (rowIdx === undefined) return;
    virtualizer.scrollToIndex(rowIdx, { align: "center" });
    // debugStep/debugFocusToken changing, or `expanded` catching up while a focus-scroll is
    // pending (see the `pendingFocusScrollRef` guard above), are the only paths that reach this
    // point — an ordinary manual expand/collapse returns earlier and never scrolls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debugStep, debugFocusToken, expanded]);

  if (!tape || !stepIndex) return null;

  function toggleExpanded(nodeIndex: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(nodeIndex)) next.delete(nodeIndex);
      else next.add(nodeIndex);
      return next;
    });
  }

  function handleStepClick(step: number, nodeIndex: number, e: React.MouseEvent) {
    e.stopPropagation();
    // Only arm the scroll-skip/clicked-step bookkeeping when this click actually changes
    // `debugStep` — the effect below is keyed on `[debugStep]`, so if `step` already equals the
    // current value, `setDebugStep` is a no-op and that effect never re-runs to consume (reset)
    // these refs. Leaving them set in that case would leak `skipNextScrollRef.current = true` into
    // the next *genuine* debugStep change (Play/Prev/Next/scrubber), silently skipping its
    // auto-scroll once (GitHub issue #166 review).
    if (step !== debugStep) {
      skipNextScrollRef.current = true;
      lastClickedStepRef.current = step;
    }
    setClickedNodeIndex(nodeIndex);
    setDebugStep(step);
  }

  // Search-match navigation (GitHub issue #482). `delta` +1 = next, -1 = prev, both wrap. No-op
  // when there's 0 or 1 match. Behaves like clicking the match row: moves `debugStep` (a mutating
  // match to its own step, a scope/trace match to its nearest-preceding step) *and* selects the
  // row itself via `setClickedNodeIndex`, so the highlighted row is the one navigated to, not that
  // step's own mutating row. All four state updates batch into one commit; `focusDebugNode` drives
  // expand-ancestors + scroll in the focus effect, and `navPendingRef` shields the selection from
  // that effect's re-runs while it expands (see `navPendingRef`'s declaration).
  function navigate(delta: 1 | -1) {
    if (matchCount <= 1 || !stepIndex) return;
    const cur = effectiveCurrentNodeIndex !== null ? matches.indexOf(effectiveCurrentNodeIndex) : 0;
    const n = matches[(cur + delta + matchCount) % matchCount];
    const step = stepForNode(stepIndex, n);
    navPendingRef.current = { nodeIndex: n, step };
    setCurrentMatchNodeIndex(n);
    setClickedNodeIndex(n);
    focusDebugNode(n);
    setDebugStep(step);
  }

  return (
    <div style={styles.container}>
      <div style={styles.searchRow}>
        <input
          type="text"
          value={debugSearchQuery}
          onChange={(e) => setDebugSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            navigate(e.shiftKey ? -1 : 1);
          }}
          placeholder={m["debug.search.placeholder"]()}
          style={styles.searchInput}
        />
        <span style={styles.searchCounter}>{`${currentMatchOrdinal} / ${matchCount}`}</span>
        <button
          type="button"
          onClick={() => navigate(-1)}
          disabled={matchCount <= 1}
          title={m["debug.search.prev"]()}
          style={styles.searchNavBtn}
        >
          <ChevronUp size={14} color={ui.text.secondary} />
        </button>
        <button
          type="button"
          onClick={() => navigate(1)}
          disabled={matchCount <= 1}
          title={m["debug.search.next"]()}
          style={styles.searchNavBtn}
        >
          <ChevronDown size={14} color={ui.text.secondary} />
        </button>
      </div>
      <div ref={scrollRef} style={styles.scroll}>
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          const { tokens, mutating } = labels[virtualRow.index];
          const highlighted = row.nodeIndex === highlightedNodeIndex;
          const isSearchMatch = matchOrAncestorSet.has(row.nodeIndex);
          const isExpanded = expanded.has(row.nodeIndex);
          const displayStep = displayStepForRow(tape, stepIndex, row);
          return (
            <div
              key={row.nodeIndex}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              className="hoverable"
              style={{
                ...styles.row,
                transform: `translateY(${virtualRow.start}px)`,
                background: highlighted ? ui.bg.panelAlt : undefined,
              }}
              onClick={(e) => {
                if (row.hasChildren) toggleExpanded(row.nodeIndex);
                else if (displayStep !== null) handleStepClick(displayStep, row.nodeIndex, e);
              }}
            >
              <span
                data-testid="step-col"
                style={styles.stepCol}
                onClick={(e) => displayStep !== null && handleStepClick(displayStep, row.nodeIndex, e)}
              >
                <span style={styles.stepNum}>{displayStep !== null ? displayStep + 1 : "—"}</span>
                {isSearchMatch && <span data-testid="search-match-dot" style={styles.searchMatchDot} />}
              </span>
              <span style={{ ...styles.rowBody, paddingLeft: ROW_BODY_PADDING_LEFT + row.depth * INDENT_PX }}>
                {row.hasChildren ? (
                  <span style={styles.disclosure}>
                    {isExpanded ? <ChevronDown size={14} color={ui.text.tertiary} /> : <ChevronRight size={14} color={ui.text.tertiary} />}
                  </span>
                ) : (
                  <span style={styles.disclosurePlaceholder} />
                )}
                <span style={row.payload.kind === "scope" ? styles.scopeText : mutating ? styles.mutatingText : styles.traceText}>
                  {tokens.map((token, i) =>
                    token.kind === "text"
                      ? <React.Fragment key={i}>{token.text}</React.Fragment>
                      : <DebugRefBubble
                          key={i}
                          target={token}
                          label={bubbleLabel(token, coords, multiFloor)}
                          onClickFloor={onBubbleClick}
                          targetFloorIndices={resolveTargetFloors?.(token)}
                        />
                  )}
                </span>
              </span>
            </div>
          );
        })}
      </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  searchRow: {
    display: "flex",
    alignItems: "center",
    gap: spacing.itemGap,
    padding: `6px ${spacing.rowGap}px`,
    borderBottom: `1px solid ${ui.border.default}`,
    flexShrink: 0,
  },
  searchInput: {
    ...typography.field,
    flex: 1,
    minWidth: 0,
    background: ui.bg.input,
    border: `1px solid ${ui.border.default}`,
    borderRadius: radius.sm,
    padding: "2px 6px",
  },
  searchCounter: {
    ...muted(typography.caption),
    flexShrink: 0,
    fontVariantNumeric: "tabular-nums",
  },
  searchNavBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: inset.iconButtonInset,
    background: "transparent",
    border: `1px solid ${ui.border.default}`,
    borderRadius: radius.sm,
    cursor: "pointer",
    flexShrink: 0,
  },
  // Absolute inside the column's reserved right padding — out of flow, so it never shifts the
  // digits regardless of how many there are.
  searchMatchDot: {
    position: "absolute",
    top: 1,
    right: 2,
    width: 5,
    height: 5,
    borderRadius: "50%",
    background: ui.debug.searchMatch,
    pointerEvents: "none",
  },
  scroll: {
    flex: 1,
    overflowY: "auto",
    position: "relative",
  },
  row: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    minHeight: ROW_MIN_HEIGHT,
    display: "flex",
    alignItems: "center",
    cursor: "default",
    paddingRight: spacing.rowGap,
  },
  stepCol: {
    ...muted(typography.body),
    position: "relative",
    width: STEP_COL_WIDTH,
    flexShrink: 0,
    textAlign: "right" as const,
    alignSelf: "center" as const,
    // Right padding reserves the strip the absolute dot lives in — digits stop at its left edge,
    // so the dot never pushes or overlaps the number at any digit count.
    padding: "0 10px 0 4px",
    boxSizing: "border-box" as const,
    cursor: "default",
  },
  stepNum: {
    display: "inline-block",
  },
  rowBody: {
    display: "flex",
    alignItems: "flex-start",
    gap: spacing.itemGap,
    flex: 1,
    minWidth: 0,
    padding: `${(ROW_MIN_HEIGHT - 16) / 2}px 0`,
  },
  disclosure: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 14,
    height: 16,
    flexShrink: 0,
  },
  disclosurePlaceholder: {
    width: 14,
    flexShrink: 0,
  },
  scopeText: {
    ...typography.body,
    fontWeight: 600,
    color: ui.text.primary,
    whiteSpace: "normal",
    wordBreak: "break-word" as const,
    minWidth: 0,
  },
  mutatingText: {
    ...typography.body,
    color: ui.text.primary,
    whiteSpace: "normal",
    wordBreak: "break-word" as const,
    minWidth: 0,
  },
  traceText: {
    ...muted(typography.body),
    whiteSpace: "normal",
    wordBreak: "break-word" as const,
    minWidth: 0,
  },
};
