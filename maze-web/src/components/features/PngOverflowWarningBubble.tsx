import { useState } from "react";
import type React from "react";
import { Modal } from "../Modal";
import { embeddedNotificationStyle, notificationPalette } from "../EmbeddedNotification";
import {
  resolvePngExportWarningMessage, resolvePngExportWarningDescription, type PngOverflowWarningId,
  resolvePngFitWarningMessage, resolvePngFitWarningDescription, type PngFitWarningId,
} from "./exportWarningsI18n";
import { spacing, typography, muted } from "../../styles/theme";

/** Shared body for both PNG canvas-fit warning bubbles — same look/interaction as
 *  `ExportWarningBubble`, but for warnings computed locally from `computeDigitalExportFit`/
 *  `computePrintExportFit`'s result rather than through `computeVectorByWallsWarnings`. No canvas
 *  hover-highlight (these aren't per-cell warnings). */
function WarningBubble({ message, description }: { message: string; description: string }) {
  const [open, setOpen] = useState(false);
  const palette = notificationPalette("warning");

  return (
    <>
      <div
        className="hoverable-tint"
        style={{ ...styles.bubble, background: palette.bg, borderColor: palette.text }}
        onClick={() => setOpen(true)}
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

/** Digital mode's canvas-overflow warning — carries a fill-percentage parameter. */
export function PngOverflowWarningBubble({ id, percent }: { id: PngOverflowWarningId; percent: number }) {
  return <WarningBubble message={resolvePngExportWarningMessage(id, percent)} description={resolvePngExportWarningDescription(id, percent)} />;
}

/** Print mode's sheet/margin-fit warnings — plain yes/no facts about the current placement, no
 *  percentage (see `PngFitWarningId`'s doc comment). */
export function PngFitWarningBubble({ id }: { id: PngFitWarningId }) {
  return <WarningBubble message={resolvePngFitWarningMessage(id)} description={resolvePngFitWarningDescription(id)} />;
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
