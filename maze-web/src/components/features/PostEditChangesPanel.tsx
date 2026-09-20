import { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { SidePanel } from "../SidePanel";
import { buildNodeByIdMap, postEditCommandLabel, type PostEditEntityBubble } from "../../pixi/postEditCommandLabels";
import type { SplitLabelContext } from "../../pixi/postEditSplitLabels";
import { navigateToFloor } from "../../pixi/renderers/floorNavigation";
import { buildActiveCells } from "../../pixi/selectors/fieldSelectors";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import { typography, muted, spacing, ui, radius } from "../../styles/theme";
import * as m from "~/paraglide/messages";
import type React from "react";

/** "Changes" panel (GitHub issue #545) — lists every entry of the post-edit command log
 *  (`Specs/post-edit.md`'s "Command Log" section), one row per `PostEditCommand`, as an action plus
 *  the entity/entities it applies to, rendered as hoverable, clickable bubbles (GitHub issue #546) —
 *  same monospace-chip style `DebugRefBubble`/`SplitNodesDialogView`'s link bubbles use — same
 *  `Lf:x:y`/`x:y` coordinate text the debug event tree's own bubbles use, not a wordy entity
 *  description. Each bubble names exactly one point, highlights only that point on hover (GitHub
 *  issue #546 second follow-up — an elevator's/vertical passage's several floors are separate
 *  bubbles, joined by a plain text arrow glyph when `showArrow`, never one combined bubble), and
 *  jumps straight to that point's own floor on click (`navigateToFloor`) — no separate `FloorBadgeRow`
 *  needed, unlike the warnings' own per-row floor badges, since every bubble here already IS a
 *  specific floor's own point. Hovering the row's own action text highlights `row.rowHighlight` — the
 *  connecting line for a same-floor edge/teleport, or every point the entity actually has drawn on
 *  some floor for a vertical passage/elevator/cross-floor teleport (collapses to the active floor's
 *  own point via `buildHoveredEntityHighlight`'s `activeLevel` gate) — through `PostEditRenderer`'s
 *  `postEditHoveredEntity`. Read-only listing otherwise: reverting/selecting individual entries is
 *  out of scope for this ticket. Docks via the shared `SidePanel`, same as "Manage split nodes" — the
 *  two never show at once (`setPostEditChangesOpen`/`setPostEditFocusedPoint` close each other). */
export function PostEditChangesPanel({ onClose }: { onClose: () => void }) {
  const commands = useMazeStore((s) => s.postEditCommands);
  const nodes = useMazeStore((s) => s.nodes);
  const floors = useMazeStore((s) => s.floors);
  const setPostEditHoveredEntity = useMazeStore((s) => s.setPostEditHoveredEntity);
  const splitPoints = useMazeStore((s) => s.postEditDraftSplitPoints);
  const activeSplitNode = useMazeStore((s) => s.postEditActiveSplitNode);
  const draftEdges = useMazeStore((s) => s.postEditDraftEdges);
  const cfg = useMazeStore((s) => s.activeTessellationConfig);
  const floorFields = useMazeStore((s) => s.floorFields);
  const nodeById = useMemo(() => buildNodeByIdMap(nodes), [nodes]);
  const multiFloor = floors.length > 1;
  // One `SplitLabelContext` per render, shared by every row/bubble — resolves a split point's node
  // to its exact link-bubble label (semantic short name or `splitNodeLabelShort`), the same
  // resolution `ManageSplitNodesDialog`'s own link bubbles use (GitHub issue #546 eighth follow-up).
  const inFieldCellsByLevel = useMemo(() => {
    const cache = new Map<number, ReadonlySet<string>>();
    return (level: number | undefined) => {
      const index = level ?? 0;
      const cached = cache.get(index);
      if (cached) return cached;
      const floor = floors[index];
      const field = floor ? floorFields[floor.id] : undefined;
      const cells = field ? buildCellSet(buildActiveCells(field.fieldPoints, field.fieldEditMode, cfg)) : new Set<string>();
      cache.set(index, cells);
      return cells;
    };
  }, [floors, floorFields, cfg]);
  const splitCtx: SplitLabelContext = useMemo(
    () => ({ allNodes: nodes, splitPoints, activeSplitNode, draftEdges, cfg, inFieldCellsAt: inFieldCellsByLevel }),
    [nodes, splitPoints, activeSplitNode, draftEdges, cfg, inFieldCellsByLevel],
  );
  // Newest first — the log itself is append-only oldest-to-newest, reversed only for display.
  const rows = useMemo(
    () => commands.map((c) => postEditCommandLabel(c, nodeById, multiFloor, splitCtx)).reverse(),
    [commands, nodeById, multiFloor, splitCtx],
  );

  const hoverBubble = (bubble: PostEditEntityBubble) => {
    if (bubble.highlight) setPostEditHoveredEntity(bubble.highlight);
  };
  const clearHover = () => setPostEditHoveredEntity(null);
  const clickBubble = (bubble: PostEditEntityBubble) => {
    if (bubble.highlight?.kind === "point") navigateToFloor(bubble.highlight.level ?? 0);
  };

  return (
    <SidePanel title={m["post_edit.changes_title"]()} onClose={onClose}>
      {rows.length === 0 ? (
        <div style={styles.empty}>{m["post_edit.changes_empty"]()}</div>
      ) : (
        <div style={styles.list}>
          {rows.map((row, i) => (
            <div
              key={i}
              style={styles.row}
              onMouseEnter={row.rowHighlight ? () => setPostEditHoveredEntity(row.rowHighlight!) : undefined}
              onMouseLeave={clearHover}
            >
              <span style={styles.action}>{row.action}</span>
              <div style={styles.bubbles}>
                {row.bubbles.map((bubble, j) => (
                  <span key={j} style={{ display: "inline-flex", alignItems: "center", gap: spacing.itemGap }}>
                    {j > 0 && row.showArrow && <span style={styles.arrow}>{row.arrow}</span>}
                    <span
                      style={bubble.highlight?.kind === "point" ? { ...styles.bubble, cursor: "pointer" } : styles.bubble}
                      onMouseEnter={bubble.highlight ? () => hoverBubble(bubble) : undefined}
                      onMouseLeave={row.rowHighlight ? () => setPostEditHoveredEntity(row.rowHighlight!) : clearHover}
                      onClick={() => clickBubble(bubble)}
                    >
                      {bubble.text}
                    </span>
                  </span>
                ))}
              </div>
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
  arrow: muted(typography.caption),
  empty: {
    ...muted(typography.body),
    padding: spacing.groupGap,
  },
};
