import { describe, it, expect, vi, beforeEach } from "vitest";

// `msdfFont.ts` (GitHub issue #352) is pure glue over pixi's `Assets`/`Cache`/`BitmapText`:
//  - `msdfFontFamily` maps a weight to the baked atlas `face`;
//  - `makeCenteredLabel` builds a `BitmapText`, anchors it 0.5, and folds an ink-centre correction
//    into `pivot.y`, computed from the installed font's own metrics;
//  - `loadMsdfFont` fires one `Assets.load` per weight, idempotently.
// All three are exercised here against a fake `Cache` carrying a synthetic font with known metrics,
// so the `pivot.y` formula is pinned without a real atlas.

const assetsLoad = vi.fn().mockResolvedValue(undefined);

/** One glyph's atlas record — only the fields `inkCentreOffset` reads. */
function glyph(yOffset: number, height: number) {
  return { yOffset, texture: { orig: { height } } };
}

// Synthetic Roboto-Regular-ish metrics (matches the real baked atlas: lineHeight 71, base 57 →
// baseLineOffset 14, measured at fontSize 54). Digit "3" spans yOffset 14 .. 14+47.
const FAKE_FONT = {
  baseLineOffset: 14,
  lineHeight: 71,
  baseMeasurementFontSize: 54,
  chars: {
    "3": glyph(14, 47),
    "8": glyph(14, 47),
    " ": { yOffset: 0, texture: undefined }, // space: no ink, must be skipped
  } as Record<string, { yOffset: number; texture?: { orig: { height: number } } }>,
};

let cacheReturnsFont = true;

vi.mock("pixi.js", () => ({
  Assets: { load: (url: string) => assetsLoad(url) },
  Cache: { get: (key: string) => (cacheReturnsFont && key.endsWith("-bitmap") ? FAKE_FONT : undefined) },
  BitmapText: class {
    text: string;
    style: Record<string, unknown>;
    anchor = { set: vi.fn() };
    pivot = { y: 0 };
    constructor(opts: { text: string; style: Record<string, unknown> }) {
      this.text = opts.text;
      this.style = opts.style;
    }
  },
}));

const { msdfFontFamily, MSDF_FONT_FAMILY, makeCenteredLabel, loadMsdfFont } = await import(
  "../pixi/renderers/msdfFont"
);

/** The documented ink-centre formula, in atlas units, scaled to `fontSize`. */
function expectedPivotY(minTop: number, maxBottom: number, fontSize: number): number {
  const inAtlasUnits =
    (minTop + maxBottom) / 2 + FAKE_FONT.baseLineOffset - (FAKE_FONT.lineHeight + FAKE_FONT.baseLineOffset) / 2;
  return inAtlasUnits * (fontSize / FAKE_FONT.baseMeasurementFontSize);
}

beforeEach(() => {
  cacheReturnsFont = true;
  assetsLoad.mockClear();
});

describe("msdfFontFamily", () => {
  it("maps each weight to its baked atlas face name", () => {
    expect(msdfFontFamily("regular")).toBe("Roboto-Regular");
    expect(msdfFontFamily("bold")).toBe("Roboto-Bold");
  });

  it("MSDF_FONT_FAMILY is the regular-weight family", () => {
    expect(MSDF_FONT_FAMILY).toBe(msdfFontFamily("regular"));
  });
});

describe("makeCenteredLabel", () => {
  it("anchors the label at its centre", () => {
    const label = makeCenteredLabel("3", "Roboto-Regular", 8.62, 0x000000);
    expect(label.anchor.set).toHaveBeenCalledWith(0.5);
  });

  it("passes text/fontFamily/fontSize/fill straight through to the BitmapText style", () => {
    const label = makeCenteredLabel("38", "Roboto-Bold", 12, 0xff0000);
    expect(label.text).toBe("38");
    expect(label.style).toMatchObject({ fontFamily: "Roboto-Bold", fontSize: 12, fill: 0xff0000 });
  });

  it("folds the metric-derived ink-centre offset into pivot.y", () => {
    const fontSize = 8.62;
    const label = makeCenteredLabel("3", "Roboto-Regular", fontSize, 0x000000);
    // "3" ink spans 14 .. 61 → +9 atlas units → scaled by 8.62/54.
    expect(label.pivot.y).toBeCloseTo(expectedPivotY(14, 61, fontSize), 5);
    expect(label.pivot.y).toBeCloseTo(1.44, 2);
  });

  it("ignores glyphs with no ink (space) when finding the ink span", () => {
    const fontSize = 10;
    const withSpace = makeCenteredLabel("3 8", "Roboto-Regular", fontSize, 0);
    const withoutSpace = makeCenteredLabel("38", "Roboto-Regular", fontSize, 0);
    expect(withSpace.pivot.y).toBeCloseTo(withoutSpace.pivot.y, 5);
  });

  it("falls back to pivot.y 0 when the font is not installed", () => {
    cacheReturnsFont = false;
    const label = makeCenteredLabel("3", "Roboto-Regular", 10, 0);
    expect(label.pivot.y).toBe(0);
  });

  it("falls back to pivot.y 0 when no glyph in the text carries metrics", () => {
    const label = makeCenteredLabel("???", "Roboto-Regular", 10, 0);
    expect(label.pivot.y).toBe(0);
  });
});

describe("loadMsdfFont", () => {
  // `loadPromise` is module-level state, so this is one sequential scenario: the first call issues
  // both weight loads, every later call reuses the cached promise without re-issuing.
  it("loads both .fnt weight atlases once, then is idempotent", async () => {
    await loadMsdfFont();
    const urls = assetsLoad.mock.calls.map((c) => c[0]);
    expect(urls).toEqual(
      expect.arrayContaining(["/fonts/roboto-regular-msdf.fnt", "/fonts/roboto-bold-msdf.fnt"]),
    );
    expect(urls.every((u) => u.endsWith(".fnt"))).toBe(true);

    const callCountAfterFirst = assetsLoad.mock.calls.length;
    await loadMsdfFont();
    await loadMsdfFont();
    expect(assetsLoad.mock.calls.length).toBe(callCountAfterFirst);
  });
});
