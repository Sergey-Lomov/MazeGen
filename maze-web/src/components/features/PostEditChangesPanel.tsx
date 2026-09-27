import { useMemo, useState } from "react";
import { X, RotateCcw, Trash2 } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import { SidePanel } from "../SidePanel";
import { ConfirmModal } from "../ConfirmModal";
import { Button } from "../Button";
import { buildNodeByIdMap, entityIdOf, postEditCommandLabel, type PostEditEntityBubble } from "../../pixi/postEditCommandLabels";
import { isCreateCommand, affectedIndicesForReset, affectedIndicesForDelete } from "../../pixi/postEditReplay";
import type { SplitLabelContext } from "../../pixi/postEditSplitLabels";
import { navigateToFloor } from "../../pixi/renderers/floorNavigation";
import { buildActiveCells } from "../../pixi/selectors/fieldSelectors";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import { sharedStyles } from "../../styles/shared";
import { typography, muted, spacing, ui, radius } from "../../styles/theme";
import * as m from "~/paraglide/messages";
import type React from "react";

/** Which row-level confirm dialog is pending (GitHub issue #547) — `commandIndex` is the log's own
 *  oldest-to-newest index (not the panel's reversed display order); `cascade` (only meaningful for
 *  `"delete"`) picks the stronger confirm wording for a create command's own lifeline cascade.
 *  `"compact"` (GitHub issue #548) has no `commandIndex` — it acts on the whole log at once. */
type PendingRowAction =
  | { kind: "reset"; commandIndex: number }
  | { kind: "delete"; commandIndex: number; cascade: boolean }
  | { kind: "compact" };

/** Which row's Reset/Delete button is currently hovered (GitHub issue #547 second follow-up) —
 *  drives the red preview highlight over every OTHER row `affectedIndicesFor{Reset,Delete}` says
 *  that action would also touch, so the user sees the blast radius before clicking. `cascade` isn't
 *  needed here (unlike `PendingRowAction`) — the preview set itself already tells the whole story. */
type HoveredRowPreview = { kind: "reset" | "delete"; commandIndex: number };

/** Size of the clear (×) button's own `X` icon, and its horizontal inset (matching
 *  `sharedStyles.closeBtn`'s own `padding: "0 2px"`) — both feed `filterInput`'s right padding so
 *  typed text can never run under the button regardless of either value changing later. */
const CLEAR_ICON_SIZE = 16;
const CLEAR_ICON_INSET = 2;

/** Size of each row's own Reset/Delete icon buttons (GitHub issue #547), inline with that row's own
 *  bubbles — same icon size as the filter's own clear button. */
const ROW_ACTION_ICON_SIZE = 16;

/** "Changes" panel (GitHub issue #545) — lists every entry of the post-edit command log
 *  (`Specs/post-edit.md`'s "Command Log" section), one row per `PostEditCommand`, as an action plus
 *  the entity/entities it applies to, rendered as hoverable, clickable bubbles (GitHub issue #546) —
 *  same monospace-chip style `DebugRefBubble`/`SplitNodesDialogView`'s link bubbles use — same
 *  `Lf x:y`/`x:y` coordinate text the debug event tree's own bubbles use, not a wordy entity
 *  description. Each bubble names exactly one point, highlights only that point on hover (GitHub
 *  issue #546 second follow-up — an elevator's/vertical passage's several floors are separate
 *  bubbles, joined by a plain text arrow glyph when `showArrow`, never one combined bubble), and
 *  jumps straight to that point's own floor on click (`navigateToFloor`) — no separate `FloorBadgeRow`
 *  needed, unlike the warnings' own per-row floor badges, since every bubble here already IS a
 *  specific floor's own point. Hovering the row's own action text highlights `row.rowHighlight` — the
 *  connecting line for a same-floor edge/teleport, or every point the entity actually has drawn on
 *  some floor for a vertical passage/elevator/cross-floor teleport (collapses to the active floor's
 *  own point via `buildHoveredEntityHighlight`'s `activeLevel` gate) — through `PostEditRenderer`'s
 *  `postEditHoveredEntity`. A row that names a stable entity (`row.entityId`, GitHub issue #574's
 *  `entityIdOf`) also gets its own id bubble pinned to the row's top-right corner (GitHub issue
 *  #573) - hovering it highlights every OTHER row sharing that id within this list
 *  (`hoveredEntityId`, local state, unrelated to the canvas highlight above); clicking it narrows
 *  the log to that entity via the same entity-id filter GitHub issue #574 already introduced
 *  (`setPostEditChangesEntityFilter`). Read-only listing otherwise: reverting/selecting individual
 *  entries is out of scope for this ticket. Docks via the shared `SidePanel`, same as "Manage split
 *  nodes" — the two never show at once (`setPostEditChangesOpen`/`setPostEditFocusedPoint` close each
 *  other). */
export function PostEditChangesPanel({ onClose }: { onClose: () => void }) {
  // Which entity id bubble is currently hovered (GitHub issue #573) — highlights every OTHER row
  // referencing the same entity id, purely within this panel's own list (never the canvas — that's
  // `postEditHoveredEntity`'s job, still driven by the row/bubble hover handlers below). Local, not
  // store state: no other component needs to know, and it must never survive a re-render for a
  // different filter/log.
  const [hoveredEntityId, setHoveredEntityId] = useState<string | null>(null);
  const [pendingRowAction, setPendingRowAction] = useState<PendingRowAction | null>(null);
  const [hoveredPreview, setHoveredPreview] = useState<HoveredRowPreview | null>(null);
  const commands = useMazeStore((s) => s.postEditCommands);
  const resetPostEditCommand = useMazeStore((s) => s.resetPostEditCommand);
  const deletePostEditCommand = useMazeStore((s) => s.deletePostEditCommand);
  const compactPostEditLog = useMazeStore((s) => s.compactPostEditLog);
  const nodes = useMazeStore((s) => s.nodes);
  const floors = useMazeStore((s) => s.floors);
  const setPostEditHoveredEntity = useMazeStore((s) => s.setPostEditHoveredEntity);
  const entityFilter = useMazeStore((s) => s.postEditChangesEntityFilter);
  const setEntityFilter = useMazeStore((s) => s.setPostEditChangesEntityFilter);
  const splitPoints = useMazeStore((s) => s.postEditDraftSplitPoints);
  const activeSplitNode = useMazeStore((s) => s.postEditActiveSplitNode);
  const draftEdges = useMazeStore((s) => s.postEditDraftEdges);
  const floorFields = useMazeStore((s) => s.floorFields);
  const nodeById = useMemo(() => buildNodeByIdMap(nodes), [nodes]);
  const multiFloor = floors.length > 1;
  // One `SplitLabelContext` per render, shared by every row/bubble — resolves a split point's node
  // to its exact link-bubble label (semantic short name or `splitNodeLabelShort`), the same
  // resolution `ManageSplitNodesDialog`'s own link bubbles use (GitHub issue #546 eighth follow-up).
  // Each floor's own `tessellationConfig` (GitHub issue #611's bug class) — a single row's bubbles
  // can span several floors (an elevator/vertical passage), each potentially needing a different
  // floor's own field shape, not one maze-wide snapshot.
  const cfgByLevel = useMemo(() => {
    return (level: number | undefined) => {
      const index = level ?? 0;
      const floor = floors[index];
      return floor ? floorFields[floor.id].tessellationConfig : floorFields[floors[0].id].tessellationConfig;
    };
  }, [floors, floorFields]);
  const inFieldCellsByLevel = useMemo(() => {
    const cache = new Map<number, ReadonlySet<string>>();
    return (level: number | undefined) => {
      const index = level ?? 0;
      const cached = cache.get(index);
      if (cached) return cached;
      const floor = floors[index];
      const field = floor ? floorFields[floor.id] : undefined;
      const cells = field ? buildCellSet(buildActiveCells(field.fieldPoints, field.fieldEditMode, field.tessellationConfig)) : new Set<string>();
      cache.set(index, cells);
      return cells;
    };
  }, [floors, floorFields]);
  const splitCtx: SplitLabelContext = useMemo(
    () => ({ allNodes: nodes, splitPoints, activeSplitNode, draftEdges, cfgAt: cfgByLevel, inFieldCellsAt: inFieldCellsByLevel }),
    [nodes, splitPoints, activeSplitNode, draftEdges, cfgByLevel, inFieldCellsByLevel],
  );
  // Newest first — the log itself is append-only oldest-to-newest, reversed only for display.
  // The entity-id filter (GitHub issue #574) matches a command's own associated id (`entityIdOf`)
  // exactly, never a text search over the row's rendered label — a command kind with no id of its
  // own (wall/basic `setEdge`/`setEdgePair`, `setMeta`, `rotateSplitPoint`) never matches and is
  // hidden whenever a filter is active.
  const rows = useMemo(
    () => commands
      .map((c, commandIndex) => ({ c, commandIndex }))
      .filter(({ c }) => entityFilter === null || entityIdOf(c) === entityFilter)
      .map(({ c, commandIndex }) => ({ ...postEditCommandLabel(c, nodeById, multiFloor, splitCtx), commandIndex, cascade: isCreateCommand(c) }))
      .reverse(),
    [commands, nodeById, multiFloor, splitCtx, entityFilter],
  );

  // Blast-radius preview (GitHub issue #547 second follow-up) — every command index the currently
  // hovered Reset/Delete button would also remove, computed through the exact same functions the
  // click itself uses (`affectedIndicesForReset`/`affectedIndicesForDelete`), so the preview can
  // never show a different set than what actually happens. `null` (not an empty set) when nothing's
  // hovered, so a hovered row with zero OTHER affected rows still renders (it stays red on its own
  // via `commandIndex === hoveredPreview.commandIndex`, handled separately below).
  const previewIndices = useMemo(() => {
    if (hoveredPreview === null) return null;
    const indices = hoveredPreview.kind === "reset"
      ? affectedIndicesForReset(commands, hoveredPreview.commandIndex)
      : affectedIndicesForDelete(commands, hoveredPreview.commandIndex);
    return indices ?? null;
  }, [commands, hoveredPreview]);

  const hoverBubble = (bubble: PostEditEntityBubble) => {
    if (bubble.highlight) setPostEditHoveredEntity(bubble.highlight);
  };
  const clearHover = () => setPostEditHoveredEntity(null);
  const clickBubble = (bubble: PostEditEntityBubble) => {
    if (bubble.highlight?.kind === "point") navigateToFloor(bubble.highlight.level ?? 0);
  };

  return (
    <SidePanel title={m["post_edit.changes_title"]()} onClose={onClose}>
      <div style={styles.filterRow}>
        <input
          type="text"
          value={entityFilter ?? ""}
          onChange={(e) => setEntityFilter(e.target.value.trim() === "" ? null : e.target.value.trim())}
          placeholder={m["post_edit.changes_filter_placeholder"]()}
          style={styles.filterInput}
        />
        {entityFilter !== null && (
          <button
            type="button"
            className="hoverable"
            onClick={() => setEntityFilter(null)}
            title={m["post_edit.changes_filter_clear"]()}
            aria-label={m["post_edit.changes_filter_clear"]()}
            style={{ ...sharedStyles.closeBtn, ...styles.filterClear }}
          >
            <X size={CLEAR_ICON_SIZE} />
          </button>
        )}
      </div>
      {entityFilter !== null && rows.length === 0 ? (
        <div style={styles.empty}>{m["post_edit.changes_filter_empty"]({ id: entityFilter })}</div>
      ) : commands.length === 0 ? (
        <div style={styles.empty}>{m["post_edit.changes_empty"]()}</div>
      ) : rows.length === 0 ? (
        <div style={styles.empty}>{m["post_edit.changes_filter_empty"]({ id: entityFilter ?? "" })}</div>
      ) : (
        <div style={styles.list}>
          {rows.map((row) => {
            const isDeletePreviewed = previewIndices !== null
              && (row.commandIndex === hoveredPreview!.commandIndex || previewIndices.has(row.commandIndex));
            const rowStyle = isDeletePreviewed
              ? { ...styles.row, ...styles.rowDeletePreview }
              : row.entityId !== undefined && row.entityId === hoveredEntityId
                ? { ...styles.row, ...styles.rowEntityHighlight }
                : styles.row;
            return (
              <div
                key={row.commandIndex}
                style={rowStyle}
                onMouseEnter={row.rowHighlight ? () => setPostEditHoveredEntity(row.rowHighlight!) : undefined}
                onMouseLeave={clearHover}
              >
                {row.entityId !== undefined && (
                  <span
                    className="hoverable"
                    style={styles.idBubble}
                    title={m["post_edit.changes_id_bubble_title"]()}
                    onMouseEnter={() => setHoveredEntityId(row.entityId!)}
                    onMouseLeave={() => setHoveredEntityId(null)}
                    onClick={() => setEntityFilter(row.entityId!)}
                  >
                    id: {row.entityId}
                  </span>
                )}
                <span style={styles.action}>{row.action}</span>
                <div style={styles.bubblesRow}>
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
                  <div style={styles.rowActions}>
                    <button
                      type="button"
                      className="hoverable"
                      onClick={() => setPendingRowAction({ kind: "reset", commandIndex: row.commandIndex })}
                      onMouseEnter={() => setHoveredPreview({ kind: "reset", commandIndex: row.commandIndex })}
                      onMouseLeave={() => setHoveredPreview(null)}
                      title={m["post_edit.changes_reset_title"]()}
                      aria-label={m["post_edit.changes_reset_title"]()}
                      style={sharedStyles.closeBtn}
                    >
                      <RotateCcw size={ROW_ACTION_ICON_SIZE} />
                    </button>
                    <button
                      type="button"
                      className="hoverable"
                      onClick={() => setPendingRowAction({ kind: "delete", commandIndex: row.commandIndex, cascade: row.cascade })}
                      onMouseEnter={() => setHoveredPreview({ kind: "delete", commandIndex: row.commandIndex })}
                      onMouseLeave={() => setHoveredPreview(null)}
                      title={m["post_edit.changes_delete_title"]()}
                      aria-label={m["post_edit.changes_delete_title"]()}
                      style={{ ...sharedStyles.closeBtn, color: ui.text.error }}
                    >
                      <Trash2 size={ROW_ACTION_ICON_SIZE} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {commands.length > 0 && (
        <div style={styles.footer}>
          <Button
            variant="secondary"
            layoutStyle={{ width: "100%" }}
            title={m["post_edit.changes_compact_title"]()}
            onClick={() => setPendingRowAction({ kind: "compact" })}
          >
            {m["post_edit.changes_compact_button"]()}
          </Button>
        </div>
      )}
      {pendingRowAction && (
        <ConfirmModal
          message={pendingRowAction.kind === "reset"
            ? m["post_edit.confirm_changes_reset"]()
            : pendingRowAction.kind === "compact"
              ? m["post_edit.confirm_changes_compact"]()
              : pendingRowAction.cascade
                ? m["post_edit.confirm_changes_delete_cascade"]()
                : m["post_edit.confirm_changes_delete"]()}
          onConfirm={() => {
            if (pendingRowAction.kind === "reset") resetPostEditCommand(pendingRowAction.commandIndex);
            else if (pendingRowAction.kind === "delete") deletePostEditCommand(pendingRowAction.commandIndex);
            else compactPostEditLog();
            setPendingRowAction(null);
          }}
          onCancel={() => setPendingRowAction(null)}
        />
      )}
    </SidePanel>
  );
}

const styles: Record<string, React.CSSProperties> = {
  filterRow: {
    position: "sticky",
    top: 0,
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    padding: `6px ${spacing.rowGap}px`,
    borderBottom: `1px solid ${ui.border.default}`,
    background: ui.bg.panel,
    flexShrink: 0,
  },
  filterInput: {
    ...typography.field,
    width: "100%",
    minWidth: 0,
    background: ui.bg.input,
    border: `1px solid ${ui.border.default}`,
    borderRadius: radius.sm,
    // Right padding reserves room for `filterClear`'s icon (`CLEAR_ICON_SIZE`) plus its own inset
    // on both sides, so typed text never runs under the button regardless of where it sits.
    padding: `2px ${spacing.rowGap + CLEAR_ICON_SIZE + 2 * CLEAR_ICON_INSET}px 2px 6px`,
  },
  filterClear: {
    position: "absolute",
    right: spacing.rowGap + 2,
  },
  list: {
    display: "flex",
    flexDirection: "column",
  },
  // Manual "Compact log" action (GitHub issue #548) — pinned below the scrollable row list, sticky
  // to the panel's own bottom edge like `filterRow` is sticky to its top, so it stays reachable
  // regardless of how long the log is.
  footer: {
    position: "sticky",
    bottom: 0,
    padding: `${spacing.itemGap}px ${spacing.rowGap}px`,
    borderTop: `1px solid ${ui.border.default}`,
    background: ui.bg.panel,
    flexShrink: 0,
  },
  row: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: spacing.itemGap / 2,
    padding: `${spacing.itemGap}px ${spacing.groupGap}px`,
    borderBottom: `1px solid ${ui.border.default}`,
  },
  // Bubbles + Reset/Delete buttons share one flex row (GitHub issue #547 follow-up: buttons moved
  // off the row's own pinned bottom-right corner into this same line) — `bubbles` wraps and grows,
  // `rowActions` stays pinned to the line's own right edge via `marginLeft: auto`.
  bubblesRow: {
    display: "flex",
    alignItems: "center",
    gap: spacing.itemGap,
  },
  // Reset ("undo everything after this point")/Delete ("remove just this change") buttons (GitHub
  // issue #547). Delete is tinted red (`ui.text.error`) since it can cascade an entire entity's
  // lifeline away; Reset keeps the neutral `closeBtn` color since it only ever affects commands
  // strictly after this row. `flexShrink: 0` keeps both icons from squeezing when `bubbles` wraps
  // to more than one line.
  rowActions: {
    display: "flex",
    gap: spacing.itemGap,
    marginLeft: "auto",
    flexShrink: 0,
  },
  // GitHub issue #573: every OTHER row sharing the currently-hovered id bubble's entity id — same
  // generic hover background other panels use (`NestedStrategyPanel`/quality canvas), not a
  // dedicated hue, since this is "related row" not a semantic (error/warning/info) state.
  rowEntityHighlight: {
    background: ui.bg.hover,
  },
  // GitHub issue #547 second follow-up: every row a hovered Reset/Delete button would remove (the
  // hovered row itself included) — same semantic-error red pairing `ui.bg.error`/`ui.text.error`
  // other panels use for a destructive-outcome preview, distinct from both `rowEntityHighlight`'s
  // neutral tint and the point bubbles' own cyan.
  rowDeletePreview: {
    background: ui.bg.error,
  },
  // Reserves room on the right so a wrapped/long action text never runs under the pinned `idBubble`.
  action: {
    ...typography.body,
    paddingRight: 56,
  },
  // The entity id bubble (GitHub issue #573) — split out of `action`'s own text (previously
  // `"Action (#id)"`) into its own hoverable/clickable chip, pinned to the row's own top-right
  // corner (`position: absolute` against `row`'s `position: relative`) rather than flowing inline
  // with the action text, so it reads as a row-level tag rather than part of the action's own
  // sentence. Green (`ui.bg.success`/`ui.text.success` — same pairing convention
  // `debug.refHighlight`/`debug.issueHighlight` use, a dedicated bg+text pair rather than a computed
  // alpha) rather than the point bubbles' cyan (`debug.refHighlight`) so it reads as a distinct kind
  // of reference at a glance. Hovering highlights every other row sharing this id (`hoveredEntityId`,
  // local panel state — never the canvas); clicking sets the entity-id filter (GitHub issue #574's
  // `setPostEditChangesEntityFilter`) to narrow the log down to just this entity.
  idBubble: {
    ...typography.caption,
    position: "absolute",
    top: spacing.itemGap,
    right: spacing.groupGap,
    fontFamily: "Consolas, Menlo, Monaco, monospace",
    display: "inline-flex",
    alignItems: "center",
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: `0 ${spacing.itemGap}px`,
    background: ui.bg.success,
    borderColor: ui.text.success,
    color: ui.text.success,
    whiteSpace: "nowrap",
    cursor: "pointer",
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
