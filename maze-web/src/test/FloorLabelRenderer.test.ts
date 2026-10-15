import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VECTOR_BY_WALLS_SETTINGS } from "../store/slices/imageExportDefaults";

class FakeContainer {
  children: unknown[] = [];
  addChild<T>(child: T): T { this.children.push(child); return child; }
  removeChildren(): any[] { return this.children.splice(0); }
  destroy = vi.fn();
}

class FakeBitmapText {
  x = 0;
  y = 0;
  anchor = { set: vi.fn() };
  pivot = { y: 0 };
  destroy = vi.fn();
  constructor(public readonly options: { text: string; style: Record<string, unknown> }) {}
}

const glyph = { xAdvance: 50, xOffset: 0, yOffset: 10, texture: { orig: { width: 58, height: 48 } } };
const font = {
  baseMeasurementFontSize: 100,
  baseLineOffset: 0,
  lineHeight: 60,
  chars: { A: glyph } as Record<string, typeof glyph>,
};

vi.mock("pixi.js", () => ({
  Container: FakeContainer,
  Graphics: class {},
  BitmapText: FakeBitmapText,
  Cache: { get: (key: string) => key.endsWith("-bitmap") ? font : undefined },
}));

const { FloorLabelRenderer } = await import("../pixi/renderers/FloorLabelRenderer");

describe("FloorLabelRenderer", () => {
  let root: FakeContainer;
  let renderer: InstanceType<typeof FloorLabelRenderer>;

  beforeEach(() => {
    root = new FakeContainer();
    renderer = new FloorLabelRenderer(root as never);
  });

  it.each([
    ["left", 57.1],
    ["center", 100],
    ["right", 142.1],
  ] as const)("places %s-aligned glyph ink inside the unchanged frame", (textAlignment, expectedX) => {
    renderer.render({
      ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.floorLabel,
      prefix: "",
      labelType: "letters",
      backgroundShape: "none",
      width: 100,
      height: 40,
      textMargin: 5,
      textSize: 10,
      textAlignment,
    }, { x: 100, y: 200 }, 0, 2, 0xffffff);

    const layer = root.children[0] as FakeContainer;
    const label = layer.children[0] as FakeBitmapText;
    expect(label.x).toBeCloseTo(expectedX);
    expect(label.y).toBe(200);
  });
});
