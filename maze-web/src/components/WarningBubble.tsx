import * as m from "~/paraglide/messages";
import { embeddedNotificationStyle, notificationPalette, type NotificationSeverity } from "./EmbeddedNotification";
import type React from "react";
import { typography } from "../styles/theme";
import { IconActionButton } from "./IconActionButton";

interface BaseProps {
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
   * hovered (e.g. Preset Connections' isolated-nodes/unreachable-split-node warnings). */
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  /** Extra content below `message`, laid out in the same flex column as `IssuesBlock`'s own
   * bubble — used for a floor-badge row (GitHub issue #420's "which floor(s) is this on"
   * follow-up for Preset Connections' unreachable-split warning, mirroring Analytics' issue bubbles). */
  children?: React.ReactNode;
  /** Makes the whole bubble clickable and marks it with an info glyph in the severity colour, like the analytics issue bubbles. */
  onInfo?: () => void;
}

/** A close button needs its accessible name, so `onDismiss` and `dismissTitle` come together. */
type DismissProps =
  | { onDismiss?: undefined; dismissTitle?: undefined }
  /** Adds a close button that dismisses the notice (e.g. a rule problem the user accepts as is). */
  | { onDismiss: () => void; dismissTitle: string };

type Props = BaseProps & DismissProps;

/** Warning/error bubble shown under a strategy's description — also the shared style for any
 * other inline info/warning/critical notice (GitHub issue #340's "match IssuesBlock" follow-up),
 * so every such notice across the app looks consistent instead of each feature rolling its own. */
export function WarningBubble({ message, severity = "warning", onMouseEnter, onMouseLeave, children, onInfo, onDismiss, dismissTitle }: Props) {
  const palette = notificationPalette(severity);
  return (
    <div
      className={onInfo ? "hoverable-tint" : undefined}
      style={{
        ...embeddedNotificationStyle,
        background: palette.bg, color: palette.text, borderColor: palette.text,
        // The close button's hover square sits 4 px from the top, bottom and right edge alike.
        ...(onDismiss ? { padding: "4px 4px 4px 8px" } : {}),
        ...(children ? { display: "flex", flexDirection: "column", gap: 4 } : {}),
      }}
      onClick={onInfo}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {onInfo || onDismiss ? (
        <div style={{ display: "flex", alignItems: onDismiss ? "flex-start" : "center", gap: 4 }}>
          {/* 18 px lines match the 18 px close button, so a one-line notice is exactly as tall as the button
              and the gaps above, below and right of it are equal. */}
          <span style={{ flex: 1, ...(onDismiss ? { lineHeight: "18px" } : {}) }}>{message ?? m["strategy.experimental_warning"]()}</span>
          {onInfo && <span style={{ ...typography.icon, flexShrink: 0, lineHeight: 1, color: palette.text }} aria-hidden="true">ℹ</span>}
          {onDismiss && (
            <span style={{ display: "flex" }} onClick={(e) => e.stopPropagation()}>
              <IconActionButton action="close" variant="contextual" size="compact" title={dismissTitle} onClick={onDismiss} />
            </span>
          )}
        </div>
      ) : (message ?? m["strategy.experimental_warning"]())}
      {children}
    </div>
  );
}
