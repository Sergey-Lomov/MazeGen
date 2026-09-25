import { useState } from "react";
import { ui, typography, radius, muted, spacing } from "../styles/theme";
import { darken } from "../styles/palette";
import { useMazeStore } from "../store/mazeStore";
import { Modal } from "./Modal";
import { FloorBadgeRow } from "./FloorBadgeRow";
import * as m from "~/paraglide/messages";
import type { HoveredDebugRef } from "../store/storeTypes";
import type React from "react";

/** Inline interactive reference bubble inside the debug event tree narration (GitHub issue
 *  #130) — hover highlights the referenced node/edge/cycle/region on the maze canvas via
 *  `DebugRefHighlightOverlay` (owned by `GenerationRenderer`), independently of whether the
 *  Analytics panel is open (unlike Analytics' own `IssueBubble`/`hoveredIssueLoopEdges`, which
 *  only render while `analyticsOpen`). Every target kind except `issue` (GitHub issue #171) stays
 *  hover-only for highlighting — no click/modal for `issue` specifically — but every kind now also
 *  switches the active floor on click (GitHub issue #350, `onClickFloor` — only passed on a
 *  multi-floor maze) before `stopPropagation()`, to keep a click on the bubble from bubbling up
 *  into the row's own `onClick` (toggleExpanded/step-jump — see `DebugEventTree.tsx`). An `issue`
 *  target additionally opens a modal listing `reasons` — one already-resolved display string per
 *  contributing check (`algorithmRegistry.ts`'s `issueReasons`, built from
 *  `resolveIssueSourceLabel` — the same per-check detail formatter Analytics' `IssueBubble` uses),
 *  rendered as a single line when there's exactly one, or a "Possible reasons:" list when a
 *  merged issue carries more than one.
 *
 *  `targetFloorIndices` (GitHub issue #467, superseding the single `L{n}` badge of GitHub issue
 *  #350) — a row of `L{n}` badges below an `issue` bubble, one per distinct floor the issue's
 *  structural payload touches, matching Analytics' `IssueBubble`/`IssueFloorBadges` presentation.
 *  Only `issue` bubbles get these — every other target kind already shows its floor via the label's
 *  own `Lf x:y` prefix. `FloorBadgeRow` itself hides on a single-floor maze and wires each badge's
 *  click-to-navigate. */
export function DebugRefBubble({
  target, label, onClickFloor, targetFloorIndices,
}: {
  target: HoveredDebugRef;
  label: string;
  /** Switches the active floor for this bubble's target — `undefined` on a single-floor maze,
   *  where there is nothing to switch to (see `DebugEventTree.tsx`'s `onBubbleClick`). */
  onClickFloor?: (target: HoveredDebugRef) => void;
  /** Distinct 0-based floor indices this bubble's issue payload touches, deduplicated and sorted
   *  ascending (`resolveIssueBubbleFloors` — see `DebugEventTree.tsx`). `undefined` on a
   *  single-floor maze; `[]` for an issue with no structural payload. Only consulted for
   *  `target.kind === "issue"` — every other target kind already shows its floor via the label's
   *  own prefix. */
  targetFloorIndices?: number[];
}) {
  const [open, setOpen] = useState(false);
  const setHoveredDebugRef = useMazeStore((s) => s.setHoveredDebugRef);

  const reasons = target.kind === "issue" ? target.reasons : [];
  const clickable = reasons.length > 0;
  // `target.target` (an `issue` token's structural highlight data) can be `null` — most issue
  // kinds carry no cycle/region payload (`IssuePayload::None`). Hovering then has nothing to
  // highlight, so it's skipped entirely rather than clearing-and-resetting a highlight that was
  // never set.
  const hoverable = target.kind !== "issue" || target.target !== null;
  const isIssue = target.kind === "issue";
  const floorLevels = isIssue ? targetFloorIndices ?? [] : [];

  return (
    <>
      <span
        style={isIssue ? styles.bubbleWrap : styles.bubble}
        onMouseEnter={hoverable ? () => setHoveredDebugRef(target) : undefined}
        onMouseLeave={hoverable ? () => setHoveredDebugRef(null) : undefined}
        onClick={(e) => {
          e.stopPropagation();
          onClickFloor?.(target);
          if (clickable) setOpen(true);
        }}
      >
        {isIssue ? <span style={styles.bubbleLabel}>{label}</span> : label}
        {/* Same `FloorBadgeRow` Analytics' `IssueBubble` uses (GitHub issue #467) — one `L{n}`
          * badge per floor the issue's payload touches, on its own row inside the bubble below the
          * label (matching Analytics' layout). Only issue bubbles carry it; `FloorBadgeRow` also
          * hides itself on a single-floor maze, so a non-multi-floor issue bubble stays a plain
          * single-line pill. */}
        {isIssue && (
          <FloorBadgeRow
            levels={floorLevels}
            bg={darken(ui.debug.issueHighlight.text, 0.2)}
            text={ui.debug.issueHighlight.bg}
          />
        )}
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
  // `inline-flex` column (GitHub issue #467) — the label on its own row, the `FloorBadgeRow` on a
  // second row inside the bubble's border below it, matching Analytics' `IssueBubble` layout. Stays
  // `inline-flex` (not block `flex`) since the bubble sits inline inside the narration text line;
  // `verticalAlign: top` keeps it from riding up on the baseline once it's taller than one line.
  bubbleWrap: {
    ...typography.body,
    fontFamily: "Consolas, Menlo, Monaco, monospace",
    display: "inline-flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: spacing.itemGap / 2,
    verticalAlign: "top",
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: `${spacing.itemGap / 2}px ${spacing.itemGap}px`,
    background: ui.debug.issueHighlight.bg,
    borderColor: ui.debug.issueHighlight.text,
    color: ui.debug.issueHighlight.text,
    cursor: "default",
    whiteSpace: "normal",
    wordBreak: "break-word" as const,
  },
  bubbleLabel: {
    lineHeight: 1.3,
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
