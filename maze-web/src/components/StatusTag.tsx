import React from "react";
import { X } from "lucide-react";
import { ui, typography, radius, inset, muted } from "../styles/theme";

// "Selected item" tag — a label with an optional clear affordance (icon or text button).
// Shared by PostEditFeature/PresetConnectionsFeature: start/finish/teleport/locked-nodes status.
export function StatusTag({ children, onClear, clearLabel }: {
  children: React.ReactNode;
  onClear?: () => void;
  clearLabel?: string;
}) {
  return (
    <div style={styles.bubble}>
      <span>{children}</span>
      {onClear && (
        <button
          className="hoverable"
          style={clearLabel ? styles.clearText : styles.clearIcon}
          onClick={onClear}
        >
          {clearLabel ?? <X size={16} />}
        </button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bubble: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    ...typography.caption,
    background: ui.bg.input,
    borderRadius: radius.md,
    padding: "6px 8px",
  },
  clearIcon: {
    ...muted(typography.icon),
    background: "none",
    border: "none",
    cursor: "default",
    padding: `0 ${inset.iconButtonInset}px`,
    lineHeight: 1,
    display: "flex",
  },
  clearText: {
    ...muted(typography.icon),
    background: "none",
    border: "none",
    cursor: "default",
    padding: `0 0 0 ${inset.iconButtonInset * 2}px`,
    lineHeight: 1,
    display: "flex",
  },
};
