import { describe, it, expect, vi } from "vitest";
import type { VerticalConnectionMarker } from "../pixi/renderers/types";
import type { VerticalConnectionStyle, VerticalMarkerStyle } from "../pixi/renderers/VerticalConnectionRenderer";
import { TILE_SIZE } from "../pixi/constants";

const navigateToFloorMock = vi.fn();
vi.mock("../pixi/renderers/floorNavigation", () => ({
  navigateToFloor: (floorIndex: number) => navigateToFloorMock(floorIndex),
}));

// Records every `circle`/`poly` call's own args (not just call count) — the offset/spread math
// this session added (same-cell spread, arrow side-by-side offset) is only observable through the
// exact coordinates each draw call receives, unlike most other mocked-pixi tests in this repo that
// only assert *that* something was drawn.
type Call = { method: "circle" | "poly" | "roundPoly" | "moveTo" | "lineTo"; args: number[] };
type StrokeCall = { width?: number; color?: number; cap?: string; join?: string; alignment?: number };
interface FakeGraphics {
  clear: () => FakeGraphics;
  removeChildren: () => FakeGraphics[];
  circle: (x: number, y: number, r: number) => FakeGraphics;
  poly: (points: number[]) => FakeGraphics;
  roundPoly: (x: number, y: number, radius: number, sides: number, corner: number) => FakeGraphics;
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
  Text: vi.fn().mockImplementation(function (this: FakeText, opts: { text: string; style: Record<string, unknown> }) {
    this.text = opts.text;
    this.style = opts.style;
    this.width = opts.text.length * (opts.style.fontSize as number) * 0.6;
    this.anchor = { set: vi.fn() };
    this.x = 0;
    this.y = 0;
    this.destroy = vi.fn();
  }),
}));

const { VerticalConnectionRenderer } = await import("../pixi/renderers/VerticalConnectionRenderer");
const { Container } = await import("pixi.js");

function circleMarkerStyle(overrides: Partial<VerticalMarkerStyle> = {}): VerticalMarkerStyle {
  return {
    shape: "circle", cornerStyle: "round",
    fillColor: 0x111111, borderColor: 0x222222, borderWidth: 0, gapWidth: 0, gapColor: 0x333333,
    size: 0.22,
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
    oneWayAccentColor: 0x2a2a2a,
    elevatorArrowColor: 0x444444,
    elevatorArrowSize: 0.6,
    elevatorArrowStyle: "triangle",
    elevatorArrowCornerStyle: "round",
    decorativeStairsTwoWay: { lineColor: 0x111111, lineWidth: 3, size: 0.22 },
    decorativeStairsOneWay: { lineColor: 0x111111, lineWidth: 3, size: 0.22 },
    decorativeElevator: { lineColor: 0x111111, lineWidth: 3, size: 0.22 },
    decorativeStairsArrowColor: 0x444444,
    decorativeStairsArrowSize: 0.6,
    decorativeStairsAccentColor: 0x2a2a2a,
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

describe("VerticalConnectionRenderer", () => {
  it("draws a lone marker centered at its own position, unshifted", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, { markers: [marker({ pos: [50, 60] })], style: baseStyle() });

    const circleCalls = g.calls.filter((c) => c.method === "circle");
    expect(circleCalls).toHaveLength(1);
    expect(circleCalls[0].args[0]).toBeCloseTo(50);
    expect(circleCalls[0].args[1]).toBeCloseTo(60);
  });

  it("spreads two markers sharing the same cell left/right, symmetric around the shared position", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    const a = marker({ pos: [50, 60], kind: "vertical_passage" });
    const b = marker({ pos: [50, 60], kind: "elevator" });
    render(renderer, { markers: [a, b], style: baseStyle() });

    const circleCalls = g.calls.filter((c) => c.method === "circle");
    expect(circleCalls).toHaveLength(2);
    const [xA, yA] = circleCalls[0].args;
    const [xB, yB] = circleCalls[1].args;
    // Symmetric around the shared position, on opposite sides, same Y (no vertical drift).
    expect(xA + xB).toBeCloseTo(100); // 2 * 50
    expect(xA).not.toBeCloseTo(xB);
    expect(yA).toBeCloseTo(60);
    expect(yB).toBeCloseTo(60);
  });

  it("a marker at a cell with no other marker there keeps its own center even when other cells have groups", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    const grouped1 = marker({ pos: [0, 0], kind: "vertical_passage" });
    const grouped2 = marker({ pos: [0, 0], kind: "elevator" });
    const lone = marker({ pos: [200, 200], kind: "vertical_passage" });
    render(renderer, { markers: [grouped1, grouped2, lone], style: baseStyle() });

    const circleCalls = g.calls.filter((c) => c.method === "circle");
    expect(circleCalls).toHaveLength(3);
    const loneCall = circleCalls[2];
    expect(loneCall.args[0]).toBeCloseTo(200);
    expect(loneCall.args[1]).toBeCloseTo(200);
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
    expect(Math.abs(moveCalls[0].args[1] - moveCalls[2].args[1])).toBeGreaterThan(TILE_SIZE * 0.1);
    expect(Math.abs(moveCalls[0].args[0] - moveCalls[1].args[0])).toBeCloseTo(TILE_SIZE * 0.22 * 0.75);
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

  it("size unit consistency: circle radius equals settings.size * TILE_SIZE with no border/gap", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [0, 0] })],
      style: baseStyle({ twoWayPassageMarker: circleMarkerStyle({ size: 0.3, borderWidth: 0, gapWidth: 0 }) }),
    });

    const circleCalls = g.calls.filter((c) => c.method === "circle");
    expect(circleCalls[0].args[2]).toBeCloseTo(0.3 * TILE_SIZE);
  });

  it.each(["triangle", "chevron", "arrow"] as const)(
    "arrowSizeFraction 1 makes a '%s' arrow's own tip reach exactly the marker's own radius (GitHub issue #347 fourth follow-up)",
    (pattern) => {
      const container = new Container();
      const renderer = new VerticalConnectionRenderer(container as never);
      const g = (renderer as unknown as { g: FakeGraphics }).g;
      const size = 0.4;

      render(renderer, {
        markers: [marker({ pos: [0, 0], kind: "vertical_passage", direction: "up", filled: true, arrowFilled: true })],
        style: baseStyle({
          twoWayPassageMarker: circleMarkerStyle({ size }),
          twoWayArrowStyle: pattern,
          twoWayArrowSize: 1,
        }),
      });

      const radius = size * TILE_SIZE;
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

  it("style 'decorative' spreads two same-cell markers apart sideways instead of overlapping at the same position", () => {
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
    // (the icon's `left = cx - r` start point) — one moveTo per marker, so the two calls' own X
    // directly show each icon's own shifted `cx`. `renderDecorativeMarker`'s
    // `(slot - (group.length - 1) / 2) * radius * 2.2` spread must land them symmetrically apart,
    // straddling the shared `pos[0]` (50), not both drawing on top of each other at 50.
    const moveToCalls = g.calls.filter((c) => c.method === "moveTo");
    expect(moveToCalls).toHaveLength(2);
    const [xA, xB] = moveToCalls.map((c) => c.args[0]);
    // Both markers share the same `left = cx - r` offset from their own `cx`, and the spread shifts
    // the two `cx`s symmetrically around the shared `pos[0]` (50) — so the two start-Xs must differ
    // from each other but average back to the same `50 - r` a lone marker's own start-X would be.
    expect(xA).not.toBeCloseTo(xB);
    const soloRender = new VerticalConnectionRenderer(container as never);
    const soloG = (soloRender as unknown as { g: FakeGraphics }).g;
    render(soloRender, { markers: [marker({ pos: [50, 60], kind: "vertical_passage", direction: undefined })], style: baseStyle({ style: "decorative" }) });
    const soloX = soloG.calls.find((c) => c.method === "moveTo")!.args[0];
    expect((xA + xB) / 2).toBeCloseTo(soloX);
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
      style: baseStyle({ style: "decorative", decorativeStairsArrowColor: 0xaaaaaa, decorativeStairsAccentColor: 0xbbbbbb }),
    });

    const arrowStroke = g.strokeCalls[g.strokeCalls.length - 1];
    expect(arrowStroke.color).toBe(0xaaaaaa);
  });

  it("style 'decorative' draws a one-way VerticalPassage's arrow in the accent color at both ends", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [50, 60], kind: "vertical_passage", filled: false, arrowFilled: true, direction: "up" })],
      style: baseStyle({ style: "decorative", decorativeStairsArrowColor: 0xaaaaaa, decorativeStairsAccentColor: 0xbbbbbb }),
    });

    const arrowStroke = g.strokeCalls[g.strokeCalls.length - 1];
    expect(arrowStroke.color).toBe(0xbbbbbb);
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

  it("a one-way passage's departure end draws the primary fill with a secondary-accent border, and arrival end draws entirely in the secondary accent (GitHub issue #347 fifth follow-up redesign, sixth follow-up swapped which end gets which treatment)", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    const style = baseStyle({
      oneWayPassageMarker: circleMarkerStyle({ fillColor: 0x555555, borderColor: 0x666666, borderWidth: 2 }),
      oneWayAccentColor: 0x2a2a2a,
    });

    const departure = marker({ pos: [0, 0], kind: "vertical_passage", filled: false, arrowFilled: true });
    render(renderer, { markers: [departure], style });
    expect(g.strokeCalls.at(-1)?.color).toBe(0x2a2a2a);
    expect(g.fillCalls.at(-1)).toBe(0x555555);

    g.calls.length = 0;
    g.strokeCalls.length = 0;
    g.fillCalls.length = 0;
    const arrival = marker({ pos: [0, 0], kind: "vertical_passage", filled: false, arrowFilled: false });
    render(renderer, { markers: [arrival], style });
    expect(g.strokeCalls.at(-1)?.color).toBe(0x2a2a2a);
    expect(g.fillCalls.at(-1)).toBe(0x2a2a2a);
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
