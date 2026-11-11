import { BitmapText, Text } from "pixi.js";

/** Runtime local-font support for issue #740. An empty or unavailable family deliberately uses
 * the bundled MSDF Roboto, which remains the portable project-file fallback. */
const loadedFamilies = new Set<string>();
const loadingFamilies = new Map<string, Promise<boolean>>();
/** Canvas-backed labels use a fixed, bounded density. They intentionally rasterize like ordinary
 * text and may soften when enlarged; this avoids zoom-driven texture allocation and GPU churn. */
const MAX_RUNTIME_TEXT_RESOLUTION = 2;

/** CSS Font Loading reports the fallback face as usable for an unknown family. Comparing a long
 * probe string against generic fallback faces prevents that false positive, so a saved typo still
 * resolves to the bundled MSDF Roboto rather than the browser's arbitrary sans-serif fallback. */
function hasDistinctGlyphMetrics(family: string): boolean {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return false;
  const probe = "Wm@#0123456789ЖЩ字🙂";
  const width = (font: string) => { context.font = font; return context.measureText(probe).width; };
  const candidate = width(`16px ${JSON.stringify(family)}, monospace`);
  // A missing family resolves to one of the generic fallbacks. It is genuine only when its
  // metrics differ from every one of them; `some` would accept a missing family that fell back
  // to monospace merely because monospace and sans-serif differ from each other.
  return ["monospace", "sans-serif", "serif"].every((fallback) => Math.abs(candidate - width(`16px ${fallback}`)) > 0.01);
}

let localFamiliesPromise: Promise<string[] | null> | null = null;

type LocalFontQuery = () => Promise<Array<{ family: string }>>;
const localFontQuery = (): LocalFontQuery | undefined => (typeof window === "undefined" ? undefined : (window as Window & { queryLocalFonts?: LocalFontQuery }).queryLocalFonts);

/** Whether the browser has the Local Font Access API at all (Chromium only). */
export function isLocalFontAccessSupported(): boolean {
  return !!localFontQuery();
}

/** Every font family installed on this machine, sorted, via the Local Font Access API. Resolves to
 * `null` when the browser has no such API or the user denied access. Cached for the page lifetime;
 * `retry` drops a cached failure and asks again, which re-prompts unless the browser has already
 * blocked the site. Call it from a user gesture. */
export function loadLocalFontFamilies(retry = false): Promise<string[] | null> {
  if (retry) localFamiliesPromise = null;
  if (!localFamiliesPromise) {
    const query = localFontQuery();
    localFamiliesPromise = query
      ? query.call(window).then((fonts) => [...new Set(fonts.map((font) => font.family.trim()).filter(Boolean))].sort()).catch(() => null)
      : Promise.resolve(null);
  }
  return localFamiliesPromise;
}

/** Whether a font family is actually installed on this machine: its glyph metrics differ from every
 * generic fallback. Synchronous, so a candidate list can be filtered without loading each font. */
export function isFontFamilyInstalled(family: string): boolean {
  return typeof document !== "undefined" && hasDistinctGlyphMetrics(family);
}

export function isLabelFontFamilyLoaded(family: string | undefined): boolean {
  return !!family?.trim() && loadedFamilies.has(family.trim());
}

/** Wait until a browser font can be measured before allowing it onto the canvas. */
export async function loadLabelFontFamily(family: string): Promise<boolean> {
  const normalized = family.trim();
  if (!normalized) return true;
  if (loadedFamilies.has(normalized)) return true;
  if (typeof document === "undefined" || !document.fonts) return false;
  const inFlight = loadingFamilies.get(normalized);
  if (inFlight) return inFlight;
  const loading = (async () => {
    try {
      const familyCss = JSON.stringify(normalized);
      // A canvas text texture is immutable until rebuilt. Load both faces before the family becomes
      // active so Pixi never bakes the bold label from a late regular/fallback face.
      await Promise.all([
        document.fonts.load(`400 16px ${familyCss}`),
        document.fonts.load(`700 16px ${familyCss}`),
      ]);
      if (!document.fonts.check(`400 16px ${familyCss}`) || !document.fonts.check(`700 16px ${familyCss}`)) return false;
      if (!hasDistinctGlyphMetrics(normalized)) return false;
      loadedFamilies.add(normalized);
      if (typeof window !== "undefined") window.dispatchEvent(new Event("mazegen:label-font-loaded"));
      return true;
    } catch {
      return false;
    }
  })();
  loadingFamilies.set(normalized, loading);
  void loading.finally(() => {
    if (loadingFamilies.get(normalized) === loading) loadingFamilies.delete(normalized);
  });
  return loading;
}

export function makeLabelText(text: string, msdfFamily: string, fontSize: number, fill: number, fontWeight: "normal" | "bold", requestedFamily?: string) {
  const family = isLabelFontFamilyLoaded(requestedFamily) ? requestedFamily!.trim() : null;
  const resolution = Math.min(MAX_RUNTIME_TEXT_RESOLUTION, Math.max(1, window.devicePixelRatio || 1));
  const label = family
    // `Text` otherwise defaults to a 1x canvas texture. The application canvas uses the device
    // pixel ratio, so matching it prevents a 1x label from being stretched and blurred at 100%.
    ? new Text({ text, style: { fontFamily: family, fontSize, fontWeight: fontWeight === "bold" ? "700" : "400", fontStyle: "normal", fill }, resolution })
    : new BitmapText({ text, style: { fontFamily: msdfFamily, fontSize, fill } });
  label.anchor.set(0.5);
  label.roundPixels = true;
  return label;
}
