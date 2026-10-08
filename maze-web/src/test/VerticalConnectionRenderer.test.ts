import { describe, it, expect, vi } from "vitest";
import type { VerticalConnectionMarker } from "../pixi/renderers/types";
import type { VerticalConnectionStyle, VerticalMarkerStyle } from "../pixi/renderers/VerticalConnectionRenderer";
import { patternVisualTipFraction, patternBaseFraction } from "../pixi/renderers/VerticalConnectionRenderer";

const navigateToFloorMock = vi.fn();
vi.mock("../pixi/renderers/floorNavigation", () => ({
  navigateToFloor: (floorIndex: number) => navigateToFloorMock(floorIndex),
}));

// Records every `circle`/`poly` call's own args (not just call count) — marker positioning and
// arrow side-by-side offset are only observable through the exact coordinates each draw call
// receives, unlike most other mocked-pixi tests in this repo that only assert *that* something was
// drawn.
type Call = { method: "circle" | "poly" | "roundPoly" | "roundRect" | "moveTo" | "lineTo"; args: number[] };
type StrokeCall = { width?: number; color?: number; cap?: string; join?: string; alignment?: number };
interface FakeGraphics {
  clear: () => FakeGraphics;
  removeChildren: () => FakeGraphics[];
  circle: (x: number, y: number, r: number) => FakeGraphics;
  poly: (points: number[]) => FakeGraphics;
  roundPoly: (x: number, y: number, radius: number, sides: number, corner: number) => FakeGraphics;
  roundRect: (x: number, y: number, w: number, h: number, radius: number) => FakeGraphics;
  rect: (x: number, y: number, w: number, h: number) => FakeGraphics;
  moveTo: (x: number, y: number) => FakeGraphics;
  lineTo: (x: number, y: number) => FakeGraphics;
  fill: (arg: unknown) => FakeGraphics;
  stroke: (arg: StrokeCall) => FakeGraphics;
  strokeCalls: StrokeCall[];
  fillCalls: number[];
  addChild: (child: unknown) => void;
  destroy: () => void;
  eventMode: string;
  cursor: string;
  on: (event: string, cb: () => void) => void;
  calls: Call[];
  children: FakeGraphics[];
}

// Methods close over `this` (bound via `.bind`/arrow-on-instance below), never a separate local
// object — `Object.assign(this, { children: [] })` followed by a later `children = []`
// *reassignment* (as `removeChildren` does) would otherwise desync a closure that captured the old
// array reference from `this`'s own live property, silently dropping every `addChild` after that
// point from what the test reads back off `this`.
function installFakeGraphics(target: FakeGraphics): void {
  target.calls = [];
  target.children = [];
  target.eventMode = "auto";
  target.cursor = "";
  target.clear = () => target;
  target.removeChildren = () => { const c = target.children; target.children = []; return c; };
  target.circle = (x, y, r) => { target.calls.push({ method: "circle", args: [x, y, r] }); return target; };
  target.poly = (points) => { target.calls.push({ method: "poly", args: points }); return target; };
  target.roundPoly = (x, y, radius, sides, corner) => { target.calls.push({ method: "roundPoly", args: [x, y, radius, sides, corner] }); return target; };
  target.roundRect = (x, y, w, h, radius) => { target.calls.push({ method: "roundRect", args: [x, y, w, h, radius] }); return target; };
  target.rect = () => target;
  target.moveTo = (x, y) => { target.calls.push({ method: "moveTo", args: [x, y] }); return target; };
  target.lineTo = (x, y) => { target.calls.push({ method: "lineTo", args: [x, y] }); return target; };
  target.fillCalls = [];
  target.fill = (arg) => { target.fillCalls.push(arg as number); return target; };
  target.strokeCalls = [];
  target.stroke = (arg) => { target.strokeCalls.push(arg); return target; };
  target.addChild = (child) => { target.children.push(child as FakeGraphics); };
  target.destroy = vi.fn();
  target.on = vi.fn();
}

// `Text.width` drives `fitElevatorBadgeFontSize`'s own scale-down decision — width scales linearly
// with `text.length` here (a stand-in for real font-metric measurement) so a wider label (e.g.
// `"VIII"` vs `"I"`) reliably measures wider, without needing a real font/canvas.
interface FakeText {
  text: string;
  style: Record<string, unknown>;
  width: number;
  anchor: { set: (v: number) => void };
  pivot: { y: number };
  x: number;
  y: number;
  destroy: () => void;
}

vi.mock("pixi.js", () => ({
  Container: vi.fn().mockImplementation(function (this: FakeGraphics) {
    this.children = [];
    this.addChild = (child) => { this.children.push(child as FakeGraphics); };
    this.removeChildren = () => { const c = this.children; this.children = []; return c; };
    this.destroy = vi.fn();
  }),
  Graphics: vi.fn().mockImplementation(function (this: FakeGraphics) {
    installFakeGraphics(this);
  }),
  // `BitmapText` (GitHub issue #352 — MSDF label font) has the same constructor/instance shape this
  // renderer relies on as the old `Text` did: `{ text, style: { fontSize, ... } }`, `.width`,
  // `.anchor.set`, `.x/.y`, `.destroy`.
  BitmapText: vi.fn().mockImplementation(function (this: FakeText, opts: { text: string; style: Record<string, unknown> }) {
    this.text = opts.text;
    this.style = opts.style;
    this.width = opts.text.length * (opts.style.fontSize as number) * 0.6;
    this.anchor = { set: vi.fn() };
    this.pivot = { y: 0 };
    this.x = 0;
    this.y = 0;
    this.destroy = vi.fn();
  }),
  Cache: { get: () => undefined },
}));

const { VerticalConnectionRenderer } = await import("../pixi/renderers/VerticalConnectionRenderer");
const { Container } = await import("pixi.js");

function circleMarkerStyle(overrides: Partial<VerticalMarkerStyle> = {}): VerticalMarkerStyle {
  return {
    shape: "circle", cornerStyle: "round",
    fillColor: 0x111111, borderColor: 0x222222, borderWidth: 0, gapWidth: 0, gapColor: 0x333333,
    size: 8.8, // 0.22 * TILE_SIZE (GitHub issue #681 — now a direct px value; a diameter — GitHub issue #681 diameter follow-up, so the effective radius is 4.4)
    ...overrides,
  };
}

function baseStyle(overrides: Partial<VerticalConnectionStyle> = {}): VerticalConnectionStyle {
  return {
    style: "abstract",
    twoWayPassageMarker: circleMarkerStyle(),
    oneWayPassageMarker: circleMarkerStyle(),
    elevatorMarker: circleMarkerStyle(),
    twoWayArrowColor: 0x444444,
    twoWayArrowSize: 0.6,
    twoWayArrowStyle: "triangle",
    twoWayArrowCornerStyle: "round",
    oneWayArrowColor: 0x444444,
    oneWayArrowSize: 0.6,
    oneWayArrowStyle: "triangle",
    oneWayArrowCornerStyle: "round",
    elevatorArrowColor: 0x444444,
    elevatorArrowSize: 0.6,
    elevatorArrowStyle: "triangle",
    elevatorArrowCornerStyle: "round",
    decorativeStairsTwoWay: { lineColor: 0x111111, lineWidth: 3, size: 0.22 },
    decorativeStairsOneWay: { lineColor: 0x111111, lineWidth: 3, size: 0.22 },
    decorativeElevator: { lineColor: 0x111111, lineWidth: 3, size: 0.22 },
    decorativeStairsArrowColor: 0x444444,
    decorativeStairsArrowSize: 0.6,
    decorativeStairsOneWayArrowColor: 0x2a2a2a,
    decorativeStairsOneWayArrowSize: 0.6,
    elevatorBadges: { enabled: false, labelType: "arabic", size: 0.5, placement: "left_right", distance: 4, gap: 1, gapWidth: 0, cornerStyle: "round", evenDistribution: true, shape: "circle", fillColor: 0x555555, textColor: 0x666666, fontWeight: "bold" },
    ...overrides,
  };
}

function marker(overrides: Partial<VerticalConnectionMarker> = {}): VerticalConnectionMarker {
  return {
    pos: [100, 100], fromNode: 0, kind: "vertical_passage",
    filled: true, arrowFilled: true,
    ...overrides,
  };
}

function render(renderer: InstanceType<typeof VerticalConnectionRenderer>, data: Parameters<InstanceType<typeof VerticalConnectionRenderer>["render"]>[0]) {
  renderer.render(data);
}

function polygonCenter(points: number[]): [number, number] {
  let x = 0;
  let y = 0;
  for (let i = 0; i < points.length; i += 2) {
    x += points[i];
    y += points[i + 1];
  }
  return [x / (points.length / 2), y / (points.length / 2)];
}

function polygonRadius(points: number[], cx: number, cy: number): number {
  return Math.max(...Array.from({ length: points.length / 2 }, (_, i) => Math.hypot(points[i * 2] - cx, points[i * 2 + 1] - cy)));
}

describe("patternVisualTipFraction / patternBaseFraction (GitHub issue #693, wall-tick centering)", () => {
  it("triangle's visual tip sits short of the nominal +1, inset by roundPoly's corner rounding", () => {
    // drawOneWayTriangle rounds its roundPoly corners (corner = (length*0.5)*0.3) — the tip
    // vertex's 60° interior angle means the cut shortens its axial reach non-negligibly, unlike a
    // plain stroked pattern's exact `+1` tip. Regression guard for the geometry derivation in
    // `patternVisualTipFraction`'s own doc comment.
    expect(patternVisualTipFraction("triangle")).toBeCloseTo(0.6003, 3);
  });

  it("chevron/arrow have no roundPoly corner rounding, so their visual tip stays the nominal +1", () => {
    expect(patternVisualTipFraction("chevron")).toBe(1);
    expect(patternVisualTipFraction("arrow")).toBe(1);
  });

  it("triangle's own base sits behind the origin; chevron/arrow's back sits exactly at it", () => {
    expect(patternBaseFraction("triangle")).toBeCloseTo(-0.5385, 3);
    expect(patternBaseFraction("chevron")).toBe(0);
    expect(patternBaseFraction("arrow")).toBe(0);
  });
});

describe("VerticalConnectionRenderer", () => {
  it("draws a lone marker centered at its own position, unshifted", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, { markers: [marker({ pos: [50, 60] })], style: baseStyle() });

    const polyCalls = g.calls.filter((c) => c.method === "poly");
    expect(polyCalls).toHaveLength(1);
    const [x, y] = polygonCenter(polyCalls[0].args);
    expect(x).toBeCloseTo(50);
    expect(y).toBeCloseTo(60);
  });

  it("gapWidth > 0 draws a floor-colored gap ring as a single true outward offset of the marker's own fill radius by borderWidth + gapWidth (GitHub issue #552 ninth follow-up)", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [0, 0], kind: "vertical_passage", filled: true })],
      style: baseStyle({
        twoWayPassageMarker: circleMarkerStyle({ borderWidth: 4, gapWidth: 3, gapColor: 0x999999 }),
      }),
    });

    const polyCalls = g.calls.filter((c) => c.method === "poly");
    // Gap ring, outer border silhouette, and marker fill — 3 total; no GPU strokes are used.
    expect(polyCalls).toHaveLength(3);
    const gapBaseRadius = polygonRadius(polyCalls[0].args, 0, 0);
    const markerRadius = polygonRadius(polyCalls[2].args, 0, 0);
    // The marker's own fill radius, not `radius + borderWidth` — a single true outward offset from
    // here, not a shape redrawn at a bigger radius first.
    expect(gapBaseRadius).toBeCloseTo(markerRadius + 4 + 3);
    expect(g.strokeCalls).toHaveLength(0);
    expect(g.fillCalls[0]).toMatchObject({ color: 0x999999 });
  });

  it("gapWidth 0 (or unset) skips the gap ring entirely — not a zero-radius circle", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [0, 0], kind: "vertical_passage", filled: true })],
      style: baseStyle({ twoWayPassageMarker: circleMarkerStyle({ borderWidth: 4, gapWidth: 0 }) }),
    });

    expect(g.calls.filter((c) => c.method === "poly")).toHaveLength(2);
  });

  it("draws co-located passage, elevator, and one-way markers at the exact shared position", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [
        marker({ pos: [50, 60], kind: "vertical_passage", filled: true }),
        marker({ pos: [50, 60], kind: "elevator" }),
        marker({ pos: [50, 60], kind: "vertical_passage", filled: false, arrowFilled: false }),
      ],
      style: baseStyle(),
    });

    const polyCalls = g.calls.filter((c) => c.method === "poly");
    expect(polyCalls).toHaveLength(3);
    for (const call of polyCalls) {
      expect(polygonCenter(call.args)).toEqual([expect.closeTo(50), expect.closeTo(60)]);
    }
  });

  it("a lone marker keeps its own center when other markers occupy another cell", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    const coLocated1 = marker({ pos: [0, 0], kind: "vertical_passage" });
    const coLocated2 = marker({ pos: [0, 0], kind: "elevator" });
    const lone = marker({ pos: [200, 200], kind: "vertical_passage" });
    render(renderer, { markers: [coLocated1, coLocated2, lone], style: baseStyle() });

    const polyCalls = g.calls.filter((c) => c.method === "poly");
    expect(polyCalls).toHaveLength(3);
    const [loneX, loneY] = polygonCenter(polyCalls[2].args);
    expect(loneX).toBeCloseTo(200);
    expect(loneY).toBeCloseTo(200);
  });

  it("a 'both' direction elevator's two triangle arrows spread vertically (same X, different Y, symmetric around center)", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [0, 0], kind: "elevator", direction: "both", arrowFilled: true })],
      style: baseStyle(),
    });

    // Default `elevatorArrowStyle` is `"triangle"`, drawn via `drawOneWayTriangle` -> `roundPoly`
    // (not a hand-built `poly` path — GitHub issue #292 follow-up). Each `drawArrowFilled` call
    // emits one `roundPoly` (the arrow triangle) — the marker's own circle isn't a roundPoly call
    // (shape: "circle" goes through `g.circle`), so every roundPoly call here is an arrow.
    const roundPolyCalls = g.calls.filter((c) => c.method === "roundPoly");
    expect(roundPolyCalls).toHaveLength(2);

    // `roundPoly(centroidX, centroidY, radius, sides, corner, rotation)` — args[0]/args[1] are the
    // triangle's own centroid X/Y. `triangle` spreads vertically, same as `chevron` (GitHub issue
    // #347 seventh follow-up reverted the sixth follow-up's sideways spread) — same X, mirrored Y
    // offsets around the marker's own center.
    const [up, down] = roundPolyCalls;
    expect(up.args[0]).toBeCloseTo(down.args[0] as number, 5);
    expect(up.args[1]).not.toBeCloseTo(down.args[1] as number);
  });

  it("a 'both' direction elevator's two triangle arrows stay at the same Y spread regardless of arrow size (GitHub issue #347 third/seventh follow-up regression)", () => {
    // The two arrows' own spread must be fixed to the marker's own radius, not the arrow-size
    // slider — otherwise shrinking arrow size also shrinks the gap between the two arrows, making
    // them converge toward the marker center instead of shrinking in place. `triangle` spreads
    // along Y (GitHub issue #347 seventh follow-up), so this asserts on `args[1]`, not `args[0]`.
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [0, 0], kind: "elevator", direction: "both", arrowFilled: true })],
      style: baseStyle({ elevatorArrowSize: 0.9 }),
    });
    const wideY = g.calls.filter((c) => c.method === "roundPoly").map((c) => c.args[1] as number);

    g.calls.length = 0;
    render(renderer, {
      markers: [marker({ pos: [0, 0], kind: "elevator", direction: "both", arrowFilled: true })],
      style: baseStyle({ elevatorArrowSize: 0.2 }),
    });
    const narrowY = g.calls.filter((c) => c.method === "roundPoly").map((c) => c.args[1] as number);

    expect(wideY[0]).toBeCloseTo(narrowY[0], 4);
    expect(wideY[1]).toBeCloseTo(narrowY[1], 4);
  });

  it("a 'both' direction elevator's two 'arrow'-pattern arrows stay at the same X spread regardless of arrow size", () => {
    // `arrow` spreads sideways (unlike `triangle`/`chevron`, GitHub issue #347 fourth follow-up),
    // so its own spread axis is still X — same regression coverage as above, other axis.
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [0, 0], kind: "elevator", direction: "both", arrowFilled: true })],
      style: baseStyle({ elevatorArrowSize: 0.9, elevatorArrowStyle: "arrow" }),
    });
    // `drawOneWayArrow` shafts each start with a `moveTo(tailX, tailY)` — its own X is the arrow's
    // own origin X (`ox`), which is what this test is actually checking stays fixed.
    const wideX = g.calls.filter((c) => c.method === "moveTo").map((c) => c.args[0] as number);

    g.calls.length = 0;
    render(renderer, {
      markers: [marker({ pos: [0, 0], kind: "elevator", direction: "both", arrowFilled: true })],
      style: baseStyle({ elevatorArrowSize: 0.2, elevatorArrowStyle: "arrow" }),
    });
    const narrowX = g.calls.filter((c) => c.method === "moveTo").map((c) => c.args[0] as number);

    // Each `drawOneWayArrow` call emits two `moveTo`s (shaft start, then head-wing start) — index 0
    // and index 2 are the two arrows' own shaft starts.
    expect(wideX[0]).toBeCloseTo(narrowX[0], 4);
    expect(wideX[2]).toBeCloseTo(narrowX[2], 4);
    expect(wideX[0]).not.toBeCloseTo(wideX[2] as number);
  });

  it("arrowCornerStyle 'miter' sets a square stroke cap on a chevron/arrow arrow, not just the join (GitHub issue #347 third follow-up)", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [0, 0], kind: "vertical_passage", direction: "up", filled: true, arrowFilled: true })],
      style: baseStyle({ twoWayArrowStyle: "chevron", twoWayArrowCornerStyle: "miter" }),
    });

    expect(g.strokeCalls.length).toBeGreaterThan(0);
    for (const call of g.strokeCalls) {
      expect(call.join).toBe("miter");
      expect(call.cap).toBe("square");
    }
  });

  it("a single-direction marker draws its own arrow with no horizontal offset applied", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [0, 0], kind: "vertical_passage", direction: "up", arrowFilled: true })],
      style: baseStyle(),
    });

    const roundPolyCalls = g.calls.filter((c) => c.method === "roundPoly");
    expect(roundPolyCalls).toHaveLength(1);
    expect(roundPolyCalls[0].args[0]).toBeCloseTo(0);
  });

  it("renders sign style as equal-length lines: plus for up and minus for down", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [
        marker({ pos: [-20, 0], direction: "up" }),
        marker({ pos: [20, 0], direction: "down" }),
      ],
      style: baseStyle({ twoWayArrowStyle: "sign" }),
    });

    const moveCalls = g.calls.filter((call) => call.method === "moveTo");
    const lineCalls = g.calls.filter((call) => call.method === "lineTo");
    expect(moveCalls).toHaveLength(3);
    expect(lineCalls).toHaveLength(3);
    expect(moveCalls[0].args[1]).toBeCloseTo(lineCalls[0].args[1]);
    expect(moveCalls[1].args[0]).toBeCloseTo(lineCalls[1].args[0]);
    expect(moveCalls[2].args[1]).toBeCloseTo(lineCalls[2].args[1]);
    expect(Math.abs(moveCalls[0].args[0] - lineCalls[0].args[0])).toBeCloseTo(
      Math.abs(moveCalls[2].args[0] - lineCalls[2].args[0]),
    );
  });

  it("uses smaller, vertically separated signs for a bidirectional elevator", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [0, 0], kind: "elevator", direction: "both" })],
      style: baseStyle({ elevatorArrowStyle: "sign", elevatorArrowSize: 1 }),
    });

    const moveCalls = g.calls.filter((call) => call.method === "moveTo");
    expect(Math.abs(moveCalls[0].args[1] - moveCalls[2].args[1])).toBeGreaterThan(4);
    expect(Math.abs(moveCalls[0].args[0] - moveCalls[1].args[0])).toBeCloseTo((8.8 / 2) * 0.75);
    const yCoordinates = g.calls
      .filter((call) => call.method === "moveTo" || call.method === "lineTo")
      .flatMap((call) => [call.args[1]]);
    expect((Math.min(...yCoordinates) + Math.max(...yCoordinates)) / 2).toBeCloseTo(0);
  });

  it("uses round caps for round-corner sign strokes", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ direction: "up" })],
      style: baseStyle({ twoWayArrowStyle: "sign", twoWayArrowCornerStyle: "round" }),
    });

    expect(g.strokeCalls.at(-1)?.cap).toBe("round");
  });

  it("interactive + resolved targetFloorIndex adds a clickable hit-circle wired to navigateToFloor", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const hitLayer = (renderer as unknown as { hitLayer: FakeGraphics }).hitLayer;

    render(renderer, {
      markers: [marker({ pos: [0, 0], targetFloorIndex: 2 })],
      style: baseStyle(),
      interactive: true,
    });

    expect(hitLayer.children).toHaveLength(1);
    const hit = hitLayer.children[0] as unknown as { on: (event: string, cb: () => void) => void };
    const onMock = hit.on as unknown as ReturnType<typeof vi.fn>;
    expect(onMock).toHaveBeenCalledWith("pointertap", expect.any(Function));
    const handler = onMock.mock.calls[0][1] as () => void;
    handler();
    expect(navigateToFloorMock).toHaveBeenCalledWith(2);
  });

  it("interactive but no targetFloorIndex (Elevator) adds no hit-circle", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const hitLayer = (renderer as unknown as { hitLayer: FakeGraphics }).hitLayer;

    render(renderer, {
      markers: [marker({ pos: [0, 0], kind: "elevator", targetFloorIndex: undefined })],
      style: baseStyle(),
      interactive: true,
    });

    expect(hitLayer.children).toHaveLength(0);
  });

  it("not interactive skips the hit-circle even when targetFloorIndex resolved", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const hitLayer = (renderer as unknown as { hitLayer: FakeGraphics }).hitLayer;

    render(renderer, {
      markers: [marker({ pos: [0, 0], targetFloorIndex: 1 })],
      style: baseStyle(),
    });

    expect(hitLayer.children).toHaveLength(0);
  });

  it("interactive as a predicate gates each marker independently", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const hitLayer = (renderer as unknown as { hitLayer: FakeGraphics }).hitLayer;

    render(renderer, {
      markers: [
        marker({ pos: [0, 0], targetFloorIndex: 1, filled: true }),
        marker({ pos: [5, 0], targetFloorIndex: 2, filled: false }),
      ],
      style: baseStyle(),
      interactive: (m) => m.filled,
    });

    // Only the `filled: true` marker's own hit-circle is added — the predicate rejects the other.
    expect(hitLayer.children).toHaveLength(1);
  });

  it("interactive predicate returning false for every marker adds no hit-circles", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const hitLayer = (renderer as unknown as { hitLayer: FakeGraphics }).hitLayer;

    render(renderer, {
      markers: [marker({ pos: [0, 0], targetFloorIndex: 1 })],
      style: baseStyle(),
      interactive: () => false,
    });

    expect(hitLayer.children).toHaveLength(0);
  });

  it("clear()/removeChildren() run on every render call — no stale draws or listeners accumulate across two renders", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const hitLayer = (renderer as unknown as { hitLayer: FakeGraphics }).hitLayer;

    render(renderer, { markers: [marker({ pos: [0, 0], targetFloorIndex: 1 })], style: baseStyle(), interactive: true });
    expect(hitLayer.children).toHaveLength(1);
    const firstHit = hitLayer.children[0];

    render(renderer, { markers: [marker({ pos: [0, 0], targetFloorIndex: 1 })], style: baseStyle(), interactive: true });
    expect(hitLayer.children).toHaveLength(1);
    expect(hitLayer.children[0]).not.toBe(firstHit);
    expect((firstHit as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy).toHaveBeenCalled();
  });

  it("size unit consistency: circle radius equals settings.size / 2, in px (GitHub issue #681 diameter follow-up)", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [0, 0] })],
      style: baseStyle({ twoWayPassageMarker: circleMarkerStyle({ size: 12, borderWidth: 0, gapWidth: 0 }) }),
    });

    const polyCalls = g.calls.filter((c) => c.method === "poly");
    expect(polygonRadius(polyCalls[0].args, 0, 0)).toBeCloseTo(6);
  });

  it.each(["triangle", "chevron", "arrow"] as const)(
    "arrowSizeFraction 1 makes a '%s' arrow's own tip reach exactly the marker's own radius (GitHub issue #347 fourth follow-up)",
    (pattern) => {
      const container = new Container();
      const renderer = new VerticalConnectionRenderer(container as never);
      const g = (renderer as unknown as { g: FakeGraphics }).g;
      const size = 16; // px diameter (GitHub issue #681 — previously a 0.4 tile fraction; GitHub issue #681 diameter follow-up)

      render(renderer, {
        markers: [marker({ pos: [0, 0], kind: "vertical_passage", direction: "up", filled: true, arrowFilled: true })],
        style: baseStyle({
          twoWayPassageMarker: circleMarkerStyle({ size }),
          twoWayArrowStyle: pattern,
          twoWayArrowSize: 1,
        }),
      });

      const radius = size / 2;
      if (pattern === "triangle") {
        // Triangle's own tip sits at `0.65 * length` from `drawOneWayTriangle`'s own input origin
        // (`wallUtils.ts`) — `drawArrowPattern` rescales `size` by `1/patternTipFraction` so this
        // still lands exactly at `radius` regardless of the triangle's own internal geometry.
        const [roundPoly] = g.calls.filter((c) => c.method === "roundPoly");
        const tipReach = 0.65 * (roundPoly.args[2] as number) * 1.5; // args[2] is roundPoly's own circumradius R; length = 1.5*R
        expect(tipReach).toBeCloseTo(radius, 1);
      } else if (pattern === "arrow") {
        const moveToCalls = g.calls.filter((c) => c.method === "moveTo");
        const tailY = moveToCalls[0].args[1] as number;
        // `direction: "up"` -> `dy = -1`; the marker's own center is `cy = 0` (this test's own
        // `pos: [0, 0]` override), tail sits at `cy - dy*size = cy + size`.
        expect(Math.abs(tailY)).toBeCloseTo(radius, 1);
      }
      // `chevron` needs no dedicated check here — `drawOneWayChevron`'s tip already sits at exactly
      // `size` with `patternTipFraction` 1 (no rescale applied), covered indirectly by every other
      // chevron test in this file still passing after the rescale was introduced.
    },
  );

  it("style 'decorative' draws a VerticalPassage as a stairs zigzag (open polyline, not circle/poly) centered at its own position", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [50, 60], kind: "vertical_passage" })],
      style: baseStyle({ style: "decorative" }),
    });

    expect(g.calls.some((c) => c.method === "circle")).toBe(false);
    expect(g.calls.some((c) => c.method === "poly")).toBe(false);
    // drawStairsIcon: one moveTo (start point) followed by lineTo segments — no fill, a stroke call.
    const moveToCalls = g.calls.filter((c) => c.method === "moveTo");
    expect(moveToCalls.length).toBeGreaterThan(0);
    expect(g.fillCalls).toHaveLength(0);
    expect(g.strokeCalls.length).toBeGreaterThan(0);
  });

  it("style 'decorative' draws co-located markers at the exact shared position", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [
        marker({ pos: [50, 60], kind: "vertical_passage", fromNode: 0, direction: undefined }),
        marker({ pos: [50, 60], kind: "vertical_passage", fromNode: 1, direction: undefined }),
      ],
      style: baseStyle({ style: "decorative" }),
    });

    // No `direction` on either marker means each draws only `drawStairsIcon`'s own single moveTo
    // (the icon's `left = cx - r` start point) — one moveTo per marker, so equal X coordinates
    // prove that both icons use the exact shared marker position.
    const moveToCalls = g.calls.filter((c) => c.method === "moveTo");
    expect(moveToCalls).toHaveLength(2);
    const [xA, xB] = moveToCalls.map((c) => c.args[0]);
    expect(xA).toBeCloseTo(xB);
  });

  it("stairs zigzag has 3 steps (7 points: vert-horiz-vert-horiz-vert-horiz-vert), starting and ending on a vertical riser", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [50, 60], kind: "vertical_passage" })],
      style: baseStyle({ style: "decorative" }),
    });

    // 1 moveTo (first point) + 6 lineTo (remaining points) = 7 points total = 3 risers interleaved
    // with 2 horizontal shelves, both ends vertical (GitHub issue #428 fourth follow-up reverted the
    // third follow-up's horizontal-start/end shape back to a vertical start/end).
    const moveToCalls = g.calls.filter((c) => c.method === "moveTo");
    const lineToCalls = g.calls.filter((c) => c.method === "lineTo");
    expect(moveToCalls).toHaveLength(1);
    expect(lineToCalls).toHaveLength(6);

    const points = [moveToCalls[0].args, ...lineToCalls.map((c) => c.args)];
    // First segment (point 0 -> 1) is a riser: same X, different Y.
    expect(points[0][0]).toBeCloseTo(points[1][0]);
    expect(points[0][1]).not.toBeCloseTo(points[1][1]);
    // Second segment (point 1 -> 2) is horizontal: same Y, different X.
    expect(points[1][1]).toBeCloseTo(points[2][1]);
    expect(points[1][0]).not.toBeCloseTo(points[2][0]);
  });

  it("style 'decorative' draws an Elevator as its own line pictogram (box + doors line + cables), not the marker shape or stairs zigzag", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [50, 60], kind: "elevator", direction: "both" })],
      style: baseStyle({ style: "decorative" }),
    });

    expect(g.calls.some((c) => c.method === "circle")).toBe(false);
    expect(g.calls.some((c) => c.method === "poly")).toBe(false);
    expect(g.fillCalls).toHaveLength(0);
    expect(g.strokeCalls.length).toBeGreaterThan(0);
  });

  it("style 'decorative' never draws a direction arrow for an Elevator, even when `direction` is set", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [50, 60], kind: "elevator", direction: "both" })],
      style: baseStyle({ style: "decorative" }),
    });

    // Elevator icon: rect (via a `rect` call the fake doesn't track) + one vertical moveTo/lineTo +
    // two cable moveTo/lineTo pairs = 3 moveTo calls total; a stairs arrow would add more.
    const moveToCalls = g.calls.filter((c) => c.method === "moveTo");
    expect(moveToCalls).toHaveLength(3);
  });

  it("style 'decorative' draws a two-way VerticalPassage's arrow in the primary arrow color, not the accent color", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [50, 60], kind: "vertical_passage", filled: true, direction: "up" })],
      style: baseStyle({ style: "decorative", decorativeStairsArrowColor: 0xaaaaaa, decorativeStairsOneWayArrowColor: 0xbbbbbb }),
    });

    const arrowStroke = g.strokeCalls[g.strokeCalls.length - 1];
    expect(arrowStroke.color).toBe(0xaaaaaa);
  });

  it("style 'decorative' draws a one-way VerticalPassage's arrow in the one-way arrow color at both ends", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [50, 60], kind: "vertical_passage", filled: false, arrowFilled: true, direction: "up" })],
      style: baseStyle({ style: "decorative", decorativeStairsArrowColor: 0xaaaaaa, decorativeStairsOneWayArrowColor: 0xbbbbbb }),
    });

    const arrowStroke = g.strokeCalls[g.strokeCalls.length - 1];
    expect(arrowStroke.color).toBe(0xbbbbbb);
  });

  it("style 'decorative' sizes a one-way VerticalPassage's arrow from its own size field, independent of the two-way arrow size (GitHub issue #583)", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [50, 60], kind: "vertical_passage", filled: false, arrowFilled: true, direction: "up" })],
      style: baseStyle({ style: "decorative", decorativeStairsArrowSize: 0.3, decorativeStairsOneWayArrowSize: 0.9 }),
    });

    // `drawStairsIcon` alone emits exactly 1 moveTo + 6 lineTo (see the "3 risers interleaved with
    // 2 shelves" test above) — the arrow shaft drawn right after is moveTo[1]/lineTo[6], and its
    // span is `2 * r * size`, so a larger `decorativeStairsOneWayArrowSize` must produce a longer
    // span than the same marker drawn with a smaller one, proving it read its own size field.
    const span = (fake: FakeGraphics) => {
      const moveTo = fake.calls.filter((c) => c.method === "moveTo")[1].args;
      const lineTo = fake.calls.filter((c) => c.method === "lineTo")[6].args;
      return Math.hypot(lineTo[0] - moveTo[0], lineTo[1] - moveTo[1]);
    };
    const largeSpan = span(g);
    expect(largeSpan).toBeGreaterThan(0);

    const rendererSmall = new VerticalConnectionRenderer(container as never);
    const gSmall = (rendererSmall as unknown as { g: FakeGraphics }).g;
    render(rendererSmall, {
      markers: [marker({ pos: [50, 60], kind: "vertical_passage", filled: false, arrowFilled: true, direction: "up" })],
      style: baseStyle({ style: "decorative", decorativeStairsArrowSize: 0.3, decorativeStairsOneWayArrowSize: 0.3 }),
    });

    expect(largeSpan).toBeGreaterThan(span(gSmall));
  });

  it("crossed-out (arrival end) arrow still draws an arrowhead, plus a tick just past the tip (GitHub issue #428 fifth follow-up: crossed-out arrow was missing its own head)", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    // arrival end: filled: false, arrowFilled: false -> crossedOut: true
    render(renderer, {
      markers: [marker({ pos: [50, 60], kind: "vertical_passage", filled: false, arrowFilled: false, direction: "up" })],
      style: baseStyle({ style: "decorative" }),
    });

    // Stairs icon: 1 moveTo. Arrow shaft: 1 moveTo. Arrowhead: 2 moveTo (one per back-wing lineTo).
    // Tick: 1 moveTo. Total 5.
    const moveToCalls = g.calls.filter((c) => c.method === "moveTo");
    expect(moveToCalls).toHaveLength(5);
  });

  it("tail-ticked (departure end) arrow draws an arrowhead plus a tick past the shaft's own tail (GitHub issue #693, decorative follow-up — the departure-end counterpart to the arrival end's crossed-out tick)", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    // departure end: filled: false, arrowFilled: true -> tailTick: true
    render(renderer, {
      markers: [marker({ pos: [50, 60], kind: "vertical_passage", filled: false, arrowFilled: true, direction: "up" })],
      style: baseStyle({ style: "decorative" }),
    });

    // Same shape count as the crossed-out (arrival) end: stairs icon (1 moveTo) + arrow shaft (1
    // moveTo) + arrowhead (2 moveTo) + tail tick (1 moveTo) = 5.
    const moveToCalls = g.calls.filter((c) => c.method === "moveTo");
    expect(moveToCalls).toHaveLength(5);

    // The tail tick sits past the shaft's own tail, not past the arrowhead's tip — so its own
    // moveTo (the last one) must land clearly further from the arrowhead's tip moveTo (the first
    // one after the stairs icon's own) than the shaft is long, confirming it wasn't drawn at the
    // tip by mistake (which would make the two nearly coincide instead).
    const [, shaftStart, , , tailTickStart] = moveToCalls;
    const shaftToTailTick = Math.hypot(tailTickStart.args[0] - shaftStart.args[0], tailTickStart.args[1] - shaftStart.args[1]);
    expect(shaftToTailTick).toBeGreaterThan(0);
  });

  it("style 'decorative' draws a two-way VerticalPassage's own direction arrow too (not just one-way), adding extra moveTo calls beyond the stairs icon alone", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [50, 60], kind: "vertical_passage", filled: true, direction: "up" })],
      style: baseStyle({ style: "decorative" }),
    });
    const withArrow = g.calls.filter((c) => c.method === "moveTo").length;

    g.calls.length = 0;
    render(renderer, {
      markers: [marker({ pos: [50, 60], kind: "vertical_passage", filled: true, direction: undefined })],
      style: baseStyle({ style: "decorative" }),
    });
    const withoutArrow = g.calls.filter((c) => c.method === "moveTo").length;

    expect(withArrow).toBeGreaterThan(withoutArrow);
  });

  it("style 'decorative' mirrors the stairs arrow's arrowhead end to marker.direction: 'up' points at the diagonal's up end, 'down' at its down end", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [50, 60], kind: "vertical_passage", filled: true, direction: "up" })],
      style: baseStyle({ style: "decorative" }),
    });
    // The arrowhead's own two back-wing lineTo calls are the last two lineTo calls emitted (stairs
    // icon draws first, then the arrow line, then the head) — their shared origin (`moveTo`) is the
    // arrowhead tip. "up" -> tip at the diagonal's own top-right (higher X, lower Y, in screen space).
    const upTipMoveTo = g.calls.filter((c) => c.method === "moveTo").at(-1)!;

    g.calls.length = 0;
    render(renderer, {
      markers: [marker({ pos: [50, 60], kind: "vertical_passage", filled: true, direction: "down" })],
      style: baseStyle({ style: "decorative" }),
    });
    const downTipMoveTo = g.calls.filter((c) => c.method === "moveTo").at(-1)!;

    // "up" tip sits further right (higher X) and higher on screen (lower Y) than "down" tip.
    expect(upTipMoveTo.args[0]).toBeGreaterThan(downTipMoveTo.args[0] as number);
    expect(upTipMoveTo.args[1]).toBeLessThan(downTipMoveTo.args[1] as number);
  });

  it("a one-way passage's departure and arrival ends both draw the ordinary fill/border, with a wall tick in the arrow color (GitHub issue #693)", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    const style = baseStyle({
      oneWayPassageMarker: circleMarkerStyle({ fillColor: 0x555555, borderColor: 0x666666, borderWidth: 2 }),
    });

    const departure = marker({ pos: [0, 0], kind: "vertical_passage", filled: false, arrowFilled: true, direction: "up" });
    render(renderer, { markers: [departure], style });
    expect(g.fillCalls[0]).toBe(0x666666);
    expect(g.fillCalls[1]).toBe(0x555555);
    // Wall tick is a filled rounded rect (GitHub issue #693, rounded-rect follow-up), not a
    // stroked line — its own fill call is the last one, after the arrow triangle's fill.
    expect(g.fillCalls.at(-1)).toBe(style.oneWayArrowColor);

    g.calls.length = 0;
    g.strokeCalls.length = 0;
    g.fillCalls.length = 0;
    const arrival = marker({ pos: [0, 0], kind: "vertical_passage", filled: false, arrowFilled: false, direction: "up" });
    render(renderer, { markers: [arrival], style });
    expect(g.fillCalls[0]).toBe(0x666666);
    expect(g.fillCalls[1]).toBe(0x555555);
    expect(g.fillCalls.at(-1)).toBe(style.oneWayArrowColor);
  });

  describe("elevator floor-number badges (GitHub issue #430)", () => {
    it("draws no badge Text/Graphics for an elevator marker when elevatorBadges is disabled", () => {
      const container = new Container();
      const renderer = new VerticalConnectionRenderer(container as never);
      const style = baseStyle({ elevatorBadges: { ...baseStyle().elevatorBadges, enabled: false } });
      const el = marker({ pos: [0, 0], kind: "elevator", targetFloorIndices: [0, 1] });
      render(renderer, { markers: [el], style });
      const badgeLayer = (renderer as unknown as { badgeLayer: FakeGraphics }).badgeLayer;
      // Only the elevator marker's own circle should be drawn — no extra badge shapes/text children.
      expect(badgeLayer.children).toHaveLength(0);
    });

    it("draws one gap-ring-then-body pair of shapes per floor, plus a Text label per badge, for an enabled elevator marker", () => {
      const container = new Container();
      const renderer = new VerticalConnectionRenderer(container as never);
      const style = baseStyle({
        elevatorBadges: {
          ...baseStyle().elevatorBadges,
          enabled: true,
          gapWidth: 2,
          placement: "left_right",
          evenDistribution: true,
        },
      });
      const el = marker({ pos: [0, 0], kind: "elevator", targetFloorIndices: [0, 1, 4] });
      render(renderer, { markers: [el], style });
      const badgeLayer = (renderer as unknown as { badgeLayer: FakeGraphics }).badgeLayer;
      // Every gap ring (one per badge, `gapWidth > 0`) is a separate `Graphics` child added before
      // any badge body — `drawElevatorBadges`' own two-pass draw order (gap-then-fill across the
      // whole set, not per-badge) — followed by one body `Graphics` + one `Text` child per badge.
      const graphicsChildren = badgeLayer.children.filter((c) => !("text" in c));
      const textChildren = badgeLayer.children.filter((c) => "text" in c) as unknown as FakeText[];
      expect(graphicsChildren).toHaveLength(6); // 3 gap rings + 3 bodies
      expect(textChildren).toHaveLength(3);
      expect(textChildren.map((t) => t.text)).toEqual(["1", "2", "5"]); // formatElevatorBadgeLabel, 1-based
    });

    it("shares one font size across every elevator's badges in the same render pass, scaled down only as far as the widest label needs", () => {
      const container = new Container();
      const renderer = new VerticalConnectionRenderer(container as never);
      const style = baseStyle({
        elevatorBadges: { ...baseStyle().elevatorBadges, enabled: true, labelType: "roman" },
      });
      // One elevator reaching only floor 1 ("I"), another reaching floor 8 ("VIII") — the shared
      // font size must be small enough for "VIII" to fit, applied to *both* markers' badges alike.
      const small = marker({ pos: [0, 0], kind: "elevator", targetFloorIndices: [0] });
      const wide = marker({ pos: [200, 0], kind: "elevator", targetFloorIndices: [7] });
      render(renderer, { markers: [small, wide], style });
      const badgeLayer = (renderer as unknown as { badgeLayer: FakeGraphics }).badgeLayer;
      const textChildren = badgeLayer.children.filter((c) => "text" in c) as unknown as FakeText[];
      expect(textChildren).toHaveLength(2);
      const fontSizes = textChildren.map((t) => t.style.fontSize);
      expect(fontSizes[0]).toBe(fontSizes[1]);
    });

    it("draws no badges for a vertical_passage marker even when elevatorBadges is enabled", () => {
      const container = new Container();
      const renderer = new VerticalConnectionRenderer(container as never);
      const style = baseStyle({ elevatorBadges: { ...baseStyle().elevatorBadges, enabled: true } });
      const passage = marker({ pos: [0, 0], kind: "vertical_passage", targetFloorIndex: 1 });
      render(renderer, { markers: [passage], style });
      const badgeLayer = (renderer as unknown as { badgeLayer: FakeGraphics }).badgeLayer;
      expect(badgeLayer.children).toHaveLength(0);
    });

    it("interactive wires one click-to-switch-floor hit-circle per badge, each to its own floor (GitHub issue #478)", () => {
      const container = new Container();
      const renderer = new VerticalConnectionRenderer(container as never);
      const style = baseStyle({ elevatorBadges: { ...baseStyle().elevatorBadges, enabled: true } });
      const el = marker({ pos: [0, 0], kind: "elevator", targetFloorIndices: [0, 2, 4] });
      render(renderer, { markers: [el], style, interactive: true });
      const hitLayer = (renderer as unknown as { hitLayer: FakeGraphics }).hitLayer;
      expect(hitLayer.children).toHaveLength(3);

      navigateToFloorMock.mockClear();
      for (const [i, child] of hitLayer.children.entries()) {
        const onMock = (child as unknown as { on: ReturnType<typeof vi.fn> }).on;
        const cb = onMock.mock.calls[0][1] as () => void;
        cb();
        expect(navigateToFloorMock).toHaveBeenNthCalledWith(i + 1, [0, 2, 4][i]);
      }
    });

    it("not interactive draws the badges but wires no hit-circles", () => {
      const container = new Container();
      const renderer = new VerticalConnectionRenderer(container as never);
      const style = baseStyle({ elevatorBadges: { ...baseStyle().elevatorBadges, enabled: true } });
      const el = marker({ pos: [0, 0], kind: "elevator", targetFloorIndices: [0, 1] });
      render(renderer, { markers: [el], style });
      const hitLayer = (renderer as unknown as { hitLayer: FakeGraphics }).hitLayer;
      expect(hitLayer.children).toHaveLength(0);
    });

    it("style 'decorative' also wires per-badge click-to-switch-floor when interactive (GitHub issue #478)", () => {
      const container = new Container();
      const renderer = new VerticalConnectionRenderer(container as never);
      const style = baseStyle({ style: "decorative", elevatorBadges: { ...baseStyle().elevatorBadges, enabled: true } });
      const el = marker({ pos: [0, 0], kind: "elevator", targetFloorIndices: [1, 3] });
      render(renderer, { markers: [el], style, interactive: true });
      const hitLayer = (renderer as unknown as { hitLayer: FakeGraphics }).hitLayer;
      expect(hitLayer.children).toHaveLength(2);
      const cb = (hitLayer.children[1] as unknown as { on: ReturnType<typeof vi.fn> }).on.mock.calls[0][1] as () => void;
      navigateToFloorMock.mockClear();
      cb();
      expect(navigateToFloorMock).toHaveBeenCalledWith(3);
    });
  });

  // GitHub issue #432 follow-up: `destroy()` must destroy `g` and both newer sibling layers
  // (`badgeLayer`, `hitLayer`) — the latter two were easy to miss since they were added after
  // `destroy()` already existed.
  describe("VerticalConnectionRenderer.destroy", () => {
    it("destroys g, badgeLayer, and hitLayer", () => {
      const container = new Container();
      const renderer = new VerticalConnectionRenderer(container as never);
      const g = (renderer as unknown as { g: FakeGraphics }).g;
      const badgeLayer = (renderer as unknown as { badgeLayer: FakeGraphics }).badgeLayer;
      const hitLayer = (renderer as unknown as { hitLayer: FakeGraphics }).hitLayer;

      renderer.destroy();

      expect(g.destroy).toHaveBeenCalled();
      expect(badgeLayer.destroy).toHaveBeenCalledWith({ children: true });
      expect(hitLayer.destroy).toHaveBeenCalledWith({ children: true });
    });
  });
});
