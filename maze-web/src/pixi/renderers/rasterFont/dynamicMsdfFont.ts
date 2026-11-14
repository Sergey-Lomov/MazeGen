import { BitmapFont, BitmapFontManager, BufferImageSource, Cache, Rectangle, Texture } from "pixi.js";
import type { AbstractBitmapFont } from "pixi.js";
import type { Kerning } from "./kerning";
import { MSDF_PIXELS_PER_EM, MSDF_RANGE_PX, type GlyphBitmap } from "./msdfEngine";

/** A bitmap font whose glyphs are added while the app runs (GitHub issue #966): the MSDF glyphs of an
 *  installed or uploaded raster font, packed into paged RGBA atlas textures. It is a pixi `BitmapFont`
 *  installed in pixi's cache under its name, so `BitmapText` draws it like a baked atlas and every label of
 *  one family and weight shares its pages. */

/** Edge of one atlas page in pixels. */
export const ATLAS_PAGE_SIZE = 1024;

/** Pages one font may grow to. A glyph that no longer fits is drawn in the fallback font, so a font used
 *  with a huge character set cannot grow without bound (4 pages of 4 MB each). */
export const MAX_ATLAS_PAGES = 4;

/** Empty pixels kept between packed glyphs so linear filtering never reads a neighbour. */
const GLYPH_SPACING = 1;

/** Vertical metrics of the source font, in em units. */
export interface FontLineMetrics {
  ascender: number;
  descender: number;
  lineGap: number;
}

interface Page {
  data: Uint8Array;
  source: BufferImageSource;
  texture: Texture;
  cursorX: number;
  rowTop: number;
  rowHeight: number;
}

export interface InsertReport {
  /** Glyphs drawn from the font itself. */
  added: string[];
  /** Characters the font does not draw; a fallback glyph stands in for each. */
  lacking: string[];
  /** Characters dropped because the atlas reached its page limit. */
  overflowed: string[];
}

/** An inkless glyph (a space) only advances the pen: pixi skips a character without a texture. */
const NO_TEXTURE = undefined as unknown as Texture;

const cacheKey = (name: string) => `${name}-bitmap`;

export class DynamicMsdfFont {
  readonly font: BitmapFont;
  private readonly pages: Page[] = [];
  private readonly lineHeight: number;
  /** Distance in atlas pixels from the top of a line to its baseline. */
  private readonly baseline: number;
  private destroyed = false;
  /** Characters drawn from the font itself (not fallback aliases). */
  private readonly own = new Set<string>();

  /** `fallback` supplies the font whose glyphs stand in for ones this font lacks (the bundled Roboto).
   *  `kerning` is the pair kerning of the source font; only pairs of characters drawn from the font itself
   *  are kerned (a fallback glyph has other metrics). */
  constructor(
    readonly name: string,
    metrics: FontLineMetrics,
    private readonly fallback: () => AbstractBitmapFont<unknown> | undefined,
    private readonly kerning: Kerning | null = null,
  ) {
    const scale = MSDF_PIXELS_PER_EM;
    this.lineHeight = Math.max(1, Math.round((metrics.ascender - metrics.descender + metrics.lineGap) * scale));
    this.baseline = (metrics.ascender + metrics.lineGap / 2) * scale;
    this.font = new BitmapFont({
      textures: [],
      data: {
        pages: [],
        chars: {},
        lineHeight: this.lineHeight,
        fontSize: scale,
        fontFamily: name,
        distanceField: { type: "msdf", range: MSDF_RANGE_PX },
        baseLineOffset: this.lineHeight - this.baseline,
      },
    });
    Cache.set(cacheKey(name), this.font);
  }

  get pageCount(): number {
    return this.pages.length;
  }

  /** Characters registered so far, aliases of fallback glyphs included. */
  get glyphCount(): number {
    return this.font.chars ? Object.keys(this.font.chars).length : 0;
  }

  has(char: string): boolean {
    return !!this.font.chars?.[char];
  }

  /** Packs `glyphs` (one per entry of `codepoints`, `null` for a missing one) into the atlas and registers
   *  them as characters. A missing glyph is replaced by the fallback font's one when it has it. One texture
   *  upload per touched page, however many glyphs arrive. */
  insert(codepoints: readonly number[], glyphs: ReadonlyArray<GlyphBitmap | null>): InsertReport {
    const report: InsertReport = { added: [], lacking: [], overflowed: [] };
    if (this.destroyed) return report;
    const touched = new Set<Page>();
    glyphs.forEach((glyph, i) => {
      const char = String.fromCodePoint(codepoints[i]);
      if (!glyph) {
        report.lacking.push(char);
        this.alias(char);
        return;
      }
      if (glyph.width === 0 || glyph.height === 0) {
        this.font.chars[char] = { id: codepoints[i], xOffset: 0, yOffset: 0, xAdvance: glyph.advance * MSDF_PIXELS_PER_EM, kerning: {}, texture: NO_TEXTURE };
        report.added.push(char);
        return;
      }
      const slot = this.place(glyph.width, glyph.height);
      if (!slot) {
        report.overflowed.push(char);
        this.alias(char);
        return;
      }
      const { page, x, y } = slot;
      for (let row = 0; row < glyph.height; row++) {
        page.data.set(glyph.rgba.subarray(row * glyph.width * 4, (row + 1) * glyph.width * 4), ((y + row) * ATLAS_PAGE_SIZE + x) * 4);
      }
      touched.add(page);
      this.font.chars[char] = {
        id: codepoints[i],
        xOffset: glyph.left * MSDF_PIXELS_PER_EM,
        yOffset: this.baseline - glyph.top * MSDF_PIXELS_PER_EM,
        xAdvance: glyph.advance * MSDF_PIXELS_PER_EM,
        kerning: {},
        texture: new Texture({
          source: page.source,
          frame: new Rectangle(x, y, glyph.width, glyph.height),
          orig: new Rectangle(0, 0, glyph.width, glyph.height),
        }),
      };
      report.added.push(char);
    });
    for (const page of touched) page.source.update();
    this.applyKerning(report.added);
    // Layouts are cached per text and style; one measured before these glyphs existed would keep omitting them.
    BitmapFontManager.measureCache.clear();
    return report;
  }

  /** Fills the pairs `fresh` characters form with each other and with the characters already drawn from the
   *  font. Pixi reads the amount for a pair from the second character's data, keyed by the first character,
   *  in atlas pixels. */
  private applyKerning(fresh: readonly string[]): void {
    const kerning = this.kerning;
    if (!kerning || fresh.length === 0) return;
    const chars = this.font.chars;
    const store = (first: string, second: string) => {
      const amount = kerning.pair(first.codePointAt(0)!, second.codePointAt(0)!) * MSDF_PIXELS_PER_EM;
      const target = chars[second].kerning;
      if (amount !== 0) target[first] = amount;
      else delete target[first];
    };
    for (const char of fresh) {
      chars[char].kerning = {};
      this.own.add(char);
    }
    for (const char of fresh) {
      for (const other of this.own) {
        store(other, char);
        store(char, other);
      }
    }
  }

  /** Registers the fallback font's glyph of `char` under this font's metrics, when the fallback has one. */
  private alias(char: string): void {
    if (this.has(char)) return;
    const fallback = this.fallback();
    const glyph = fallback?.chars[char];
    if (!fallback || !glyph) return;
    const fallbackBaseline = fallback.lineHeight - fallback.baseLineOffset;
    this.font.chars[char] = {
      id: glyph.id,
      xOffset: glyph.xOffset,
      yOffset: glyph.yOffset - fallbackBaseline + this.baseline,
      xAdvance: glyph.xAdvance,
      kerning: {},
      // The glyph texture is the fallback's own; a copy keeps this font's disposal from destroying it.
      texture: glyph.texture
        ? new Texture({ source: glyph.texture.source, frame: glyph.texture.frame.clone(), orig: glyph.texture.orig.clone() })
        : NO_TEXTURE,
    };
  }

  /** A free `width` x `height` slot: the current shelf of the newest page, a new shelf, or a new page. */
  private place(width: number, height: number): { page: Page; x: number; y: number } | null {
    if (width > ATLAS_PAGE_SIZE || height > ATLAS_PAGE_SIZE) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const page = this.pages[this.pages.length - 1];
      if (page) {
        if (page.cursorX + width > ATLAS_PAGE_SIZE) {
          page.rowTop += page.rowHeight + GLYPH_SPACING;
          page.rowHeight = 0;
          page.cursorX = 0;
        }
        if (page.rowTop + height <= ATLAS_PAGE_SIZE) {
          const slot = { page, x: page.cursorX, y: page.rowTop };
          page.cursorX += width + GLYPH_SPACING;
          page.rowHeight = Math.max(page.rowHeight, height);
          return slot;
        }
      }
      if (this.pages.length >= MAX_ATLAS_PAGES) return null;
      this.pages.push(this.createPage());
    }
    return null;
  }

  private createPage(): Page {
    const data = new Uint8Array(ATLAS_PAGE_SIZE * ATLAS_PAGE_SIZE * 4);
    // Straight alpha: the distance field lives in the color channels and the empty margin must stay zero.
    const source = new BufferImageSource({ resource: data, width: ATLAS_PAGE_SIZE, height: ATLAS_PAGE_SIZE, alphaMode: "no-premultiply-alpha" });
    const texture = new Texture({ source });
    this.font.pages.push({ texture });
    return { data, source, texture, cursorX: 0, rowTop: 0, rowHeight: 0 };
  }

  /** Uninstalls the font and frees its atlas pages. Labels still using it must be gone. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (Cache.has(cacheKey(this.name))) Cache.remove(cacheKey(this.name));
    for (const page of this.pages) page.texture.destroy(true);
    this.pages.length = 0;
    // Glyph textures are own objects over a page or over the fallback's page; neither source is touched here.
    this.font.pages.length = 0;
    this.font.destroy();
    BitmapFontManager.measureCache.clear();
  }
}
