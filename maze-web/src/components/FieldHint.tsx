import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { Placement, VirtualElement } from "@floating-ui/react-dom";
import { FLOATING_Z_INDEX, useFeedbackFloating } from "./floating/floatingPosition";
import { announce } from "../notifications/announcer";
import { noticeDisplayDuration } from "../notifications/notificationStore";
import { useLocale } from "../i18n/useLocale";
import { radius, spacing, typography, ui } from "../styles/theme";
import * as m from "~/paraglide/messages";
import { Tooltip } from "./Tooltip";

/** Why a field's input was rejected or corrected. `key` identifies the reason (a repeat of the same
 *  key restarts the timer silently); `message` is called on every render, so a locale switch
 *  re-translates a visible hint in place. */
export interface FieldHintReason {
  key: string;
  message: () => string;
}

export interface FieldHintController {
  /** Attach to the field element — the hint is positioned against it (together with the label,
   *  when attached). */
  anchorRef: (el: HTMLElement | null) => void;
  /** Attach to the field's label — the hint then spans from the label's left edge to the field's
   *  right edge (at least; longer text extends past it), reading as a note of the whole row.
   *  Optional: without a label the hint is at least as wide as the field. */
  labelRef: (el: HTMLElement | null) => void;
  /** Spread onto the field: `aria-describedby` of the visible hint, `undefined` while hidden. */
  describedBy: string | undefined;
  /** Merge into the field's `style`: an info-colored outline tying the field to its visible hint,
   *  `undefined` while hidden. Applied by the owner (not written to the DOM node), so React keeps
   *  the field's own styles consistent. */
  fieldStyle: React.CSSProperties | undefined;
  /** Shows `reason`, replacing the current hint. The same `key` again restarts the timer without
   *  re-announcement. */
  show: (reason: FieldHintReason) => void;
  /** Hides the hint — call on the next accepted value change of the field. */
  dismiss: () => void;
  /** Portal-rendered hint element (or `null`); render it anywhere in the field's owner, so the
   *  hint disappears when the field unmounts. */
  hint: React.ReactNode;
}

interface HintState {
  reason: FieldHintReason;
  /** Bumped by a repeat of the same reason — restarts the display timer. */
  restart: number;
  /** Active display time, ms — the notice-toast formula (`noticeDisplayDuration`) applied to the
   *  text at show / repeat time; a locale switch does not change it. */
  duration: number;
}

/** Field-anchored hint (GitHub issue #768, epic #766 rule 4): one hint per field, shown when input
 *  is rejected or corrected. Closed by the next accepted change (`dismiss`), its close button, the
 *  notice-toast display duration (`noticeDisplayDuration`) of active display (hovering the hint
 *  pauses it), or unmount of the owner. Announced once politely through the shared `Announcer`; the
 *  hint itself has no live role. */
export function useFieldHint(placement: Placement = "bottom-start"): FieldHintController {
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [label, setLabel] = useState<HTMLElement | null>(null);
  const [state, setState] = useState<HintState | null>(null);
  const currentKey = useRef<string | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  anchorRef.current = anchor;

  const show = useCallback((reason: FieldHintReason) => {
    // Nothing to anchor to (field not mounted yet): no hint, so no announcement either.
    if (!anchorRef.current) return;
    if (currentKey.current === reason.key) {
      setState((prev) => ({ reason, restart: (prev?.restart ?? 0) + 1, duration: noticeDisplayDuration(reason.message()) }));
      return;
    }
    currentKey.current = reason.key;
    setState({ reason, restart: 0, duration: noticeDisplayDuration(reason.message()) });
    announce(reason.message(), "polite");
  }, []);

  const dismiss = useCallback(() => {
    currentKey.current = null;
    setState(null);
  }, []);

  const hint = state && anchor
    ? <FieldHintBubble id={id} anchor={anchor} label={label} placement={placement} state={state} onClose={dismiss} />
    : null;
  return {
    anchorRef: setAnchor,
    labelRef: setLabel,
    describedBy: hint ? id : undefined,
    fieldStyle: hint ? FIELD_OUTLINE_STYLE : undefined,
    show,
    dismiss,
    hint,
  };
}

function FieldHintBubble({ id, anchor, label, placement, state, onClose }: {
  id: string;
  /** The field. */
  anchor: HTMLElement;
  /** The field's label, when attached — the hint spans from it to the field. */
  label: HTMLElement | null;
  placement: Placement;
  state: HintState;
  onClose: () => void;
}) {
  useLocale();
  const { refs, floatingStyles } = useFeedbackFloating(placement, FIELD_HINT_GAP, true);
  useLayoutEffect(() => {
    refs.setReference(label ? spanReference(label, anchor) : anchor);
  }, [label, anchor, refs]);

  const [paused, setPaused] = useState(false);
  const [closeHovered, setCloseHovered] = useState(false);
  const remaining = useRef(state.duration);
  // Declared before the timer effect: on a restart the timer's cleanup runs first, then this reset,
  // then the timer starts again from the full duration.
  useEffect(() => {
    remaining.current = state.duration;
  }, [state.reason.key, state.restart, state.duration]);
  useEffect(() => {
    if (paused) return;
    const startedAt = Date.now();
    const timer = setTimeout(onClose, remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt));
    };
  }, [paused, state.reason.key, state.restart, state.duration, onClose]);

  return createPortal(
    <div
      ref={refs.setFloating}
      id={id}
      data-testid="field-hint"
      style={{ ...floatingStyles, ...styles.caption }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <span style={styles.message}>
        {state.reason.message()}
        <span
          key={`${state.reason.key}:${state.restart}`}
          data-testid="field-hint-countdown"
          aria-hidden="true"
          style={{ ...styles.countdown, animationDuration: `${state.duration}ms`, animationPlayState: paused ? "paused" : "running" }}
        />
      </span>
      <Tooltip content={m["notifications.close"]()}><button
        type="button"
        aria-label={m["notifications.close"]()}
        style={{ ...styles.closeBtn, opacity: closeHovered ? 1 : 0.5 }}
        onMouseEnter={() => setCloseHovered(true)}
        onMouseLeave={() => setCloseHovered(false)}
        onFocus={() => setCloseHovered(true)}
        onBlur={() => setCloseHovered(false)}
        onClick={onClose}
      >
        <X size={12} />
      </button></Tooltip>
    </div>,
    document.body,
  );
}

/** Virtual reference covering the label and the field together (their bounding union), so the hint
 *  spans from the label's left edge to the field's right edge. `contextElement` lets `autoUpdate`
 *  follow the field's scroll containers. */
function spanReference(label: HTMLElement, field: HTMLElement): VirtualElement {
  return {
    contextElement: field,
    getBoundingClientRect() {
      const a = label.getBoundingClientRect();
      const b = field.getBoundingClientRect();
      const left = Math.min(a.left, b.left);
      const top = Math.min(a.top, b.top);
      const right = Math.max(a.right, b.right);
      const bottom = Math.max(a.bottom, b.bottom);
      return { x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top };
    },
  };
}

/** Field outline while its hint is shown — ties the caption to its field. */
const FIELD_OUTLINE_STYLE: React.CSSProperties = { outline: `1px solid ${ui.text.info}`, outlineOffset: 1 };

/** Distance between the field and its caption, px — tighter than tooltips, so the caption reads as
 *  part of the field. */
const FIELD_HINT_GAP = 2;

const styles: Record<string, React.CSSProperties> = {
  // Lightweight inline-looking caption: thin dimmed border, no shadow; the panel-colored backdrop only keeps
  // the text readable when it overlaps neighboring rows. Hints are single-line messages: the close
  // button is centered on the text line.
  caption: {
    ...typography.caption,
    zIndex: FLOATING_Z_INDEX,
    // Minimum width comes from the `size` middleware (label-to-field span); padding stays inside it.
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    gap: spacing.elementsGap,
    padding: "1px 4px",
    // Thin, dimmed info border — outlines the caption without turning it into a heavy bubble.
    border: `1px solid color-mix(in srgb, ${ui.text.info} 45%, transparent)`,
    borderRadius: radius.sm,
    background: ui.bg.panel,
    color: ui.text.info,
  },
  message: {
    position: "relative",
    flex: 1,
    minWidth: 0,
    overflowWrap: "anywhere",
    paddingBottom: 2,
  },
  /** Same countdown as notice toasts (`NotificationHost`'s `CountdownBar`), drawn as a thin
   *  underline of the text: always starts full (a repeat remounts it via `key`), pauses together
   *  with the timer on hover. */
  countdown: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 1,
    background: "currentColor",
    transformOrigin: "left center",
    opacity: 0.5,
    pointerEvents: "none",
    animationName: "notice-countdown",
    animationTimingFunction: "linear",
    animationFillMode: "forwards",
    ["--countdown-from" as string]: 1,
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "inherit",
    cursor: "default",
    padding: 0,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    borderRadius: radius.sm,
  },
};
