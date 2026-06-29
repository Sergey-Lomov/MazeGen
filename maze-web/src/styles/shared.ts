import type React from "react";
import { ui, font, radius } from "./theme";

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
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    color: ui.text.primary,
    padding: "3px 6px",
    fontSize: font.md,
    borderRadius: radius.sm,
  } satisfies React.CSSProperties,

  // Same as input but used in contexts where fontSize: 11 is needed
  inputSm: {
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    color: ui.text.primary,
    fontSize: font.sm,
    borderRadius: radius.sm,
    padding: "2px 6px",
  } satisfies React.CSSProperties,

  select: {
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    color: ui.text.primary,
    padding: "3px 20px 3px 6px",
    fontSize: font.md,
    borderRadius: radius.sm,
    ...selectArrow,
  } satisfies React.CSSProperties,

  selectSm: {
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    color: ui.text.primary,
    fontSize: font.sm,
    borderRadius: radius.sm,
    padding: "1px 18px 1px 4px",
    ...selectArrow,
  } satisfies React.CSSProperties,

  // Label as flex column (wraps a field)
  fieldLabel: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
    fontSize: font.sm,
    color: ui.text.tertiary,
  } satisfies React.CSSProperties,

  // Section header: uppercase, bold, dim
  sectionHeader: {
    fontSize: font.sm,
    fontWeight: "bold" as const,
    color: ui.text.tertiary,
    textTransform: "uppercase" as const,
    letterSpacing: 1,
  } satisfies React.CSSProperties,

  // Primary action button
  btnPrimary: {
    background: ui.accent.base,
    border: "none",
    color: ui.text.inverse,
    padding: "5px 0",
    cursor: "pointer",
    borderRadius: radius.sm,
    fontSize: font.md,
  } satisfies React.CSSProperties,

  // Muted / secondary button
  btnMuted: {
    background: ui.border.strong,
    border: "none",
    color: ui.text.inverse,
    padding: "5px 0",
    cursor: "pointer",
    borderRadius: radius.sm,
    fontSize: font.md,
  } satisfies React.CSSProperties,

  // Toggle / pill button (inactive state)
  toggleBtn: {
    flex: 1,
    padding: "4px 0",
    fontSize: font.sm,
    border: `1px solid ${ui.border.strong}`,
    background: ui.bg.input,
    color: ui.text.tertiary,
    borderRadius: radius.sm,
    cursor: "pointer",
  } satisfies React.CSSProperties,

  // Toggle button active state
  toggleBtnActive: {
    background: ui.accent.base,
    color: ui.text.inverse,
    border: `1px solid ${ui.accent.base}`,
  } satisfies React.CSSProperties,

  // Icon/close button (no bg/border)
  closeBtn: {
    background: "none",
    border: "none",
    color: ui.text.tertiary,
    cursor: "pointer",
    fontSize: font.xl,
    padding: "0 2px",
  } satisfies React.CSSProperties,

  // Disabled state overlay
  btnDisabled: {
    opacity: 0.4,
    cursor: "not-allowed",
  } satisfies React.CSSProperties,

  // Slider row (label + range + value)
  sliderRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
  } satisfies React.CSSProperties,

  sliderRowLabel: {
    fontSize: font.sm,
    color: ui.text.secondary,
    width: 110,
    flexShrink: 0,
  } satisfies React.CSSProperties,

  sliderRowValue: {
    fontSize: font.sm,
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
    fontSize: font.sm,
    color: ui.text.error,
    background: ui.bg.error,
    padding: "4px 6px",
    borderRadius: radius.sm,
  } satisfies React.CSSProperties,

  warningMsg: {
    fontSize: font.sm,
    color: ui.text.warning,
    background: ui.bg.warning,
    padding: "4px 6px",
    borderRadius: radius.sm,
  } satisfies React.CSSProperties,

  // Panel title
  panelTitle: {
    fontSize: font.lg,
    fontWeight: "bold" as const,
    color: ui.text.tertiary,
    marginBottom: 4,
  } satisfies React.CSSProperties,
} as const;

type ButtonVariant = "primary" | "toggle" | "toggle-active" | "destructive";

export function buttonStyle(variant: ButtonVariant): React.CSSProperties {
  switch (variant) {
    case "primary":
      return {
        background: ui.accent.base,
        border: "none",
        color: ui.text.inverse,
        padding: "5px 0",
        cursor: "pointer",
        borderRadius: radius.sm,
        fontSize: font.md,
      };
    case "toggle":
      return {
        flex: 1,
        padding: "4px 0",
        fontSize: font.sm,
        border: `1px solid ${ui.border.strong}`,
        background: ui.bg.input,
        color: ui.text.tertiary,
        borderRadius: radius.sm,
        cursor: "pointer",
      };
    case "toggle-active":
      return {
        flex: 1,
        padding: "4px 0",
        fontSize: font.sm,
        border: `1px solid ${ui.accent.base}`,
        background: ui.accent.base,
        color: ui.text.inverse,
        borderRadius: radius.sm,
        cursor: "pointer",
      };
    case "destructive":
      return {
        padding: "4px 0",
        fontSize: font.sm,
        border: `1px solid ${ui.text.error}`,
        background: ui.bg.input,
        color: ui.text.error,
        borderRadius: radius.sm,
        cursor: "pointer",
      };
  }
}
