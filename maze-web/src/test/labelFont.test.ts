import { afterEach, describe, expect, it, vi } from "vitest";

const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
const originalGetContext = HTMLCanvasElement.prototype.getContext;

afterEach(() => {
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  vi.resetModules();
});

function mockFontEnvironment(widthFor: (font: string) => number) {
  const load = vi.fn().mockResolvedValue([]);
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load, check: vi.fn().mockReturnValue(true) },
  });
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
    font: "",
    measureText(this: { font: string }) { return { width: widthFor(this.font) }; },
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  return load;
}

describe("loadLabelFontFamily", () => {
  it("rejects a missing family even when Font Loading API reports its generic fallback as available", async () => {
    mockFontEnvironment((font) => font.includes("Missing") || font.includes("monospace") ? 100 : 80);
    const { loadLabelFontFamily, isLabelFontFamilyLoaded } = await import("../pixi/renderers/labelFont");

    await expect(loadLabelFontFamily("Missing")).resolves.toBe(false);
    expect(isLabelFontFamilyLoaded("Missing")).toBe(false);
  });

  it("shares concurrent loading of the same real family", async () => {
    const load = mockFontEnvironment((font) => font.includes("Fira Sans") ? 110 : font.includes("monospace") ? 100 : 80);
    const { loadLabelFontFamily, isLabelFontFamilyLoaded } = await import("../pixi/renderers/labelFont");

    await expect(Promise.all([loadLabelFontFamily("Fira Sans"), loadLabelFontFamily("Fira Sans")])).resolves.toEqual([true, true]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(isLabelFontFamilyLoaded("Fira Sans")).toBe(true);
  });
});
