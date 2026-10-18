import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Placement } from "@floating-ui/react-dom";
import { FLOATING_Z_INDEX, useFeedbackFloating } from "./floating/floatingPosition";
import { radius, shadow, typography, ui } from "../styles/theme";

/** Hover delay before showing, ms — avoids flicker while the pointer crosses a settings list.
 *  Focus and touch show immediately. */
export const TOOLTIP_HOVER_DELAY_MS = 300;

/** Accessible tooltip (GitHub issue #768) — replaces the native `title`, which does not work on
 *  touch, cannot be reached from the keyboard on a disabled control and is not reliably announced.
 *
 *  `children` are wrapped in a focusable element (`tabIndex=0`) whose `aria-describedby` points to a
 *  visually hidden copy of `content`, so the description is available as soon as the wrapper gains
 *  focus. The visible bubble is portaled into `body` (above modals), positioned with the shared
 *  `flip`/`shift` middleware, and shown on hover, focus and tap; a tap outside or Escape hides it.
 *
 *  Meant for disabled controls and other non-focusable content (epic #766 rule 3). With empty
 *  `content` the wrapper stays in place (so toggling a control's `disabled` never remounts it) but is
 *  inert: no tab stop, no description, no bubble. */
export function Tooltip({ content, children, placement = "bottom", block = false, stretch = false, bubbleStyle }: {
  content: React.ReactNode;
  children: React.ReactNode;
  placement?: Placement;
  /** Render the wrapper as a block-level `div` (e.g. a whole settings row) instead of an
   *  `inline-flex` `span`. */
  block?: boolean;
  /** Make the wrapper fill its parent flex row's cross axis. */
  stretch?: boolean;
  /** Optional presentation override for one tooltip bubble. Most callers use the shared style. */
  bubbleStyle?: React.CSSProperties;
}) {
  const id = useId();
  const descriptionId = `${id}-description`;
  const active = !!content;
  const [open, setOpen] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { refs, floatingStyles } = useFeedbackFloating(placement);

  const clearHoverTimer = () => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  useEffect(() => clearHoverTimer, []);
  useEffect(() => {
    if (!active) {
      clearHoverTimer();
      setOpen(false);
    }
  }, [active]);

  // Touch: a tap outside both the anchor and the bubble hides it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if ((refs.reference.current as Element | null)?.contains(target) || refs.floating.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, refs]);

  const Wrapper = block ? "div" : "span";
  return (
    <Wrapper
      ref={refs.setReference}
      data-testid="tooltip-anchor"
      tabIndex={active ? 0 : undefined}
      aria-describedby={active ? descriptionId : undefined}
      style={{ ...(block ? styles.block : styles.inline), ...(stretch ? { alignSelf: "stretch" } : {}) }}
      onPointerEnter={(e) => {
        if (!active || e.pointerType === "touch") return;
        clearHoverTimer();
        hoverTimer.current = setTimeout(() => setOpen(true), TOOLTIP_HOVER_DELAY_MS);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "touch") return;
        clearHoverTimer();
        setOpen(false);
      }}
      onPointerDown={(e) => {
        if (active && e.pointerType === "touch") setOpen(true);
      }}
      onFocus={() => active && setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      {children}
      {active && <span id={descriptionId} hidden>{content}</span>}
      {active && open && createPortal(
        <div ref={refs.setFloating} data-testid="tooltip" aria-hidden="true" style={{ ...floatingStyles, ...styles.bubble, ...bubbleStyle }}>
          {content}
        </div>,
        document.body,
      )}
    </Wrapper>
  );
}

const styles: Record<string, React.CSSProperties> = {
  inline: { display: "inline-flex", outlineOffset: 2, borderRadius: radius.sm },
  block: { display: "block", outlineOffset: 2, borderRadius: radius.sm },
  bubble: {
    ...typography.caption,
    zIndex: FLOATING_Z_INDEX,
    maxWidth: 280,
    padding: "4px 8px",
    borderRadius: radius.md,
    border: `1px solid ${ui.border.default}`,
    background: ui.bg.panelAlt,
    color: ui.text.primary,
    boxShadow: shadow.modal,
    pointerEvents: "none",
    overflowWrap: "anywhere",
  },
};
