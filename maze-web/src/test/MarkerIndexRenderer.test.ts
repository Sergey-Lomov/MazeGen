import { describe, it, expect, vi } from "vitest";
import { TILE_SIZE } from "../pixi/constants";
import type { MarkerIndexLabel } from "../pixi/selectors/mazeSelectors/markerIndex";
import type { MarkerIndexSettings } from "../store/imageExportTypes";

// Minimal pixi stubs — the renderer only calls `roundRect().fill().stroke()` on `Graphics`,
// `CanvasTextMetrics.measureText` for width, and constructs `Text`/`TextStyle`. Same
// mocked-pixi convention as `VerticalConnectionRenderer.test.ts`.
type RoundRect = { x: number; y: number; w: number; h: number; r: number };
interface FakeGraphics {
  roundRectCalls: RoundRect[];
  fillCalls: number[];
  strokeCalls: { color?: number; width?: number }[];
  roundRect: (x: number, y: number, w: number, h: number, r: number) => FakeGraphics;
  fill: (c: number) => FakeGraphics;
  stroke: (a: { color?: number; width?: number }) => FakeGraphics;
  destroy: () => void;
}
interface FakeText {
  text: string;
  x: number;
  y: number;
  anchor: { set: (v: number) => void };
  destroy: () => void;
}

vi.mock("pixi.js", () => ({
  Container: vi.fn().mockImplementation(function (this: { children: unknown[]; addChild: (c: unknown) => void; removeChildren: () => unknown[]; destroy: () => void }) {
    this.children = [];
    this.addChild = (c) => { this.children.push(c); };
    this.removeChildren = () => { const c = this.children; this.children = []; return c; };
    this.destroy = vi.fn();
  }),
  Graphics: vi.fn().mockImplementation(function (this: FakeGraphics) {
    this.roundRectCalls = [];
    this.fillCalls = [];
    this.strokeCalls = [];
    this.roundRect = (x, y, w, h, r) => { this.roundRectCalls.push({ x, y, w, h, r }); return this; };
    this.fill = (c) => { this.fillCalls.push(c); return this; };
    this.stroke = (a) => { this.strokeCalls.push(a); return this; };
    this.destroy = vi.fn();
  }),
  Text: vi.fn().mockImplementation(function (this: FakeText, opts: { text: string }) {
    this.text = opts.text;
    this.x = 0;
    this.y = 0;
    this.anchor = { set: vi.fn() };
    this.destroy = vi.fn();
  }),
  TextStyle: vi.fn().mockImplementation(function (this: Record<string, unknown>, opts: Record<string, unknown>) {
    Object.assign(this, opts);
  }),
  CanvasTextMetrics: {
    // Width scales with text length so the widest label reliably wins, no real font needed.
    measureText: (text: string, style: { fontSize: number }) => ({ width: text.length * style.fontSize * 0.6 }),
  },
}));

const { MarkerIndexRenderer } = await import("../pixi/renderers/MarkerIndexRenderer");
const { Container } = await import("pixi.js");

function style(patch: Partial<MarkerIndexSettings> = {}): MarkerIndexSettings {
  return {
    enabled: true,
    labelStyle: "arabic",
    height: 0.35,
    offset: 0,
    cornerRadius: 0.03,
    paddingX: 0.04,
    gap: 3,
    fillColor: 0xf0c900,
    textColor: 0x333333,
    borderColor: 0x444444,
    borderColorFromMarker: false,
    borderWidth: 2,
    fontWeight: "bold",
    coverage: { singleFloorTeleport: true, crossFloorTeleport: true, verticalPassage: true, elevator: true },
    ...patch,
  };
}

const label = (patch: Partial<MarkerIndexLabel> = {}): MarkerIndexLabel => ({
  pos: [100, 200],
  label: "1",
  markerOuterRadius: 10,
  borderMatchColor: 0xabcdef,
  ...patch,
});

function makeRenderer() {
  const gapContainer = new Container() as unknown as { children: FakeGraphics[] };
  const bodyContainer = new Container() as unknown as { children: (FakeGraphics | FakeText)[] };
  const renderer = new MarkerIndexRenderer(gapContainer as never, bodyContainer as never);
  // The renderer nests one own Container inside each caller container.
  const gapLayer = () => (gapContainer.children[0] as unknown as { children: FakeGraphics[] }).children;
  const bodyLayer = () => (bodyContainer.children[0] as unknown as { children: (FakeGraphics | FakeText)[] }).children;
  return { renderer, gapLayer, bodyLayer };
}

describe("MarkerIndexRenderer.render", () => {
  it("draws nothing when disabled or when there are no labels", () => {
    const { renderer, gapLayer, bodyLayer } = makeRenderer();
    renderer.render({ labels: [label()], allLabelStrings: ["1"], style: style({ enabled: false }), floorColor: 0x000000 });
    expect(bodyLayer()).toHaveLength(0);
    renderer.render({ labels: [], allLabelStrings: [], style: style(), floorColor: 0x000000 });
    expect(bodyLayer()).toHaveLength(0);
    expect(gapLayer()).toHaveLength(0);
  });

  it("positions the plate so its center sits markerOuterRadius + offset below the cell center", () => {
    const { renderer, bodyLayer } = makeRenderer();
    renderer.render({ labels: [label({ pos: [100, 200], markerOuterRadius: 10 })], allLabelStrings: ["1"], style: style({ offset: 0.1, height: 0.35 }), floorColor: 0x000000 });
    const plate = bodyLayer()[0] as FakeGraphics;
    const { y, h } = plate.roundRectCalls[0];
    const plateCenterY = y + h / 2;
    expect(plateCenterY).toBeCloseTo(200 + 10 + 0.1 * TILE_SIZE);
    expect(h).toBeCloseTo(0.35 * TILE_SIZE);
  });

  it("sizes the plate width to the widest label across the whole project", () => {
    const { renderer, bodyLayer } = makeRenderer();
    renderer.render({ labels: [label({ label: "1" })], allLabelStrings: ["1", "8888"], style: style({ paddingX: 0.04 }), floorColor: 0x000000 });
    const plate = bodyLayer()[0] as FakeGraphics;
    const fontSize = 0.35 * TILE_SIZE * 0.72;
    const widest = 4 * fontSize * 0.6; // "8888"
    expect(plate.roundRectCalls[0].w).toBeCloseTo(widest + 2 * 0.04 * TILE_SIZE);
  });

  it("draws a floor-colored gap ring outset by gap + borderWidth/2, below the body", () => {
    const { renderer, gapLayer, bodyLayer } = makeRenderer();
    renderer.render({ labels: [label()], allLabelStrings: ["1"], style: style({ gap: 4, borderWidth: 2 }), floorColor: 0x123456 });
    const ring = gapLayer()[0] as FakeGraphics;
    const body = bodyLayer()[0] as FakeGraphics;
    const outset = 4 + 2 / 2;
    expect(ring.fillCalls[0]).toBe(0x123456);
    expect(ring.roundRectCalls[0].x).toBeCloseTo(body.roundRectCalls[0].x - outset);
    expect(ring.roundRectCalls[0].w).toBeCloseTo(body.roundRectCalls[0].w + 2 * outset);
  });

  it("omits the gap ring entirely when gap is 0", () => {
    const { renderer, gapLayer } = makeRenderer();
    renderer.render({ labels: [label()], allLabelStrings: ["1"], style: style({ gap: 0 }), floorColor: 0x123456 });
    expect(gapLayer()).toHaveLength(0);
  });

  it("takes the plate border color from the marker when borderColorFromMarker is on", () => {
    const { renderer, bodyLayer } = makeRenderer();
    renderer.render({ labels: [label({ borderMatchColor: 0xfeed01 })], allLabelStrings: ["1"], style: style({ borderColorFromMarker: true, borderWidth: 2, borderColor: 0x444444 }), floorColor: 0x000000 });
    const plate = bodyLayer()[0] as FakeGraphics;
    expect(plate.strokeCalls[0].color).toBe(0xfeed01);
  });

  it("uses the configured borderColor when borderColorFromMarker is off, and no stroke at borderWidth 0", () => {
    const { renderer, bodyLayer } = makeRenderer();
    renderer.render({ labels: [label()], allLabelStrings: ["1"], style: style({ borderColorFromMarker: false, borderColor: 0x010203, borderWidth: 2 }), floorColor: 0x000000 });
    expect((bodyLayer()[0] as FakeGraphics).strokeCalls[0].color).toBe(0x010203);

    const { renderer: r2, bodyLayer: b2 } = makeRenderer();
    r2.render({ labels: [label()], allLabelStrings: ["1"], style: style({ borderWidth: 0 }), floorColor: 0x000000 });
    expect((b2()[0] as FakeGraphics).strokeCalls).toHaveLength(0);
  });

  it("clear() removes every drawn plate from both layers", () => {
    const { renderer, gapLayer, bodyLayer } = makeRenderer();
    renderer.render({ labels: [label(), label({ pos: [300, 300] })], allLabelStrings: ["1", "2"], style: style({ gap: 3 }), floorColor: 0x000000 });
    expect(bodyLayer().length).toBeGreaterThan(0);
    renderer.clear();
    expect(gapLayer()).toHaveLength(0);
    expect(bodyLayer()).toHaveLength(0);
  });
});
