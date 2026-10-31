import { describe, it, expect, vi } from "vitest";
import type { MarkerIndexLabel } from "../pixi/selectors/mazeSelectors/markerIndex";
import type { MarkerIndexSettings } from "../store/imageExportTypes";

// Minimal pixi stubs — the renderer draws a closed rounded path, then calls `fill().stroke()` on `Graphics` and
// constructs `BitmapText` (GitHub issue #352 — MSDF label font), reading `.width` off a throwaway
// instance to size the plate. Same mocked-pixi convention as `VerticalConnectionRenderer.test.ts`.
type RoundRect = { x: number; y: number; w: number; h: number; r: number };
interface FakeGraphics {
  roundRectCalls: RoundRect[];
  pathPoints: number[];
  fillPathPoints: number[][];
  fillCalls: number[];
  strokeCalls: { color?: number; width?: number }[];
  roundRect: (x: number, y: number, w: number, h: number, r: number) => FakeGraphics;
  moveTo: (x: number, y: number) => FakeGraphics;
  lineTo: (x: number, y: number) => FakeGraphics;
  arcTo: (x: number, y: number, x2: number, y2: number, r: number) => FakeGraphics;
  closePath: () => FakeGraphics;
  fill: (c: number) => FakeGraphics;
  stroke: (a: { color?: number; width?: number }) => FakeGraphics;
  destroy: () => void;
}
interface FakeText {
  text: string;
  x: number;
  y: number;
  width: number;
  anchor: { set: (v: number) => void };
  pivot: { y: number };
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
    this.pathPoints = [];
    this.fillPathPoints = [];
    this.fillCalls = [];
    this.strokeCalls = [];
    this.roundRect = (x, y, w, h, r) => { this.roundRectCalls.push({ x, y, w, h, r }); return this; };
    this.moveTo = (x, y) => { this.pathPoints.push(x, y); return this; };
    this.lineTo = (x, y) => { this.pathPoints.push(x, y); return this; };
    this.arcTo = (_x, _y, x2, y2) => { this.pathPoints.push(x2, y2); return this; };
    this.closePath = () => this;
    this.fill = (c) => { this.fillCalls.push(c); this.fillPathPoints.push([...this.pathPoints]); this.pathPoints = []; return this; };
    this.stroke = (a) => { this.strokeCalls.push(a); return this; };
    this.destroy = vi.fn();
  }),
  BitmapText: vi.fn().mockImplementation(function (this: FakeText, opts: { text: string; style: { fontSize: number } }) {
    this.text = opts.text;
    this.x = 0;
    this.y = 0;
    // Width scales with text length so the widest label reliably wins, no real font needed.
    this.width = opts.text.length * opts.style.fontSize * 0.6;
    this.anchor = { set: vi.fn() };
    this.pivot = { y: 0 };
    this.destroy = vi.fn();
  }),
  Cache: { get: () => undefined },
}));

const { MarkerIndexRenderer } = await import("../pixi/renderers/MarkerIndexRenderer");
const { Container } = await import("pixi.js");

function style(patch: Partial<MarkerIndexSettings> = {}): MarkerIndexSettings {
  return {
    enabled: true,
    labelStyle: "arabic",
    height: 14,
    offset: 0,
    cornerRadius: 1.2,
    width: 16,
    textSize: 10, textMargin: 1,
    gap: 3,
    fillColor: 0xf0c900,
    textColor: 0x333333,
    borderColor: 0x444444,
    borderColorFromMarker: false,
    borderWidthFromMarker: false,
    borderWidth: 2,
    textFontWeight: "bold",
    coverage: { singleFloorTeleport: true, crossFloorTeleport: true, verticalPassage: true, elevator: true },
    ...patch,
  };
}

const label = (patch: Partial<MarkerIndexLabel> = {}): MarkerIndexLabel => ({
  pos: [100, 200],
  nodeId: 1,
  kind: "teleport",
  label: "1",
  markerOuterRadius: 10,
  markerBorderWidth: 2,
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

function pathBounds(points: number[]): { x: number; y: number; w: number; h: number } {
  const xs = points.filter((_, i) => i % 2 === 0);
  const ys = points.filter((_, i) => i % 2 === 1);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

describe("MarkerIndexRenderer.render", () => {
  it("draws nothing when disabled or when there are no labels", () => {
    const { renderer, gapLayer, bodyLayer } = makeRenderer();
    renderer.render({ labels: [label()], style: style({ enabled: false }), floorColor: 0x000000 });
    expect(bodyLayer()).toHaveLength(0);
    renderer.render({ labels: [], style: style(), floorColor: 0x000000 });
    expect(bodyLayer()).toHaveLength(0);
    expect(gapLayer()).toHaveLength(0);
  });

  it("positions the plate so its center sits markerOuterRadius + offset below the cell center", () => {
    const { renderer, bodyLayer } = makeRenderer();
    renderer.render({ labels: [label({ pos: [100, 200], markerOuterRadius: 10 })], style: style({ offset: 4, height: 14 }), floorColor: 0x000000 });
    const plate = bodyLayer()[0] as FakeGraphics;
    const { y, h } = pathBounds(plate.fillPathPoints.at(-1)!);
    const plateCenterY = y + h / 2;
    expect(plateCenterY).toBeCloseTo(200 + 10 + 4);
    expect(h).toBeCloseTo(14);
  });

  it("draws a fixed-width plate that does not depend on the label text", () => {
    const { renderer, bodyLayer } = makeRenderer();
    renderer.render({ labels: [label({ label: "1" }), label({ label: "8888", pos: [300, 300] })], style: style({ width: 12 }), floorColor: 0x000000 });
    const plates = bodyLayer().filter((c) => (c as FakeGraphics).fillPathPoints) as FakeGraphics[];
    expect(plates).toHaveLength(2);
    for (const plate of plates) expect(pathBounds(plate.fillPathPoints.at(-1)!).w).toBeCloseTo(12);
  });

  it("draws a floor-colored gap ring outset by gap + borderWidth, below the body", () => {
    const { renderer, gapLayer, bodyLayer } = makeRenderer();
    renderer.render({ labels: [label()], style: style({ gap: 4, borderWidth: 2 }), floorColor: 0x123456 });
    const ring = gapLayer()[0] as FakeGraphics;
    const body = bodyLayer()[0] as FakeGraphics;
    const outset = 4 + 2;
    expect(ring.fillCalls[0]).toBe(0x123456);
    expect(pathBounds(ring.fillPathPoints[0]).x).toBeCloseTo(pathBounds(body.fillPathPoints.at(-1)!).x - outset);
    expect(pathBounds(ring.fillPathPoints[0]).w).toBeCloseTo(pathBounds(body.fillPathPoints.at(-1)!).w + 2 * outset);
  });

  it("inherits the marker border width for the plate and its gap outset", () => {
    const { renderer, gapLayer, bodyLayer } = makeRenderer();
    renderer.render({ labels: [label({ markerBorderWidth: 6 })], style: style({ borderWidthFromMarker: true, borderWidth: 1, gap: 4 }), floorColor: 0x123456 });
    const ring = pathBounds((gapLayer()[0] as FakeGraphics).fillPathPoints[0]);
    const plate = pathBounds((bodyLayer()[0] as FakeGraphics).fillPathPoints.at(-1)!);
    expect(ring.x).toBeCloseTo(plate.x - 10);
    expect(pathBounds((bodyLayer()[0] as FakeGraphics).fillPathPoints[0]).x).toBeCloseTo(plate.x - 6);
  });

  it("uses its own border width when marker-border inheritance is disabled", () => {
    const { renderer, bodyLayer } = makeRenderer();
    renderer.render({ labels: [label({ markerBorderWidth: 6 })], style: style({ borderWidthFromMarker: false, borderWidth: 2, gap: 0 }), floorColor: 0x123456 });
    const body = bodyLayer()[0] as FakeGraphics;
    const plate = pathBounds(body.fillPathPoints.at(-1)!);
    expect(pathBounds(body.fillPathPoints[0]).x).toBeCloseTo(plate.x - 2);
  });

  it("omits the gap ring entirely when gap is 0", () => {
    const { renderer, gapLayer } = makeRenderer();
    renderer.render({ labels: [label()], style: style({ gap: 0 }), floorColor: 0x123456 });
    expect(gapLayer()).toHaveLength(0);
  });

  it("takes the plate border color from the marker when borderColorFromMarker is on", () => {
    const { renderer, bodyLayer } = makeRenderer();
    renderer.render({ labels: [label({ borderMatchColor: 0xfeed01 })], style: style({ borderColorFromMarker: true, borderWidth: 2, borderColor: 0x444444 }), floorColor: 0x000000 });
    const plate = bodyLayer()[0] as FakeGraphics;
    expect(plate.fillCalls[0]).toBe(0xfeed01);
  });

  it("uses the configured borderColor when borderColorFromMarker is off, and no stroke at borderWidth 0", () => {
    const { renderer, bodyLayer } = makeRenderer();
    renderer.render({ labels: [label()], style: style({ borderColorFromMarker: false, borderColor: 0x010203, borderWidth: 2 }), floorColor: 0x000000 });
    expect((bodyLayer()[0] as FakeGraphics).fillCalls[0]).toBe(0x010203);

    const { renderer: r2, bodyLayer: b2 } = makeRenderer();
    r2.render({ labels: [label()], style: style({ borderWidth: 0 }), floorColor: 0x000000 });
    expect((b2()[0] as FakeGraphics).strokeCalls).toHaveLength(0);
  });

  it("clear() removes every drawn plate from both layers", () => {
    const { renderer, gapLayer, bodyLayer } = makeRenderer();
    renderer.render({ labels: [label(), label({ pos: [300, 300] })], style: style({ gap: 3 }), floorColor: 0x000000 });
    expect(bodyLayer().length).toBeGreaterThan(0);
    renderer.clear();
    expect(gapLayer()).toHaveLength(0);
    expect(bodyLayer()).toHaveLength(0);
  });
});
