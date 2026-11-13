import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { MSDF_FONTS, VECTOR_FONT_FAMILY } from "../pixi/renderers/fontChoice";
import { FONT_NOTICES, LICENSE_TEXT_URLS, findFontNotice, fontNoticeId } from "../components/fontLicenses";

// Every baked font must be credited (GitHub issue #982): a font added to the catalog without a notice
// would ship under its license without its copyright line.

describe("bundled font notices", () => {
  it("credit exactly the fonts of the MSDF catalog, under the catalog's names", () => {
    const catalog = Object.entries(MSDF_FONTS).map(([key, font]) => [fontNoticeId(key), font.label]).sort();
    expect(FONT_NOTICES.map((notice) => [notice.id, notice.name]).sort()).toEqual(catalog);
  });

  it("are reachable for every catalog font, the one a font row's copyright icon opens", () => {
    for (const key of Object.keys(MSDF_FONTS)) expect(findFontNotice(key)?.name, key).toBe(MSDF_FONTS[key].label);
    expect(findFontNotice(VECTOR_FONT_FAMILY)?.id).toBe("roboto");
  });

  it("serve a full text for every license in use", () => {
    for (const license of new Set(FONT_NOTICES.map((notice) => notice.license))) {
      const path = resolve(process.cwd(), `public${LICENSE_TEXT_URLS[license]}`);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toContain(license === "ofl-1.1" ? "SIL OPEN FONT LICENSE Version 1.1" : "Apache License");
    }
  });

  it("keep one text per license: every font's own OFL file ends with the shared text, up to line wrapping", () => {
    const words = (text: string) => text.replace(/\s+/g, " ").trim();
    const shared = words(readFileSync(resolve(process.cwd(), `public${LICENSE_TEXT_URLS["ofl-1.1"]}`), "utf8"));
    const sources = resolve(process.cwd(), "tools/msdf");
    const files = readdirSync(sources).filter((name) => /^OFL-.*\.txt$/.test(name));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) expect(words(readFileSync(resolve(sources, name), "utf8")).endsWith(shared), name).toBe(true);
  });
});
