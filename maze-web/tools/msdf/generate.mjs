// Bakes the MSDF atlases used by canvas `BitmapText` labels (GitHub issue #352).
//
// Input:  tools/msdf/Roboto-Regular.ttf  +  tools/msdf/Roboto-Bold.ttf  (Apache-2.0, committed)
// Output: public/fonts/roboto-regular-msdf.{fnt,png}
//         public/fonts/roboto-bold-msdf.{fnt,png}
//
// Output is `.fnt` (AngelCode XML), NOT `.json` — pixi.js v8's bitmap-font loader only recognizes
// `.fnt`/`.xml` by extension. A `.json` atlas loads as a plain object and `BitmapText` silently
// falls back to a runtime canvas font (blurry, wrong weight).
//
// Two weights so the label `fontWeight` setting (elevator badges, marker indices) actually
// switches — MSDF glyph shapes are baked, not synthesized, so a bold look needs its own atlas.
//
// Charset — only the glyphs canvas labels actually draw:
//   digits 0-9, ':', uppercase A-Z, '(' ')' ',' space
// Extend `CHARSET` and re-run `npm run gen:msdf` when a new label introduces a new glyph.

import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import generateBMFont from "msdf-bmfont-xml";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, "../../public/fonts");

const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:(), ";

const WEIGHTS = [
  { src: "Roboto-Regular.ttf", out: "roboto-regular-msdf" },
  { src: "Roboto-Bold.ttf", out: "roboto-bold-msdf" },
];

function bake(fontSrc, outName) {
  return new Promise((res, rej) => {
    generateBMFont(
      fontSrc,
      {
        charset: CHARSET,
        fieldType: "msdf",
        outputType: "xml",
        // 512x512 page, fontSize 54, wide 8px distance range — the wide spread keeps labels sharp
        // at extreme viewport zoom (a narrow range runs out of gradient once a glyph is drawn much
        // larger than its atlas size). Keep textureSize in sync if CHARSET grows a lot.
        textureSize: [512, 512],
        fontSize: 54,
        distanceRange: 8,
        smartSize: true,
      },
      async (err, textures, font) => {
        if (err) return rej(err);
        try {
          for (const texture of textures) {
            await writeFile(resolve(OUT_DIR, `${outName}.png`), texture.texture);
          }
          // Point the .fnt's <page> at our stable .png name (single-page for this charset).
          const fnt = font.data.replace(/file="[^"]*"/, `file="${outName}.png"`);
          await writeFile(resolve(OUT_DIR, `${outName}.fnt`), fnt);
          console.log(`wrote ${outName}.fnt + ${outName}.png`);
          res();
        } catch (e) {
          rej(e);
        }
      },
    );
  });
}

try {
  for (const w of WEIGHTS) {
    await bake(resolve(here, w.src), w.out);
  }
} catch (err) {
  console.error(err);
  process.exit(1);
}
