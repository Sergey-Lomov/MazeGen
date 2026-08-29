import type { TextStyleFontWeight } from "pixi.js";

/** Label numbering style shared by elevator floor-number badges (GitHub issue #430) and marker
 *  index labels (GitHub issue #471). "roman" tends to stay legible at small font sizes. */
export type IndexLabelStyle = "arabic" | "roman" | "letters";

/** Font weight choice for a label, shared by the same two features. */
export type LabelFontWeight = "regular" | "bold";

export const LABEL_FONT_WEIGHTS: Record<LabelFontWeight, TextStyleFontWeight> = {
  regular: "normal",
  bold: "bold",
};

const ROMAN_VALUES: [number, string][] = [
  [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
  [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
  [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
];

export function toRoman(n: number): string {
  let remaining = n;
  let result = "";
  for (const [value, symbol] of ROMAN_VALUES) {
    while (remaining >= value) {
      result += symbol;
      remaining -= value;
    }
  }
  return result;
}

/** Spreadsheet-style base-26 letters (`A`, ..., `Z`, `AA`, `AB`, ...) — `n` is 1-based. */
export function toLetters(n: number): string {
  let remaining = n;
  let result = "";
  while (remaining > 0) {
    const rem = (remaining - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return result;
}

/** Formats a 0-based index as its label — displayed as `index + 1` (1-based). Roman numerals and
 *  letters only have a "1 and up" convention; `index + 1 <= 0` falls back to the Arabic digit for
 *  those two styles rather than producing an empty/invalid string. */
export function formatIndexLabel(index0Based: number, style: IndexLabelStyle): string {
  const n = index0Based + 1;
  if (style === "roman") return n >= 1 ? toRoman(n) : String(n);
  if (style === "letters") return n >= 1 ? toLetters(n) : String(n);
  return String(n);
}
