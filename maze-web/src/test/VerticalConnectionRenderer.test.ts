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
type Call = { method: "circle" | "poly"; args: number[] };
interface FakeGraphics {
  clear: () => FakeGraphics;
  removeChildren: () => FakeGraphics[];
  circle: (x: number, y: number, r: number) => FakeGraphics;
  poly: (points: number[]) => FakeGraphics;
  fill: (arg: unknown) => FakeGraphics;
  stroke: (arg: unknown) => FakeGraphics;
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
  target.fill = () => target;
  target.stroke = () => target;
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
    displayStyle: "marker",
    verticalPassageMarker: circleMarkerStyle(),
    elevatorMarker: circleMarkerStyle(),
    arrowColor: 0x444444,
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

  it("a 'both' direction elevator draws two arrows side by side (different X), level with each other (equal Y)", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [0, 0], kind: "elevator", direction: "both", arrowFilled: true })],
      style: baseStyle(),
    });

    // Each `drawDirectionArrow` call emits one `poly` (the arrow triangle) — the marker's own
    // circle isn't a poly call (shape: "circle" goes through `g.circle`), so every poly call here
    // is an arrow.
    const polyCalls = g.calls.filter((c) => c.method === "poly");
    expect(polyCalls).toHaveLength(2);

    // `drawDirectionArrow`'s own tip/base midpoint (not the 3-vertex centroid — see
    // `VerticalConnectionRenderer`'s own doc comment on `oy`: it explicitly compensates the tip/base
    // midpoint, `(tipY + baseY) / 2`, to land at the same Y for both arrows, GitHub issue #337
    // follow-up "идеально ровно на одной высоте"). Vertex order is `[tip, baseA, baseB]`, so `tipY`
    // is index 1 and `baseY` is the shared Y of vertices at index 3 and 5.
    const tipBaseMidY = (points: number[]) => (points[1] + points[3]) / 2;
    const avgX = (points: number[]) => (points[0] + points[2] + points[4]) / 3;
    const [up, down] = polyCalls;
    expect(tipBaseMidY(up.args)).toBeCloseTo(tipBaseMidY(down.args), 5);
    expect(avgX(up.args)).not.toBeCloseTo(avgX(down.args));
  });

  it("a single-direction marker draws its own arrow with no horizontal offset applied", () => {
    const container = new Container();
    const renderer = new VerticalConnectionRenderer(container as never);
    const g = (renderer as unknown as { g: FakeGraphics }).g;

    render(renderer, {
      markers: [marker({ pos: [0, 0], kind: "vertical_passage", direction: "up", arrowFilled: true })],
      style: baseStyle(),
    });

    const polyCalls = g.calls.filter((c) => c.method === "poly");
    expect(polyCalls).toHaveLength(1);
    const avgX = (polyCalls[0].args[0] + polyCalls[0].args[2] + polyCalls[0].args[4]) / 3;
    expect(avgX).toBeCloseTo(0);
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
      style: baseStyle({ verticalPassageMarker: circleMarkerStyle({ size: 0.3, borderWidth: 0, gapWidth: 0 }) }),
    });

    const circleCalls = g.calls.filter((c) => c.method === "circle");
    expect(circleCalls[0].args[2]).toBeCloseTo(0.3 * TILE_SIZE);
  });
});
