import { describe, expect, it } from "vitest";
import { truncateToWidth } from "../pixi/ellipsisFit";

// Every character is 10 px wide, so the fit is easy to reason about.
const measure = (s: string) => s.length * 10;

describe("truncateToWidth", () => {
  it("leaves a phrase that fits unchanged, up to the exact width", () => {
    expect(truncateToWidth("abcde", 50, measure)).toBe("abcde");
  });

  it("keeps the longest prefix that fits together with the ellipsis", () => {
    expect(truncateToWidth("abcdefgh", 50, measure)).toBe("abcd…");
  });

  it("returns only the ellipsis when no character fits", () => {
    expect(truncateToWidth("abcdefgh", 10, measure)).toBe("…");
    expect(truncateToWidth("abcdefgh", 0, measure)).toBe("…");
  });

  it("drops the space before the ellipsis", () => {
    expect(truncateToWidth("ab cdefgh", 40, measure)).toBe("ab…");
  });

  it("counts surrogate pairs as one character", () => {
    expect(truncateToWidth("😀😀😀😀", 30, (s) => Array.from(s).length * 10)).toBe("😀😀…");
  });
});
