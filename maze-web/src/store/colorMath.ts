/** Conversions between a packed 24-bit RGB number (the app's canonical color representation, e.g.
 *  `0x336699`) and the RGB/HSL/OKLCH color models, plus the `#rrggbb` hex string. No React/component
 *  dependency — lives in `store/` so both the color picker UI (`components/colorFormat.ts` re-
 *  exports this module) and the parameter-links engine (`parameterLinks.ts`'s per-channel color
 *  modifiers, GitHub issue #647) can use the same math without `store/` reaching into `components/`. */

/** 6-hex-digit color with an optional leading `#`. */
export const HEX_COLOR_RE = /^#?[0-9a-fA-F]{6}$/;

export function colorToHex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

/** Parse a string that matches `HEX_COLOR_RE`; behavior is undefined for other input. */
export function hexToColor(hex: string): number {
  return parseInt(hex.replace("#", ""), 16);
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Unpack a 24-bit RGB number into its three 0-255 channels. */
export function colorToRgb(color: number): Rgb {
  return {
    r: (color >> 16) & 0xff,
    g: (color >> 8) & 0xff,
    b: color & 0xff,
  };
}

/** Pack three channels into a 24-bit RGB number; each channel is clamped to 0-255 and rounded. */
export function rgbToColor({ r, g, b }: Rgb): number {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return (clamp(r) << 16) | (clamp(g) << 8) | clamp(b);
}

export interface Hsl {
  /** Hue in degrees, 0-360. */
  h: number;
  /** Saturation, 0-100. */
  s: number;
  /** Lightness, 0-100. */
  l: number;
}

/** Exact sRGB HSL from a packed 24-bit RGB number. For achromatic colors hue is reported as 0. */
export function colorToHsl(color: number): Hsl {
  const { r, g, b } = colorToRgb(color);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;

  let h = 0;
  let s = 0;
  if (delta !== 0) {
    s = delta / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case rn:
        h = ((gn - bn) / delta) % 6;
        break;
      case gn:
        h = (bn - rn) / delta + 2;
        break;
      default:
        h = (rn - gn) / delta + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }

  return { h, s: s * 100, l: l * 100 };
}

/** Pack an HSL triple into a 24-bit RGB number. `h` wraps mod 360; `s` / `l` clamp to 0-100. */
export function hslToColor({ h, s, l }: Hsl): number {
  const hn = ((h % 360) + 360) % 360;
  const sn = Math.max(0, Math.min(100, s)) / 100;
  const ln = Math.max(0, Math.min(100, l)) / 100;

  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const mm = ln - c / 2;

  let rn = 0;
  let gn = 0;
  let bn = 0;
  if (hn < 60) [rn, gn, bn] = [c, x, 0];
  else if (hn < 120) [rn, gn, bn] = [x, c, 0];
  else if (hn < 180) [rn, gn, bn] = [0, c, x];
  else if (hn < 240) [rn, gn, bn] = [0, x, c];
  else if (hn < 300) [rn, gn, bn] = [x, 0, c];
  else [rn, gn, bn] = [c, 0, x];

  return rgbToColor({ r: (rn + mm) * 255, g: (gn + mm) * 255, b: (bn + mm) * 255 });
}

export interface Oklch {
  /** Perceived lightness, 0-100 (%). */
  l: number;
  /** Chroma, 0+. `OKLCH_MAX_CHROMA` is the picker's UI upper bound; sRGB colors sit under ~0.32. */
  c: number;
  /** Hue in degrees, 0-360. */
  h: number;
}

/** Largest chroma the OKLCH slider / numeric inputs allow (issue #502). OKLCH can address colors
 *  well outside sRGB, but past this the picker offers nothing useful (real sRGB colors sit under
 *  ~0.32). Drives the C slider / input range, the 2D area's C axis, and the gamut-boundary search. */
export const OKLCH_MAX_CHROMA = 0.4;

// --- sRGB transfer function (CSS Color 4 / IEC 61966-2-1) ---

function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

// --- linear sRGB <-> OKLab (Bjorn Ottosson, https://bottosson.github.io/posts/oklab/) ---

interface LinearRgb {
  r: number;
  g: number;
  b: number;
}

function linearRgbToOklab({ r, g, b }: LinearRgb): { L: number; a: number; bb: number } {
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    bb: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

function oklabToLinearRgb(L: number, a: number, bb: number): LinearRgb {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * bb;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * bb;
  const s_ = L - 0.0894841775 * a - 1.291485548 * bb;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

const EPS = 1e-4;

/** Convert an OKLCH triple to linear sRGB (channels may fall outside 0-1 when the color is out of
 *  the sRGB gamut). */
function oklchToLinearRgb({ l, c, h }: Oklch): LinearRgb {
  const L = l / 100;
  const hr = (h * Math.PI) / 180;
  return oklabToLinearRgb(L, c * Math.cos(hr), c * Math.sin(hr));
}

/** True when the OKLCH color lies inside the sRGB gamut (every linear channel within [0, 1]). */
export function oklchInSrgb(oklch: Oklch): boolean {
  const { r, g, b } = oklchToLinearRgb(oklch);
  return (
    r >= -EPS && r <= 1 + EPS && g >= -EPS && g <= 1 + EPS && b >= -EPS && b <= 1 + EPS
  );
}

/** Largest chroma that keeps `(l, h)` inside the sRGB gamut, found by bisection. Used to mark the
 *  out-of-gamut region on the C slider track. Returns 0 for an achromatic `l` at the extremes. */
export function oklchMaxChroma(l: number, h: number): number {
  if (oklchInSrgb({ l, c: OKLCH_MAX_CHROMA, h })) return OKLCH_MAX_CHROMA;
  let lo = 0;
  let hi = OKLCH_MAX_CHROMA;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (oklchInSrgb({ l, c: mid, h })) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Gamut-clamped sRGB bytes for an OKLCH triple. Feeds the OKLCH 2D area's per-pixel paint — every
 *  cell is just its clamped color; the out-of-gamut region is marked on the C slider track, not
 *  in the area. */
export function oklchToSrgbSample({ l, c, h }: Oklch): { r: number; g: number; b: number } {
  const lin = oklchToLinearRgb({ l, c, h });
  const to = (v: number) => Math.round(linearToSrgb(Math.max(0, Math.min(1, v))) * 255);
  return { r: to(lin.r), g: to(lin.g), b: to(lin.b) };
}

/** Exact OKLCH from a packed 24-bit RGB number. Achromatic colors report `h = 0`. */
export function colorToOklch(color: number): Oklch {
  const { r, g, b } = colorToRgb(color);
  const lin = {
    r: srgbToLinear(r / 255),
    g: srgbToLinear(g / 255),
    b: srgbToLinear(b / 255),
  };
  const { L, a, bb } = linearRgbToOklab(lin);
  const c = Math.sqrt(a * a + bb * bb);
  let h = 0;
  if (c > EPS) {
    h = (Math.atan2(bb, a) * 180) / Math.PI;
    if (h < 0) h += 360;
  }
  return { l: L * 100, c, h };
}

/** Pack an OKLCH triple into a 24-bit RGB number, gamut-clamped to sRGB. `l` clamps to 0-100, `c`
 *  to 0+, `h` wraps mod 360; the resulting sRGB channels are clamped to 0-255 by `rgbToColor`. */
export function oklchToColor({ l, c, h }: Oklch): number {
  const ln = Math.max(0, Math.min(100, l));
  const cn = Math.max(0, c);
  const hn = ((h % 360) + 360) % 360;
  const lin = oklchToLinearRgb({ l: ln, c: cn, h: hn });
  return rgbToColor({
    r: linearToSrgb(Math.max(0, Math.min(1, lin.r))) * 255,
    g: linearToSrgb(Math.max(0, Math.min(1, lin.g))) * 255,
    b: linearToSrgb(Math.max(0, Math.min(1, lin.b))) * 255,
  });
}
