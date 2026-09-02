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

  // Text input sized to `controlRowHeight` the same way `selectSm` is — for labeled param rows
  // (`TextRow`) so a text field lines up with the select/color/toggle rows in the same list.
  textFieldSm: {
    ...typography.field,
    lineHeight: "16px",
    boxSizing: "border-box",
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    borderRadius: radius.sm,
    padding: "2px 6px",
  } satisfies React.CSSProperties,

  select: {
    ...typography.field,
    // Native <select> needs an explicit line-height — without it Chromium seats the label text
    // low in the line box and clips descenders (GitHub issue #457).
    lineHeight: "16px",
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    padding: "3px 20px 3px 6px",
    borderRadius: radius.sm,
    ...selectArrow,
  } satisfies React.CSSProperties,

  // `controlRowHeight` is reached via line-height + symmetric vertical padding rather than a fixed
  // `height` — a fixed height with zero vertical padding left the text seated low and clipped its
  // descenders (GitHub issue #457).
  selectSm: {
    ...typography.field,
    lineHeight: "16px",
    boxSizing: "border-box",
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    borderRadius: radius.sm,
    padding: "2px 18px 2px 4px",
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

  // Toggle button selected state
  toggleBtnSelected: {
    background: ui.state.selected,
    color: ui.text.primary,
    border: `1px solid ${ui.state.selected}`,
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

type ButtonVariant = "primary" | "secondary" | "toggle" | "toggle-selected" | "destructive" | "toggle-danger" | "toggle-danger-selected";

// Rest/hover/active colors for every variant live in the matching CSS class (`global.css`,
// `.btn-*`), not here — an inline `background`/`border`/`color` always outranks a CSS class
// regardless of selector specificity (except `!important`), which silently defeated `:hover`/
// `:active` for every one of these variants (GitHub issue #329). `buttonStyle()` only returns
// layout that has no visual-state variation (padding, flex, radius, typography, cursor).
export function buttonStyle(variant: ButtonVariant): React.CSSProperties {
  const flex = variant === "primary" || variant === "secondary" || variant === "destructive" ? {} : { flex: 1 };
  return {
    ...typography.control,
    ...flex,
    padding: inset.toolButtonInset,
    borderRadius: radius.sm,
    cursor: "default",
  };
}

const buttonClassByVariant: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  toggle: "btn-toggle",
  "toggle-selected": "btn-toggle-selected",
  destructive: "btn-destructive",
  "toggle-danger": "btn-toggle-danger",
  "toggle-danger-selected": "btn-toggle-danger-selected",
};

export function buttonClass(variant: ButtonVariant): string {
  return buttonClassByVariant[variant];
}
