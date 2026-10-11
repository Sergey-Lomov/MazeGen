import React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ui, spacing } from "../styles/theme";
import { sharedStyles } from "../styles/shared";

// One chevron size for every nesting level — a smaller nested icon drew a thinner, dimmer line
// than its parent's (GitHub issue #734).
const CHEVRON_SIZE = 14;

/** Collapsible section header — chevron + label, click-to-toggle. Shared by every feature with
 *  collapsible settings sections (Analytics, image-export render mode settings panels) at every
 *  nesting level, so the expand/collapse row reads identically everywhere. `disabled` renders it
 *  greyed out and non-interactive (e.g. a vertical-passage sub-group with nothing to configure). */
export function SectionHeader({ label, expanded, disabled, onToggle }: {
  label: React.ReactNode;
  expanded: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const chevronColor = disabled ? ui.text.disabled : ui.text.tertiary;
  return (
    <div
      className={disabled ? undefined : "hoverable"}
      data-side-panel-clickable={disabled ? undefined : "true"}
      style={styles.sectionHeaderRow}
      onClick={disabled ? undefined : onToggle}
      aria-disabled={disabled || undefined}
    >
      {expanded ? <ChevronDown size={CHEVRON_SIZE} color={chevronColor} /> : <ChevronRight size={CHEVRON_SIZE} color={chevronColor} />}
      <div style={disabled ? { ...sharedStyles.sectionHeader, color: ui.text.disabled } : sharedStyles.sectionHeader}>{label}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  sectionHeaderRow: {
    display: "flex", alignItems: "center", gap: spacing.itemGap, cursor: "default", borderRadius: 3,
    // Keep the existing negative margin so headers retain their ordinary-section spacing. The
    // positioning is also a hit-testing workaround for Chromium-based browsers: an unpositioned
    // flex item with a negative margin can lose pointer events near the top edge of an overflow
    // scroll container (GitHub issue #679).
    position: "relative",
    padding: `${spacing.itemGap}px 0`, margin: `-${spacing.itemGap}px 0`,
  },
};
