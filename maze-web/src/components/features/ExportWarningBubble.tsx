import { useState } from "react";
import type React from "react";
import { useMazeStore } from "../../store/mazeStore";
import { Modal } from "../Modal";
import { embeddedNotificationStyle, notificationPalette } from "../EmbeddedNotification";
import { resolveExportWarningMessage, resolveExportWarningDescription } from "./exportWarningsI18n";
import type { ExportWarning } from "../../pixi/selectors/exportWarnings";
import { spacing, typography, muted } from "../../styles/theme";
import { darken } from "../../styles/palette";
import { FloorBadgeRow } from "../FloorBadgeRow";

/** One export-warning list entry (GitHub issue #298 follow-up) — same bubble look/interaction as
 *  `IssuesBlock`'s `IssueBubble` (Analytics feature's QC issue list): a top row of label + info icon
 *  (opens a modal with the warning's full description), a `FloorBadgeRow` below it (round-4 GitHub
 *  issue #430 follow-up — `elevator_badges_overlap`/`elevator_badges_too_many`'s own
 *  `crossFloorTargets`, same shared component `IssueBubble`/Preset Connections' orphan-split warning
 *  use, not a bespoke copy), hovering highlights the warning's flagged node(s)/edges on the canvas
 *  via `hoveredExportWarningKey` (`VectorByWallsRenderer`'s own highlight overlay). Kept as its own
 *  component (not folded into `IssueBubble`) since `ExportWarning` is a distinct type from
 *  `IssueDto` — see `exportWarnings.ts`'s doc comment on why these are a separate concern from QC
 *  issues. */
export function ExportWarningBubble({ warning, interactive = true }: { warning: ExportWarning; interactive?: boolean }) {
  const [open, setOpen] = useState(false);
  const setHoveredExportWarningKey = useMazeStore((s) => s.setHoveredExportWarningKey);
  const message = resolveExportWarningMessage(warning.id);
  const description = resolveExportWarningDescription(warning.id, warning.colorFields, warning.colorValues);
  const palette = notificationPalette("warning");
  const levels = Array.from(new Set((warning.crossFloorTargets ?? []).map((t) => t.targetFloorIndex))).sort((a, b) => a - b);

  return (
    <>
      <div
        className={`hoverable-tint${interactive ? "" : " color-warning-no-info"}`}
        style={{
          ...styles.bubble,
          background: palette.bg,
          borderColor: palette.text,
        }}
        onClick={interactive ? () => setOpen(true) : undefined}
        onMouseEnter={() => setHoveredExportWarningKey(warning.key)}
        onMouseLeave={() => setHoveredExportWarningKey(null)}
      >
        <div style={styles.topRow}>
          <span style={{ ...styles.label, color: palette.text }}>{message}</span>
          <span style={{ ...styles.infoIcon, color: palette.text }}>ℹ</span>
        </div>
        {/* `hoverable-tint`'s brightness filter on the outer bubble div would also wash out these
          * badges' own deliberately fixed bg/text contrast -- `hoverable-tint-counter` cancels it
          * back out, same convention `IssueBubble` uses for its own `IssueFloorBadges`. */}
        <FloorBadgeRow levels={levels} bg={darken(palette.text, 0.2)} text={palette.bg} className="hoverable-tint-counter" />
      </div>
      {interactive && open && (
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
    flexDirection: "column",
    gap: spacing.itemGap / 2,
    cursor: "default",
  },
  topRow: {
    display: "flex",
    alignItems: "center",
    gap: spacing.itemGap,
  },
  label: { flex: 1, ...typography.body, lineHeight: 1.4 },
  infoIcon: { ...typography.icon, flexShrink: 0, lineHeight: 1 },
  description: {
    margin: 0,
    ...muted(typography.body),
    lineHeight: 1.5,
  },
};
