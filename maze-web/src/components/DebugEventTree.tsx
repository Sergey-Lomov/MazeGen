import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMazeStore } from "../store/mazeStore";
import {
  buildStepIndex, flattenVisibleRows, resolveHighlightTarget, buildNodeCoordIndex,
  displayStepForRow, type TreeRow,
} from "../debug/debugTreeSelectors";
import { nodeAt, nodeView, topLevelSourceScopes, type ParsedTape } from "../debug/eventTape";
import { adapterForNode, type Token, type BaseAlgorithmAdapter, type ScopeTitleLookup } from "../debug/algorithmRegistry";
import type { EventedEventKind } from "../wasm/mazeService";
import { DebugRefBubble } from "./DebugRefBubble";
import { resolveIssue } from "./issueRegistry";
import { ui, typography, muted } from "../styles/theme";
import * as m from "~/paraglide/messages";

const ROW_MIN_HEIGHT = 26;
const INDENT_PX = 16;
const STEP_COL_WIDTH = 34;
const ROW_BODY_PADDING_LEFT = 8;
const ROW_BODY_PADDING_RIGHT = 8;
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
 *  e.g. "Passage added", not "Passage added: 3:18 → 3:19"). Format is `x:y`, no parens/comma. `issue`
 *  tokens are the one exception: there's no id to format, so the label is the issue kind's own
 *  resolved display name (`resolveIssue`, the same registry `IssuesBlock`'s `IssueBubble` reads),
 *  not a coordinate. */
function bubbleLabel(token: Token, coords?: (id: bigint) => { x: number; y: number } | null): string {
  const fmt = (id: bigint) => {
    if (!coords) return `${id}`;
    const p = coords(id);
    if (!p) throw new Error(`bubbleLabel: node id ${id} not found in debugArena.nodes — core/web tape mismatch`);
    return `${p.x}:${p.y}`;
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
  recursive_backtracker: () => m["debug.tree.source_scope.generation"](),
  kruskal: () => m["debug.tree.source_scope.generation"](),
  wilson: () => m["debug.tree.source_scope.generation"](),
  edge_based: () => m["debug.tree.source_scope.generation"](),
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
  const setDebugStep = useMazeStore((s) => s.setDebugStep);
  const stages = useMazeStore((s) => s.stages);
  const rules = useMazeStore((s) => s.rules);
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

  // Auto-expanding each top-level source scope for a freshly-loaded tape keeps "step N"/"edge
  // N"/... visible immediately instead of forcing a click just to see any content. Each source's
  // own former-root merge artifact (GitHub issue #169's wrapping, GitHub issue #147's regression
  // fix) never gets its own row (see `flattenVisibleRows`'s doc comment), so it needs no entry
  // here — expanding the top-level scope alone already reveals its real children.
  //
  // Resets `expanded` to a fresh Set on every new tape (rather than adding on top of whatever was
  // there before) — node indices are only meaningful within the tape that produced them, so
  // carrying a previous tape's expanded-row indices into a new one is stale state, not a feature:
  // a coincidentally-matching index in the new tape would silently inherit an expand/collapse
  // decision the user never made on this run.
  useLayoutEffect(() => {
    if (!tape) return;
    setExpanded(() => new Set(topLevelSourceScopes(tape).map((scope) => scope.nodeIndex)));
    // Only re-run when the tape identity itself changes (a fresh generate()) — expanding/
    // collapsing individual rows afterward must not re-trigger this auto-expand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tape]);
  const stepIndex = useMemo(() => (tape ? buildStepIndex(tape, stepIndexSources) : null), [tape, stepIndexSources]);
  const coordIndex = useMemo(() => (debugArena ? buildNodeCoordIndex(debugArena.nodes) : null), [debugArena]);
  const coords = useMemo(() => (coordIndex ? (id: bigint) => coordIndex.get(id) : () => null), [coordIndex]);

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
    if (!tape || !stepIndex) return null;
    return resolveHighlightTarget(tape, stepIndex, debugStep, rowIndexByNodeIndex);
  }, [tape, stepIndex, debugStep, rowIndexByNodeIndex]);
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

  useLayoutEffect(() => {
    // `debugStep` changed for a reason other than a row click in this tree (playback controls,
    // scrubber, a fresh generate()) — the click-selected row no longer applies.
    if (lastClickedStepRef.current !== debugStep) setClickedNodeIndex(null);
    lastClickedStepRef.current = null;

    if (skipNextScrollRef.current) {
      skipNextScrollRef.current = false;
      return;
    }
    if (highlightedNodeIndex === null) return;
    const rowIdx = rowIndexByNodeIndex.get(highlightedNodeIndex);
    if (rowIdx === undefined) return;
    virtualizer.scrollToIndex(rowIdx, { align: "center" });
    // Only debugStep should trigger the auto-scroll — expanding/collapsing a node changes
    // rowIndexByNodeIndex too, which would otherwise re-run this and yank the scroll position
    // away from the node the user just expanded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debugStep]);

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
              <span style={{ ...styles.rowBody, paddingLeft: 8 + row.depth * INDENT_PX }}>
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
                      : <DebugRefBubble key={i} target={token} label={bubbleLabel(token, coords)} />
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
    paddingRight: 8,
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
    gap: 4,
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
