import React from "react";
import { typography } from "../styles/theme";
import * as m from "~/paraglide/messages";
import { notificationPalette, type NotificationSeverity } from "./EmbeddedNotification";

interface Props {
  /** Tooltip text — defaults to the experimental-strategy warning, the overwhelming majority of
   * this icon's uses (strategy select dialogs' item list, the rule card's strategy panel). */
  title?: string;
  /** "critical" (red, same palette as `IssuesBlock`'s critical issues) for a condition that
   * guarantees a hard failure, "warning" (yellow, default) for anything softer. See
   * `WarningBubble`'s matching prop. */
  severity?: NotificationSeverity;
}

/** Inline ⚠ badge. */
export function WarningIcon({ title, severity = "warning" }: Props) {
  return (
    <span
      style={{ ...styles.icon, color: notificationPalette(severity).text }}
      title={title ?? m["strategy.experimental_warning"]()}
    >⚠</span>
  );
}

const styles: Record<string, React.CSSProperties> = {
  icon: {
    ...typography.icon,
    flexShrink: 0,
    lineHeight: 1,
  },
};
