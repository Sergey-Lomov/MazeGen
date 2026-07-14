import { base, hexToNumber } from "../styles/palette";

export const NODE_RADIUS = 6;
export const WALL_THICKNESS = 3;
export const GRID_LINE_ALPHA = 1.0;
export const ORIGIN_ALPHA = 0.9;
export const ACTIVE_CELL_ALPHA = 0.7;
export const COMPONENT_MASK_ALPHA = 0.45;
export const REGION_CLASS_MASK_ALPHA = 0.45;
export const DEBUG_ACTIVE_ALPHA = 0.5;

// Canvas color tokens, namespaced by render entity (mirrors `ui.*` on the DOM side).
export const canvas = {
  node: {
    default: hexToNumber(base.canvasAccent),
    hover: hexToNumber(base.nodeHover),
    selected: hexToNumber(base.nodeSelected),
    start: hexToNumber(base.nodeStart),
    finish: hexToNumber(base.nodeFinish),
  },

  edge: {
    default: hexToNumber(base.edge),
    oneWay: hexToNumber(base.oneWay),
  },

  wall: {
    default: hexToNumber(base.textSecondary),
    undecided: hexToNumber(base.textDisabled),
  },

  floor: {
    default: hexToNumber(base.bgSurfaceRaised),
  },

  stage: {
    background: hexToNumber(base.bgApp),
  },

  lock: {
    default: hexToNumber(base.edge),
  },

  preset: {
    invalid: hexToNumber(base.invalid),
  },

  fieldEditor: {
    hover: hexToNumber(base.canvasHover),
    activeCell: hexToNumber(base.textDisabled),
  },

  grid: {
    line: hexToNumber(base.borderDefault),
  },

  origin: {
    default: hexToNumber(base.origin),
  },

  teleport: {
    default: hexToNumber(base.teleport),
  },

  // Region class overlay — fixed per-class colors (not the rotating component palette)
  region: {
    path: hexToNumber(base.nodeStart),
    alternative: hexToNumber(base.canvasAccent),
    unreachable: hexToNumber(base.edge),
    trap: hexToNumber(base.nodeFinish),
  },

  debug: {
    active: hexToNumber(base.debugActive),
    currentSrc: hexToNumber(base.debugCurrentSrc),
    refHighlight: hexToNumber(base.debugRefHighlight),
  },
} as const;

// ─── Palette ──────────────────────────────────────────────────────────────────

// Quantized hue palette: 12 steps of 30°, pre-ordered by golden-angle jumps
// so consecutive indices are maximally separated on the color wheel.
const HUE_PALETTE = [0, 210, 30, 270, 90, 330, 150, 60, 240, 120, 300, 180];

// Lightness levels per pass over the palette.
const LIGHTNESS_PASSES = [0.65, 0.48, 0.78];

export function hslToRgb(h: number, s: number, l: number): number {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  return (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255);
}

// Debug-value palette (GitHub issue #131's follow-up) — a handful of muted, analogous hues
// (blue/teal/violet family, not full-spectrum like HUE_PALETTE above) at increasing lightness, so
// simultaneously-toggled debug values read as "the same family, different shades" rather than
// clashing unrelated colors. Lower saturation than the region palette (0.45 vs 0.65) to stay calm
// against the maze's own busy line/wall rendering.
const DEBUG_VALUE_HUES = [210, 190, 250]; // blue, teal, violet
const DEBUG_VALUE_LIGHTNESS = [0.55, 0.68, 0.42]; // per pass over the hue list
const DEBUG_VALUE_SATURATION = 0.45;

export function buildDebugValuePalette(count: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < count; i++) {
    const pass = Math.floor(i / DEBUG_VALUE_HUES.length);
    const hue = DEBUG_VALUE_HUES[i % DEBUG_VALUE_HUES.length];
    const lightness = DEBUG_VALUE_LIGHTNESS[pass % DEBUG_VALUE_LIGHTNESS.length];
    result.push(hslToRgb(hue, DEBUG_VALUE_SATURATION, lightness));
  }
  return result;
}

export function buildPalette(count: number): number[] {
  const S = 0.65;
  const result: number[] = [];
  let usedHues: number[] = [];
  let currentPass = 0;

  for (let i = 0; i < count; i++) {
    const pass = Math.floor(i / HUE_PALETTE.length);
    if (pass !== currentPass) {
      usedHues = [];
      currentPass = pass;
    }
    const L = LIGHTNESS_PASSES[pass % LIGHTNESS_PASSES.length];

    let best = HUE_PALETTE[0];
    let bestDist = -1;
    for (const candidate of HUE_PALETTE) {
      const minDist = usedHues.reduce((d, u) => {
        const diff = Math.abs(candidate - u);
        return Math.min(d, diff, 360 - diff);
      }, 360);
      if (minDist > bestDist) {
        bestDist = minDist;
        best = candidate;
      }
    }

    usedHues.push(best);
    result.push(hslToRgb(best, S, L));
  }

  return result;
}
