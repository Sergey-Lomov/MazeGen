import React from "react";
import { ui, radius, typography } from "../styles/theme";
import * as m from "~/paraglide/messages";

/** Warning bubble shown under a strategy's description when it's experimental — same fixed
 * message everywhere it's used (strategy select dialogs, quality detail panel). */
export function WarningBubble() {
  return (
    <div style={styles.bubble}>{m["strategy.experimental_warning"]()}</div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bubble: {
    ...typography.body,
    lineHeight: 1.4,
    background: ui.bg.warning,
    color: ui.text.warning,
    border: `1px solid ${ui.text.warning}`,
    borderRadius: radius.sm,
    padding: "6px 10px",
  },
};
