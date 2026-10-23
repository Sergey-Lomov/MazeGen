import { base, lighten, darken, disabledOf } from "./palette";

export const ui = {
  bg: {
    app: base.bgApp,
    panel: base.bgPanel,
    panelAlt: base.bgPanelAlt,
    hover: base.bgSurfaceRaised,
    input: base.bgSurfaceRaised,
    keycap: base.bgKeycap,
    error: base.errorBg,
    warning: base.warningBg,
    success: base.successBg,
    info: base.infoBg,
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
    info: base.info,
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

  // Debug event tree node/edge/cycle/region ref bubbles (GitHub issue #130) — exact same
  // bg/text pair as the info notification bubble (`notificationPalette("info")`), border
  // restored (same color as the text, matching `IssueBubble`'s own border) — a borderless
  // version nearly disappeared against the tree row's own highlighted-row background.
  debug: {
    refHighlight: {
      bg: base.infoBg,
      text: base.info,
    },
    // Issue-kind ref bubbles (GitHub issue #203) — red instead of `refHighlight`'s cyan, so an
    // issue reads as visually distinct from a plain node/edge/cycle/region reference at a glance.
    // Same bg/text pairing convention as `refHighlight` above, using the app's semantic error red.
    issueHighlight: {
      bg: base.errorBg,
      text: base.error,
    },
    // Debug event tree search-match dot (GitHub issue #482) — shown on every row that matches the
    // query or has a match somewhere in its subtree. Amber (`base.warning`), semantically "found /
    // attention", distinct from `refHighlight`'s cyan (info) and `issueHighlight`'s red (error).
    searchMatch: base.warning,
  },
} as const;

export const radius = {
  sm: 3,
  md: 4,
  lg: 6,
} as const;

// Vertical/horizontal gap inside a flex/grid container. Named by structural role, not size.
//
// Boundary rule (spacing vs inset vs control size):
//   - spacing = distance BETWEEN sibling elements (gap, marginTop/Bottom between blocks)
//   - inset   = padding INSIDE a single component's own border
//   - control size (width/height of icons, switches, inputs) is a separate system, not spacing
export const spacing = {
  elementsGap: 2, // micro-gap between tightly-related elements: label→value pairs, tool button clusters
  itemGap: 4,     // element within a list/grid: toggle rows, chip rows, grid cells (most common value)
  rowGap: 8,      // horizontal gap inside a single label/control row (same value as groupGap, distinct role)
  groupGap: 8,    // block within a section
  sectionGap: 16, // independent sub-section / param-with-description spacing
  tableColumnsGap: 32, // horizontal gap between columns in compact data tables
} as const;

// Fixed height every param-row control (color swatch, toggle switch, select) shares, so rows with
// different control types line up at the same height in the same settings list.
export const controlRowHeight = 22;

export const inset = {
  // Dialog/modal action-button family (footer Confirm/Cancel/OK-style buttons).
  buttonInsetX: 12,
  buttonInsetY: 5,
  // Toolbar/inline button family — sharedStyles.btn*/buttonStyle()/GenerationFeature.btnGenerate
  // and friends. Square padding (X and Y equal).
  toolButtonInset: 4,
  // Icon-only button family (edit/clear glyph, no label) — GenerationFeature.editBtn,
  // NestedStrategyPanel.editBtn, qualityCanvasStyles.editBtn, PostEditFeature.clearTag.
  // Horizontal only; these buttons size to their icon's own line-height vertically.
  iconButtonInset: 2,
  // Top-level panel/card padding — FeatureCard header, FeaturesPanel footer, DebugPanel rows.
  panelInsetX: 12,
  panelInsetY: 10,
} as const;

// Hierarchical tree indent — not a spacing scale, kept in its own namespace on purpose
// (mixing indent into spacing invites nonsense like `paddingLeft: sectionGap`).
export const indent = {
  tree: 12, // NestedStrategyPanel: depth * indent.tree
} as const;

export const font = {
  xs: 11,
  sm: 12,
  md: 13,
  lg: 14,
  xl: 15,
} as const;

// Combined size+color presets. Font family is set globally (styles/global.css).
// Components should use one of these instead of composing fontSize/color/fontWeight ad hoc.
export const typography = {
  // Modal/section titles.
  title: {
    fontSize: font.xl,
    fontWeight: 600,
    color: ui.text.primary,
    lineHeight: "18px",
    letterSpacing: 0,
  },

  // Base UI text layer — most neutral, most readable.
  body: {
    fontSize: font.lg,
    fontWeight: 400,
    color: ui.text.primary,
    lineHeight: "17px",
  },

  // Dialog/confirmation/system message copy. Same size as body but lower-contrast color — an
  // instructive layer, not content, so it shouldn't compete visually.
  message: {
    fontSize: font.lg,
    fontWeight: 400,
    color: ui.text.secondary,
    lineHeight: "17px",
  },

  // Hints, captions, meta info.
  caption: {
    fontSize: font.sm,
    fontWeight: 400,
    color: ui.text.tertiary,
    letterSpacing: 0.3,
    lineHeight: "14px",
  },

  // Button label text. Color is intentionally not part of this token — buttons vary it by
  // variant (primary/secondary/destructive), unlike the content presets above.
  control: {
    fontSize: font.lg,
  },

  // Icon-only buttons (close/info/edit icons).
  icon: {
    fontSize: font.xl,
  },

  // Text input / select fields. Same size as `control` — one unified field size, no
  // separate "Sm" variant.
  field: {
    fontSize: font.lg,
    color: ui.text.primary,
  },
} as const;

type TypographyToken = (typeof typography)[keyof typeof typography];

// Color modifiers — apply to any typography token instead of overriding `color` ad hoc at
// the call site. Usage: `{ ...muted(typography.body) }`.
export function muted<T extends TypographyToken>(token: T): T & { color: string } {
  return { ...token, color: ui.text.secondary };
}

export function disabled<T extends TypographyToken>(token: T): T & { color: string } {
  return { ...token, color: ui.text.disabled };
}

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
  // Same shrink-to-fit/no-fixed-`width` shape as `approve` (grows with its content, capped at
  // `maxWidth`) but a taller ceiling — for a list dialog whose rows can carry several coordinate
  // bubbles (`PostEditEntityDeleteDialog`, GitHub issue #550 seventh follow-up) and would otherwise
  // wrap constantly at `approve`'s narrow 360px cap. A row still wraps onto a second line past
  // `maxWidth` (the row's own `flexWrap`) — this only raises the point where that kicks in.
  approveWide: { minWidth: 260, maxWidth: 640 },
  // Shrink-to-fit with no width floor — for a pick list whose rows stay on one line and set the
  // dialog's width themselves (move/settings element pickers, GitHub issue #748).
  fit: { minWidth: 0, maxWidth: 640 },
  info: { minWidth: 280, maxWidth: 520, width: 520 },
  complex: { minWidth: 460, maxWidth: 720, width: 720, height: "60vh" },
  // Same height as `complex`, wider — `LinkEditor` (GitHub issue #645) needs a third column for a
  // link's modifier chain alongside the existing target/source pickers, which `complex`'s 720px is
  // too narrow for without squeezing all three.
  threeColumn: { minWidth: 460, maxWidth: 960, width: 960, height: "60vh" },
  printSizing: { minWidth: 520, maxWidth: 720 },
  // The pattern editor (`AbstractPatternEditorDialog`) — its tile diagram and node-card list stack
  // vertically, not side-by-side (GitHub issue #237 follow-up: post-edit/preset moved to a
  // `SidePanel`, leaving this the only `wide` caller), so it no longer needs `complex`'s width,
  // just its own extra height for the tile+cards column.
  wide: { minWidth: 420, maxWidth: 560, width: 480, height: "70vh" },
} as const;
