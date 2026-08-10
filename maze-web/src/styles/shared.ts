import type React from "react";
import { ui, font, radius, typography, spacing, inset, controlRowHeight } from "./theme";

const selectArrow = {
  appearance: "none",
  WebkitAppearance: "none",
  MozAppearance: "none",
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='${ui.text.tertiary.replace("#", "%23")}'/%3E%3C/svg%3E")`,
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 6px center",
  backgroundSize: "9px 6px",
} satisfies React.CSSProperties;

export const sharedStyles = {
  // Input / select field
  input: {
    ...typography.field,
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    padding: "3px 6px",
    borderRadius: radius.sm,
  } satisfies React.CSSProperties,

  // Same as input but used in tighter layouts (padding only, same font size as `input`).
  inputSm: {
    ...typography.field,
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    borderRadius: radius.sm,
    padding: "2px 6px",
  } satisfies React.CSSProperties,

  select: {
    ...typography.field,
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    padding: "3px 20px 3px 6px",
    borderRadius: radius.sm,
    ...selectArrow,
  } satisfies React.CSSProperties,

  selectSm: {
    ...typography.field,
    height: controlRowHeight,
    boxSizing: "border-box",
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    borderRadius: radius.sm,
    padding: "0 18px 0 4px",
    ...selectArrow,
  } satisfies React.CSSProperties,

  // Label as flex column (wraps a field)
  fieldLabel: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.elementsGap,
    ...typography.caption,
  } satisfies React.CSSProperties,

  // Section header, separated from surrounding content by spacing rather than weight/case.
  sectionHeader: {
    ...typography.body,
  } satisfies React.CSSProperties,

  // Primary action button
  btnPrimary: {
    ...typography.control,
    background: ui.accent.base,
    border: "none",
    color: ui.text.inverse,
    padding: inset.toolButtonInset,
    cursor: "default",
    borderRadius: radius.sm,
  } satisfies React.CSSProperties,

  // Muted / secondary button
  btnMuted: {
    ...typography.control,
    background: ui.border.strong,
    border: "none",
    color: ui.text.inverse,
    padding: inset.toolButtonInset,
    cursor: "default",
    borderRadius: radius.sm,
  } satisfies React.CSSProperties,

  // Toggle / pill button (inactive state)
  toggleBtn: {
    ...typography.control,
    flex: 1,
    padding: inset.toolButtonInset,
    border: `1px solid ${ui.border.strong}`,
    background: ui.bg.input,
    color: ui.text.tertiary,
    borderRadius: radius.sm,
    cursor: "default",
  } satisfies React.CSSProperties,

  // Toggle button active state
  toggleBtnActive: {
    background: ui.accent.base,
    color: ui.text.inverse,
    border: `1px solid ${ui.accent.base}`,
  } satisfies React.CSSProperties,

  // Icon/close button (no bg/border)
  closeBtn: {
    ...typography.icon,
    background: "none",
    border: "none",
    color: ui.text.tertiary,
    cursor: "default",
    padding: "0 2px",
  } satisfies React.CSSProperties,

  // Disabled state overlay
  btnDisabled: {
    opacity: 0.4,
    cursor: "not-allowed",
  } satisfies React.CSSProperties,

  // Slider row (label + range + value) — explicit `controlRowHeight` so it lines up with
  // `ColorRow`/`SelectRow`/`ToggleRow`, which all size their own control (`ColorSwatch`, `select`,
  // `Switch`) to that same height; the range `<input>` has no equivalent sizing of its own.
  sliderRow: {
    display: "flex",
    alignItems: "center",
    gap: spacing.rowGap,
    minHeight: controlRowHeight,
    boxSizing: "border-box",
  } satisfies React.CSSProperties,

  // `width` (not `flexBasis`/`minWidth`) so a long label wraps within that width instead of
  // growing the row — `flexShrink: 0` keeps that width from being squeezed by the slider/value
  // still claiming their own space (`flex: 1` on the range input, fixed width on the value).
  sliderRowLabel: {
    fontSize: font.lg,
    color: ui.text.primary,
    width: 110,
    flexShrink: 0,
    lineHeight: 1.3,
  } satisfies React.CSSProperties,

  sliderRowValue: {
    fontSize: font.lg,
    color: ui.text.tertiary,
    width: 32,
    textAlign: "right" as const,
    flexShrink: 0,
  } satisfies React.CSSProperties,

  sliderInput: {
    flex: 1,
  } satisfies React.CSSProperties,

  // Error / warning messages
  errorMsg: {
    ...typography.body,
    color: ui.text.error,
    background: ui.bg.error,
    padding: "4px 6px",
    borderRadius: radius.sm,
  } satisfies React.CSSProperties,

  warningMsg: {
    ...typography.body,
    color: ui.text.warning,
    background: ui.bg.warning,
    padding: "4px 6px",
    borderRadius: radius.sm,
  } satisfies React.CSSProperties,

  // Panel title
  panelTitle: {
    ...typography.title,
    marginBottom: spacing.itemGap,
  } satisfies React.CSSProperties,
} as const;

type ButtonVariant = "primary" | "toggle" | "toggle-active" | "destructive" | "toggle-danger" | "toggle-danger-active";

export function buttonStyle(variant: ButtonVariant): React.CSSProperties {
  switch (variant) {
    case "primary":
      return {
        ...typography.control,
        background: ui.accent.base,
        border: "none",
        color: ui.text.inverse,
        padding: inset.toolButtonInset,
        cursor: "default",
        borderRadius: radius.sm,
      };
    case "toggle":
      return {
        ...typography.control,
        flex: 1,
        padding: inset.toolButtonInset,
        border: `1px solid ${ui.border.strong}`,
        background: ui.bg.input,
        color: ui.text.tertiary,
        borderRadius: radius.sm,
        cursor: "default",
      };
    case "toggle-active":
      return {
        ...typography.control,
        flex: 1,
        padding: inset.toolButtonInset,
        border: `1px solid ${ui.accent.base}`,
        background: ui.accent.base,
        color: ui.text.inverse,
        borderRadius: radius.sm,
        cursor: "default",
      };
    case "destructive":
      return {
        ...typography.control,
        padding: inset.toolButtonInset,
        border: `1px solid ${ui.text.error}`,
        background: ui.bg.input,
        color: ui.text.error,
        borderRadius: radius.sm,
        cursor: "default",
      };
    // A toggle tool whose selected state should read as dangerous (GitHub issue #327's unified
    // Reset tool) — same shape as `toggle`/`toggle-active`, red instead of accent.
    case "toggle-danger":
      return {
        ...typography.control,
        flex: 1,
        padding: inset.toolButtonInset,
        border: `1px solid ${ui.text.error}`,
        background: ui.bg.input,
        color: ui.text.error,
        borderRadius: radius.sm,
        cursor: "default",
      };
    case "toggle-danger-active":
      return {
        ...typography.control,
        flex: 1,
        padding: inset.toolButtonInset,
        border: `1px solid ${ui.text.error}`,
        background: ui.text.error,
        color: ui.text.inverse,
        borderRadius: radius.sm,
        cursor: "default",
      };
  }
}
