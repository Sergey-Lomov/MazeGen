/** A label font choice (GitHub issue #973): the family and the weight are one value, because the
 *  weights a font offers depend on the font. `family` is the empty string for the bundled vector
 *  (MSDF) Roboto and a browser font family name otherwise; `weight` is a CSS weight (100..900). */
export interface LabelFont {
  family: string;
  weight: number;
}

/** Family value that stands for the bundled MSDF Roboto in every font field. */
const VECTOR_FONT_FAMILY = "";

const DEFAULT_LABEL_WEIGHT = 700;

/** The font every text style starts with: bundled Roboto, bold. */
export const DEFAULT_LABEL_FONT: LabelFont = { family: VECTOR_FONT_FAMILY, weight: DEFAULT_LABEL_WEIGHT };

/** CSS weights a font can offer, ascending. */
export const CSS_FONT_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

export function labelFontEquals(a: LabelFont, b: LabelFont): boolean {
  return a.family === b.family && a.weight === b.weight;
}

/** A detached copy of `font`. A selector that computes under `trackedMemo` reads settings through a
 *  tracking view and must not put a view into its result, so it copies the font object with this. */
export function plainLabelFont(font: LabelFont): LabelFont {
  return { family: font.family, weight: font.weight };
}

/** The offered weight closest to `weight`; the heavier one wins a tie. Falls back to `weight`
 *  itself when the list is empty. */
export function nearestWeight(weight: number, offered: readonly number[]): number {
  let best: number | null = null;
  for (const candidate of offered) {
    if (best === null || Math.abs(candidate - weight) < Math.abs(best - weight)
      || (Math.abs(candidate - weight) === Math.abs(best - weight) && candidate > best)) best = candidate;
  }
  return best ?? weight;
}

/** One baked MSDF atlas: the weight it draws, its `BitmapText` `fontFamily` (the `face` recorded in the
 *  atlas, its source font-face name) and the descriptor path relative to the served root. */
export interface MsdfFace {
  weight: number;
  atlasName: string;
  url: string;
}

/** The baked MSDF fonts, keyed by stored family. Each font lists the weights it was baked with, so a
 *  font baked with other weights only needs another entry here (and its atlases from
 *  `tools/msdf/generate.mjs`); the picker offers exactly these weights. */
export const MSDF_FONTS: Record<string, { label: string; faces: MsdfFace[] }> = {
  [VECTOR_FONT_FAMILY]: {
    label: "Roboto",
    faces: [
      { weight: 400, atlasName: "Roboto-Regular", url: "/fonts/roboto-regular-msdf.fnt" },
      { weight: 700, atlasName: "Roboto-Bold", url: "/fonts/roboto-bold-msdf.fnt" },
    ],
  },
};

/** Whether a stored family is a baked MSDF font (as opposed to a browser font). */
export function isMsdfFamily(family: string): boolean {
  return Object.prototype.hasOwnProperty.call(MSDF_FONTS, family);
}

/** Weights the baked font `family` offers, ascending. */
export function msdfFontWeights(family: string): number[] {
  return (MSDF_FONTS[family] ?? MSDF_FONTS[VECTOR_FONT_FAMILY]).faces.map((face) => face.weight).sort((a, b) => a - b);
}

/** The atlas that draws `font` in MSDF: the font's face with the nearest baked weight. An unknown
 *  family (a browser font that did not load) renders as the default MSDF font. */
export function msdfFace(font: LabelFont): MsdfFace {
  const faces = (MSDF_FONTS[font.family] ?? MSDF_FONTS[VECTOR_FONT_FAMILY]).faces;
  const weight = nearestWeight(font.weight, faces.map((face) => face.weight));
  return faces.find((face) => face.weight === weight)!;
}

/** Parse the weight a Local Font Access `style` name stands for ("Bold", "Semibold", "Light Italic").
 *  `null` for an italic or oblique face and for any other style (Condensed, Narrow, ...): a font
 *  value can only address a normal-style, normal-width face. */
export function weightFromStyleName(style: string): number | null {
  const words = style.toLowerCase().replace(/[-_]/g, " ").split(/\s+/).filter(Boolean);
  if (words.some((word) => word === "italic" || word === "oblique" || word === "slanted")) return null;
  const name = words.join("");
  if (name === "") return 400;
  const byName: Record<string, number> = {
    thin: 100, hairline: 100,
    extralight: 200, ultralight: 200,
    light: 300,
    regular: 400, normal: 400, book: 400, roman: 400,
    medium: 500,
    semibold: 600, demibold: 600, demi: 600,
    bold: 700,
    extrabold: 800, ultrabold: 800,
    black: 900, heavy: 900,
  };
  return byName[name] ?? null;
}
