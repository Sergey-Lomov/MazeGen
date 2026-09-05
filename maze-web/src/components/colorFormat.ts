/** Conversions between a packed 24-bit RGB number (the app's canonical color representation, e.g.
 *  `0x336699`) and a `#rrggbb` CSS hex string. Shared by `ColorSwatch` and `ColorPickerPanel`. */

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
