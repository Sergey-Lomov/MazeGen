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
  it("hands a baked MSDF family to the atlas loader (GitHub issue #982)", async () => {
    const loadMsdfFamily = vi.fn().mockResolvedValue(true);
    vi.doMock("../pixi/renderers/msdfLoader", () => ({ loadMsdfFamily }));
    const { loadLabelFont, isLabelFontLoaded } = await import("../pixi/renderers/labelFont");

    await expect(loadLabelFont(font("msdf:fira-sans", 700))).resolves.toBe(true);
    expect(loadMsdfFamily).toHaveBeenCalledWith("msdf:fira-sans");
    // A baked font is never a raster font: it has no dynamic atlas.
    expect(isLabelFontLoaded(font("msdf:fira-sans", 700))).toBe(false);
    vi.doUnmock("../pixi/renderers/msdfLoader");
  });

  it("reports a failed atlas download as not loaded", async () => {
    vi.doMock("../pixi/renderers/msdfLoader", () => ({ loadMsdfFamily: vi.fn().mockResolvedValue(false) }));
    const { loadLabelFont } = await import("../pixi/renderers/labelFont");

    await expect(loadLabelFont(font("msdf:fira-sans"))).resolves.toBe(false);
    vi.doUnmock("../pixi/renderers/msdfLoader");
  });

  it("rejects a missing family even when Font Loading API reports its generic fallback as available", async () => {
    mockFontEnvironment((font) => font.includes("Missing") || font.includes("monospace") ? 100 : 80);
    const { loadLabelFont, isLabelFontLoaded } = await import("../pixi/renderers/labelFont");

    await expect(loadLabelFont(font("Missing"))).resolves.toBe(false);
    expect(isLabelFontLoaded(font("Missing"))).toBe(false);
  });

  it("accepts a font that covers only one script, told apart from the fallbacks by that script's probe", async () => {
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

  it("shares concurrent loading of the same real family", async () => {
    const load = mockFontEnvironment((font) => font.includes("Fira Sans") ? 110 : font.includes("monospace") ? 100 : 80);
    const { loadLabelFont, isLabelFontLoaded } = await import("../pixi/renderers/labelFont");

    await expect(Promise.all([loadLabelFont(font("Fira Sans")), loadLabelFont(font("Fira Sans"))])).resolves.toEqual([true, true]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(isLabelFontLoaded(font("Fira Sans"))).toBe(true);
  });

  it("loads only the browser face of a raster font, never its MSDF atlas (GitHub issue #966)", async () => {
    mockFontEnvironment((font) => font.includes("Fira Sans") ? 110 : font.includes("monospace") ? 100 : 80);
    const loadRasterFont = vi.fn();
    vi.doMock("../pixi/renderers/rasterFont/rasterMsdf", () => ({ loadRasterFont, isRasterFontReady: () => false, rasterCoversText: () => false }));
    const { loadLabelFont } = await import("../pixi/renderers/labelFont");

    await expect(loadLabelFont(font("Fira Sans"))).resolves.toBe(true);
    expect(loadRasterFont).not.toHaveBeenCalled();
    vi.doUnmock("../pixi/renderers/rasterFont/rasterMsdf");
  });

  it("treats the default font as always loaded without asking anyone", async () => {
    const { loadLabelFont, isLabelFontLoaded } = await import("../pixi/renderers/labelFont");

    await expect(loadLabelFont(font(""))).resolves.toBe(true);
    expect(isLabelFontLoaded(font(""))).toBe(false);
  });
});

describe("usesCanvasText (GitHub issue #966)", () => {
  const withAtlas = (ready: boolean, covers: boolean) => vi.doMock("../pixi/renderers/rasterFont/rasterMsdf", () => ({
    loadRasterFont: vi.fn(), isRasterFontReady: () => ready, rasterCoversText: () => covers,
  }));
  const fira = () => mockFontEnvironment((name) => name.includes("Fira Sans") ? 110 : name.includes("monospace") ? 100 : 80);

  it("is canvas text once the browser face has loaded and there is no atlas yet", async () => {
    fira();
    withAtlas(false, false);
    const { loadLabelFont, usesCanvasText } = await import("../pixi/renderers/labelFont");
    expect(usesCanvasText(font("Fira Sans"), "Hi")).toBe(false); // face still loading: Roboto
    await loadLabelFont(font("Fira Sans"));
    expect(usesCanvasText(font("Fira Sans"), "Hi")).toBe(true);
    vi.doUnmock("../pixi/renderers/rasterFont/rasterMsdf");
  });

  it("switches to the atlas when it exists and holds every character", async () => {
    fira();
    withAtlas(true, true);
    const { loadLabelFont, usesCanvasText } = await import("../pixi/renderers/labelFont");
    await loadLabelFont(font("Fira Sans"));
    expect(usesCanvasText(font("Fira Sans"), "Hi")).toBe(false);
    vi.doUnmock("../pixi/renderers/rasterFont/rasterMsdf");
  });

  it("keeps canvas text for a text the atlas does not cover yet, so no character disappears", async () => {
    fira();
    withAtlas(true, false);
    const { loadLabelFont, usesCanvasText } = await import("../pixi/renderers/labelFont");
    await loadLabelFont(font("Fira Sans"));
    expect(usesCanvasText(font("Fira Sans"), "Ω")).toBe(true);
    vi.doUnmock("../pixi/renderers/rasterFont/rasterMsdf");
  });

  it("stays canvas text for a font with MSDF conversion switched off, even when an atlas exists", async () => {
    fira();
    withAtlas(true, true);
    const { loadLabelFont, usesCanvasText } = await import("../pixi/renderers/labelFont");
    await loadLabelFont(font("Fira Sans"));
    expect(usesCanvasText({ ...font("Fira Sans"), msdf: false }, "Hi")).toBe(true);
    vi.doUnmock("../pixi/renderers/rasterFont/rasterMsdf");
  });

  it("is never canvas text for the default or a baked MSDF font", async () => {
    withAtlas(false, false);
    const { usesCanvasText } = await import("../pixi/renderers/labelFont");
    expect(usesCanvasText(font(""), "Hi")).toBe(false);
    expect(usesCanvasText(font("msdf:fira-sans"), "Hi")).toBe(false);
    vi.doUnmock("../pixi/renderers/rasterFont/rasterMsdf");
  });

  it("changes the metrics cache key when a browser font finishes loading", async () => {
    mockFontEnvironment((name) => name.includes("Metric") ? 110 : name.includes("monospace") ? 100 : 80);
    const { loadLabelFont, labelFontMetricsKey } = await import("../pixi/renderers/labelFont");
    const before = labelFontMetricsKey();
    await expect(loadLabelFont(font("Metric"))).resolves.toBe(true);
    expect(labelFontMetricsKey()).toBe(before + 1);
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
  const withLocalFonts = async (fonts: Array<{ family: string; style: string; blob: () => Promise<Blob> }>) => {
    (window as Window & { queryLocalFonts?: unknown }).queryLocalFonts = () => Promise.resolve(fonts);
    const mod = await import("../pixi/renderers/labelFont");
    await mod.loadLocalFontFamilies();
    return mod;
  };
  afterEach(() => { delete (window as Window & { queryLocalFonts?: unknown }).queryLocalFonts; });

  it("offers exactly the normal-style weights the machine reports for a family, ascending", async () => {
    mockFontEnvironment(() => 80);
    const blob = () => Promise.resolve(new Blob());
    const { rasterFontWeights } = await withLocalFonts([
      { family: "Fira Sans", style: "Bold", blob },
      { family: "Fira Sans", style: "Light", blob },
      { family: "Fira Sans", style: "Regular", blob },
      { family: "Fira Sans", style: "Bold Italic", blob },
      { family: "Fira Sans", style: "Condensed", blob },
      { family: "Arial", style: "Regular", blob },
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
