import React from "react";
import { ui, radius, typography } from "../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  /** Bubble text — defaults to the experimental-strategy warning, the overwhelming majority of
   * this bubble's uses (strategy select dialogs, quality detail panel). */
  message?: string;
  /** "critical" (red, same palette as `IssuesBlock`'s critical issues) for a condition that
   * guarantees a hard failure (e.g. a mandatory nested strategy left unassigned — the parent
   * strategy's `apply()` will always return `Failed`), "warning" (yellow, default) for anything
   * softer, like being experimental. */
  severity?: "warning" | "critical";
}

/** Warning/error bubble shown under a strategy's description. */
export function WarningBubble({ message, severity = "warning" }: Props) {
  const palette = severity === "critical"
    ? { bg: ui.bg.error, text: ui.text.error }
    : { bg: ui.bg.warning, text: ui.text.warning };
  return (
    <div style={{ ...styles.bubble, background: palette.bg, color: palette.text, borderColor: palette.text }}>
      {message ?? m["strategy.experimental_warning"]()}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bubble: {
    ...typography.body,
    lineHeight: 1.4,
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: "6px 10px",
  },
};
