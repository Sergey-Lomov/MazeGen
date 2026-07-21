import { useState } from "react";
import { ui, typography, radius, muted, spacing } from "../styles/theme";
import { useMazeStore } from "../store/mazeStore";
import { Modal } from "./Modal";
import * as m from "~/paraglide/messages";
import type { HoveredDebugRef } from "../store/storeTypes";
import type React from "react";

/** Inline interactive reference bubble inside the debug event tree narration (GitHub issue
 *  #130) — hover highlights the referenced node/edge/cycle/region on the maze canvas via
 *  `DebugRefHighlightOverlay` (owned by `GenerationRenderer`), independently of whether the
 *  Analytics panel is open (unlike Analytics' own `IssueBubble`/`hoveredIssueLoopEdges`, which
 *  only render while `analyticsOpen`). Every target kind except `issue` (GitHub issue #171) stays
 *  hover-only — no click/modal — so `onClick` only ever calls `stopPropagation`, to keep a click
 *  on the bubble from bubbling up into the row's own `onClick` (toggleExpanded/step-jump — see
 *  `DebugEventTree.tsx`). An `issue` target additionally opens a modal listing `reasons` — one
 *  already-resolved display string per contributing check (`algorithmRegistry.ts`'s
 *  `issueReasons`, built from `resolveIssueSourceLabel` — the same per-check detail formatter
 *  Analytics' `IssueBubble` uses), rendered as a single line when there's exactly one, or a
 *  "Possible reasons:" list when a merged issue carries more than one. */
export function DebugRefBubble({ target, label }: { target: HoveredDebugRef; label: string }) {
  const [open, setOpen] = useState(false);
  const setHoveredDebugRef = useMazeStore((s) => s.setHoveredDebugRef);

  const reasons = target.kind === "issue" ? target.reasons : [];
  const clickable = reasons.length > 0;
  // `target.target` (an `issue` token's structural highlight data) can be `null` — most issue
  // kinds carry no cycle/region payload (`IssuePayload::None`). Hovering then has nothing to
  // highlight, so it's skipped entirely rather than clearing-and-resetting a highlight that was
  // never set.
  const hoverable = target.kind !== "issue" || target.target !== null;

  return (
    <>
      <span
        style={target.kind === "issue" ? styles.bubbleWrap : styles.bubble}
        onMouseEnter={hoverable ? () => setHoveredDebugRef(target) : undefined}
        onMouseLeave={hoverable ? () => setHoveredDebugRef(null) : undefined}
        onClick={(e) => {
          e.stopPropagation();
          if (clickable) setOpen(true);
        }}
      >
        {label}
      </span>
      {clickable && open && (
        <Modal title={label} onClose={() => setOpen(false)}>
          {reasons.length === 1 ? (
            <p style={styles.description}>{reasons[0]}</p>
          ) : (
            <>
              <p style={styles.description}>{m["debug.tree.qc.issue_reasons_header"]()}</p>
              <ul style={styles.reasonsList}>
                {reasons.map((reason, i) => (
                  <li key={i} style={styles.description}>{reason}</li>
                ))}
              </ul>
            </>
          )}
        </Modal>
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // Same shape as `IssueBubble`'s bubble/label in `IssuesBlock.tsx` (Analytics' equivalent
  // reference bubble) — `typography.body`'s own `lineHeight` untouched, no `verticalAlign`
  // override. `display: inline-flex` + `alignItems: center` (instead of `IssueBubble`'s plain
  // `flex`, since this bubble sits inline inside a text line rather than as its own block row).
  bubble: {
    ...typography.body,
    // Monospace, not the app's default `system-ui` stack — coordinate labels ("(3,18)") read
    // better with fixed-width digits, and `system-ui`'s font metrics (ascent/descent) were
    // pushing the label visibly off the bubble's vertical center; this stack centers cleanly.
    fontFamily: "Consolas, Menlo, Monaco, monospace",
    display: "inline-flex",
    alignItems: "center",
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: `0 ${spacing.itemGap}px`,
    background: ui.debug.refHighlight.bg,
    borderColor: ui.debug.refHighlight.text,
    color: ui.debug.refHighlight.text,
    cursor: "default",
    whiteSpace: "nowrap",
  },
  // Issue-kind bubbles carry a resolved display name (`resolveIssue(kind).label`), not a short
  // coordinate — those can run long, so unlike the coordinate bubbles above this one wraps instead
  // of overflowing the row (GitHub issue #204). Red (`ui.debug.issueHighlight`, GitHub issue
  // #203), not `refHighlight`'s cyan, so an issue reads as visually distinct at a glance.
  bubbleWrap: {
    ...typography.body,
    fontFamily: "Consolas, Menlo, Monaco, monospace",
    display: "inline-flex",
    alignItems: "center",
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: `0 ${spacing.itemGap}px`,
    background: ui.debug.issueHighlight.bg,
    borderColor: ui.debug.issueHighlight.text,
    color: ui.debug.issueHighlight.text,
    cursor: "default",
    whiteSpace: "normal",
    wordBreak: "break-word" as const,
  },
  description: {
    margin: 0,
    ...muted(typography.body),
    lineHeight: 1.5,
  },
  reasonsList: {
    margin: `${spacing.itemGap}px 0 0`,
    paddingLeft: 20,
  },
};
