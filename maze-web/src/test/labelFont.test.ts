import { afterEach, describe, expect, it, vi } from "vitest";

const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
const originalGetContext = HTMLCanvasElement.prototype.getContext;

afterEach(() => {
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  vi.resetModules();
});

const font = (family: string, weight = 400) => ({ family, weight });

function mockFontEnvironment(widthFor: (font: string, text: string) => number) {
  const load = vi.fn().mockResolvedValue([]);
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load, check: vi.fn().mockReturnValue(true) },
  });
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
    font: "",
    measureText(this: { font: string }, text: string) { return { width: widthFor(this.font, text) }; },
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  return load;
}

describe("loadLabelFont", () => {
  it("rejects a missing family even when Font Loading API reports its generic fallback as available", async () => {
    mockFontEnvironment((font) => font.includes("Missing") || font.includes("monospace") ? 100 : 80);
    const { loadLabelFont, isLabelFontLoaded } = await import("../pixi/renderers/labelFont");

    await expect(loadLabelFont(font("Missing"))).resolves.toBe(false);
    expect(isLabelFontLoaded(font("Missing"))).toBe(false);
  });

  it("accepts a font that covers only one script, told apart from the fallbacks by that script's probe", async () => {
    // Latin probes fall back to monospace for this face (as a runic or Cyrillic-only font does);
    // the Cyrillic probe is the only one that measures differently.
    const cyrillic = /[А-Яа-я]/;
    mockFontEnvironment((font, text) => font.includes("Runes") && cyrillic.test(text) ? 150 : font.includes("Runes") || font.includes("monospace") ? 100 : 80);
    const { loadLabelFont } = await import("../pixi/renderers/labelFont");

    await expect(loadLabelFont(font("Runes"))).resolves.toBe(true);
  });

  it("accepts a family the machine reports even when its metrics match a fallback everywhere", async () => {
    mockFontEnvironment((font) => font.includes("Twin") || font.includes("monospace") ? 100 : 80);
    (window as Window & { queryLocalFonts?: () => Promise<Array<{ family: string }>> }).queryLocalFonts = () => Promise.resolve([{ family: "Twin" }]);
    try {
      const { loadLabelFont, loadLocalFontFamilies } = await import("../pixi/renderers/labelFont");
      await expect(loadLabelFont(font("Twin"))).resolves.toBe(false);
      await loadLocalFontFamilies();
      await expect(loadLabelFont(font("Twin"))).resolves.toBe(true);
    } finally {
      delete (window as Window & { queryLocalFonts?: unknown }).queryLocalFonts;
    }
  });

  it("hands a baked MSDF family to the atlas loader and never asks the browser for it (GitHub issue #982)", async () => {
    const browserLoad = mockFontEnvironment(() => 80);
    const loadMsdfFamily = vi.fn().mockResolvedValue(true);
    vi.doMock("../pixi/renderers/msdfLoader", () => ({ loadMsdfFamily }));
    const { loadLabelFont, isLabelFontLoaded } = await import("../pixi/renderers/labelFont");

    await expect(loadLabelFont(font("msdf:fira-sans", 700))).resolves.toBe(true);
    expect(loadMsdfFamily).toHaveBeenCalledWith("msdf:fira-sans");
    expect(browserLoad).not.toHaveBeenCalled();
    // A baked font is drawn by the atlas path, never as browser text.
    expect(isLabelFontLoaded(font("msdf:fira-sans", 700))).toBe(false);
    vi.doUnmock("../pixi/renderers/msdfLoader");
  });

  it("reports a failed atlas download as not loaded", async () => {
    mockFontEnvironment(() => 80);
    vi.doMock("../pixi/renderers/msdfLoader", () => ({ loadMsdfFamily: vi.fn().mockResolvedValue(false) }));
    const { loadLabelFont } = await import("../pixi/renderers/labelFont");

    await expect(loadLabelFont(font("msdf:fira-sans"))).resolves.toBe(false);
    vi.doUnmock("../pixi/renderers/msdfLoader");
  });

  it("shares concurrent loading of the same real family", async () => {
    const load = mockFontEnvironment((font) => font.includes("Fira Sans") ? 110 : font.includes("monospace") ? 100 : 80);
    const { loadLabelFont, isLabelFontLoaded } = await import("../pixi/renderers/labelFont");

    await expect(Promise.all([loadLabelFont(font("Fira Sans")), loadLabelFont(font("Fira Sans"))])).resolves.toEqual([true, true]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(isLabelFontLoaded(font("Fira Sans"))).toBe(true);
  });
});

describe("labelFontCss", () => {
  it("puts the generic sans-serif behind a browser font", async () => {
    const { labelFontCss, labelFontFamilies } = await import("../pixi/renderers/labelFont");
    expect(labelFontCss("Fira Sans")).toBe('"Fira Sans", sans-serif');
    expect(labelFontFamilies("  Arial ")).toEqual(["Arial", "sans-serif"]);
    expect(labelFontCss("")).toBe("sans-serif");
  });
});

describe("rasterFontWeights", () => {
  const withLocalFonts = async (fonts: Array<{ family: string; style: string }>) => {
    (window as Window & { queryLocalFonts?: unknown }).queryLocalFonts = () => Promise.resolve(fonts);
    const mod = await import("../pixi/renderers/labelFont");
    await mod.loadLocalFontFamilies();
    return mod;
  };
  afterEach(() => { delete (window as Window & { queryLocalFonts?: unknown }).queryLocalFonts; });

  it("offers exactly the normal-style weights the machine reports for a family, ascending", async () => {
    mockFontEnvironment(() => 80);
    const { rasterFontWeights } = await withLocalFonts([
      { family: "Fira Sans", style: "Bold" },
      { family: "Fira Sans", style: "Light" },
      { family: "Fira Sans", style: "Regular" },
      { family: "Fira Sans", style: "Bold Italic" },
      { family: "Fira Sans", style: "Condensed" },
      { family: "Arial", style: "Regular" },
    ]);
    expect(rasterFontWeights("Fira Sans")).toEqual([300, 400, 700]);
    expect(rasterFontWeights("Arial")).toEqual([400]);
  });

  it("probes for a real bold face when the machine did not report the family", async () => {
    // Bold measures wider than regular only for "Heavy": it has its own bold face. "Flat" does not.
    mockFontEnvironment((font) => font.startsWith("700") && font.includes("Heavy") ? 120 : 100);
    const { rasterFontWeights } = await import("../pixi/renderers/labelFont");
    expect(rasterFontWeights("Heavy")).toEqual([400, 700]);
    expect(rasterFontWeights("Flat")).toEqual([400]);
  });
});

describe("fontCoversSample", () => {
  const cyrillic = /[А-Яа-я]/;

  it("tells a face that draws the sample from one that falls back, probing each family once", async () => {
    mockFontEnvironment((font, text) => font.includes("Covers") && cyrillic.test(text) ? 150 : font.includes("monospace") ? 100 : 80);
    const { fontCoversSample } = await import("../pixi/renderers/labelFont");

    expect(fontCoversSample("Covers", "ЖЩ")).toBe(true);
    expect(fontCoversSample("Latin only", "ЖЩ")).toBe(false);
    fontCoversSample("Covers", "ЖЩ");
    fontCoversSample("Latin only", "ЖЩ");
    // One scratch canvas serves every probe, however many families are asked about.
    expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalledTimes(1);
  });
});
