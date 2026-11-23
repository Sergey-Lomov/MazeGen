import * as m from "~/paraglide/messages";
import { embeddedNotificationStyle, notificationPalette, type NotificationSeverity } from "./EmbeddedNotification";
import type React from "react";
import { typography } from "../styles/theme";

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
  /** Hover handlers — used by callers that highlight something on the canvas while this bubble is
   * hovered (e.g. Preset Connections' isolated-nodes/orphan-split-node warnings). */
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  /** Extra content below `message`, laid out in the same flex column as `IssuesBlock`'s own
   * bubble — used for a floor-badge row (GitHub issue #420's "which floor(s) is this on"
   * follow-up for Preset Connections' orphan-split warning, mirroring Analytics' issue bubbles). */
  children?: React.ReactNode;
  /** Makes the whole bubble clickable and marks it with an info glyph in the severity colour, like the analytics issue bubbles. */
  onInfo?: () => void;
}

/** Warning/error bubble shown under a strategy's description — also the shared style for any
 * other inline info/warning/critical notice (GitHub issue #340's "match IssuesBlock" follow-up),
 * so every such notice across the app looks consistent instead of each feature rolling its own. */
export function WarningBubble({ message, severity = "warning", onMouseEnter, onMouseLeave, children, onInfo }: Props) {
  const palette = notificationPalette(severity);
  return (
    <div
      className={onInfo ? "hoverable-tint" : undefined}
      style={{
        ...embeddedNotificationStyle,
        background: palette.bg, color: palette.text, borderColor: palette.text,
        ...(children ? { display: "flex", flexDirection: "column", gap: 4 } : {}),
      }}
      onClick={onInfo}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {onInfo ? (
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ flex: 1 }}>{message ?? m["strategy.experimental_warning"]()}</span>
          <span style={{ ...typography.icon, flexShrink: 0, lineHeight: 1, color: palette.text }} aria-hidden="true">ℹ</span>
        </div>
      ) : (message ?? m["strategy.experimental_warning"]())}
      {children}
    </div>
  );
}
