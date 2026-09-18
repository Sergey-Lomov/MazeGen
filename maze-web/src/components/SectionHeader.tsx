import React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ui, spacing, typography } from "../styles/theme";
import { sharedStyles } from "../styles/shared";

/** Collapsible section header — chevron + label, click-to-toggle. Shared by every feature with
 *  collapsible settings sections (Analytics, image-export render mode settings panels) so the
 *  expand/collapse row reads identically everywhere. */
export function SectionHeader({ label, expanded, onToggle }: { label: React.ReactNode; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="hoverable" style={styles.sectionHeaderRow} onClick={onToggle}>
      {expanded ? <ChevronDown size={14} color={ui.text.tertiary} /> : <ChevronRight size={14} color={ui.text.tertiary} />}
      <div style={sharedStyles.sectionHeader}>{label}</div>
    </div>
  );
}

export function SubsectionHeader({ label, expanded, disabled, onToggle }: {
  label: string;
  expanded: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={disabled ? undefined : "hoverable"}
      style={{ ...styles.subsectionHeaderRow, ...(disabled ? styles.disabled : {}) }}
      onClick={disabled ? undefined : onToggle}
      aria-disabled={disabled || undefined}
    >
      {expanded ? <ChevronDown size={12} color={disabled ? ui.text.disabled : ui.text.tertiary} /> : <ChevronRight size={12} color={disabled ? ui.text.disabled : ui.text.tertiary} />}
      <div style={disabled ? { ...styles.subsectionHeader, color: ui.text.disabled } : styles.subsectionHeader}>{label}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  sectionHeaderRow: {
    display: "flex", alignItems: "center", gap: spacing.itemGap, cursor: "default", borderRadius: 3,
    padding: `${spacing.itemGap}px 0`, margin: `-${spacing.itemGap}px 0`,
  },
  subsectionHeaderRow: { display: "flex", alignItems: "center", gap: spacing.itemGap, cursor: "default", borderRadius: 3 },
  subsectionHeader: { ...typography.body },
  disabled: { cursor: "default" },
};
