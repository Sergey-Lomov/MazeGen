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
