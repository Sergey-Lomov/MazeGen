export const colors = {
  // Backgrounds
  bgApp: "#111111",
  bgPanel: "#181818",
  bgPanelAlt: "#222",
  bgInput: "#2a2a2a",
  bgBtnPrimary: "#3a6ea8",
  bgBtnPrimaryActive: "#2a5080",
  bgBtnSecondary: "#555",
  bgBtnMuted: "#444",

  // Borders
  borderStrong: "#444",
  borderMid: "#333",
  borderDim: "#2a2a2a",
  borderSelected: "#666",

  // Text
  textPrimary: "#e0e0e0",
  textSecondary: "#ddd",
  textMuted: "#ccc",
  textFaint: "#aaa",
  textDim: "#888",
  textVeryDim: "#666",
  textDisabled: "#555",
  textWhite: "#fff",

  // Semantic
  textError: "#ff6b6b",
  bgError: "#2a1a1a",
  textWarning: "#ffaa44",
  bgWarning: "#2a2010",
  textAccent: "#4a9eff",
  textSuccess: "#6dbf7e",
  accentSlider: "#5a9",

  // Feature card status
  featureStatusUnavailable: "#666",
  featureStatusSet: "#6dbf7e",
  featureStatusWarning: "#ffaa44",
  featureStatusCritical: "#ff6b6b",
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
