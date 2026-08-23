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
type Call = { method: "circle" | "poly" | "roundPoly" | "moveTo"; args: number[] };
type StrokeCall = { width?: number; color?: number; cap?: string; join?: string; alignment?: number };
interface FakeGraphics {
  clear: () => FakeGraphics;
  removeChildren: () => FakeGraphics[];
  circle: (x: number, y: number, r: number) => FakeGraphics;
  poly: (points: number[]) => FakeGraphics;
  roundPoly: (x: number, y: number, radius: number, sides: number, corner: number) => FakeGraphics;
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
  target.moveTo = (x, y) => { target.calls.push({ method: "moveTo", args: [x, y] }); return target; };
  target.lineTo = () => target;
  target.fillCalls = [];
  target.fill = (arg) => { target.fillCalls.push(arg as number); return target; };
  target.strokeCalls = [];
  target.stroke = (arg) => { target.strokeCalls.push(arg); return target; };
  target.addChild = (child) => { target.children.push(child as FakeGraphics); };
  target.destroy = vi.fn();
  target.on = vi.fn();
}

vi.mock("pixi.js", () => ({
  Container: vi.fn().mockImplementation(function (this: { addChild: () => void }) {
    this.addChild = vi.fn();
  }),
  Graphics: vi.fn().mockImplementation(function (this: FakeGraphics) {
    installFakeGraphics(this);
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

  it("interactive + resolved targetFloorIndex adds a clickable hit-circle wired to navigateToFloor", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [0, 0], targetFloorIndex: 2 })],
      style: baseStyle(),
      interactive: true,
    });

    expect(g.children).toHaveLength(1);
    const hit = g.children[0] as unknown as { on: (event: string, cb: () => void) => void };
    const onMock = hit.on as unknown as ReturnType<typeof vi.fn>;
    expect(onMock).toHaveBeenCalledWith("pointertap", expect.any(Function));
    const handler = onMock.mock.calls[0][1] as () => void;
    handler();
    expect(navigateToFloorMock).toHaveBeenCalledWith(2);
  });

  it("interactive but no targetFloorIndex (Elevator) adds no hit-circle", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [0, 0], kind: "elevator", targetFloorIndex: undefined })],
      style: baseStyle(),
      interactive: true,
    });

    expect(g.children).toHaveLength(0);
  });

  it("not interactive skips the hit-circle even when targetFloorIndex resolved", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [0, 0], targetFloorIndex: 1 })],
      style: baseStyle(),
    });

    expect(g.children).toHaveLength(0);
  });

  it("interactive as a predicate gates each marker independently", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [
        marker({ pos: [0, 0], targetFloorIndex: 1, filled: true }),
        marker({ pos: [5, 0], targetFloorIndex: 2, filled: false }),
      ],
      style: baseStyle(),
      interactive: (m) => m.filled,
    });

    // Only the `filled: true` marker's own hit-circle is added — the predicate rejects the other.
    expect(g.children).toHaveLength(1);
  });

  it("interactive predicate returning false for every marker adds no hit-circles", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [0, 0], targetFloorIndex: 1 })],
      style: baseStyle(),
      interactive: () => false,
    });

    expect(g.children).toHaveLength(0);
  });

  it("clear()/removeChildren() run on every render call — no stale draws or listeners accumulate across two renders", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, { markers: [marker({ pos: [0, 0], targetFloorIndex: 1 })], style: baseStyle(), interactive: true });
    expect(g.children).toHaveLength(1);
    const firstHit = g.children[0];

    render(renderer, { markers: [marker({ pos: [0, 0], targetFloorIndex: 1 })], style: baseStyle(), interactive: true });
    expect(g.children).toHaveLength(1);
    expect(g.children[0]).not.toBe(firstHit);
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

  it("style 'decorative' draws a VerticalPassage as a stairs pictogram (poly, not circle) centered at its own position", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [50, 60], kind: "vertical_passage" })],
      style: baseStyle({ style: "decorative" }),
    });

    expect(g.calls.some((c) => c.method === "circle")).toBe(false);
    const polyCalls = g.calls.filter((c) => c.method === "poly");
    expect(polyCalls).toHaveLength(1);
    // drawStairsIcon: start point + 4 steps * (x, yTop, x+w, yTop) + closing point = 2 + 16 + 2.
    expect(polyCalls[0].args).toHaveLength(20);
    // First/last points sit on the marker's own horizontal center line (cy), matching cx±r.
    expect(polyCalls[0].args[1]).toBeCloseTo(polyCalls[0].args[19]);
  });

  it("style 'decorative' still draws an Elevator as its ordinary marker shape (no stairs treatment, per the renderer's own doc comment)", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [50, 60], kind: "elevator", direction: "both" })],
      style: baseStyle({ style: "decorative" }),
    });

    expect(g.calls.some((c) => c.method === "circle")).toBe(true);
    expect(g.calls.some((c) => c.method === "poly")).toBe(false);
  });

  it("a one-way passage's arrival end draws the primary fill with a secondary-accent border, and departure end draws entirely in the secondary accent (GitHub issue #347 fifth follow-up redesign)", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    const style = baseStyle({
      oneWayPassageMarker: circleMarkerStyle({ fillColor: 0x555555, borderColor: 0x666666, borderWidth: 2 }),
      oneWayAccentColor: 0x2a2a2a,
    });

    const arrival = marker({ pos: [0, 0], kind: "vertical_passage", filled: false, arrowFilled: false });
    render(renderer, { markers: [arrival], style });
    expect(g.strokeCalls.at(-1)?.color).toBe(0x2a2a2a);
    expect(g.fillCalls.at(-1)).toBe(0x555555);

    g.calls.length = 0;
    g.strokeCalls.length = 0;
    g.fillCalls.length = 0;
    const departure = marker({ pos: [0, 0], kind: "vertical_passage", filled: false, arrowFilled: true });
    render(renderer, { markers: [departure], style });
    expect(g.strokeCalls.at(-1)?.color).toBe(0x2a2a2a);
    expect(g.fillCalls.at(-1)).toBe(0x2a2a2a);
  });
});
