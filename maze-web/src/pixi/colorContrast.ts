/** Perceptual color-distance helpers for export-renderer presentation warnings. */

function channel(color: number, shift: number): number {
  return (color >> shift) & 0xff;
}

function linearRgb(color: number): [number, number, number] {
  const linear = (value: number) => {
    const srgb = value / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return [linear(channel(color, 16)), linear(channel(color, 8)), linear(channel(color, 0))];
}

/** Convert an sRGB color to the perceptually-oriented OKLab color space. */
export function rgbToOklab(color: number): [number, number, number] {
  const [r, g, b] = linearRgb(color);
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const cubeRoot = (value: number) => Math.cbrt(value);
  const lRoot = cubeRoot(l);
  const mRoot = cubeRoot(m);
  const sRoot = cubeRoot(s);
  return [
    0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot,
    1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot,
    0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot,
  ];
}

/** Euclidean distance in OKLab; unlike luminance alone it also distinguishes hue differences. */
export function perceptualColorDistance(a: number, b: number): number {
  const [l1, a1, b1] = rgbToOklab(a);
  const [l2, a2, b2] = rgbToOklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

// Only very small OKLab distances are considered indistinguishable for the large shapes and
// markers used by export renderers. This intentionally minimizes false positives.
export const EXPORT_WARNING_COLOR_DISTANCE_THRESHOLD = 0.04;

export function hasLowContrast(foreground: number, background: number): boolean {
  return perceptualColorDistance(foreground, background) < EXPORT_WARNING_COLOR_DISTANCE_THRESHOLD;
}
