import type React from "react";
import type { PostEditEntityBubble } from "../../pixi/postEditCommandLabels";
import { useMazeStore } from "../../store/mazeStore";
import { muted, radius, spacing, typography, ui } from "../../styles/theme";
import { Tooltip } from "../Tooltip";
import * as m from "~/paraglide/messages";

/** One row of hoverable/clickable entity bubbles (monospace `Lf x:y` chips) with an optional text
 *  arrow between exactly two of them — the shared presentation of the post-edit "Changes" panel
 *  rows and the Teleports section's group list. Interaction is entirely caller-owned: this only
 *  wires each bubble's own mouse events to the given handlers. A bubble gets a pointer cursor when
 *  it has a point `highlight`. */
export function EntityBubbleRow({ bubbles, arrow, onBubbleEnter, onBubbleLeave, onBubbleClick, onArrowEnter, onArrowLeave }: {
  bubbles: PostEditEntityBubble[];
  /** Glyph drawn between `bubbles[0]` and `bubbles[1]`; omitted draws no arrow. */
  arrow?: "->" | "<-" | "<->";
  onBubbleEnter: (bubble: PostEditEntityBubble, index: number) => void;
  onBubbleLeave?: (bubble: PostEditEntityBubble, index: number) => void;
  onBubbleClick: (bubble: PostEditEntityBubble, index: number) => void;
  /** Optional hover handlers for the arrow glyph itself. */
  onArrowEnter?: () => void;
  onArrowLeave?: () => void;
}) {
  const floors = useMazeStore((s) => s.floors);
  const activeFloorId = useMazeStore((s) => s.activeFloorId);
  const activeFloorIndex = floors.findIndex((floor) => floor.id === activeFloorId);
  return (
    <div style={arrow ? styles.bubblesTight : styles.bubbles}>
      {bubbles.map((bubble, j) => {
        const targetFloor = bubble.highlight?.kind === "point" ? bubble.highlight.level ?? 0 : undefined;
        const canNavigate = targetFloor !== undefined && floors.length > 1 && targetFloor !== activeFloorIndex;
        return (
          <span key={j} style={{ display: "inline-flex", alignItems: "center", gap: 0 }}>
            {j > 0 && arrow && <span style={styles.arrowZone} onMouseEnter={onArrowEnter} onMouseLeave={onArrowLeave}>{arrow}</span>}
            <Tooltip content={canNavigate ? m["common.go_to_floor"]() : undefined}><span
              style={canNavigate ? { ...styles.bubble, cursor: "pointer" } : styles.bubble}
              onMouseEnter={bubble.highlight ? () => onBubbleEnter(bubble, j) : undefined}
              onMouseLeave={onBubbleLeave ? () => onBubbleLeave(bubble, j) : undefined}
              onClick={() => onBubbleClick(bubble, j)}
            >
              {bubble.text}
            </span></Tooltip>
          </span>
        );
      })}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bubbles: {
    display: "flex",
    flexWrap: "wrap",
    gap: spacing.itemGap / 2,
  },
  // With an arrow, spacing lives in the arrow's own padding so the hover zones of bubble and arrow touch.
  bubblesTight: { display: "flex", flexWrap: "wrap", gap: 0 },
  arrowZone: { ...muted(typography.caption), padding: `0 ${spacing.itemGap}px`, alignSelf: "stretch", display: "inline-flex", alignItems: "center" },
  bubble: {
    ...typography.caption,
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
    whiteSpace: "nowrap",
  },
  arrow: muted(typography.caption),
};
