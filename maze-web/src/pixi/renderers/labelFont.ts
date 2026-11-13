import { BitmapText, Text } from "pixi.js";
import { CSS_FONT_WEIGHTS, LABEL_FONT_LOADED_EVENT, isMsdfFamily, msdfFace, weightFromStyleName, type LabelFont } from "./fontChoice";
import { loadMsdfFamily } from "./msdfLoader";

/** Runtime local-font support for issue #740. An empty or unavailable family deliberately uses
 * the bundled MSDF Roboto, which remains the portable project-file fallback. */
const loadedFonts = new Set<string>();
const loadingFonts = new Map<string, Promise<boolean>>();
const fontKey = (family: string, weight: number) => `${weight}|${family}`;
/** Canvas-backed labels use a fixed, bounded density. They intentionally rasterize like ordinary
 * text and may soften when enlarged; this avoids zoom-driven texture allocation and GPU churn. */
const MAX_RUNTIME_TEXT_RESOLUTION = 2;

let sharedMeasureContext: CanvasRenderingContext2D | null | undefined;

/** One scratch 2D context for every glyph probe: the picker probes each installed family, and a canvas
 *  per probe would be created hundreds of times when it opens. */
function measureContext(): CanvasRenderingContext2D | null {
  if (sharedMeasureContext === undefined) sharedMeasureContext = document.createElement("canvas").getContext("2d");
  return sharedMeasureContext;
}

/** CSS Font Loading reports the fallback face as usable for an unknown family. Comparing a long
 * probe string against generic fallback faces prevents that false positive, so a saved typo still
 * resolves to the bundled MSDF Roboto rather than the browser's arbitrary sans-serif fallback. */
function hasDistinctGlyphMetrics(family: string, probes: readonly string[] = PROBES): boolean {
  const context = measureContext();
  if (!context) return false;
  const width = (font: string, probe: string) => { context.font = font; return context.measureText(probe).width; };
  // A font may cover only one script (a Cyrillic-only or runic face renders Latin through the
  // fallback), so each script is probed on its own and one distinct probe is enough.
  return probes.some((probe) => {
    const candidate = width(`16px ${JSON.stringify(family)}, monospace`, probe);
    // A missing family resolves to one of the generic fallbacks. It is genuine only when its
    // metrics differ from every one of them; `some` would accept a missing family that fell back
    // to monospace merely because monospace and sans-serif differ from each other.
    return ["monospace", "sans-serif", "serif"].every((fallback) => Math.abs(candidate - width(`16px ${fallback}`, probe)) > 0.01);
  });
}

const PROBES = ["Wm@#0123456789", "ЖЩшюЯ"];

const coverageCache = new Map<string, boolean>();

/** Whether the browser font `family` draws every glyph of `sample` itself (GitHub issue #984): a script
 *  the face lacks falls back to a generic font, so its metrics match one of them. Cached, since the
 *  picker asks it for every installed family. */
export function fontCoversSample(family: string, sample: string): boolean {
  if (typeof document === "undefined") return false;
  const key = `${sample}|${family}`;
  let covers = coverageCache.get(key);
  if (covers === undefined) {
    covers = hasDistinctGlyphMetrics(family, [sample]);
    coverageCache.set(key, covers);
  }
  return covers;
}

/** Font families, in order, for a browser font: the font itself, then the generic sans-serif. The one
 *  stack behind the canvas labels, their measuring and the font picker preview, so a glyph the chosen
 *  font lacks (Cyrillic in a Latin-only face) falls back to the same face in both. */
export function labelFontFamilies(family: string): string[] {
  const normalized = family.trim();
  return normalized ? [normalized, "sans-serif"] : ["sans-serif"];
}

/** `labelFontFamilies` as a CSS `font-family` / canvas `font` value. */
export function labelFontCss(family: string): string {
  return labelFontFamilies(family).map((name) => (name === "sans-serif" ? name : JSON.stringify(name))).join(", ");
}

let localFamiliesPromise: Promise<string[] | null> | null = null;
/** Families the machine reported through the Local Font Access API, once that query has resolved. An
 *  exact name here proves the font is installed even when its glyph metrics cannot be told apart
 *  from a generic fallback (a face that covers neither probe script). */
let reportedLocalFamilies: Set<string> | null = null;
/** Weights of each reported family's normal-style faces (`weightFromStyleName`), once the query has resolved. */
let reportedLocalWeights: Map<string, Set<number>> | null = null;

type LocalFontQuery = () => Promise<Array<{ family: string; style?: string }>>;
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
      ? query.call(window).then((fonts) => {
          const families = [...new Set(fonts.map((font) => font.family.trim()).filter(Boolean))].sort();
          reportedLocalFamilies = new Set(families);
          const weights = new Map<string, Set<number>>();
          for (const font of fonts) {
            const family = font.family.trim();
            const weight = weightFromStyleName(font.style ?? "");
            if (!family || weight === null) continue;
            if (!weights.has(family)) weights.set(family, new Set());
            weights.get(family)!.add(weight);
          }
          reportedLocalWeights = weights;
          return families;
        }).catch(() => null)
      : Promise.resolve(null);
  }
  return localFamiliesPromise;
}

/** Whether a font family is actually installed on this machine: its glyph metrics differ from every
 * generic fallback. Synchronous, so a candidate list can be filtered without loading each font. */
export function isFontFamilyInstalled(family: string): boolean {
  return typeof document !== "undefined" && (reportedLocalFamilies?.has(family) === true || hasDistinctGlyphMetrics(family));
}

/** Whether `font`'s browser face is loaded and may be drawn. The default MSDF font is never "loaded" in
 *  this sense: it is baked, so it needs no browser face. */
export function isLabelFontLoaded(font: LabelFont | undefined): boolean {
  return !!font?.family.trim() && loadedFonts.has(fontKey(font.family.trim(), font.weight));
}

/** Weights a browser font family offers, ascending (GitHub issue #973). With the Local Font Access
 *  API these are exactly the weights of the family's installed normal-style faces. Without it (or for
 *  a family the machine did not report) a face is offered only when the browser draws it visibly
 *  differently from regular, so the list is never larger than what the font provides: a regular face,
 *  plus bold when it has glyph metrics of its own. */
export function rasterFontWeights(family: string): number[] {
  const reported = reportedLocalWeights?.get(family.trim());
  if (reported && reported.size > 0) return CSS_FONT_WEIGHTS.filter((weight) => reported.has(weight));
  return typeof document !== "undefined" && hasDistinctBoldFace(family.trim()) ? [400, 700] : [400];
}

/** Whether `family` draws its bold weight with other metrics than its regular one, which tells a real
 *  bold face from the browser's synthesized one. Each probe script is tried; one difference is enough. */
function hasDistinctBoldFace(family: string): boolean {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return false;
  const width = (weight: number, probe: string) => { context.font = `${weight} 16px ${JSON.stringify(family)}, monospace`; return context.measureText(probe).width; };
  return PROBES.some((probe) => Math.abs(width(700, probe) - width(400, probe)) > 0.01);
}

/** Wait until a font can be drawn before allowing it onto the canvas: a browser font is measurable, a
 *  baked MSDF font has its atlases downloaded (GitHub issue #982). Resolves to `false` when it cannot be
 *  loaded; the label then keeps the default font. */
export async function loadLabelFont(font: LabelFont): Promise<boolean> {
  const family = font.family.trim();
  if (!family) return true;
  if (isMsdfFamily(family)) return loadMsdfFamily(family);
  const key = fontKey(family, font.weight);
  if (loadedFonts.has(key)) return true;
  if (typeof document === "undefined" || !document.fonts) return false;
  const inFlight = loadingFonts.get(key);
  if (inFlight) return inFlight;
  const loading = (async () => {
    try {
      const face = `${font.weight} 16px ${JSON.stringify(family)}`;
      // A canvas text texture is immutable until rebuilt. Load the face before the font becomes
      // active so Pixi never bakes the label from a late regular/fallback face.
      await document.fonts.load(face);
      if (!document.fonts.check(face)) return false;
      if (!isFontFamilyInstalled(family)) return false;
      loadedFonts.add(key);
      if (typeof window !== "undefined") window.dispatchEvent(new Event(LABEL_FONT_LOADED_EVENT));
      return true;
    } catch {
      return false;
    }
  })();
  loadingFonts.set(key, loading);
  void loading.finally(() => {
    if (loadingFonts.get(key) === loading) loadingFonts.delete(key);
  });
  return loading;
}

/** A label drawn in `font`: browser text when its face is loaded, else the baked MSDF atlas nearest to
 *  its weight. */
export function makeLabelText(text: string, font: LabelFont, fontSize: number, fill: number) {
  const family = isLabelFontLoaded(font) ? font.family.trim() : null;
  const resolution = Math.min(MAX_RUNTIME_TEXT_RESOLUTION, Math.max(1, window.devicePixelRatio || 1));
  const label = family
    // `Text` otherwise defaults to a 1x canvas texture. The application canvas uses the device
    // pixel ratio, so matching it prevents a 1x label from being stretched and blurred at 100%.
    ? new Text({ text, style: { fontFamily: labelFontFamilies(family), fontSize, fontWeight: String(font.weight) as "400", fontStyle: "normal", fill }, resolution })
    : new BitmapText({ text, style: { fontFamily: msdfFace(font).atlasName, fontSize, fill } });
  label.anchor.set(0.5);
  label.roundPixels = true;
  return label;
}
