import { hueGroupColors } from "./colorMath";
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
