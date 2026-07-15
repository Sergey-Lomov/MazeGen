import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMazeStore } from "../store/mazeStore";
import {
  buildStepIndex, flattenVisibleRows, resolveHighlightTarget, buildNodeCoordIndex,
  displayStepForRow, type TreeRow,
} from "../debug/debugTreeSelectors";
import { adapterFor, type Token, type BaseAlgorithmAdapter } from "../debug/algorithmRegistry";
import { DebugRefBubble } from "./DebugRefBubble";
import { ui, typography, muted } from "../styles/theme";

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
 *  e.g. "Edge added", not "Edge added: 3:18 → 3:19"). Format is `x:y`, no parens/comma. */
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
  }
}

/** Runs one adapter's full scope-label / decode+narrate pipeline for a row. Generic over the
 *  adapter so the decoded event's type flows from `decodeEvent` straight into
 *  `narrationTokensFor`/`isMutatingEvent` on the *same* concrete adapter — no `unknown` laundering
 *  at the decode/narrate boundary (GitHub issue #163's review). */
function rowTokensFor<E>(adapter: BaseAlgorithmAdapter<E>, row: TreeRow): { tokens: Token[]; mutating: boolean } {
  if (row.payload.kind === "scope") {
    return { tokens: [{ kind: "text", text: adapter.scopeLabel(row.payload.name) }], mutating: false };
  }
  const event = adapter.decodeEvent(row.payload.tag, row.payload.bytes);
  return { tokens: adapter.narrationTokensFor(event), mutating: adapter.isMutatingEvent(event) };
}

/** Dispatches to the current algorithm's adapter (GitHub issue #163) — the only place this
 *  component still branches on `algorithmKind`, and only to pick which concrete adapter to run
 *  `rowTokensFor` with. */
function rowTokens(row: TreeRow, algorithmKind: "recursive_backtracker" | "kruskal" | "wilson"): { tokens: Token[]; mutating: boolean } {
  if (algorithmKind === "kruskal") return rowTokensFor(adapterFor("kruskal"), row);
  if (algorithmKind === "wilson") return rowTokensFor(adapterFor("wilson"), row);
  return rowTokensFor(adapterFor("recursive_backtracker"), row);
}

export function DebugEventTree() {
  const debugArena = useMazeStore((s) => s.debugArena);
  const debugStep = useMazeStore((s) => s.debugStep);
  const setDebugStep = useMazeStore((s) => s.setDebugStep);

  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  // Set right before a step-col click sets debugStep — tells the auto-scroll effect below to
  // skip scrolling, since the user is already looking at that row and a jump would be jarring.
  const skipNextScrollRef = useRef(false);

  const tape = debugArena?.tape ?? null;
  const algorithmKind = debugArena?.algorithmKind ?? "recursive_backtracker";
  const stepIndex = useMemo(() => (tape ? buildStepIndex(tape, algorithmKind) : null), [tape, algorithmKind]);
  const coordIndex = useMemo(() => (debugArena ? buildNodeCoordIndex(debugArena.nodes) : null), [debugArena]);
  const coords = useMemo(() => (coordIndex ? (id: bigint) => coordIndex.get(id) : () => null), [coordIndex]);

  const { rows, labels, rowIndexByNodeIndex } = useMemo(() => {
    if (!tape) {
      return { rows: [] as TreeRow[], labels: [] as { tokens: Token[]; mutating: boolean }[], rowIndexByNodeIndex: new Map<number, number>() };
    }
    const rows = flattenVisibleRows(tape, expanded);
    const labels = rows.map((row) => rowTokens(row, algorithmKind));
    const rowIndexByNodeIndex = new Map(rows.map((r, i) => [r.nodeIndex, i]));
    return { rows, labels, rowIndexByNodeIndex };
  }, [tape, expanded, algorithmKind]);

  const highlightedNodeIndex = useMemo(() => {
    if (!tape || !stepIndex) return null;
    return resolveHighlightTarget(tape, stepIndex, debugStep, rowIndexByNodeIndex);
  }, [tape, stepIndex, debugStep, rowIndexByNodeIndex]);

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

  function handleStepClick(step: number, e: React.MouseEvent) {
    e.stopPropagation();
    skipNextScrollRef.current = true;
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
              onClick={() => row.hasChildren && toggleExpanded(row.nodeIndex)}
            >
              <span
                data-testid="step-col"
                style={styles.stepCol}
                onClick={(e) => displayStep !== null && handleStepClick(displayStep, e)}
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
