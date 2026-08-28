import type React from "react";
import { spacing, typography } from "../styles/theme";
import { navigateToFloor } from "../pixi/renderers/floorNavigation";
import { useMazeStore } from "../store/mazeStore";

/** Row of solid `L{n}` click-to-navigate badges naming which floor(s) something spans — shared by
 *  every "which floor is this on" caller (`IssuesBlock`'s issue bubbles, the debug event tree's own
 *  issue bubbles (`DebugRefBubble`, GitHub issue #467), Preset Connections' orphan split warning,
 *  export warnings' `elevator_badges_overlap`/`elevator_badges_too_many`) instead of each rolling
 *  its own copy of the same button row. Hidden on a single-floor maze/project, same as
 *  every cross-floor indicator in the app — nothing to badge when there's only one floor. `levels`
 *  is the caller's own already-deduplicated, ascending-sorted list of floor *indices*
 *  (`NodeDto.level ?? 0` convention) — this component does no resolution of its own, since each
 *  caller's source data (node ids, orphan points, `crossFloorTargets`) differs. `className` lets a
 *  caller counter a parent's own hover filter (see `IssuesBlock`'s `hoverable-tint-counter` use). */
export function FloorBadgeRow({ levels, bg, text, className }: { levels: number[]; bg: string; text: string; className?: string }) {
  const floors = useMazeStore((s) => s.floors);
  if (floors.length <= 1 || levels.length === 0) return null;
  return (
    <div className={className} style={styles.row}>
      {levels.map((level) => (
        <button
          key={level}
          type="button"
          style={{ ...styles.badge, background: bg, color: text }}
          // Badges typically live inside a clickable bubble (opens a description modal) —
          // stopPropagation keeps a badge click purely a floor switch, not also an open-modal click.
          onClick={(e) => {
            e.stopPropagation();
            navigateToFloor(level);
          }}
          disabled={!floors[level]}
        >
          {`L${level + 1}`}
        </button>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: "flex",
    flexWrap: "wrap",
    gap: spacing.itemGap / 2,
    flexShrink: 0,
  },
  badge: {
    ...typography.body,
    fontSize: "0.75em",
    lineHeight: 1,
    padding: "2px 6px",
    borderRadius: 999,
    border: "none",
    cursor: "pointer",
  },
};
