import * as m from "~/paraglide/messages";
import { embeddedNotificationStyle, notificationPalette, type NotificationSeverity } from "./EmbeddedNotification";

interface Props {
  /** Bubble text — defaults to the experimental-strategy warning, the overwhelming majority of
   * this bubble's uses (strategy select dialogs, quality detail panel). */
  message?: string;
  /** "critical" (red, same palette as `IssuesBlock`'s critical issues) for a condition that
   * guarantees a hard failure (e.g. a mandatory nested strategy left unassigned — the parent
   * strategy's `apply()` will always return `Failed`), "warning" (yellow, default) for anything
   * softer, like being experimental, "info" (blue) for a purely informational notice with no
   * risk attached (e.g. a param panel being unavailable for canonical elements). */
  severity?: NotificationSeverity;
}

/** Warning/error bubble shown under a strategy's description. */
export function WarningBubble({ message, severity = "warning" }: Props) {
  const palette = notificationPalette(severity);
  return (
    <div style={{ ...embeddedNotificationStyle, background: palette.bg, color: palette.text, borderColor: palette.text }}>
      {message ?? m["strategy.experimental_warning"]()}
    </div>
  );
}
