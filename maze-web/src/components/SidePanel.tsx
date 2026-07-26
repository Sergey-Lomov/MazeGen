import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { ui, typography, spacing, inset } from "../styles/theme";
import { sharedStyles } from "../styles/shared";
import { embeddedNotificationStyle, notificationPalette } from "./EmbeddedNotification";
import type React from "react";

const MIN_PANEL_WIDTH = 320;

/** DOM id of `App.tsx`'s slot beside the canvas column — every `SidePanel` portals here
 *  regardless of where in the component tree it's triggered from (GitHub issue #237), so it
 *  always docks next to the canvas rather than wherever its owning feature happens to live in the
 *  left features panel. */
export const SIDE_PANEL_SLOT_ID = "side-panel-slot";

interface Props {
  title: string;
  subtitle?: string;
  onClose: () => void;
  /** Diagnostic hints/warnings for the panel's current content — shown in a dismissible strip
   *  under the header, auto-reopened whenever the message set changes (GitHub issue #237). Purely
   *  informational, never blocks any action. */
  warnings?: string[];
  children: React.ReactNode;
}

/** Generic resizable side panel (GitHub issue #237) — same shape as `DebugPanel`: docked to the
 *  canvas's right edge, drag-to-resize handle on its left edge, header with title/close. Used by
 *  the split-node management panels (post-edit, preset, pattern editor) so editing a node's
 *  connections reads as directly manipulating the canvas rather than a modal dialog floating over
 *  it — every click's effect on the maze is visible immediately behind the panel. */
export function SidePanel({ title, subtitle, onClose, warnings, children }: Props) {
  const [width, setWidth] = useState(MIN_PANEL_WIDTH);
  const resizing = useRef(false);
  const [warningsDismissed, setWarningsDismissed] = useState(false);

  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      if (!resizing.current) return;
      setWidth((w) => Math.max(MIN_PANEL_WIDTH, w - e.movementX));
    }
    function handleMouseUp() {
      resizing.current = false;
    }
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  // Re-open the strip whenever the actual set of warnings changes — a dismissal only ever
  // suppresses the current list, not future diagnostics.
  useEffect(() => { setWarningsDismissed(false); }, [warnings?.join("\n")]);

  const showWarnings = !warningsDismissed && !!warnings && warnings.length > 0;

  const slot = document.getElementById(SIDE_PANEL_SLOT_ID);
  if (!slot) return null;

  return createPortal(
    <div style={{ ...styles.panel, width, minWidth: MIN_PANEL_WIDTH }}>
      <div
        style={styles.resizeHandle}
        onMouseDown={(e) => { e.preventDefault(); resizing.current = true; }}
      />
      <div style={styles.header}>
        <div style={styles.headerText}>
          <span style={typography.title}>{title}</span>
          {subtitle && <span style={styles.subtitle}>{subtitle}</span>}
        </div>
        <button className="hoverable" style={sharedStyles.closeBtn} onClick={onClose}><X size={16} /></button>
      </div>
      {showWarnings && (
        <div style={styles.warningsStrip}>
          <div style={styles.warningsList}>
            {warnings.map((w, i) => (
              <div key={i} style={styles.warningItem}>{w}</div>
            ))}
          </div>
          <button className="hoverable" style={sharedStyles.closeBtn} onClick={() => setWarningsDismissed(true)}>
            <X size={14} />
          </button>
        </div>
      )}
      <div style={styles.body}>
        {children}
      </div>
    </div>,
    slot,
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    height: "100%",
    background: ui.bg.panel,
    borderLeft: `1px solid ${ui.border.default}`,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    flexShrink: 0,
    position: "relative",
  },
  resizeHandle: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: -3,
    width: 6,
    cursor: "ew-resize",
    zIndex: 1,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.groupGap,
    padding: `${inset.panelInsetY}px ${inset.panelInsetX}px`,
    background: ui.bg.panelAlt,
    borderBottom: `1px solid ${ui.border.default}`,
    flexShrink: 0,
  },
  headerText: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 0,
  },
  subtitle: {
    ...typography.caption,
  },
  warningsStrip: {
    display: "flex",
    alignItems: "flex-start",
    gap: spacing.itemGap,
    padding: `${inset.panelInsetY}px ${inset.panelInsetX}px`,
    borderBottom: `1px solid ${ui.border.default}`,
    background: notificationPalette("warning").bg,
    flexShrink: 0,
  },
  warningsList: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: spacing.itemGap,
    minWidth: 0,
  },
  warningItem: {
    ...embeddedNotificationStyle,
    background: "transparent",
    borderWidth: 0,
    padding: 0,
    color: notificationPalette("warning").text,
  },
  body: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    overflow: "hidden",
  },
};
