import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMazeStore } from "../store/mazeStore";
import {
  buildStepIndex, flattenVisibleRows, resolveHighlightTarget, stepForNode, buildNodeCoordIndex,
  type TreeRow,
} from "../debug/debugTreeSelectors";
import { decodeRecursiveBacktrackerEvent, isMutatingRbEvent, type RecursiveBacktrackerEvent } from "../debug/eventTape";
import { ui, typography, muted } from "../styles/theme";
import * as m from "~/paraglide/messages";

const ROW_HEIGHT = 26;
const INDENT_PX = 16;

function narrationFor(event: RecursiveBacktrackerEvent, coords: (id: bigint) => { x: number; y: number } | null): string {
  const fmt = (id: bigint) => {
    const p = coords(id);
    if (!p) throw new Error(`narrationFor: node id ${id} not found in debugArena.nodes — core/web tape mismatch`);
    return p;
  };
  switch (event.kind) {
    case "VertexSelected": { const p = fmt(event.id); return m["debug.tree.vertex_selected"]({ x: p.x, y: p.y }); }
    case "CandidatesComputed": return m["debug.tree.candidates_computed"]({ count: event.ids.length });
    case "DeadEnd": return m["debug.tree.dead_end"]();
    case "CandidateChosen": { const p = fmt(event.id); return m["debug.tree.candidate_chosen"]({ x: p.x, y: p.y }); }
    case "EdgeAdded": { const f = fmt(event.from); const t = fmt(event.to); return m["debug.tree.edge_added"]({ fx: f.x, fy: f.y, tx: t.x, ty: t.y }); }
    case "VertexVisited": { const p = fmt(event.id); return m["debug.tree.vertex_visited"]({ x: p.x, y: p.y }); }
    case "VertexPopped": { const p = fmt(event.id); return m["debug.tree.vertex_popped"]({ x: p.x, y: p.y }); }
    case "VertexPushed": { const p = fmt(event.id); return m["debug.tree.vertex_pushed"]({ x: p.x, y: p.y }); }
  }
}

function rowLabel(row: TreeRow, coords: (id: bigint) => { x: number; y: number } | null): { text: string; mutating: boolean } {
  if (row.payload.kind === "scope") {
    return { text: m["debug.tree.step_scope"](), mutating: false };
  }
  const event = decodeRecursiveBacktrackerEvent(row.payload.tag, row.payload.bytes);
  return { text: narrationFor(event, coords), mutating: isMutatingRbEvent(event) };
}

export function DebugEventTree() {
  const debugArena = useMazeStore((s) => s.debugArena);
  const debugStep = useMazeStore((s) => s.debugStep);
  const setDebugStep = useMazeStore((s) => s.setDebugStep);

  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  const tape = debugArena?.tape ?? null;
  const stepIndex = useMemo(() => (tape ? buildStepIndex(tape) : null), [tape]);
  const coordIndex = useMemo(() => (debugArena ? buildNodeCoordIndex(debugArena.nodes) : null), [debugArena]);
  const coords = useMemo(() => (coordIndex ? (id: bigint) => coordIndex.get(id) : () => null), [coordIndex]);

  const { rows, rowIndexByNodeIndex } = useMemo(() => {
    if (!tape) return { rows: [] as TreeRow[], rowIndexByNodeIndex: new Map<number, number>() };
    const rows = flattenVisibleRows(tape, expanded);
    const rowIndexByNodeIndex = new Map(rows.map((r, i) => [r.nodeIndex, i]));
    return { rows, rowIndexByNodeIndex };
  }, [tape, expanded]);

  const highlightedNodeIndex = useMemo(() => {
    if (!tape || !stepIndex) return null;
    return resolveHighlightTarget(tape, stepIndex, debugStep, rowIndexByNodeIndex);
  }, [tape, stepIndex, debugStep, rowIndexByNodeIndex]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
  });

  useLayoutEffect(() => {
    if (highlightedNodeIndex === null) return;
    const rowIdx = rowIndexByNodeIndex.get(highlightedNodeIndex);
    if (rowIdx === undefined) return;
    virtualizer.scrollToIndex(rowIdx, { align: "auto" });
  }, [highlightedNodeIndex, rowIndexByNodeIndex, virtualizer]);

  if (!tape || !stepIndex) return null;

  function toggleExpanded(nodeIndex: number, e: React.MouseEvent) {
    e.stopPropagation();
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(nodeIndex)) next.delete(nodeIndex);
      else next.add(nodeIndex);
      return next;
    });
  }

  function handleRowClick(row: TreeRow) {
    setDebugStep(stepForNode(stepIndex!, row.nodeIndex));
  }

  return (
    <div ref={scrollRef} style={styles.scroll}>
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          const { text, mutating } = rowLabel(row, coords);
          const highlighted = row.nodeIndex === highlightedNodeIndex;
          const isExpanded = expanded.has(row.nodeIndex);
          return (
            <div
              key={row.nodeIndex}
              className="hoverable"
              style={{
                ...styles.row,
                transform: `translateY(${virtualRow.start}px)`,
                paddingLeft: 8 + row.depth * INDENT_PX,
                background: highlighted ? ui.bg.panelAlt : undefined,
              }}
              onClick={() => handleRowClick(row)}
            >
              {row.hasChildren ? (
                <span style={styles.disclosure} onClick={(e) => toggleExpanded(row.nodeIndex, e)}>
                  {isExpanded ? <ChevronDown size={14} color={ui.text.tertiary} /> : <ChevronRight size={14} color={ui.text.tertiary} />}
                </span>
              ) : (
                <span style={styles.disclosurePlaceholder} />
              )}
              <span style={row.payload.kind === "scope" ? styles.scopeText : mutating ? styles.mutatingText : styles.traceText}>
                {text}
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
    height: ROW_HEIGHT,
    display: "flex",
    alignItems: "center",
    gap: 4,
    cursor: "default",
    paddingRight: 8,
  },
  disclosure: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 14,
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
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  mutatingText: {
    ...typography.body,
    color: ui.text.primary,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  traceText: {
    ...muted(typography.body),
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
};
