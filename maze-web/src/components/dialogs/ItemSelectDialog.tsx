import React from "react";
import { Modal } from "../Modal";
import { WarningIcon } from "../WarningIcon";
import { ui, dialogSpacing, typography } from "../../styles/theme";

interface Item {
  id: string;
  label: string;
  disabled?: boolean;
  /** Shows a warning icon after the label (e.g. an experimental strategy). */
  warning?: boolean;
}

interface Props {
  title: string;
  items: Item[];
  selectedId: string;
  onSelectId: (id: string) => void;
  rightPanel: React.ReactNode;
  footer: React.ReactNode;
  onClose: () => void;
}

export function ItemSelectDialog({ title, items, selectedId, onSelectId, rightPanel, footer, onClose }: Props) {
  const body = (
    <div style={styles.content}>
      <div style={styles.leftCol}>
        {items.map((item) => (
          <button
            key={item.id}
            style={{
              ...styles.item,
              ...(item.id === selectedId ? styles.itemSelected : {}),
              ...(item.disabled ? styles.itemDisabled : {}),
            }}
            disabled={item.disabled}
            onClick={() => onSelectId(item.id)}
          >
            <span style={styles.itemLabel}>{item.label}</span>
            {item.warning && <WarningIcon />}
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
