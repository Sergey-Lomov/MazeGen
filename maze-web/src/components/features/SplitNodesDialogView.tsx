import { useState } from "react";
import { X } from "lucide-react";
import { Modal } from "../Modal";
import { ConfirmModal } from "../ConfirmModal";
import { ui, typography, radius, spacing } from "../../styles/theme";
import { Stack } from "../Layout";
import * as m from "~/paraglide/messages";
import type React from "react";

/** One link (edge or teleport) from a node, resolved to a small display label. */
export interface LinkInfo {
  otherLabel: string;
  arrow: string;
}

export interface SplitNodesRow<E> {
  key: string;
  endpoint: E;
  title: string;
  removable: boolean;
  active: boolean;
  ownLabel: string;
  links: LinkInfo[];
}

interface Props<E> {
  title: string;
  rows: SplitNodesRow<E>[];
  onClose: () => void;
  onSetActive: (endpoint: E) => void;
  onAdd: () => void;
  onRemove: (row: SplitNodesRow<E>) => void;
}

/** Presentational core for "Manage split nodes" (GitHub issue #221/#231) — one card per node (the
 * point's original node first, never removable, then each extra slot in slotId order), a
 * "Set active" click target, a per-row Remove button behind a confirm modal, and a footer "+ Add
 * node" button. Shared by post-edit's `ManageSplitNodesDialog` (nodes resolved to real `NodeId`s)
 * and the preset stage's `PresetSplitNodesDialog` (nodes addressed by raw point+slot, no `NodeId`
 * concept yet) — both adapters compute `rows`/labels/links from their own data and pass them in,
 * this component owns only layout/styling and the remove-confirmation flow. */
export function SplitNodesDialogView<E>({ title, rows, onClose, onSetActive, onAdd, onRemove }: Props<E>) {
  const [pendingRemove, setPendingRemove] = useState<SplitNodesRow<E> | null>(null);

  return (
    <Modal title={title} onClose={onClose}>
      <Stack gap="itemGap">
        {rows.map((row) => {
          // The corner (Remove button and/or Active badge) is absolutely positioned over the
          // title row — when it has anything in it, push the links row down so its bubbles don't
          // visually collide with the corner instead of just wrapping under the title.
          const hasCorner = row.active || row.removable;
          return (
            <div
              key={row.key}
              style={{ ...styles.card, cursor: row.active ? "default" : "pointer" }}
              className={row.active ? undefined : "hoverable"}
              onClick={row.active ? undefined : () => onSetActive(row.endpoint)}
            >
              <div style={styles.cardCorner}>
                {row.removable && (
                  <button
                    className="hoverable-danger"
                    style={styles.iconBtn}
                    title={m["post_edit.split_remove"]()}
                    onClick={(e) => { e.stopPropagation(); setPendingRemove(row); }}
                  >
                    <X size={18} color={ui.text.tertiary} />
                  </button>
                )}
                {row.active && <span style={styles.activeBadge}>{m["post_edit.split_active_badge"]()}</span>}
              </div>
              <span style={styles.cardTitle}>{row.title}</span>
              <div style={{ ...styles.linksCell, marginTop: hasCorner ? 4 : 0 }}>
                {row.links.length === 0 ? (
                  <span style={typography.body}>{m["post_edit.split_no_links"]()}</span>
                ) : (
                  row.links.map((link, i) => (
                    <span key={i} style={styles.bubble}>{row.ownLabel} {link.arrow} {link.otherLabel}</span>
                  ))
                )}
              </div>
            </div>
          );
        })}
        <button
          className="hoverable-accent"
          style={styles.addBtn}
          onClick={onAdd}
        >
          {m["post_edit.split_add_node"]()}
        </button>
      </Stack>

      {pendingRemove !== null && (
        <ConfirmModal
          message={m["post_edit.confirm_remove_split_node"]()}
          onConfirm={() => { onRemove(pendingRemove); setPendingRemove(null); }}
          onCancel={() => setPendingRemove(null)}
        />
      )}
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // One bordered card per node — clearer separation than a borderless grid row, especially once
  // link bubbles wrap onto a second line. The whole card (except its corner controls) is a click
  // target that activates the node — `position: relative` anchors `cardCorner`. Deliberately no
  // `paddingRight` reservation on the card itself — an earlier version added one to keep the
  // title/corner from overlapping, but padding on a flex column narrows *every* child's content
  // box, including `linksCell`, which pushed link bubbles onto extra wrapped lines even when the
  // corner (only tall enough for its own row) had nothing above the links row to collide with.
  card: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: spacing.itemGap,
    padding: spacing.itemGap,
    border: `1px solid ${ui.border.default}`,
    borderRadius: radius.md,
  },
  // Top-right corner row — Remove button (removable cards only) to the left of the Active badge
  // (when active). Absolutely positioned (overlaps only the title row, not links below it) so it
  // doesn't consume card width the links row would otherwise wrap around.
  cardCorner: {
    position: "absolute",
    top: spacing.itemGap,
    right: spacing.itemGap,
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.itemGap,
  },
  cardTitle: {
    ...typography.body,
    color: ui.text.primary,
    textAlign: "center",
  },
  iconBtn: {
    background: "none",
    border: "none",
    cursor: "default",
    padding: 4,
    display: "flex",
    alignItems: "center",
  },
  linksCell: {
    display: "flex",
    flexWrap: "wrap",
    gap: spacing.itemGap,
  },
  // Same shape as `DebugRefBubble`'s coordinate bubble — reused for visual consistency, not its
  // hover/click behavior (this dialog's bubbles are plain, non-interactive labels).
  bubble: {
    ...typography.body,
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
  activeBadge: {
    ...typography.control,
    padding: "0 6px",
    border: `1px solid ${ui.accent.base}`,
    background: ui.accent.base,
    color: ui.text.inverse,
    borderRadius: radius.sm,
    textAlign: "center",
    whiteSpace: "nowrap",
  },
  addBtn: {
    ...typography.control,
    background: ui.accent.base,
    border: "none",
    color: ui.text.inverse,
    padding: 8,
    cursor: "default",
    borderRadius: radius.sm,
    width: "100%",
  },
};
