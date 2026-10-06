import { describe, expect, it, vi } from "vitest";

const pixi = vi.hoisted(() => ({
  images: [] as FakeImage[],
  textures: [] as unknown[],
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

const FakeContainer = vi.hoisted(() => class FakeContainer {
  parent: FakeContainer | null = null;
  children: unknown[] = [];
  visible = true;
  eventMode = "none";
  x = 0;
  y = 0;

  addChild(child: unknown): unknown {
    this.children.push(child);
    if (child && typeof child === "object") (child as { parent?: FakeContainer }).parent = this;
    return child;
  }

  getChildIndex(child: unknown): number { return this.children.indexOf(child); }

  setChildIndex(child: unknown, index: number): void {
    const current = this.getChildIndex(child);
    if (current < 0) return;
    this.children.splice(current, 1);
    this.children.splice(index, 0, child);
  }

  destroy(): void {}
});

vi.mock("pixi.js", () => ({
  Container: FakeContainer,
  Graphics: class {
    clear() { return this; }
    rect() { return this; }
    circle() { return this; }
    stroke() { return this; }
    fill() { return this; }
  },
  Rectangle: class {
    constructor(public x: number, public y: number, public width: number, public height: number) {}
  },
  Sprite: class {
    visible = true;
    position = { set: vi.fn() };
    scale = { set: vi.fn() };
    anchor = { set: vi.fn() };
    destroy = vi.fn();
    constructor() { pixi.sprites.push(this); }
  },
  Texture: class {
    static from = vi.fn(() => ({ source: {} }));
    destroy = vi.fn();
    constructor(options?: unknown) { pixi.textures.push(options); }
  },
}));

vi.mock("../pixi/tessellationGeometry", () => ({
  getCellVertices: vi.fn(),
}));

vi.stubGlobal("Image", FakeImage);

import {
  BACKGROUND_IMAGE_ALPHA,
  BackgroundImageHost,
  BackgroundImageLayer,
  backgroundImageChanged,
  calculateBackgroundImageLayout,
  calculateBackgroundImagePageLayout,
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
  layer: "below_grid" as const,
  opacity: 0.5,
};

describe("underlay layout", () => {
  it("returns no bounds for an empty field", () => {
    expect(fieldBounds([], { type: "square_custom", points: [] })).toBeNull();
  });

  it("uses 50% opacity", () => {
    expect(BACKGROUND_IMAGE_ALPHA).toBe(0.5);
  });

  it("detects only underlay state changes", () => {
    const state = {
      showBackgroundImage: true,
      backgroundImage: baseImage,
      backgroundImageManualPositioning: false,
      backgroundImageCropping: false,
    };

    expect(backgroundImageChanged(state as never, state as never)).toBe(false);
    expect(backgroundImageChanged(state as never, { ...state, backgroundImageCropping: true } as never)).toBe(true);
  });

  it("hosts the shared layer and renders from store state", async () => {
    pixi.images.length = 0;
    const root = new FakeContainer();
    const imageContainer = new FakeContainer();
    const floorContainer = new FakeContainer();
    const gridContainer = new FakeContainer();
    const anchorContainer = new FakeContainer();
    root.addChild(imageContainer);
    root.addChild(floorContainer);
    root.addChild(gridContainer);
    root.addChild(anchorContainer);
    const host = new BackgroundImageHost({
      image: imageContainer as never,
      floor: floorContainer as never,
      grid: gridContainer as never,
      layerAnchor: anchorContainer as never,
    });

    host.render({
      openCard: "post_edit",
      activeFloorId: "floor-1",
      floorFields: {},
      showBackgroundImage: true,
      backgroundImage: baseImage,
      backgroundImageManualPositioning: false,
      backgroundImageCropping: false,
    } as never);
    pixi.images[0].onload?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(pixi.sprites).toHaveLength(1);
    host.destroy();
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

  it("renders only the persisted source crop in the sprite texture", async () => {
    pixi.images.length = 0;
    pixi.sprites.length = 0;
    pixi.textures.length = 0;
    const layer = new BackgroundImageLayer({ addChild: vi.fn() } as never);
    layer.render({ ...baseImage, cropX: 10, cropY: 20, cropWidth: 40, cropHeight: 30 }, true);

    pixi.images[0].onload?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(pixi.textures[0]).toMatchObject({
      frame: { x: 10, y: 20, width: 40, height: 30 },
      orig: { x: 0, y: 0, width: 40, height: 30 },
    });
    layer.destroy();
  });

  it("fits inside the field while preserving the source aspect ratio", () => {
    const image = calculateBackgroundImageLayout(
      "data:image/png;base64,abc",
      200,
      100,
      { minX: -50, minY: -50, maxX: 50, maxY: 50 },
    );

    expect(image.displayWidth).toBe(100);
    expect(image.displayHeight).toBe(50);
    expect(image.centerX).toBe(0);
    expect(image.centerY).toBe(0);
  });

  it("fits the selected crop instead of the complete source image", () => {
    const image = calculateBackgroundImageLayout(
      "data:image/png;base64,abc",
      1000,
      1000,
      { minX: -50, minY: -50, maxX: 50, maxY: 50 },
      { x: 100, y: 200, width: 200, height: 100 },
    );

    expect(image).toMatchObject({
      cropX: 100,
      cropY: 200,
      cropWidth: 200,
      cropHeight: 100,
      displayWidth: 100,
      displayHeight: 50,
      centerX: 0,
      centerY: 0,
    });
  });

  it("leaves empty space in the shorter field dimension instead of cropping the image", () => {
    const image = calculateBackgroundImageLayout(
      "data:image/png;base64,abc",
      100,
      200,
      { minX: -100, minY: -25, maxX: 100, maxY: 25 },
    );

    expect(image.displayWidth).toBe(25);
    expect(image.displayHeight).toBe(50);
    expect(image.displayHeight / image.displayWidth).toBe(2);
  });

  it("fits the image to the shared paper page, preserving aspect ratio and centering it", () => {
    const image = calculateBackgroundImagePageLayout(
      baseImage.dataUrl,
      200,
      100,
      { type: "square" },
      {
        density: "screen_96",
        paperSize: "a4",
        customWidthMm: 210,
        customHeightMm: 297,
        orientation: "portrait",
        marginHMm: 5,
        marginVMm: 5,
        scale: 1,
        scaleAutoFit: true,
        anchor: "center",
        offsetXMm: 0,
        offsetYMm: 0,
      },
    );

    expect(image.centerX).toBe(0);
    expect(image.centerY).toBe(0);
    expect(image.displayHeight / image.displayWidth).toBe(0.5);
    expect(image.displayWidth).toBeGreaterThan(0);

    const noMargins = calculateBackgroundImagePageLayout(
      baseImage.dataUrl,
      200,
      100,
      { type: "square" },
      {
        density: "screen_96",
        paperSize: "a4",
        customWidthMm: 210,
        customHeightMm: 297,
        orientation: "portrait",
        marginHMm: 0,
        marginVMm: 0,
        scale: 1,
        scaleAutoFit: true,
        anchor: "center",
        offsetXMm: 0,
        offsetYMm: 0,
      },
    );
    expect(image.displayWidth).toBeLessThan(noMargins.displayWidth);
  });

  it("rejects non-finite page geometry instead of persisting an invalid transform", () => {
    expect(() => calculateBackgroundImagePageLayout(
      baseImage.dataUrl,
      200,
      100,
      { type: "square" },
      {
        density: "screen_96",
        paperSize: "a4",
        customWidthMm: 210,
        customHeightMm: 297,
        orientation: "portrait",
        marginHMm: Number.NaN,
        marginVMm: 5,
        scale: 1,
        scaleAutoFit: true,
        anchor: "center",
        offsetXMm: 0,
        offsetYMm: 0,
      },
    )).toThrow("Paper layout has invalid dimensions");
  });

  it("keeps the above-grid image between grid and floor containers", () => {
    const root = new FakeContainer();
    const imageContainer = new FakeContainer();
    const gridContainer = new FakeContainer();
    const floorContainer = new FakeContainer();
    const overlayContainer = new FakeContainer();
    root.addChild(imageContainer);
    root.addChild(gridContainer);
    root.addChild(floorContainer);
    root.addChild(overlayContainer);
    const layer = new BackgroundImageLayer(
      imageContainer as never,
      floorContainer as never,
      gridContainer as never,
      overlayContainer as never,
    );

    layer.render({ ...baseImage, layer: "above_grid" }, false);

    expect(root.children[0]).toBe(gridContainer);
    expect(root.children[1]).toBe(imageContainer);
    expect(root.children[2]).toBe(floorContainer);
    layer.render({ ...baseImage, layer: "above_floor" }, false);

    expect(root.children[0]).toBe(gridContainer);
    expect(root.children[1]).toBe(floorContainer);
    expect(root.children[2]).toBe(imageContainer);
    expect(root.children[3]).toBe(overlayContainer);
    layer.render({ ...baseImage, layer: "below_grid" }, false);
    expect(root.children[0]).toBe(imageContainer);
    expect(root.children[1]).toBe(gridContainer);
    layer.render({ ...baseImage, layer: "above_everything" }, false);
    expect(root.children[0]).toBe(gridContainer);
    expect(root.children[1]).toBe(floorContainer);
    expect(root.children[2]).toBe(overlayContainer);
    expect(root.children[3]).toBe(imageContainer);
    layer.destroy();
  });
});
