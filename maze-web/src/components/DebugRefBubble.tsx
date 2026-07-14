import { ui, typography, radius } from "../styles/theme";
import { useMazeStore } from "../store/mazeStore";
import type { HoveredDebugRef } from "../store/storeTypes";
import type React from "react";

/** Inline interactive reference bubble inside the debug event tree narration (GitHub issue
 *  #130) — hover highlights the referenced node/edge on the maze canvas via
 *  `DebugRefHighlightOverlay` (owned by `GenerationRenderer`). Unlike `IssueBubble`, this is
 *  hover-only: no click/modal, so `onClick` isn't wired at all — only `stopPropagation` matters,
 *  to keep a click on the bubble from bubbling up into the row's own `onClick`
 *  (toggleExpanded/step-jump — see `DebugEventTree.tsx`). */
export function DebugRefBubble({ target, label }: { target: HoveredDebugRef; label: string }) {
  const setHoveredDebugRef = useMazeStore((s) => s.setHoveredDebugRef);

  return (
    <span
      style={styles.bubble}
      onMouseEnter={() => setHoveredDebugRef(target)}
      onMouseLeave={() => setHoveredDebugRef(null)}
      onClick={(e) => e.stopPropagation()}
    >
      {label}
    </span>
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
    padding: "0 4px",
    background: ui.debug.refHighlight.bg,
    borderColor: ui.debug.refHighlight.text,
    color: ui.debug.refHighlight.text,
    cursor: "default",
    whiteSpace: "nowrap",
  },
};
