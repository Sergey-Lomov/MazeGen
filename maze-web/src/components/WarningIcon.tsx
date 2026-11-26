import React from "react";
import { AlertTriangle } from "lucide-react";
import * as m from "~/paraglide/messages";
import { notificationPalette, type NotificationSeverity } from "./EmbeddedNotification";
import { Tooltip } from "./Tooltip";

interface Props {
  /** Tooltip text — defaults to the experimental-strategy warning, the overwhelming majority of
   * this icon's uses (strategy select dialogs' item list, the rule card's strategy panel). */
  title?: React.ReactNode;
  /** The problems the icon reports, one message each. Replaces `title`: a single problem is shown as
   * plain text, several as a "Warnings" heading above a bulleted list. */
  messages?: string[];
  /** "critical" (red, same palette as `IssuesBlock`'s critical issues) for a condition that
   * guarantees a hard failure, "warning" (yellow, default) for anything softer. See
   * `WarningBubble`'s matching prop. */
  severity?: NotificationSeverity;
}

/** Inline ⚠ badge. */
export function WarningIcon({ title, messages, severity = "warning" }: Props) {
  return (
    <Tooltip content={messages ? <MessagesTooltip messages={messages} /> : title ?? m["strategy.experimental_warning"]()}>
      <span style={{ ...styles.icon, color: notificationPalette(severity).text }}><AlertTriangle size={16} /></span>
    </Tooltip>
  );
}

function MessagesTooltip({ messages }: { messages: string[] }) {
  if (messages.length === 1) return <>{messages[0]}</>;
  return (
    <div>
      <div>{m["common.warnings_title"]()}</div>
      <ul style={styles.list}>
        {messages.map((message, i) => <li key={i}>{message}</li>)}
      </ul>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  list: { margin: 0, paddingLeft: 16, listStyleType: "disc" },
  icon: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 16,
    height: 16,
    flexShrink: 0,
    lineHeight: 0,
  },
};
