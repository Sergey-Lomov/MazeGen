import React from "react";
import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { colors, font, radius, overlay, shadow, dialogSpacing, dialogSize } from "../styles/theme";
import { sharedStyles } from "../styles/shared";

type DialogSizeKey = keyof typeof dialogSize;

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
          <button style={styles.closeBtn} onClick={onClose}><X size={16} /></button>
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
    background: colors.bgPanel,
    border: `1px solid ${colors.borderStrong}`,
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
    borderBottom: `1px solid ${colors.borderMid}`,
    flexShrink: 0,
  },
  title: {
    fontSize: font.xl,
    fontWeight: "bold" as const,
    color: colors.textPrimary,
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
