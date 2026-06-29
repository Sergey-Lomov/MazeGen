import React from "react";
import { Modal } from "../Modal";
import { Switch } from "../Switch";
import { ui, dialogSpacing, typography } from "../../styles/theme";

interface Item {
  id: string;
  label: string;
  disabled?: boolean;
  /** When given (multiselect mode), renders a checkbox before the label, toggled via
   * `onToggleChecked` independent of row-click (which only changes `selectedId`/preview). */
  checked?: boolean;
}

interface Props {
  title: string;
  items: Item[];
  selectedId: string;
  onSelectId: (id: string) => void;
  /** Multiselect mode when given — shows a checkbox per item (see `Item.checked`). */
  onToggleChecked?: (id: string) => void;
  /** Selected-row highlight color — "primary" (blue, default) for dialogs that target an
   * existing rule/strategy, "neutral" (grey) for the "Add new rule" flow's own dialogs, where
   * blue would wrongly read as "already committed" before the flow finishes. */
  selectedVariant?: "primary" | "neutral";
  rightPanel: React.ReactNode;
  footer: React.ReactNode;
  onClose: () => void;
}

export function ItemSelectDialog({ title, items, selectedId, onSelectId, onToggleChecked, selectedVariant = "primary", rightPanel, footer, onClose }: Props) {
  const body = (
    <div style={styles.content}>
      <div style={styles.leftCol}>
        {items.map((item) => (
          <button
            key={item.id}
            style={{
              ...styles.item,
              ...(item.id === selectedId ? (selectedVariant === "neutral" ? styles.itemSelectedNeutral : styles.itemSelected) : {}),
              ...(item.disabled ? styles.itemDisabled : {}),
            }}
            disabled={item.disabled}
            onClick={() => onSelectId(item.id)}
          >
            <span style={styles.itemLabel}>{item.label}</span>
            {onToggleChecked && (
              <span onClick={(e) => e.stopPropagation()}>
                <Switch
                  checked={item.checked ?? false}
                  disabled={item.disabled}
                  onChange={() => onToggleChecked(item.id)}
                />
              </span>
            )}
          </button>
        ))}
      </div>
      <div style={styles.rightCol}>
        <div style={styles.rightPanel}>{rightPanel}</div>
        <div style={styles.footer}>{footer}</div>
      </div>
    </div>
  );

  return <Modal title={title} size="complex" rawBody={body} onClose={onClose} />;
}

const styles: Record<string, React.CSSProperties> = {
  content: {
    display: "flex",
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  leftCol: {
    width: 260,
    flexShrink: 0,
    borderRight: `1px solid ${ui.border.default}`,
    overflowY: "auto" as const,
    padding: "8px 0",
    display: "flex",
    flexDirection: "column",
    gap: 1,
  },
  item: {
    ...typography.control,
    background: "none",
    border: "none",
    textAlign: "left" as const,
    padding: `6px ${dialogSpacing.paddingX}px`,
    color: ui.text.secondary,
    cursor: "pointer",
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  itemSelected: {
    background: ui.accent.base,
    color: ui.text.inverse,
  },
  itemSelectedNeutral: {
    background: ui.text.disabled,
    color: ui.text.inverse,
  },
  itemDisabled: {
    opacity: 0.4,
    cursor: "default",
  },
  itemLabel: {
    flex: 1,
  },
  rightCol: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    minHeight: 0,
  },
  rightPanel: {
    flex: 1,
    overflowY: "auto" as const,
    padding: `${dialogSpacing.bodyPadding}px ${dialogSpacing.paddingX}px`,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 6,
    padding: `${dialogSpacing.paddingY}px ${dialogSpacing.paddingX}px`,
    borderTop: `1px solid ${ui.border.default}`,
    flexShrink: 0,
  },
};
