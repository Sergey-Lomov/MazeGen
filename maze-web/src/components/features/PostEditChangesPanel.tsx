import { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { SidePanel } from "../SidePanel";
import { FloorBadgeRow } from "../FloorBadgeRow";
import { buildNodeByIdMap, buildLiveEntries, postEditCommandLabel, postEditCommandFloors, postEditRowHighlight, type PostEditEntityBubble } from "../../pixi/postEditCommandLabels";
import { typography, muted, spacing, ui, radius } from "../../styles/theme";
import { darken } from "../../styles/palette";
import * as m from "~/paraglide/messages";
import type React from "react";

/** "Changes" panel (GitHub issue #545) — lists every entry of the post-edit command log
 *  (`Specs/post-edit.md`'s "Command Log" section), one row per `PostEditCommand`, as an action plus
 *  the entity/entities it applies to, rendered as hoverable bubbles (GitHub issue #546) — same
 *  monospace-chip style `DebugRefBubble`/`SplitNodesDialogView`'s link bubbles use — same `Lf:x:y`/
 *  `x:y` coordinate text the debug event tree's own bubbles use, not a wordy entity description.
 *  Hovering a bubble (or, for a link-shaped row, the row itself, via the "->" between its two
 *  bubbles) highlights the corresponding entity on the canvas through
 *  `PostEditRenderer`'s `postEditHoveredEntity`; a `FloorBadgeRow` below a multi-floor-relevant row
 *  lets a click jump straight to the floor an entity lives on, matching the warnings' own
 *  `FloorBadgeRow` use. Read-only listing: reverting/selecting individual entries is out of scope
 *  for this ticket. Docks via the shared `SidePanel`, same as "Manage split nodes" — the two never
 *  show at once (`setPostEditChangesOpen`/`setPostEditFocusedPoint` close each other). */
export function PostEditChangesPanel({ onClose }: { onClose: () => void }) {
  const commands = useMazeStore((s) => s.postEditCommands);
  const nodes = useMazeStore((s) => s.nodes);
  const floors = useMazeStore((s) => s.floors);
  const teleports = useMazeStore((s) => s.postEditDraftTeleports);
  const verticalPassages = useMazeStore((s) => s.postEditDraftVerticalPassages);
  const elevators = useMazeStore((s) => s.postEditDraftElevators);
  const setPostEditHoveredEntity = useMazeStore((s) => s.setPostEditHoveredEntity);
  const nodeById = useMemo(() => buildNodeByIdMap(nodes), [nodes]);
  const live = useMemo(() => buildLiveEntries(teleports, verticalPassages, elevators), [teleports, verticalPassages, elevators]);
  const multiFloor = floors.length > 1;
  // Newest first — the log itself is append-only oldest-to-newest, reversed only for display.
  const rows = useMemo(
    () => commands.map((c) => postEditCommandLabel(c, nodeById, live, multiFloor)).reverse(),
    [commands, nodeById, live, multiFloor],
  );

  const hoverBubble = (bubble: PostEditEntityBubble) => {
    if (bubble.highlight) setPostEditHoveredEntity(bubble.highlight);
  };
  const clearHover = () => setPostEditHoveredEntity(null);

  return (
    <SidePanel title={m["post_edit.changes_title"]()} onClose={onClose}>
      {rows.length === 0 ? (
        <div style={styles.empty}>{m["post_edit.changes_empty"]()}</div>
      ) : (
        <div style={styles.list}>
          {rows.map((row, i) => {
            const rowHighlight = postEditRowHighlight(row);
            const floors = postEditCommandFloors(row);
            return (
              <div key={i} style={styles.row}>
                <span style={styles.action}>{row.action}</span>
                <div style={styles.bubbles}>
                  {row.isLink && row.bubbles.length === 2 ? (
                    <span
                      style={styles.bubble}
                      onMouseEnter={rowHighlight ? () => setPostEditHoveredEntity(rowHighlight) : undefined}
                      onMouseLeave={clearHover}
                    >
                      {row.bubbles[0].text} {row.arrow} {row.bubbles[1].text}
                    </span>
                  ) : (
                    row.bubbles.map((bubble, j) => (
                      <span
                        key={j}
                        style={styles.bubble}
                        onMouseEnter={bubble.highlight ? () => hoverBubble(bubble) : undefined}
                        onMouseLeave={clearHover}
                      >
                        {bubble.text}
                      </span>
                    ))
                  )}
                </div>
                <FloorBadgeRow levels={floors} bg={darken(ui.debug.refHighlight.text, 0.2)} text={ui.debug.refHighlight.bg} />
              </div>
            );
          })}
        </div>
      )}
    </SidePanel>
  );
}

const styles: Record<string, React.CSSProperties> = {
  list: {
    display: "flex",
    flexDirection: "column",
  },
  row: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.itemGap / 2,
    padding: `${spacing.itemGap}px ${spacing.groupGap}px`,
    borderBottom: `1px solid ${ui.border.default}`,
  },
  action: {
    ...typography.body,
  },
  bubbles: {
    display: "flex",
    flexWrap: "wrap",
    gap: spacing.itemGap / 2,
  },
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
  empty: {
    ...muted(typography.body),
    padding: spacing.groupGap,
  },
};
