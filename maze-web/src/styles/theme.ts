import { base, lighten, darken, disabledOf } from "./palette";

export const ui = {
  bg: {
    app: base.bgApp,
    panel: base.bgPanel,
    panelAlt: base.bgPanelAlt,
    hover: base.bgSurfaceRaised,
    input: base.bgSurfaceRaised,
    error: base.errorBg,
    warning: base.warningBg,
  },

  border: {
    strong: base.borderStrong,
    default: base.borderDefault,
  },

  text: {
    primary: base.textPrimary,
    secondary: base.textSecondary,
    tertiary: base.textTertiary,
    disabled: base.textDisabled,
    inverse: base.textInverse,
    error: base.error,
    warning: base.warning,
    success: base.success,
  },

  // Active accent (primary buttons, etc.) plus state modifiers derived from it.
  accent: {
    base: base.accent,
    hover: lighten(base.accent, 0.15),
    active: darken(base.accent, 0.15),
    disabled: disabledOf(base.accent),
  },

  // Selection state — reuses the strongest border tone, not a dedicated hue.
  state: {
    selected: base.borderStrong,
  },

  // Feature card status — aliases of the semantic text tokens above.
  status: {
    unavailable: base.textDisabled,
    set: base.success,
    warning: base.warning,
    critical: base.error,
  },
} as const;

export const radius = {
  sm: 3,
  md: 4,
  lg: 6,
} as const;

export const font = {
  xs: 9,
  sm: 11,
  md: 12,
  lg: 13,
  xl: 14,
} as const;

export const overlay = {
  bg: "rgba(0,0,0,0.6)",
  zIndex: 1000,
} as const;

export const shadow = {
  modal: "0 4px 24px rgba(0,0,0,0.5)",
} as const;

export const dialogSpacing = {
  paddingX: 14,
  paddingY: 10,
  gap: 10,
  bodyPadding: 12,
  maxHeight: "80vh",
} as const;

// Semantic dialog widths
export const dialogSize = {
  approve: { minWidth: 260, maxWidth: 360 },
  info: { minWidth: 280, maxWidth: 520, width: 520 },
  complex: { minWidth: 460, maxWidth: 720, width: 720, height: "60vh" },
} as const;
