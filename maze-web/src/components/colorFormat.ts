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
