import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMazeStore } from "../store/mazeStore";
import {
  buildStepIndex, flattenVisibleRows, resolveHighlightTarget, buildNodeCoordIndex,
  displayStepForRow, nodeIndexForStep, resolveBubbleFloor, resolveIssueBubbleFloors, type TreeRow,
} from "../debug/debugTreeSelectors";
import { nodeAt, nodeView, topLevelSourceScopes, type ParsedTape } from "../debug/eventTape";
import { adapterForNode, type Token, type BaseAlgorithmAdapter, type ScopeTitleLookup } from "../debug/algorithmRegistry";
import type { EventedEventKind } from "../wasm/mazeService";
import type { HoveredDebugRef } from "../store/storeTypes";
import { DebugRefBubble } from "./DebugRefBubble";
import { resolveIssue } from "./issueRegistry";
import { ui, typography, muted, spacing, indent } from "../styles/theme";
import * as m from "~/paraglide/messages";

const ROW_MIN_HEIGHT = 26;
const INDENT_PX = indent.tree;
const STEP_COL_WIDTH = 34;
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

/** Bubble label — coordinates only, per user decision (narration text around it stays wordless,
 *  e.g. "Passage added", not "Passage added: 3:18 → 3:19"). Format is `x:y`, no parens/comma —
 *  or, on a multi-floor maze (GitHub issue #350), `Lf:x:y` (1-based floor index, `L` prefix so
 *  it's unambiguous this is a floor, not another coordinate), so a bubble stays readable when
 *  nodes on different floors legitimately share the same `(x, y)`. The floor prefix is only shown
 *  when `multiFloor` — a single-floor maze's bubbles are unchanged, since every node is trivially
 *  floor 1. `issue` tokens are the one exception: there's no id to format, so the label is the
 *  issue kind's own resolved display name (`resolveIssue`, the same registry `IssuesBlock`'s
 *  `IssueBubble` reads), not a coordinate. */
export function bubbleLabel(
  token: Token,
  coords?: (id: bigint) => { x: number; y: number; level: number; i: number; split: boolean } | null,
  multiFloor = false,
): string {
  const fmt = (id: bigint) => {
    if (!coords) return `${id}`;
    const p = coords(id);
    // `coords` joins against `debugArena.nodes` concatenated with `debugArena.allNodes` (GitHub
    // issue #271) — the union of every node that ever existed during the run, including ones a
    // later QC command removed/replaced (`RemoveNode`, `ReplacePointNodes`), not just
    // `debugArena.nodes`'s final survivors (see `coordIndex`'s own `useMemo` below for why both
    // are needed). The `#id` fallback below is now only reached for a genuinely unresolvable id (a
    // real core/web tape desync), not for the common "removed later" case — degrades gracefully
    // rather than crashing the whole tree either way (a React render-time throw here previously
    // took down the entire debug panel).
    if (!p) return `#${id}`;
    const coord = multiFloor ? `L${p.level + 1}:${p.x}:${p.y}` : `${p.x}:${p.y}`;
    // A split point's node also names which node of the point it is (GitHub issue #468) — 1-based
    // compact "N{N}" form, the point's original node is "N1". Non-split points stay bare coords.
    return p.split ? `${coord} (${m["post_edit.split_node_label_short"]({ slotId: p.i + 1 })})` : coord;
  };
  switch (token.kind) {
    case "text": return token.text;
    case "node": return fmt(token.id);
    case "edge": return `${fmt(token.from)} ${token.bidirectional ? "<->" : "->"} ${fmt(token.to)}`;
    case "cycle": return token.edges.map(([f, t]) => `${fmt(f)}–${fmt(t)}`).join(", ");
    case "region": return token.nodes.map(fmt).join(", ");
    case "issue": return resolveIssue(token.issueKind).label;
  }
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
  const debugStepFocusToken = useMazeStore((s) => s.debugStepFocusToken);
  const setDebugStep = useMazeStore((s) => s.setDebugStep);
  const stages = useMazeStore((s) => s.stages);
  const rules = useMazeStore((s) => s.rules);
  const multiFloor = useMazeStore((s) => s.floors.length > 1);
  // Resolved live from the current store config, not from the tape (core has no concept of a
  // rule/stage's display title, only its opaque `id` — see `ScopeTitleLookup`'s doc comment).
  const titleLookup: ScopeTitleLookup = useMemo(() => {
    const stageTitles = new Map(stages.map((s) => [s.id, s.name]));
    const ruleTitles = new Map(rules.map((r) => [r.id, r.name]));
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
  }, [stages, rules]);

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

  // Step-label click (`focusDebugStep`, bumps `debugStepFocusToken`) must force the current
  // step's exact row into view, unlike ordinary playback sync — `resolveHighlightTarget` below
  // deliberately walks up to the nearest *already-visible* ancestor and stops there without
  // expanding anything (per its own doc comment), so if the target row's scope chain is
  // collapsed, a plain re-scroll just re-centers on that same collapsed ancestor with no visible
  // change. Set (not cleared) here on every `debugStepFocusToken` bump, cleared once the scroll
  // effect below has actually scrolled for it — gates that effect's reaction to `expanded`
  // changes so an ordinary manual expand/collapse (this flag false) never re-triggers a scroll.
  const pendingFocusScrollRef = useRef(false);
  const lastFocusTokenRef = useRef(debugStepFocusToken);
  if (lastFocusTokenRef.current !== debugStepFocusToken) {
    lastFocusTokenRef.current = debugStepFocusToken;
    pendingFocusScrollRef.current = true;
  }

  // Distinguishes "this run was caused by debugStep/debugStepFocusToken changing" (always allowed
  // to scroll) from "this run was caused only by `expanded` changing" (allowed to scroll only
  // while a focus-scroll is pending — see below) — `expanded` is a dep of the effect below purely
  // so it can re-check after its own `setExpanded` call, not to license scrolling on every manual
  // toggle.
  const lastScrollTriggerRef = useRef<{ debugStep: number; token: number }>({ debugStep, token: debugStepFocusToken });

  useLayoutEffect(() => {
    // `debugStep` changed for a reason other than a row click in this tree (playback controls,
    // scrubber, a fresh generate()) — the click-selected row no longer applies.
    if (lastClickedStepRef.current !== debugStep) setClickedNodeIndex(null);
    lastClickedStepRef.current = null;

    if (skipNextScrollRef.current) {
      skipNextScrollRef.current = false;
      return;
    }

    const triggeredByStepOrToken =
      lastScrollTriggerRef.current.debugStep !== debugStep || lastScrollTriggerRef.current.token !== debugStepFocusToken;
    lastScrollTriggerRef.current = { debugStep, token: debugStepFocusToken };

    if (!triggeredByStepOrToken && !pendingFocusScrollRef.current) return;

    if (pendingFocusScrollRef.current && tape && stepIndex && debugStep < stepIndex.stepToNodeIndex.length) {
      // Expand every collapsed ancestor of the step's own node before scrolling — otherwise
      // `highlightedNodeIndex` below resolves (via `resolveHighlightTarget`) to the nearest
      // already-visible ancestor instead of the real target row. Only done for an explicit
      // step-label focus (`pendingFocusScrollRef`), never on ordinary playback/scrubber steps —
      // those must not auto-expand. `setExpanded` triggers a new render/commit; this effect is
      // also keyed on `expanded` (see deps below) so it re-runs once that commit lands, at which
      // point `missing` is empty and this branch falls through to the scroll below.
      const targetNodeIndex = nodeIndexForStep(stepIndex, debugStep);
      const ancestors: number[] = [];
      let current: number | null = nodeAt(tape, targetNodeIndex).parent;
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

    if (highlightedNodeIndex === null) return;
    const rowIdx = rowIndexByNodeIndex.get(highlightedNodeIndex);
    if (rowIdx === undefined) return;
    virtualizer.scrollToIndex(rowIdx, { align: "center" });
    // debugStep/debugStepFocusToken changing, or `expanded` catching up while a focus-scroll is
    // pending (see the `pendingFocusScrollRef` guard above), are the only paths that reach this
    // point — an ordinary manual expand/collapse returns earlier and never scrolls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debugStep, debugStepFocusToken, expanded]);

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

  return (
    <div ref={scrollRef} style={styles.scroll}>
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          const { tokens, mutating } = labels[virtualRow.index];
          const highlighted = row.nodeIndex === highlightedNodeIndex;
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
                {displayStep !== null ? displayStep + 1 : "—"}
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
  );
}

const styles: Record<string, React.CSSProperties> = {
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
    width: STEP_COL_WIDTH,
    flexShrink: 0,
    textAlign: "right" as const,
    alignSelf: "center" as const,
    padding: "0 6px",
    boxSizing: "border-box" as const,
    cursor: "default",
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
