import { createMsdfgen } from "@playcanvas/msdfgen-wasm";

/** Glyph generation core (GitHub issue #966): msdfgen compiled to WebAssembly turns glyphs of a TTF/OTF
 *  file into multi-channel signed distance field bitmaps. Runs inside `msdfWorker.ts`; tests run it on
 *  the calling thread. */

/** Atlas pixels per em. Equal to the bundled Roboto atlas (baked at 54 px), so a Roboto glyph can stand in
 *  for a missing one without rescaling. */
export const MSDF_PIXELS_PER_EM = 54;

/** Distance range in atlas pixels, the same as the bundled atlases. */
export const MSDF_RANGE_PX = 8;

/** Margin kept around a glyph's ink: half the distance range, where the field is still informative. */
const GLYPH_PADDING = MSDF_RANGE_PX / 2;

/** One generated glyph, cropped to its ink plus padding. Positions are in em units. */
export interface GlyphBitmap {
  codepoint: number;
  /** Cropped bitmap size in atlas pixels; zero for a glyph without ink (a space). */
  width: number;
  height: number;
  /** Top-down RGBA pixels of the cropped bitmap; empty for an inkless glyph. */
  rgba: Uint8ClampedArray;
  advance: number;
  /** Bitmap left edge relative to the pen position. */
  left: number;
  /** Bitmap top edge above the baseline. */
  top: number;
}

interface MsdfFont {
  generateGlyph(codepoint: number, size: number, pxrange: number): {
    width: number; height: number; rgba: Uint8Array | Uint8ClampedArray; advance: number;
    translateX: number; translateY: number; boundsL: number; boundsB: number; boundsR: number; boundsT: number;
  } | null;
  delete(): void;
}

export interface MsdfEngine {
  /** Loads font bytes under `key`; `false` when the file is not a usable font. */
  load(key: string, bytes: Uint8Array): boolean;
  unload(key: string): void;
  /** Glyphs of `codepoints`, in order; `null` for a codepoint the font does not draw. */
  generate(key: string, codepoints: readonly number[]): Array<GlyphBitmap | null>;
}

/** Cell edge in pixels: msdfgen frames a glyph into a square cell two ems wide. */
const CELL_SIZE = MSDF_PIXELS_PER_EM * 2;

function cropGlyph(codepoint: number, glyph: NonNullable<ReturnType<MsdfFont["generateGlyph"]>>): GlyphBitmap {
  const scale = MSDF_PIXELS_PER_EM;
  const hasInk = glyph.boundsR > glyph.boundsL && glyph.boundsT > glyph.boundsB;
  if (!hasInk) return { codepoint, width: 0, height: 0, rgba: new Uint8ClampedArray(0), advance: glyph.advance, left: 0, top: 0 };
  const x0 = Math.max(0, Math.floor((glyph.boundsL + glyph.translateX) * scale) - GLYPH_PADDING);
  const x1 = Math.min(CELL_SIZE, Math.ceil((glyph.boundsR + glyph.translateX) * scale) + GLYPH_PADDING);
  // Source rows run top-down; bounds are em offsets above the cell bottom.
  const y0 = Math.max(0, CELL_SIZE - Math.ceil((glyph.boundsT + glyph.translateY) * scale) - GLYPH_PADDING);
  const y1 = Math.min(CELL_SIZE, CELL_SIZE - Math.floor((glyph.boundsB + glyph.translateY) * scale) + GLYPH_PADDING);
  const width = x1 - x0;
  const height = y1 - y0;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    const source = ((y0 + row) * glyph.width + x0) * 4;
    rgba.set(glyph.rgba.subarray(source, source + width * 4), row * width * 4);
  }
  return {
    codepoint,
    width,
    height,
    rgba,
    advance: glyph.advance,
    left: x0 / scale - glyph.translateX,
    top: (CELL_SIZE - y0) / scale - glyph.translateY,
  };
}

/** Starts the msdfgen module. `wasmUrl` points at its `.wasm` file when the bundler serves it; without
 *  it the module finds the file next to its own script (Node). */
export async function createMsdfEngine(wasmUrl?: string): Promise<MsdfEngine> {
  const msdfgen = await createMsdfgen(wasmUrl ? { moduleOverrides: { locateFile: () => wasmUrl } } : {});
  const fonts = new Map<string, MsdfFont>();
  return {
    load(key, bytes) {
      fonts.get(key)?.delete();
      const font = msdfgen.loadFont(bytes) as MsdfFont | null;
      if (!font) { fonts.delete(key); return false; }
      fonts.set(key, font);
      return true;
    },
    unload(key) {
      fonts.get(key)?.delete();
      fonts.delete(key);
    },
    generate(key, codepoints) {
      const font = fonts.get(key);
      if (!font) return codepoints.map(() => null);
      return codepoints.map((codepoint) => {
        const glyph = font.generateGlyph(codepoint, CELL_SIZE, MSDF_RANGE_PX);
        return glyph ? cropGlyph(codepoint, glyph) : null;
      });
    },
  };
}
