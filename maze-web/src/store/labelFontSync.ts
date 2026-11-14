import type { StoreApi } from "zustand";
import type { MazeStore } from "./storeTypes";
import { VECTOR_FONT_FAMILY, convertsToMsdf, isMsdfFamily, type LabelFont } from "../pixi/renderers/fontChoice";
import { loadMsdfFamily } from "../pixi/renderers/msdfLoader";
import { loadRasterFont, pruneRasterFonts } from "../pixi/renderers/rasterFont/rasterMsdf";
import { restoreUploadedFonts, subscribeRasterFonts } from "../pixi/renderers/rasterFont/rasterFontStore";
import { isFontPickerOpen, subscribeFontPicker } from "../pixi/renderers/rasterFont/pickerSession";

/** Fonts found under each settings node. Settings are updated immutably, so a subtree that did
 *  not change keeps its identity and is answered from here: a settings change that touches one slider
 *  re-walks only the path to it, not the whole tree (manual connector paths can be large). */
const fontsUnder = new WeakMap<object, readonly LabelFont[]>();

/** Every distinct `LabelFont` (`{ family, weight }`) inside `value`, a plain, immutably updated
 *  settings tree, keyed `weight|family`. The default font is the empty family. */
export function collectLabelFonts(value: unknown, into: Map<string, LabelFont> = new Map()): Map<string, LabelFont> {
  if (typeof value !== "object" || value === null) return into;
  let found = fontsUnder.get(value);
  if (!found) {
    const { family, weight, msdf } = value as { family?: unknown; weight?: unknown; msdf?: unknown };
    if (typeof family === "string" && typeof weight === "number") {
      found = [msdf === false ? { family, weight, msdf: false } : { family, weight }];
    } else {
      const children = new Map<string, LabelFont>();
      for (const child of Object.values(value)) collectLabelFonts(child, children);
      found = [...children.values()];
    }
    fontsUnder.set(value, found);
  }
  for (const font of found) {
    const key = `${font.weight}|${font.family}`;
    // Two texts may name one font with and without conversion: the converting one wins, since its atlas is needed.
    const known = into.get(key);
    if (!known || !convertsToMsdf(known)) into.set(key, font);
  }
  return into;
}

/** Families of every `LabelFont` inside `value`. The default font is the empty family. */
export function collectLabelFontFamilies(value: unknown, into: Set<string> = new Set()): Set<string> {
  for (const font of collectLabelFonts(value).values()) into.add(font.family);
  return into;
}

/** Families of the on-demand MSDF fonts (everything but the default Roboto, which is always loaded)
 *  named by any `LabelFont` inside `value`. */
export function collectLazyMsdfFamilies(value: unknown, into: Set<string> = new Set()): Set<string> {
  for (const family of collectLabelFontFamilies(value)) {
    if (family !== VECTOR_FONT_FAMILY && isMsdfFamily(family)) into.add(family);
  }
  return into;
}

/** The export settings that hold label fonts: what a font counts as "used in the project" by. */
export function projectFontSettings(state: MazeStore): unknown[] {
  return [state.vectorByWallsSettings, state.vectorByCorridorsSettings, state.pngExportSettings];
}

/** Starts the work for the fonts the export settings reference and frees the ones they no longer do. Settings arrive from a
 *  project file, a visual preset, a shared-style link or a picker, and none of those is guaranteed to render a
 *  font row, so the work is tied to the settings themselves: whatever puts a font name into them starts its
 *  download (GitHub issue #982) or its MSDF conversion (GitHub issue #966), and labels switch from the default
 *  font once it lands. A baked family is requested once from here; a failed download falls back to the default
 *  font and is retried by a later pick. A raster font may only be readable once the local font list or the
 *  uploaded fonts arrive, so it is requested again when they change. While a font picker is open the settings
 *  hold previews, which are drawn by canvas text and never converted: the conversion of the font that stays
 *  starts when the picker closes. Dynamic atlases no project text uses are freed (`pruneRasterFonts`). */
export function installLabelFontSync(store: StoreApi<MazeStore>): void {
  const requested = new Set<string>();
  const request = (state: MazeStore) => {
    const previewing = isFontPickerOpen();
    const fonts = collectLabelFonts(projectFontSettings(state));
    for (const font of fonts.values()) {
      if (font.family === VECTOR_FONT_FAMILY) continue;
      if (isMsdfFamily(font.family)) {
        if (requested.has(font.family)) continue;
        requested.add(font.family);
        void loadMsdfFamily(font.family);
      } else if (!previewing && convertsToMsdf(font)) {
        void loadRasterFont(font);
      }
    }
    if (!previewing) pruneRasterFonts(new Set([...fonts].filter(([, font]) => convertsToMsdf(font)).map(([key]) => key)));
  };
  store.subscribe((state, prev) => {
    if (
      state.vectorByWallsSettings === prev.vectorByWallsSettings
      && state.vectorByCorridorsSettings === prev.vectorByCorridorsSettings
      && state.pngExportSettings === prev.pngExportSettings
    ) return;
    request(state);
  });
  // A project font may be an uploaded one from an earlier session, or an installed one the machine reports
  // only once the user grants the permission: request again when the sources change.
  let running = false;
  const refresh = () => {
    if (running) return;
    running = true;
    try { request(store.getState()); } finally { running = false; }
  };
  subscribeRasterFonts(refresh);
  subscribeFontPicker(refresh);
  void restoreUploadedFonts().then(refresh);
  request(store.getState());
}
