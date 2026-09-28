import React, { useEffect, useId } from "react";
import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { ui, radius, overlay, shadow, dialogSpacing, dialogSize, typography } from "../styles/theme";
import { sharedStyles } from "../styles/shared";

type DialogSizeKey = keyof typeof dialogSize;

/** Stack of currently mounted Modal instance ids, topmost (most recently opened) last.
 *  Lets Esc close only the topmost modal when several are stacked. */
const openModalStack: string[] = [];

/** True while at least one `Modal` is currently mounted — lets other Escape-handling UI (e.g.
 *  `SidePanel`, GitHub issue #631) defer to a dialog stacked on top of it instead of also closing. */
export function hasOpenModal(): boolean {
  return openModalStack.length > 0;
}

interface Props {
  title: string;
  size?: DialogSizeKey;
  /** Replaces the padded body with a raw full-bleed container. Use when the content manages its own layout (e.g. split-pane dialogs). */
  rawBody?: React.ReactNode;
  onClose: () => void;
  children?: React.ReactNode;
}

export function Modal({ title, size = "info", rawBody, onClose, children }: Props) {
  const sizeTokens = dialogSize[size];
  const id = useId();

  useEffect(() => {
    openModalStack.push(id);
    return () => {
      const i = openModalStack.indexOf(id);
      if (i !== -1) openModalStack.splice(i, 1);
    };
  }, [id]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (openModalStack[openModalStack.length - 1] !== id) return;
      onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [id, onClose]);

  return createPortal(
    <div style={styles.overlay} onClick={onClose}>
      <div
        style={{
          ...styles.modal,
          minWidth: sizeTokens.minWidth,
          maxWidth: sizeTokens.maxWidth,
          ...("width" in sizeTokens ? { width: sizeTokens.width } : {}),
          ...("height" in sizeTokens ? { height: (sizeTokens as { height: string | number }).height } : {}),
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={styles.header}>
          <span style={styles.title}>{title}</span>
          <button className="hoverable" style={styles.closeBtn} onClick={onClose}><X size={16} /></button>
        </div>
        {rawBody !== undefined ? (
          <div style={styles.bodyRaw}>{rawBody}</div>
        ) : (
          <div style={styles.body}>{children}</div>
        )}
      </div>
    </div>,
    document.body
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: overlay.bg,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: overlay.zIndex,
  },
  modal: {
    background: ui.bg.panel,
    border: `1px solid ${ui.border.strong}`,
    borderRadius: radius.lg,
    maxHeight: dialogSpacing.maxHeight,
    display: "flex",
    flexDirection: "column",
    boxShadow: shadow.modal,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: `${dialogSpacing.paddingY}px ${dialogSpacing.paddingX}px`,
    borderBottom: `1px solid ${ui.border.default}`,
    flexShrink: 0,
  },
  title: {
    ...typography.title,
  },
  closeBtn: sharedStyles.closeBtn,
  body: {
    flex: 1,
    overflowY: "auto" as const,
    padding: `${dialogSpacing.bodyPadding}px ${dialogSpacing.paddingX}px`,
    display: "flex",
    flexDirection: "column",
    gap: dialogSpacing.gap,
    minHeight: 0,
  },
  bodyRaw: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    overflow: "hidden",
  },
};
