import React from "react";
import { ui, typography } from "../styles/theme";
import * as m from "~/paraglide/messages";

/** Inline ⚠ badge for an experimental strategy — same fixed tooltip everywhere it's used
 * (strategy select dialogs' item list, the rule card's strategy panel). */
export function WarningIcon() {
  return (
    <span style={styles.icon} title={m["strategy.experimental_warning"]()}>⚠</span>
  );
}

const styles: Record<string, React.CSSProperties> = {
  icon: {
    ...typography.icon,
    color: ui.text.warning,
    flexShrink: 0,
    lineHeight: 1,
  },
};
