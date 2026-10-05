import { describe, expect, it, vi } from "vitest";

const pixi = vi.hoisted(() => ({
  images: [] as FakeImage[],
  sprites: [] as Array<{
    position: { set: ReturnType<typeof vi.fn> };
    alpha?: number;
  }>,
}));

class FakeImage {
  naturalWidth = 100;
  naturalHeight = 100;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) { pixi.images.push(this); }
}

vi.mock("pixi.js", () => ({
  Container: class { addChild = vi.fn(); },
  Sprite: class {
    visible = true;
    position = { set: vi.fn() };
    scale = { set: vi.fn() };
    anchor = { set: vi.fn() };
    destroy = vi.fn();
    constructor() { pixi.sprites.push(this); }
  },
  Texture: { from: vi.fn(() => ({})) },
}));

vi.mock("../pixi/tessellationGeometry", () => ({
  getCellVertices: vi.fn(),
}));

vi.stubGlobal("Image", FakeImage);

import {
  BACKGROUND_IMAGE_ALPHA,
  BackgroundImageLayer,
  calculateBackgroundImageLayout,
  fieldBounds,
} from "../pixi/BackgroundImageLayer";

const baseImage = {
  dataUrl: "data:image/png;base64,abc",
  naturalWidth: 100,
  naturalHeight: 100,
  displayWidth: 200,
  displayHeight: 200,
  centerX: 0,
  centerY: 0,
};

describe("underlay layout", () => {
  it("returns no bounds for an empty field", () => {
    expect(fieldBounds([], { type: "square_custom", points: [] })).toBeNull();
  });

  it("uses 50% opacity", () => {
    expect(BACKGROUND_IMAGE_ALPHA).toBe(0.5);
  });

  it("uses the latest layout if the image finishes loading after a recalculation", async () => {
    pixi.images.length = 0;
    pixi.sprites.length = 0;
    const layer = new BackgroundImageLayer({ addChild: vi.fn() } as never);
    layer.render(baseImage, true);
    layer.render({ ...baseImage, centerX: 20, centerY: -10 }, true);

    pixi.images[0].onload?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(pixi.sprites).toHaveLength(1);
    expect(pixi.sprites[0].position.set).toHaveBeenCalledWith(20, -10);
    expect(pixi.sprites[0].alpha).toBe(0.5);
    layer.destroy();
  });

  it("covers the field while preserving the source aspect ratio", () => {
    const image = calculateBackgroundImageLayout(
      "data:image/png;base64,abc",
      200,
      100,
      { minX: -50, minY: -50, maxX: 50, maxY: 50 },
    );

    expect(image.displayWidth).toBe(200);
    expect(image.displayHeight).toBe(100);
    expect(image.centerX).toBe(0);
    expect(image.centerY).toBe(0);
  });

  it("lets the image extend past the shorter field dimension", () => {
    const image = calculateBackgroundImageLayout(
      "data:image/png;base64,abc",
      100,
      200,
      { minX: -100, minY: -25, maxX: 100, maxY: 25 },
    );

    expect(image.displayWidth).toBe(200);
    expect(image.displayHeight).toBe(400);
    expect(image.displayHeight / image.displayWidth).toBe(2);
  });
});
