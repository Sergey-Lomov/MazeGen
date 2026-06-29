// Single source of truth for raw color values, shared by the UI (DOM) and canvas (Pixi) layers.
// `theme.ts` and `pixi/colorUtils.ts` build their namespaced tokens from these base values.

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;

  if (d === 0) return { h: 0, s: 0, l };

  const s = d / (1 - Math.abs(2 * l - 1));
  let hue: number;
  switch (max) {
    case r: hue = ((g - b) / d) % 6; break;
    case g: hue = (b - r) / d + 2; break;
    default: hue = (r - g) / d + 4; break;
  }
  hue *= 60;
  if (hue < 0) hue += 360;

  return { h: hue, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }

  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Lighten by a fraction (0..1) of the remaining distance to white.
export function lighten(hex: string, amount: number): string {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h, s, clamp01(l + (1 - l) * amount));
}

// Darken by a fraction (0..1) of the remaining distance to black.
export function darken(hex: string, amount: number): string {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h, s, clamp01(l * (1 - amount)));
}

// Reduce saturation by a fraction (0..1).
export function desaturate(hex: string, amount: number): string {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h, clamp01(s * (1 - amount)), l);
}

// disabled = desaturated + darkened version of the active color
export function disabledOf(hex: string): string {
  return darken(desaturate(hex, 0.6), 0.2);
}

export function hexToNumber(hex: string): number {
  return parseInt(hex.replace("#", ""), 16);
}

// ─── Base palette ───────────────────────────────────────────────────────────
// Raw values. Everything else (ui.*, canvas.*) derives from these.

// Backgrounds — single base + lighten steps, 4 levels total (was 5 hand-picked hexes).
const bgApp = "#111111";
const bgPanel = lighten(bgApp, 0.03);
const bgPanelAlt = lighten(bgPanel, 0.05);
const bgSurfaceRaised = lighten(bgPanelAlt, 0.04); // hover fill and input background — same tone

export const base = {
  // Backgrounds
  bgApp,
  bgPanel,
  bgPanelAlt,
  bgSurfaceRaised,

  // Borders
  borderStrong: "#444444",
  borderDefault: "#333333",

  // Text — 5 levels: primary, secondary, tertiary, disabled, inverse.
  textPrimary: "#e0e0e0",
  textSecondary: "#cccccc",
  textTertiary: "#aaaaaa",
  textDisabled: "#666666",
  textInverse: "#ffffff",

  // Accent — canonical brand blue, defined by the primary button color.
  accent: "#3a6ea8",

  // Canvas accent — same hue family as `accent`, but lighter for contrast
  // against the dark canvas background. Kept distinct on purpose.
  canvasAccent: "#4a9eff",

  // Semantic status
  error: "#ff6b6b",
  errorBg: "#2a1a1a",
  warning: "#ffaa44",
  warningBg: "#2a2010",
  success: "#6dbf7e",

  // Canvas-only hues, kept separate from the UI accent family because they
  // identify distinct graph/maze semantics, not interactive states.
  nodeHover: "#ff9f4a",
  nodeSelected: "#ff4a4a",
  nodeStart: "#44dd88",
  nodeFinish: "#dd4466",
  edge: "#888888",
  oneWay: "#ffaa00",
  invalid: "#ddaa00",
  canvasHover: "#44aaff",
  origin: "#ff6600",
  debugActive: "#4488ff",
  debugCurrentSrc: "#cccc22",
} as const;
