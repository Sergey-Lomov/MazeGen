import { Assets } from "pixi.js";
import { LABEL_FONT_LOADED_EVENT, MSDF_FONTS, hasMsdfFamilyAtlases, isMsdfFamily, markMsdfFamilyLoaded } from "./fontChoice";

/** On-demand loading of the baked MSDF atlases (GitHub issue #982). A font's atlases are downloaded and
 *  decoded the first time the font is needed (picked in the font picker, referenced by an opened project,
 *  previewed), never at startup, except the default Roboto that `App.tsx` awaits. */

/** In-flight loads by family, so concurrent requests share one download. A settled load leaves the map:
 *  a success is remembered by `markMsdfFamilyLoaded`, a failure may be retried by a later request. */
const loading = new Map<string, Promise<boolean>>();

/** Loads and installs every atlas of the baked font `family` so `BitmapText` can reference them by
 *  `atlasName`. Resolves to `true` once the font can be drawn and to `false` for an unknown family or a
 *  failed download (the font then keeps rendering as the default one); it never rejects. A newly loaded
 *  font announces itself with `LABEL_FONT_LOADED_EVENT`, like a browser font. */
export function loadMsdfFamily(family: string): Promise<boolean> {
  if (!isMsdfFamily(family)) return Promise.resolve(false);
  if (hasMsdfFamilyAtlases(family)) return Promise.resolve(true);
  const inFlight = loading.get(family);
  if (inFlight) return inFlight;
  const request = Promise.all(MSDF_FONTS[family].faces.map((face) => Assets.load(face.url)))
    .then(() => {
      markMsdfFamilyLoaded(family);
      if (typeof window !== "undefined") window.dispatchEvent(new Event(LABEL_FONT_LOADED_EVENT));
      return true;
    })
    .catch(() => false)
    .finally(() => { loading.delete(family); });
  loading.set(family, request);
  return request;
}
