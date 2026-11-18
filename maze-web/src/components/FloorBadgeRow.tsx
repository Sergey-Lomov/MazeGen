import type React from "react";
import { spacing } from "../styles/theme";
import { navigateToFloor } from "../pixi/renderers/floorNavigation";
import { useMazeStore } from "../store/mazeStore";
import { Bubble } from "./Bubble";

/** Row of solid `L{n}` click-to-navigate badges naming which floor(s) something spans — shared by
 *  every "which floor is this on" caller (`IssuesBlock`'s issue bubbles, the debug event tree's own
 *  issue bubbles (`DebugRefBubble`, GitHub issue #467), Preset Connections' orphan split warning,
 *  export warnings' `elevator_badges_overlap`/`elevator_badges_too_many`, the zones list) instead of
 *  each rolling its own copy of the same button row. Each badge is a standard `Bubble` (GitHub issue
 *  #1042), so it looks like every other bubble of the project. Hidden on a single-floor maze/project,
 *  same as every cross-floor indicator in the app — nothing to badge when there's only one floor.
 *  Without `bg` and `text` the badges are the standard blue info bubbles. `levels` is the caller's own already-deduplicated, ascending-sorted list of floor *indices*
 *  (`NodeDto.level ?? 0` convention) — this component does no resolution of its own, since each
 *  caller's source data (node ids, orphan points, `crossFloorTargets`) differs. `className` lets a
 *  caller counter a parent's own hover filter (see `IssuesBlock`'s `hoverable-tint-counter` use). */
export function FloorBadgeRow({ levels, bg, text, className }: { levels: number[]; bg?: string; text?: string; className?: string }) {
  const floors = useMazeStore((s) => s.floors);
  if (floors.length <= 1 || levels.length === 0) return null;
  return (
    <div className={className} style={styles.row}>
      {levels.map((level) => {
        const exists = !!floors[level];
        const go = (e: React.SyntheticEvent) => {
          // Badges typically live inside a clickable bubble (opens a description modal) —
          // stopPropagation keeps a badge click purely a floor switch, not also an open-modal click.
          e.stopPropagation();
          navigateToFloor(level);
        };
        return (
          <Bubble
            key={level}
            colors={bg !== undefined && text !== undefined ? { bg, text } : undefined}
            interactive={exists}
            role="button"
            aria-disabled={!exists}
            tabIndex={exists ? 0 : -1}
            onClick={exists ? go : undefined}
            onKeyDown={exists ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(e); } } : undefined}
          >
            {`L${level + 1}`}
          </Bubble>
        );
      })}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: "flex",
    flexWrap: "wrap",
    gap: spacing.itemGap,
    flexShrink: 0,
  },
};
