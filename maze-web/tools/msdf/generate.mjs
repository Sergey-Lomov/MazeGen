// Bakes the MSDF atlases used by canvas `BitmapText` labels (GitHub issue #352).
//
// Input:  tools/msdf/<Font>-Regular.ttf  +  tools/msdf/<Font>-Bold.ttf, committed (see `FONTS` below)
// Output: public/fonts/<id>-regular-msdf.{fnt,png}
//         public/fonts/<id>-bold-msdf.{fnt,png}
//
// Output is `.fnt` (AngelCode XML), NOT `.json` — pixi.js v8's bitmap-font loader only recognizes
// `.fnt`/`.xml` by extension. A `.json` atlas loads as a plain object and `BitmapText` silently
// falls back to a runtime canvas font (blurry, wrong weight).
//
// Two weights so the font picker can offer both: MSDF glyph shapes are baked, not synthesized, so a
// bold look needs its own atlas. A baked weight is only offered once it is listed in `MSDF_FONTS`
// (`src/pixi/renderers/fontChoice.ts`).
//
// Charset — only the glyphs canvas labels actually draw:
//   digits 0-9, ':', '#', '№', '+', '-', '=', Latin and Cyrillic letters (uppercase and lowercase), '(' ')' ',' space,
//   and common text punctuation (. ; ! ? ' " / & _ * % @ [ ] « » – — …).
//   Lowercase glyphs and punctuation are required by the free-form floor-label prefix and floor
//   titles (GitHub issue #747).
// Extend `CHARSET` and re-run `npm run gen:msdf` when a new label introduces a new glyph.

import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import generateBMFont from "msdf-bmfont-xml";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, "../../public/fonts");

const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:(),#+-=№ .;!?'\"/&_*%@[]«»–—…АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя";

// One entry per bundled font, Regular and Bold each. Fonts other than Roboto (Apache-2.0, `public/licenses/Apache-2.0.txt`)
// are SIL OFL 1.1 (`OFL-<Font>.txt` next to the sources; Noto Sans Condensed shares `OFL-NotoSans.txt`). Usage: `npm run gen:msdf` bakes every font,
// `npm run gen:msdf -- fira-sans noto-serif` only the named ones (output is otherwise byte-identical, so
// rebaking an unchanged font only adds diff noise).
const FONTS = [
  { id: "roboto", src: "Roboto" },
  { id: "noto-sans", src: "NotoSans" },
  { id: "noto-sans-condensed", src: "NotoSansCondensed" },
  { id: "noto-serif", src: "NotoSerif" },
  { id: "fira-sans", src: "FiraSans" },
  { id: "fira-mono", src: "FiraMono" },
  { id: "arimo", src: "Arimo" },
  { id: "tinos", src: "Tinos" },
  { id: "cousine", src: "Cousine" },
  { id: "open-sans", src: "OpenSans" },
];

const requested = process.argv.slice(2);
const unknown = requested.filter((id) => !FONTS.some((font) => font.id === id));
if (unknown.length > 0) {
  console.error(`unknown font id(s): ${unknown.join(", ")}; known: ${FONTS.map((font) => font.id).join(", ")}`);
  process.exit(1);
}

const WEIGHTS = FONTS
  .filter((font) => requested.length === 0 || requested.includes(font.id))
  .flatMap((font) => ["Regular", "Bold"].map((weight) => ({
    src: `${font.src}-${weight}.ttf`,
    out: `${font.id}-${weight.toLowerCase()}-msdf`,
  })));

function bake(fontSrc, outName) {
  return new Promise((res, rej) => {
    generateBMFont(
      fontSrc,
      {
        charset: CHARSET,
        fieldType: "msdf",
        outputType: "xml",
        // 1024x1024 page, fontSize 54, wide 8px distance range — the wide spread keeps labels
        // sharp at extreme viewport zoom (a narrow range runs out of gradient once a glyph is drawn
        // much larger than its atlas size). Keep textureSize in sync if CHARSET grows a lot.
        textureSize: [1024, 1024],
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
