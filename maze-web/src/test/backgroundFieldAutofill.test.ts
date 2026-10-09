import { describe, expect, it, vi } from "vitest";

vi.mock("../pixi/tessellationGeometry", () => ({
  getCellVertices: (x: number, y: number) => [
    { x: x * 40, y: -(y + 1) * 40 },
    { x: (x + 1) * 40, y: -(y + 1) * 40 },
    { x: (x + 1) * 40, y: -y * 40 },
    { x: x * 40, y: -y * 40 },
  ],
  pointInPolygon: (point: { x: number; y: number }, vertices: { x: number; y: number }[]) => {
    return point.x >= Math.min(...vertices.map((v) => v.x))
      && point.x <= Math.max(...vertices.map((v) => v.x))
      && point.y >= Math.min(...vertices.map((v) => v.y))
      && point.y <= Math.max(...vertices.map((v) => v.y));
  },
}));

import { buildBackgroundFieldPreview, buildBackgroundFieldPreviewFromImage, getBackgroundImageTopLeftColor, topLeftPixelColor } from "../pixi/backgroundFieldAutofill";
import { encodePoint } from "../pixi/tessellationProjection";

const image = {
  dataUrl: "data:image/png;base64,test",
  naturalWidth: 2,
  naturalHeight: 2,
  displayWidth: 40,
  displayHeight: 40,
  centerX: 20,
  centerY: -20,
  layer: "below_grid" as const,
  opacity: 0.5,
};

const config = { type: "square_custom" as const, points: [] };

describe("buildBackgroundFieldPreview", () => {
  it("falls back to white for an invalid pixel buffer", () => {
    expect(topLeftPixelColor({ data: new Uint8ClampedArray(), width: 0, height: 0 })).toBe(0xffffff);
    expect(buildBackgroundFieldPreview(image, config, {
      data: new Uint8ClampedArray(3),
      width: 1,
      height: 1,
    }, "transparent", 0xffffff, 0.5)).toEqual(new Set());
  });

  it("reads the default selected color from the top-left pixel", () => {
    expect(topLeftPixelColor({
      data: new Uint8ClampedArray([0x12, 0x34, 0x56, 255]),
      width: 1,
      height: 1,
    })).toBe(0x123456);
  });

  it("uses the displayed image alignment and transparent pixels", () => {
    const pixels = new Uint8ClampedArray([
      255, 0, 0, 255, 255, 0, 0, 255,
      255, 0, 0, 255, 255, 0, 0, 0,
    ]);

    const result = buildBackgroundFieldPreview(image, config, { data: pixels, width: 2, height: 2 }, "transparent", 0xffffff, 0.5);

    expect(result).toEqual(new Set([encodePoint(0, 0)]));
  });

  it("treats pixels close to the selected RGB color as background", () => {
    const pixels = new Uint8ClampedArray([
      250, 250, 250, 255, 255, 0, 0, 255,
      255, 0, 0, 255, 250, 250, 250, 255,
    ]);

    const result = buildBackgroundFieldPreview(image, config, { data: pixels, width: 2, height: 2 }, "color", 0xffffff, 0.49);

    expect(result).toEqual(new Set([encodePoint(0, 0)]));
  });

  it("counts the part of a cell outside the image as background", () => {
    const partialImage = { ...image, displayWidth: 20, centerX: 10 };
    const pixels = new Uint8ClampedArray([
      255, 0, 0, 255, 255, 0, 0, 255,
      255, 0, 0, 255, 255, 0, 0, 255,
    ]);

    const result = buildBackgroundFieldPreview(partialImage, config, { data: pixels, width: 2, height: 2 }, "transparent", 0xffffff, 0.75);

    expect(result).not.toContain(encodePoint(0, 0));
  });

  it("classifies large cells deterministically", () => {
    const largeImage = {
      ...image,
      naturalWidth: 4000,
      naturalHeight: 4000,
      displayWidth: 400,
      displayHeight: 400,
      centerX: 200,
      centerY: -200,
    };
    const pixels = new Uint8ClampedArray(4000 * 4000 * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      pixels[offset] = 255;
      pixels[offset + 3] = 255;
    }
    const result = buildBackgroundFieldPreview(
      largeImage,
      config,
      { data: pixels, width: 4000, height: 4000 },
      "transparent",
      0xffffff,
      0.5,
    );

    expect(result).toContain(encodePoint(0, 0));
  });

  it("refines cells near the threshold deterministically", () => {
    const largeImage = {
      ...image,
      naturalWidth: 4000,
      naturalHeight: 4000,
      displayWidth: 400,
      displayHeight: 400,
      centerX: 200,
      centerY: -200,
    };
    const pixels = new Uint8ClampedArray(4000 * 4000 * 4);
    for (let sourceY = 0; sourceY < 4000; sourceY++) {
      for (let sourceX = 0; sourceX < 2200; sourceX++) {
        const offset = (sourceY * 4000 + sourceX) * 4;
        pixels[offset] = 255;
        pixels[offset + 3] = 255;
      }
    }
    const first = buildBackgroundFieldPreview(largeImage, config, { data: pixels, width: 4000, height: 4000 }, "transparent", 0xffffff, 0.5);
    const second = buildBackgroundFieldPreview(largeImage, config, { data: pixels, width: 4000, height: 4000 }, "transparent", 0xffffff, 0.5);

    expect(first).toEqual(second);
    expect(first).toContain(encodePoint(0, 0));
  });

  it("reads the top-left source pixel and builds from decoded image data", async () => {
    class FakeImage {
      naturalWidth = 2;
      naturalHeight = 2;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) { this.onload?.(); }
    }
    const context = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray([
          0x12, 0x34, 0x56, 255, 255, 0, 0, 255,
          255, 0, 0, 255, 255, 0, 0, 255,
        ]),
      })),
    };
    const canvas = { width: 0, height: 0, getContext: () => context };
    const originalCreateElement = document.createElement.bind(document);
    const createElement = vi.spyOn(document, "createElement").mockImplementation((tagName, options) => (
      tagName === "canvas" ? canvas as unknown as HTMLCanvasElement : originalCreateElement(tagName, options)
    ));
    vi.stubGlobal("Image", FakeImage);

    try {
      await expect(getBackgroundImageTopLeftColor(image.dataUrl)).resolves.toBe(0x123456);
      await expect(buildBackgroundFieldPreviewFromImage(image, config, "transparent", 0xffffff, 0.5)).resolves.toBeInstanceOf(Set);
      expect(context.drawImage).toHaveBeenCalledTimes(1);
    } finally {
      createElement.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("does not keep a rejected image decode in the pixel cache", async () => {
    const dataUrl = "data:image/png;base64,cache-error";
    let shouldFail = true;
    class FakeImage {
      naturalWidth = 1;
      naturalHeight = 1;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        (shouldFail ? this.onerror : this.onload)?.();
      }
    }
    const context = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([0x12, 0x34, 0x56, 255]) })),
    };
    const canvas = { width: 0, height: 0, getContext: () => context };
    const originalCreateElement = document.createElement.bind(document);
    const createElement = vi.spyOn(document, "createElement").mockImplementation((tagName, options) => (
      tagName === "canvas" ? canvas as unknown as HTMLCanvasElement : originalCreateElement(tagName, options)
    ));
    vi.stubGlobal("Image", FakeImage);

    try {
      await expect(getBackgroundImageTopLeftColor(dataUrl)).rejects.toThrow("Failed to load underlay");
      shouldFail = false;
      await expect(getBackgroundImageTopLeftColor(dataUrl)).resolves.toBe(0x123456);
      expect(context.drawImage).toHaveBeenCalledTimes(1);
    } finally {
      createElement.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
