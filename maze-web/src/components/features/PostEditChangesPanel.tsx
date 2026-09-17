import { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { SidePanel } from "../SidePanel";
import { buildNodeByIdMap, postEditCommandLabel } from "../../pixi/postEditCommandLabels";
import { typography, muted, spacing, ui } from "../../styles/theme";
import * as m from "~/paraglide/messages";
import type React from "react";

/** "Changes" panel (GitHub issue #545) — lists every entry of the post-edit command log
 *  (`Specs/post-edit.md`'s "Command Log" section), one row per `PostEditCommand`, as an
 *  action + the entity it applies to. Read-only listing: reverting/selecting individual entries
 *  is out of scope for this ticket. Docks via the shared `SidePanel`, same as "Manage split
 *  nodes" — the two never show at once (`setPostEditChangesOpen`/`setPostEditFocusedPoint`
 *  close each other). */
export function PostEditChangesPanel({ onClose }: { onClose: () => void }) {
  const commands = useMazeStore((s) => s.postEditCommands);
  const nodes = useMazeStore((s) => s.nodes);
  const nodeById = useMemo(() => buildNodeByIdMap(nodes), [nodes]);
  // Newest first — the log itself is append-only oldest-to-newest, reversed only for display.
  const rows = useMemo(() => commands.map((c) => postEditCommandLabel(c, nodeById)).reverse(), [commands, nodeById]);

  return (
    <SidePanel title={m["post_edit.changes_title"]()} onClose={onClose}>
      {rows.length === 0 ? (
        <div style={styles.empty}>{m["post_edit.changes_empty"]()}</div>
      ) : (
        <div style={styles.list}>
          {rows.map((row, i) => (
            <div key={i} style={styles.row}>
              <span style={styles.action}>{row.action}</span>
              <span style={styles.entity}>{row.entity}</span>
            </div>
          ))}
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
    gap: 2,
    padding: `${spacing.itemGap}px ${spacing.groupGap}px`,
    borderBottom: `1px solid ${ui.border.default}`,
  },
  action: {
    ...typography.body,
  },
  entity: {
    ...muted(typography.caption),
  },
  empty: {
    ...muted(typography.body),
    padding: spacing.groupGap,
  },
};
