import { useState } from "react";
import type React from "react";
import { useMazeStore } from "../../store/mazeStore";
import { Modal } from "../Modal";
import { embeddedNotificationStyle, notificationPalette } from "../EmbeddedNotification";
import { resolveExportWarningMessage, resolveExportWarningDescription } from "./exportWarningsI18n";
import type { ExportWarning } from "../../pixi/selectors/exportWarnings";
import { spacing, typography, muted } from "../../styles/theme";

/** One export-warning list entry (GitHub issue #298 follow-up) — same bubble look/interaction as
 *  `IssuesBlock`'s `IssueBubble` (Analytics feature's QC issue list): an info icon opens a modal
 *  with the warning's full description, hovering highlights the warning's flagged node(s)/edges on
 *  the canvas via `hoveredExportWarningKey` (`VectorByWallsRenderer`'s own highlight overlay). Kept
 *  as its own component (not folded into `IssueBubble`) since `ExportWarning` is a distinct type
 *  from `IssueDto` — see `exportWarnings.ts`'s doc comment on why these are a separate concern from
 *  QC issues. */
export function ExportWarningBubble({ warning }: { warning: ExportWarning }) {
  const [open, setOpen] = useState(false);
  const setHoveredExportWarningKey = useMazeStore((s) => s.setHoveredExportWarningKey);
  const message = resolveExportWarningMessage(warning.id);
  const description = resolveExportWarningDescription(warning.id);
  const palette = notificationPalette("warning");

  return (
    <>
      <div
        className="hoverable-tint"
        style={{
          ...styles.bubble,
          background: palette.bg,
          borderColor: palette.text,
        }}
        onClick={() => setOpen(true)}
        onMouseEnter={() => setHoveredExportWarningKey(warning.key)}
        onMouseLeave={() => setHoveredExportWarningKey(null)}
      >
        <span style={{ ...styles.label, color: palette.text }}>{message}</span>
        <span style={{ ...styles.infoIcon, color: palette.text }}>ℹ</span>
      </div>
      {open && (
        <Modal title={message} onClose={() => setOpen(false)}>
          <p style={styles.description}>{description}</p>
        </Modal>
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bubble: {
    ...embeddedNotificationStyle,
    display: "flex",
    alignItems: "center",
    gap: spacing.itemGap,
    cursor: "default",
  },
  label: { flex: 1, ...typography.body, lineHeight: 1.4 },
  infoIcon: { ...typography.icon, flexShrink: 0, lineHeight: 1 },
  description: {
    margin: 0,
    ...muted(typography.body),
    lineHeight: 1.5,
  },
};
