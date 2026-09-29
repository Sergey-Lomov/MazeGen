import React, { useEffect, useId, useRef } from "react";
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

/** True while `target` is a field where Space must type a literal space instead of confirming —
 *  a text-entry control (`<textarea>`, or an `<input>` of a text-like type, or a contentEditable
 *  element). Excludes non-text inputs (`checkbox`, `range`, ...), which have no use for a literal
 *  space and should confirm like everything else. */
function isSpaceTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === "TEXTAREA") return true;
  if (target instanceof HTMLInputElement) {
    return !["checkbox", "radio", "range", "button", "submit", "reset", "color", "file"].includes(target.type);
  }
  return false;
}

/** True only for `<textarea>` — the one control where Enter must insert a newline instead of
 *  confirming. A single-line text `<input>` has no such use for Enter (submitting on Enter is the
 *  standard, expected behavior of a text field inside a form-like dialog). */
function isNewlineTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.tagName === "TEXTAREA";
}

interface Props {
  title: string;
  size?: DialogSizeKey;
  /** Replaces the padded body with a raw full-bleed container. Use when the content manages its own layout (e.g. split-pane dialogs). */
  rawBody?: React.ReactNode;
  onClose: () => void;
  /** Enter/Space confirmation shortcut (GitHub issue #638) — omit for dialogs with no confirmation
   *  action (informational dialogs, or ones where picking a row confirms and closes immediately). */
  onConfirm?: () => void;
  children?: React.ReactNode;
}

export function Modal({ title, size = "info", rawBody, onClose, onConfirm, children }: Props) {
  const sizeTokens = dialogSize[size];
  const id = useId();
  const modalRef = useRef<HTMLDivElement>(null);

  // Move focus into the dialog on mount (GitHub issue #638 follow-up) — otherwise the button that
  // opened it stays focused, so Space re-activates that trigger (native button behavior) instead
  // of reaching this modal's own Enter/Space confirm shortcut, and only a mouse click inside fixes
  // it. `tabIndex={-1}` on the modal box makes it focusable programmatically without joining the
  // Tab order.
  useEffect(() => {
    modalRef.current?.focus();
  }, []);

  useEffect(() => {
    openModalStack.push(id);
    return () => {
      const i = openModalStack.indexOf(id);
      if (i !== -1) openModalStack.splice(i, 1);
    };
  }, [id]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (openModalStack[openModalStack.length - 1] !== id) return;
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (!onConfirm) return;
      if (e.key === "Enter" && !isNewlineTarget(e.target)) {
        e.preventDefault();
        onConfirm();
        return;
      }
      if (e.key === " " && !isSpaceTypingTarget(e.target)) {
        e.preventDefault();
        onConfirm();
      }
    }
    // Capture phase (GitHub issue #638 follow-up): a button/item-row/slider inside the dialog can
    // hold keyboard focus (clicked earlier, or focused via Tab) — in the bubble phase its own
    // native Enter/Space activation (re-clicking that element) would already have happened by the
    // time this listener runs. Capturing on `window` intercepts the key before it reaches that
    // focused element, so Enter/Space always confirms the dialog instead of re-activating whatever
    // happens to be focused.
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [id, onClose, onConfirm]);

  return createPortal(
    <div style={styles.overlay} onClick={onClose}>
      <div
        ref={modalRef}
        tabIndex={-1}
        style={{
          ...styles.modal,
          outline: "none",
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
