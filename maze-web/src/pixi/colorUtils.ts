// Node rendering
export const NODE_RADIUS = 6;
export const NODE_COLOR = 0x4a9eff;
export const NODE_HOVER_COLOR = 0xff9f4a;
export const NODE_SELECTED_COLOR = 0xff4a4a;
export const NODE_START_COLOR = 0x44dd88;
export const NODE_FINISH_COLOR = 0xdd4466;

// Edge rendering
export const EDGE_COLOR = 0x888888;

// Wall rendering
export const WALL_COLOR = 0xcccccc;
export const WALL_COLOR_UNDECIDED = 0x666666;
export const WALL_THICKNESS = 3;

// Floor rendering
export const FLOOR_COLOR = 0x2a2a2a;

// Pixi stage/canvas background color (outside any field/floor area)
export const STAGE_BACKGROUND_COLOR = 0x111111;

// One-way passage marker
export const ONE_WAY_COLOR = 0xffaa00;

// Lock icon
export const LOCK_COLOR = 0x888888;

// Invalid preset highlight
export const INVALID_COLOR = 0xddaa00;

// Hover highlight
export const HOVER_COLOR = 0x44aaff;

// Grid overlay
export const GRID_LINE_COLOR = 0x383838;
export const GRID_LINE_ALPHA = 1.0;

// Origin crosshair
export const ORIGIN_COLOR = 0xff6600;
export const ORIGIN_ALPHA = 0.9;

// Field editor active cell
export const ACTIVE_CELL_COLOR = 0x666666;
export const ACTIVE_CELL_ALPHA = 0.7;

// Component overlay
export const COMPONENT_MASK_ALPHA = 0.45;

// Debug overlay
export const DEBUG_ACTIVE_COLOR = 0x4488ff;
export const DEBUG_CURRENT_SRC_COLOR = 0xcccc22;
export const DEBUG_ACTIVE_ALPHA = 0.5;

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
