import { Cache } from "pixi.js";
import type { AbstractBitmapFont } from "pixi.js";
import { LABEL_FONT_LOADED_EVENT, MSDF_FONTS, VECTOR_FONT_FAMILY, nearestWeight, registerRasterFace, unregisterRasterFace, type LabelFont } from "../fontChoice";
import { DynamicMsdfFont } from "./dynamicMsdfFont";
import { getMsdfService } from "./msdfClient";
import { currentCharset } from "./glyphCharset";
import { beginRasterWork, endRasterWork, isRasterWorkBusy, knownRasterWeights, rasterFaceBytes, rasterFaceSource, subscribeRasterFonts, subscribeRasterWork } from "./rasterFontStore";
import { readKerning } from "./kerning";
import { readFontInfo } from "./sfnt";

/** Dynamic MSDF atlases of raster fonts (GitHub issue #966): an installed or uploaded TTF/OTF font is turned
 *  into signed distance field glyphs by a worker and drawn by `BitmapText`, so it stays sharp at any zoom like
 *  the bundled fonts, with no per-label canvas texture. One atlas serves every label of a family and weight. */

/** Built atlases that no project text uses are kept for quick re-selection in the picker, up to this
 *  many (least recently used first out); atlases of fonts the project uses are never evicted. */
export const MAX_IDLE_RASTER_FONTS = 4;

interface Entry {
  /** `weight|family` of the face the atlas holds. */
  id: string;
  /** Identity of the font file the atlas was built from (`rasterFaceSource`). */
  source: string;
  /** Version of the character set the atlas was last completed with. */
  charsetVersion: string;
  family: string;
  weight: number;
  atlas: DynamicMsdfFont;
  /** Weights requested by labels that resolved to this atlas. */
  requested: Set<number>;
  /** Characters the source font does not draw (Roboto draws them). */
  lacking: Set<string>;
  /** Codepoints already sent to the generator, so a missing glyph is not retried on every label. */
  tried: Set<number>;
  queue: Set<number>;
  flushing: boolean;
  lastUsed: number;
}

const entries = new Map<string, Entry>();
const building = new Map<string, Promise<Entry | null>>();
const requests = new Map<string, Promise<boolean>>();
let clock = 0;

const entryId = (family: string, weight: number) => `${weight}|${family}`;

function announce(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LABEL_FONT_LOADED_EVENT));
}

/** The bundled Roboto atlas nearest to `weight`, whose glyphs stand in for ones a raster font lacks. */
function fallbackFont(weight: number): AbstractBitmapFont<unknown> | undefined {
  const faces = MSDF_FONTS[VECTOR_FONT_FAMILY].faces;
  const face = faces.find((candidate) => candidate.weight === nearestWeight(weight, faces.map((f) => f.weight)));
  const key = face ? `${face.atlasName}-bitmap` : "";
  return face && Cache.has(key) ? Cache.get<AbstractBitmapFont<unknown>>(key) : undefined;
}

function attach(entry: Entry, requestedWeight: number): void {
  entry.requested.add(requestedWeight);
  entry.lastUsed = ++clock;
  registerRasterFace(entry.family, requestedWeight, { weight: entry.weight, atlasName: entry.atlas.name, url: "" });
}

async function build(family: string, weight: number): Promise<Entry | null> {
  const id = entryId(family, weight);
  const service = getMsdfService();
  const source = rasterFaceSource(family, weight);
  const bytes = await rasterFaceBytes(family, weight);
  if (!bytes || !source) return null;
  const info = readFontInfo(bytes);
  if (!info) return null;
  if (!(await service.load(id, bytes))) return null;
  const charset = currentCharset();
  let glyphs;
  try {
    glyphs = await service.generate(id, charset.codepoints);
  } catch {
    service.unload(id);
    return null;
  }
  const atlas = new DynamicMsdfFont(`raster:${family}:${weight}`, info, () => fallbackFont(weight), readKerning(bytes));
  const report = atlas.insert(charset.codepoints, glyphs);
  const entry: Entry = {
    id, source, charsetVersion: charset.version, family, weight, atlas,
    requested: new Set(), lacking: new Set(report.lacking),
    tried: new Set(charset.codepoints), queue: new Set(), flushing: false, lastUsed: ++clock,
  };
  entries.set(id, entry);
  return entry;
}

/** Builds (once) the MSDF atlas that draws `font` and makes labels use it, then announces it so labels
 *  switch from the canvas fallback. Resolves `true` when the font can be drawn from its own atlas, `false`
 *  when it cannot (no readable file, an unusable file, a failed conversion): labels then stay as they are.
 *  The family's weights are those its file provides; a weight it lacks maps to the nearest one. A cached
 *  atlas is reused and completed when the character set changed. Never rejects. */
export function loadRasterFont(font: LabelFont): Promise<boolean> {
  const family = font.family.trim();
  const requested = entryId(family, font.weight);
  const pending = requests.get(requested);
  if (pending) return pending;
  const weights = knownRasterWeights(family);
  if (weights.length === 0) return Promise.resolve(false);
  const weight = nearestWeight(font.weight, weights);
  const id = entryId(family, weight);
  const existing = entries.get(id);
  if (existing) {
    attach(existing, font.weight);
    completeCharset(existing);
    return Promise.resolve(true);
  }
  beginRasterWork();
  let job = building.get(id);
  if (!job) {
    job = build(family, weight).catch(() => null).finally(() => { building.delete(id); });
    building.set(id, job);
  }
  const request = job.then((entry) => {
    if (!entry) return false;
    attach(entry, font.weight);
    announce();
    return true;
  }).finally(() => {
    requests.delete(requested);
    endRasterWork();
  });
  requests.set(requested, request);
  return request;
}

/** Queues the characters of the current set an older atlas lacks (the declared sets changed). */
function completeCharset(entry: Entry): void {
  const charset = currentCharset();
  if (entry.charsetVersion === charset.version) return;
  entry.charsetVersion = charset.version;
  for (const point of charset.codepoints) {
    if (entry.tried.has(point)) continue;
    entry.tried.add(point);
    entry.queue.add(point);
  }
  if (entry.queue.size > 0 && !entry.flushing) void flush(entry);
}

/** Whether `font` is drawn from a ready raster atlas. */
export function isRasterFontReady(font: LabelFont): boolean {
  const entry = atlasOf(font);
  return !!entry && entry.requested.has(font.weight);
}

async function flush(entry: Entry): Promise<void> {
  entry.flushing = true;
  beginRasterWork();
  try {
    while (entry.queue.size > 0) {
      const codepoints = [...entry.queue];
      entry.queue.clear();
      let glyphs;
      try {
        glyphs = await getMsdfService().generate(entry.id, codepoints);
      } catch {
        return;
      }
      if (entries.get(entry.id) !== entry) return;
      const report = entry.atlas.insert(codepoints, glyphs);
      for (const char of report.lacking) entry.lacking.add(char);
      if (report.added.length > 0 || report.lacking.length > 0) announce();
    }
  } finally {
    entry.flushing = false;
    endRasterWork();
  }
}

/** The atlas that draws `font`, if one was built. */
function atlasOf(font: LabelFont): Entry | undefined {
  const family = font.family.trim();
  return entries.get(entryId(family, nearestWeight(font.weight, knownRasterWeights(family))));
}

/** Whether the atlas of `font` can draw every character of `text` now. A character outside the converted
 *  set is queued for generation (labels redraw once it lands, `LABEL_FONT_LOADED_EVENT`) and the answer is
 *  `false` meanwhile, so the caller keeps the canvas text instead of dropping the character. A character the
 *  font lacks counts as covered: Roboto draws it. `false` for a font without a ready atlas. */
export function rasterCoversText(font: LabelFont, text: string): boolean {
  const entry = atlasOf(font);
  if (!entry || !entry.requested.has(font.weight)) return false;
  entry.lastUsed = ++clock;
  let covered = true;
  for (const char of text) {
    const codepoint = char.codePointAt(0)!;
    if (/\s/.test(char) || entry.lacking.has(char) || entry.atlas.has(char)) continue;
    covered = false;
    if (!entry.tried.has(codepoint)) {
      entry.tried.add(codepoint);
      entry.queue.add(codepoint);
    }
  }
  if (entry.queue.size > 0 && !entry.flushing) void flush(entry);
  return covered;
}

function dispose(entry: Entry): void {
  entries.delete(entry.id);
  for (const weight of entry.requested) unregisterRasterFace(entry.family, weight);
  entry.atlas.destroy();
  getMsdfService().unload(entry.id);
}

/** Frees atlases no project text needs. `inUse` holds `weight|family` keys of the fonts the project uses; an
 *  atlas that one of them resolves to is kept, the rest are idle and only the `MAX_IDLE_RASTER_FONTS`
 *  most recently used survive. */
export function pruneRasterFonts(inUse: ReadonlySet<string>): void {
  const idle = [...entries.values()].filter((entry) => ![...entry.requested].some((weight) => inUse.has(entryId(entry.family, weight))));
  idle.sort((a, b) => b.lastUsed - a.lastUsed);
  for (const entry of idle.slice(MAX_IDLE_RASTER_FONTS)) dispose(entry);
}

/** Frees every atlas of `family` (its uploaded font was removed). */
export function disposeRasterFamily(family: string): void {
  for (const entry of [...entries.values()]) if (entry.family === family) dispose(entry);
}

/** Atlases alive now, for tests and diagnostics. */
export function rasterFontCount(): number {
  return entries.size;
}

/** Changes whenever a dynamic atlas gains glyphs or is built or freed: an input of text measurements
 *  (`textMetricsKey`). */
export function rasterAtlasSignature(): string {
  return [...entries.values()].map((entry) => `${entry.id}:${entry.atlas.glyphCount}`).join(",");
}

/** Frees atlases whose font file was replaced since they were built (an upload with the same family and weight). */
subscribeRasterFonts(() => {
  for (const entry of [...entries.values()]) if (rasterFaceSource(entry.family, entry.weight) !== entry.source) dispose(entry);
});

/** Resolves once no atlas is being built or extended, or after `timeoutMs`. An export awaits it so labels
 *  are drawn from their final atlas. */
export function whenRasterFontsSettled(timeoutMs = 10000): Promise<void> {
  if (!isRasterWorkBusy()) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); unsubscribe(); resolve(); };
    const unsubscribe = subscribeRasterWork(() => { if (!isRasterWorkBusy()) finish(); });
    const timer = setTimeout(finish, timeoutMs);
  });
}
