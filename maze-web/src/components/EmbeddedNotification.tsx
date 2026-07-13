import { ui, radius, typography } from "../styles/theme";
import type React from "react";

export type NotificationSeverity = "info" | "warning" | "critical";

/** Shared bg/text colors for a given severity — same palette across `WarningBubble`,
 * `WarningIcon` and `IssuesBlock`'s `IssueBubble`. */
export function notificationPalette(severity: NotificationSeverity): { bg: string; text: string } {
  switch (severity) {
    case "critical":
      return { bg: ui.bg.error, text: ui.text.error };
    case "info":
      return { bg: ui.bg.info, text: ui.text.info };
    case "warning":
      return { bg: ui.bg.warning, text: ui.text.warning };
  }
}

/** Shared box style (border, radius, padding, typography) for inline info/warning/critical
 * bubbles. Single source of truth so all embedded notifications (strategy warnings, analytics
 * issue bubbles) look consistent — only the palette varies by severity. */
export const embeddedNotificationStyle: React.CSSProperties = {
  ...typography.body,
  lineHeight: 1.4,
  borderStyle: "solid",
  borderWidth: 1,
  borderRadius: radius.lg,
  padding: "4px 8px",
};
