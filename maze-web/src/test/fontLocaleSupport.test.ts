import { describe, it, expect } from "vitest";
import { LOCALE_FONT_SCRIPT, fontSupportsScript } from "../components/fontLocaleSupport";
import { MSDF_FONTS } from "../pixi/renderers/fontChoice";
import { locales } from "../i18n/localeStore";

// A new locale must say how font support is checked (GitHub issue #984). The `Record<Locale, ...>` type
// already refuses to compile without it; this guards the declaration against being emptied or cast away.
describe("locale font support", () => {
  it("declares a check for every locale", () => {
    for (const locale of locales) expect(Object.prototype.hasOwnProperty.call(LOCALE_FONT_SCRIPT, locale), locale).toBe(true);
  });

  it("has a bundled MSDF font for every script a locale needs, so a new script is not left out of the catalog", () => {
    for (const locale of locales) {
      const script = LOCALE_FONT_SCRIPT[locale];
      if (script === null) continue;
      const covering = Object.keys(MSDF_FONTS).filter((family) => fontSupportsScript(family, script));
      expect(covering.length, `${locale} (${script})`).toBeGreaterThan(0);
    }
  });

  it("needs no script for English and Cyrillic for Russian", () => {
    expect(LOCALE_FONT_SCRIPT.en).toBeNull();
    expect(LOCALE_FONT_SCRIPT.ru).toBe("cyrillic");
  });

  it("counts every bundled MSDF font as covering Cyrillic", () => {
    for (const family of Object.keys(MSDF_FONTS)) expect(fontSupportsScript(family, "cyrillic"), family).toBe(true);
  });
});
