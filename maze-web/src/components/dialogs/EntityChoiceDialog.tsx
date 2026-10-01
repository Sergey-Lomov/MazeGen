import type React from "react";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { ui, radius, dialogSpacing, spacing, typography, inset, muted } from "../../styles/theme";
import * as m from "~/paraglide/messages";

export interface EntityChoiceRow {
  key: string;
  title: string;
  entityId?: string | number;
  bubbles: string[];
  showArrow?: boolean;
  arrow?: string;
}

interface Props {
  title: string;
  hint: string;
  rows: EntityChoiceRow[];
  deleteAllLabel: string;
  onSelect: (row: EntityChoiceRow) => void;
  onDeleteAll: () => void;
  onClose: () => void;
}

/** Shared presentation for entity-delete and post-edit command-choice dialogs. */
export function EntityChoiceDialog({ title, hint, rows, deleteAllLabel, onSelect, onDeleteAll, onClose }: Props) {
  return (
    <Modal title={title} size="approveWide" onClose={onClose}>
      <p style={styles.hint}>{hint}</p>
      <div style={styles.list}>
        {rows.map((row) => (
          <Button key={row.key} variant="secondary" layoutStyle={styles.item} onClick={() => onSelect(row)}>
            <span style={styles.action}>{row.title}</span>
            {row.entityId !== undefined && <span style={styles.idBubble}>id: {row.entityId}</span>}
            <div style={styles.bubbles}>
              {row.bubbles.map((bubble, index) => (
                <span key={`${row.key}:${index}`} style={styles.bubbleGroup}>
                  {index > 0 && row.showArrow && <span style={styles.arrow}>{row.arrow}</span>}
                  <span style={styles.bubble}>{bubble}</span>
                </span>
              ))}
            </div>
          </Button>
        ))}
      </div>
      <div style={styles.footer}>
        <Button variant="secondary" layoutStyle={styles.footerButton} onClick={onClose}>{m["common.cancel"]()}</Button>
        <Button variant="destructive" layoutStyle={styles.footerButton} onClick={onDeleteAll}>{deleteAllLabel}</Button>
      </div>
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  hint: { ...typography.control, color: ui.text.secondary, margin: 0, paddingBottom: dialogSpacing.paddingY },
  list: { display: "flex", flexDirection: "column", gap: dialogSpacing.gap },
  item: {
    ...typography.control, display: "flex", alignItems: "center", flexWrap: "wrap", gap: spacing.rowGap,
    width: "100%", justifyContent: "flex-start", padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`, borderRadius: radius.sm,
  },
  action: { ...typography.body, whiteSpace: "nowrap" },
  idBubble: {
    ...typography.caption, fontFamily: "Consolas, Menlo, Monaco, monospace", display: "inline-flex", alignItems: "center",
    borderStyle: "solid", borderWidth: 1, borderRadius: radius.lg, padding: `0 ${spacing.itemGap}px`,
    background: ui.bg.success, borderColor: ui.text.success, color: ui.text.success, whiteSpace: "nowrap",
  },
  bubbles: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: spacing.itemGap / 2 },
  bubbleGroup: { display: "inline-flex", alignItems: "center", gap: spacing.itemGap },
  arrow: { ...muted(typography.caption) },
  bubble: {
    ...typography.caption, fontFamily: "Consolas, Menlo, Monaco, monospace", display: "inline-flex", alignItems: "center",
    borderStyle: "solid", borderWidth: 1, borderRadius: radius.lg, padding: `0 ${spacing.itemGap}px`,
    background: ui.debug.refHighlight.bg, borderColor: ui.debug.refHighlight.text, color: ui.debug.refHighlight.text, whiteSpace: "nowrap",
  },
  footer: { display: "flex", justifyContent: "flex-end", gap: dialogSpacing.gap, paddingTop: dialogSpacing.paddingY, borderTop: `1px solid ${ui.border.default}` },
  footerButton: { ...typography.control, padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`, cursor: "default", borderRadius: radius.sm },
};
