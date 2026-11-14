import { describe, expect, it } from "vitest";
import { charsetVersion, currentCharset, expandCharsets } from "../pixi/renderers/rasterFont/glyphCharset";
import { LOCALE_MSDF_CHARSETS } from "../i18n/localeCharsets";
import { locales } from "~/paraglide/runtime";

const has = (char: string) => currentCharset().codepoints.includes(char.codePointAt(0)!);

describe("MSDF glyph charset", () => {
  it("unions ranges and characters without duplicates, counting astral characters once", () => {
    const points = expandCharsets([{ ranges: [[0x41, 0x43]], chars: "B😀" }, { chars: "😀A" }]);
    expect(points).toEqual([0x41, 0x42, 0x43, 0x1f600]);
  });

  it("holds the base Latin, the common symbols and every locale's declaration", () => {
    for (const char of ["A", "z", "0", "9", ":", "№", "«", "Ж", "я", "Ё", "ё"]) expect(has(char)).toBe(true);
  });

  it("does not contain whole Unicode", () => {
    expect(currentCharset().codepoints.length).toBeLessThan(600);
    expect(has("中")).toBe(false);
  });

  it("gets its alphabets from the locale declarations, one per project locale", () => {
    expect(Object.keys(LOCALE_MSDF_CHARSETS).sort()).toEqual([...locales].sort());
  });

  it("versions the set by content", () => {
    expect(charsetVersion([1, 2, 3])).toBe(charsetVersion([1, 2, 3]));
    expect(charsetVersion([1, 2, 3])).not.toBe(charsetVersion([1, 2, 4]));
    expect(currentCharset().version).toBe(charsetVersion(currentCharset().codepoints));
  });
});
