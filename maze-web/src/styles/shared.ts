import type React from "react";
import { colors, font, radius } from "./theme";

export const sharedStyles = {
  // Input / select field
  input: {
    background: colors.bgInput,
    border: `1px solid ${colors.borderStrong}`,
    color: colors.textPrimary,
    padding: "3px 6px",
    fontSize: font.md,
    borderRadius: radius.sm,
  } satisfies React.CSSProperties,

  // Same as input but used in contexts where fontSize: 11 is needed
  inputSm: {
    background: colors.bgInput,
    border: `1px solid ${colors.borderStrong}`,
    color: colors.textPrimary,
    fontSize: font.sm,
    borderRadius: radius.sm,
    padding: "2px 6px",
  } satisfies React.CSSProperties,

  select: {
    background: colors.bgInput,
    border: `1px solid ${colors.borderStrong}`,
    color: colors.textPrimary,
    padding: "3px 6px",
    fontSize: font.md,
    borderRadius: radius.sm,
  } satisfies React.CSSProperties,

  selectSm: {
    background: colors.bgInput,
    border: `1px solid ${colors.borderStrong}`,
    color: colors.textPrimary,
    fontSize: font.sm,
    borderRadius: radius.sm,
    padding: "1px 4px",
  } satisfies React.CSSProperties,

  // Label as flex column (wraps a field)
  fieldLabel: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
    fontSize: font.sm,
    color: colors.textFaint,
  } satisfies React.CSSProperties,

  // Section header: uppercase, bold, dim
  sectionHeader: {
    fontSize: font.sm,
    fontWeight: "bold" as const,
    color: colors.textDim,
    textTransform: "uppercase" as const,
    letterSpacing: 1,
  } satisfies React.CSSProperties,

  // Primary action button
  btnPrimary: {
    background: colors.bgBtnPrimary,
    border: "none",
    color: colors.textWhite,
    padding: "5px 0",
    cursor: "pointer",
    borderRadius: radius.sm,
    fontSize: font.md,
  } satisfies React.CSSProperties,

  // Muted / secondary button
  btnMuted: {
    background: colors.bgBtnMuted,
    border: "none",
    color: colors.textWhite,
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
    border: `1px solid ${colors.borderStrong}`,
    background: colors.bgInput,
    color: colors.textDim,
    borderRadius: radius.sm,
    cursor: "pointer",
  } satisfies React.CSSProperties,

  // Toggle button active state
  toggleBtnActive: {
    background: colors.bgBtnPrimary,
    color: colors.textWhite,
    border: `1px solid ${colors.bgBtnPrimary}`,
  } satisfies React.CSSProperties,

  // Icon/close button (no bg/border)
  closeBtn: {
    background: "none",
    border: "none",
    color: colors.textDim,
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
    color: colors.textMuted,
    width: 110,
    flexShrink: 0,
  } satisfies React.CSSProperties,

  sliderRowValue: {
    fontSize: font.sm,
    color: colors.textDim,
    width: 32,
    textAlign: "right" as const,
    flexShrink: 0,
  } satisfies React.CSSProperties,

  sliderInput: {
    flex: 1,
    accentColor: colors.accentSlider,
  } satisfies React.CSSProperties,

  // Error / warning messages
  errorMsg: {
    fontSize: font.sm,
    color: colors.textError,
    background: colors.bgError,
    padding: "4px 6px",
    borderRadius: radius.sm,
  } satisfies React.CSSProperties,

  warningMsg: {
    fontSize: font.sm,
    color: colors.textWarning,
    background: colors.bgWarning,
    padding: "4px 6px",
    borderRadius: radius.sm,
  } satisfies React.CSSProperties,

  // Panel title
  panelTitle: {
    fontSize: font.lg,
    fontWeight: "bold" as const,
    color: colors.textFaint,
    marginBottom: 4,
  } satisfies React.CSSProperties,
} as const;

type ButtonVariant = "primary" | "toggle" | "toggle-active" | "destructive";

export function buttonStyle(variant: ButtonVariant): React.CSSProperties {
  switch (variant) {
    case "primary":
      return {
        background: colors.bgBtnPrimary,
        border: "none",
        color: colors.textWhite,
        padding: "5px 0",
        cursor: "pointer",
        borderRadius: radius.sm,
        fontSize: font.md,
      };
    case "toggle":
      return {
        padding: "4px 0",
        fontSize: font.sm,
        border: `1px solid ${colors.borderStrong}`,
        background: colors.bgInput,
        color: colors.textDim,
        borderRadius: radius.sm,
        cursor: "pointer",
      };
    case "toggle-active":
      return {
        padding: "4px 0",
        fontSize: font.sm,
        border: `1px solid ${colors.bgBtnPrimary}`,
        background: colors.bgBtnPrimary,
        color: colors.textWhite,
        borderRadius: radius.sm,
        cursor: "pointer",
      };
    case "destructive":
      return {
        padding: "4px 0",
        fontSize: font.sm,
        border: `1px solid ${colors.textError}`,
        background: colors.bgInput,
        color: colors.textError,
        borderRadius: radius.sm,
        cursor: "pointer",
      };
  }
}
