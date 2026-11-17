import { type LabelFont, isMsdfFamily, MSDF_FONTS } from "../pixi/renderers/fontChoice";
import * as m from "~/paraglide/messages";

/** Localized name of a CSS font weight ("Bold"); the bare number for a weight outside the 100..900 scale. */
export function fontWeightName(weight: number): string {
  switch (weight) {
    case 100: return m["font_picker.weight_100"]();
    case 200: return m["font_picker.weight_200"]();
    case 300: return m["font_picker.weight_300"]();
    case 400: return m["font_picker.weight_400"]();
    case 500: return m["font_picker.weight_500"]();
    case 600: return m["font_picker.weight_600"]();
    case 700: return m["font_picker.weight_700"]();
    case 800: return m["font_picker.weight_800"]();
    case 900: return m["font_picker.weight_900"]();
    default: return String(weight);
  }
}

/** Display name of a stored font family: the baked font's own name, or the browser family itself. */
function fontFamilyName(family: string): string {
  return isMsdfFamily(family) ? MSDF_FONTS[family].label : family;
}

/** "Roboto, Bold" — a font choice as the settings and the parameter-links dialog show it. */
export function formatLabelFont(font: LabelFont): string {
  return `${fontFamilyName(font.family)}, ${fontWeightName(font.weight)}`;
}
