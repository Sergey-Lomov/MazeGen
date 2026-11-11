import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VECTOR_BY_WALLS_SETTINGS as BASE_WALLS_SETTINGS } from "../store/slices/imageExportDefaults";

// Floor labels are disabled by default; the renderer is exercised enabled.
const DEFAULT_VECTOR_BY_WALLS_SETTINGS = { ...BASE_WALLS_SETTINGS, floorLabel: { ...BASE_WALLS_SETTINGS.floorLabel, enabled: true } };

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

class FakeGraphics {
  readonly commands: { kind: string; args: number[] }[] = [];
  rect(...args: number[]) { this.commands.push({ kind: "rect", args }); return this; }
  moveTo(...args: number[]) { this.commands.push({ kind: "moveTo", args }); return this; }
  lineTo(...args: number[]) { this.commands.push({ kind: "lineTo", args }); return this; }
  arcTo(...args: number[]) { this.commands.push({ kind: "arcTo", args }); return this; }
  closePath() { this.commands.push({ kind: "closePath", args: [] }); return this; }
  fill(...args: unknown[]) { this.commands.push({ kind: "fill", args: args as number[] }); return this; }
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
  Graphics: FakeGraphics,
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

  it("renders the active floor title in title mode", () => {
    renderer.render({
      ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.floorLabel,
      labelMode: "title",
      backgroundShape: "none",
    }, { x: 100, y: 200 }, 0, 2, 0xffffff, "Ground");

    const layer = root.children[0] as FakeContainer;
    const label = layer.children[0] as FakeBitmapText;
    expect(label.options.text).toBe("Ground");
  });

  it.each(["rectangle", "parallelogram"] as const)("keeps the %s backplate's gap and border sharp at zero corner radius", (backgroundShape) => {
    renderer.render({
      ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.floorLabel,
      backgroundShape,
      cornerRadius: 0,
      gap: 4,
      borderWidth: 2,
    }, { x: 100, y: 200 }, 0, 2, 0xffffff);

    const layer = root.children[0] as FakeContainer;
    const body = layer.children[0] as FakeGraphics;
    if (backgroundShape === "rectangle") {
      expect(body.commands.filter(({ kind }) => kind === "rect")).toHaveLength(3);
    } else {
      expect(body.commands.filter(({ kind }) => kind === "arcTo").every(({ args }) => args.at(-1) === 0)).toBe(true);
    }
  });

  it("expands non-zero rectangular corner radii through the border and gap", () => {
    renderer.render({
      ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.floorLabel,
      backgroundShape: "rectangle",
      cornerRadius: 3,
      gap: 4,
      borderWidth: 2,
    }, { x: 100, y: 200 }, 0, 2, 0xffffff);

    const layer = root.children[0] as FakeContainer;
    const body = layer.children[0] as FakeGraphics;
    const radii = body.commands
      .filter(({ kind }) => kind === "arcTo")
      .map(({ args }) => args.at(-1));
    expect(radii).toEqual([9, 9, 9, 9, 5, 5, 5, 5, 3, 3, 3, 3]);
  });
});
