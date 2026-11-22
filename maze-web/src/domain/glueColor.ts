import { HUE_GROUP_LIGHTNESS_STEP, hueGroupColors } from "./colorMath";
import { AUTO_HUE_BASE_COLOR, GLUE_HOVER_LIGHTNESS } from "./renderConstants";

/// How many colours one round of the automatic palette of glues and zones holds. The round is spread over all of them at
/// once, whatever number of glues (zones) exists, so adding one never changes the colours of the others.
export const AUTO_COLOR_COUNT = 8;

/// Position of round `round` off the base colour in the group scheme of `hueGroupColors`: 0, +1, -1, +2, -2, ... The
/// first round is the base itself and later ones are not centred on it, so adding a round never changes an earlier one.
function roundPosition(round: number): number {
  return Math.ceil(round / 2) * (round % 2 === 1 ? 1 : -1);
}

/// The colour of glue `index`: `AUTO_HUE_BASE_COLOR` with its hue spread evenly round the wheel over `AUTO_COLOR_COUNT`
/// colours (`hueGroupColors`); each further round of `AUTO_COLOR_COUNT` is a group shifted in lightness and hue. A hovered glue is lighter.
export function glueColor(index: number, hovered = false): number {
  return autoPalette(Math.floor(index / AUTO_COLOR_COUNT), hovered)[index % AUTO_COLOR_COUNT];
}

/// The widest lightness range, either side of the base colour, a set of colours whose size is known may use: past it
/// the lightest rounds turn white and the darkest black, and the colours stop being told apart.
const MAX_LIGHTNESS_SPAN = 30;

/// The colour of item `index` among `total` that are all coloured at once (the automatic zones, whose number is known
/// from the start). Up to `AUTO_COLOR_COUNT` * 3 items it is `glueColor`. Beyond that the rounds are squeezed: their
/// lightness step shrinks so the farthest round stays within `MAX_LIGHTNESS_SPAN` of the base, and their hue shift
/// shrinks so that no two rounds fall on the same hues. Colours change when `total` crosses such a bound.
export function autoColorAmong(index: number, total: number): number {
  const farthest = Math.ceil((Math.ceil(total / AUTO_COLOR_COUNT) - 1) / 2);
  if (farthest <= 1) return glueColor(index);
  const round = Math.floor(index / AUTO_COLOR_COUNT);
  const key = `${round}:squeezed:${farthest}`;
  let palette = cachedPalettes.get(key);
  if (!palette) {
    const steps = { lightness: Math.min(HUE_GROUP_LIGHTNESS_STEP, MAX_LIGHTNESS_SPAN / farthest), hue: 45 / (2 * farthest + 1) };
    palette = hueGroupColors(AUTO_HUE_BASE_COLOR, AUTO_COLOR_COUNT, roundPosition(round), 0, steps);
    cachedPalettes.set(key, palette);
  }
  return palette[index % AUTO_COLOR_COUNT];
}

/// The rounds' palettes, cached (a redraw asks for the same distribution once per arrow).
const cachedPalettes = new Map<string, number[]>();
function autoPalette(round: number, hovered: boolean): number[] {
  const key = `${round}:${hovered}`;
  let palette = cachedPalettes.get(key);
  if (!palette) {
    palette = hueGroupColors(AUTO_HUE_BASE_COLOR, AUTO_COLOR_COUNT, roundPosition(round), hovered ? GLUE_HOVER_LIGHTNESS : 0);
    cachedPalettes.set(key, palette);
  }
  return palette;
}
