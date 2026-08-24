import { describe, it, expect, vi } from "vitest";

vi.mock("../pixi/tessellationGeometry", () => ({
  getCellCenter: (x: number, y: number) => ({ x: x * 10, y: y * 10 }),
  getCellVertices: () => null,
}));

vi.mock("../pixi/renderers/floorNavigation", () => ({
  navigateToFloor: vi.fn(),
}));

// Minimal fake pixi (same pattern as `TeleportRenderer.test.ts`) so `RegionOverlayRenderer.render()`
// can be exercised end-to-end — `CellFillRenderer` (cell fill) and `floorBadge.ts` (badge + hit-circle)
// both draw into these fakes too, so this also covers the `attachFloorBadgeNavigation` wiring
// (GitHub issue #368) that `render()`'s own `drawBadge` closure calls for every ring/teleport marker.
vi.mock("pixi.js", () => {
  class FakeGraphics {
    calls: { fn: string; args: unknown[] }[] = [];
    children: unknown[] = [];
    circle(...args: unknown[]) { this.calls.push({ fn: "circle", args }); return this; }
    poly(...args: unknown[]) { this.calls.push({ fn: "poly", args }); return this; }
    moveTo(...args: unknown[]) { this.calls.push({ fn: "moveTo", args }); return this; }
    lineTo(...args: unknown[]) { this.calls.push({ fn: "lineTo", args }); return this; }
    fill(...args: unknown[]) { this.calls.push({ fn: "fill", args }); return this; }
    stroke(...args: unknown[]) { this.calls.push({ fn: "stroke", args }); return this; }
    clear() { this.calls = []; return this; }
    addChild(child: unknown) { this.children.push(child); return child; }
    destroy() {}
    eventMode = "auto";
    cursor = "";
    listeners: Record<string, (() => void)[]> = {};
    on(event: string, cb: () => void) { (this.listeners[event] ??= []).push(cb); return this; }
  }
  class FakeContainer {
    children: FakeGraphics[] = [];
    addChild(child: FakeGraphics) { this.children.push(child); return child; }
    destroy() {}
  }
  class FakeText {
    anchor = { set: vi.fn() };
    x = 0;
    y = 0;
    text: string;
    constructor(opts: { text: string }) { this.text = opts.text; }
    destroy() {}
  }
  return { Container: FakeContainer, Graphics: FakeGraphics, Text: FakeText };
});

const { RegionOverlayRenderer, buildRegionRingMarkers, buildRegionTeleportMarkers } = await import(
  "../pixi/renderers/RegionOverlayRenderer"
);
const { navigateToFloor } = await import("../pixi/renderers/floorNavigation");
const { Container } = await import("pixi.js");
import type { NodeDto } from "../wasm/generated/dto";
import type { EdgeDto } from "../wasm/generated/dto";
import type { TeleportEdge } from "../pixi/renderers/types";

type FakeChild = { calls: { fn: string; args: unknown[] }[]; listeners?: Record<string, (() => void)[]> };
type FakeCont = { children: FakeChild[] };

function node(id: number, x: number, y: number): NodeDto {
  return { id, x, y, i: 0, level: 0 } as NodeDto;
}

describe("buildRegionRingMarkers", () => {
  const components = [[1, 2], [3]];
  const componentColors = [0xff0000, 0x00ff00];
  const unscopedNodeById = new Map<number, NodeDto>([
    [1, node(1, 0, 0)],
    [2, node(2, 5, 5)],
  ]);

  it("collects a badge when a same-component vertical_passage edge leaves the active floor", () => {
    const resolveNodeLevel = (id: number) => (id === 1 ? 0 : 1);
    const edges: EdgeDto[] = [{ from: 1, to: 2, kind: "vertical_passage" }];
    const markers = buildRegionRingMarkers(components, edges, resolveNodeLevel, 0, unscopedNodeById, componentColors);
    expect(markers).toEqual([{ cell: [0, 0], color: 0xff0000, targets: [1] }]);
  });

  it("skips edges whose endpoints land in different components", () => {
    const resolveNodeLevel = (id: number) => (id === 1 ? 0 : 1);
    const edges: EdgeDto[] = [{ from: 1, to: 3, kind: "elevator" }];
    const nodeById = new Map<number, NodeDto>([[1, node(1, 0, 0)], [3, node(3, 5, 5)]]);
    const markers = buildRegionRingMarkers(components, edges, resolveNodeLevel, 0, nodeById, componentColors);
    expect(markers).toEqual([]);
  });

  it("skips edges of an unrelated kind (basic/teleport)", () => {
    const resolveNodeLevel = (id: number) => (id === 1 ? 0 : 1);
    const edges: EdgeDto[] = [{ from: 1, to: 2, kind: "basic" }];
    const markers = buildRegionRingMarkers(components, edges, resolveNodeLevel, 0, unscopedNodeById, componentColors);
    expect(markers).toEqual([]);
  });

  it("skips edges that don't leave the active floor", () => {
    const resolveNodeLevel = () => 0;
    const edges: EdgeDto[] = [{ from: 1, to: 2, kind: "elevator" }];
    const markers = buildRegionRingMarkers(components, edges, resolveNodeLevel, 0, unscopedNodeById, componentColors);
    expect(markers).toEqual([]);
  });

  it("merges distinct target floors reached from the same cell into one marker", () => {
    const nodeById = new Map<number, NodeDto>([
      [1, node(1, 0, 0)],
      [2, node(2, 5, 5)],
      [4, node(4, 6, 6)],
    ]);
    const comps = [[1, 2, 4]];
    const colors = [0x123456];
    const resolveNodeLevel = (id: number) => (id === 1 ? 0 : id === 2 ? 1 : 2);
    const edges: EdgeDto[] = [
      { from: 1, to: 2, kind: "elevator" },
      { from: 1, to: 4, kind: "elevator" },
    ];
    const markers = buildRegionRingMarkers(comps, edges, resolveNodeLevel, 0, nodeById, colors);
    expect(markers).toEqual([{ cell: [0, 0], color: 0x123456, targets: [1, 2] }]);
  });
});

describe("buildRegionTeleportMarkers", () => {
  const components = [[1, 2]];
  const componentColors = [0xabcdef];
  const unscopedNodeById = new Map<number, NodeDto>([[1, node(1, 3, 4)]]);
  const cfg = {} as never;

  it("builds a marker anchored to the teleport's own badge position for a toFloor edge", () => {
    const edges: TeleportEdge[] = [{ from: [30, 40], to: [99, 88], oneWay: false, fromNode: 1, toNode: 2, toFloor: 2 }];
    const markers = buildRegionTeleportMarkers(components, edges, unscopedNodeById, cfg, componentColors);
    expect(markers).toEqual([{ pos: [99, 88], stubFrom: [30, 40], color: 0xabcdef, targetFloorIndex: 2 }]);
  });

  it("builds a marker anchored to `from` for a fromFloor edge", () => {
    const edges: TeleportEdge[] = [{ from: [11, 22], to: [30, 40], oneWay: false, fromNode: 2, toNode: 1, fromFloor: 3 }];
    const markers = buildRegionTeleportMarkers(components, edges, unscopedNodeById, cfg, componentColors);
    expect(markers).toEqual([{ pos: [11, 22], stubFrom: [30, 40], color: 0xabcdef, targetFloorIndex: 3 }]);
  });

  it("skips edges with neither toFloor nor fromFloor set", () => {
    const edges: TeleportEdge[] = [{ from: [11, 22], to: [30, 40], oneWay: false, fromNode: 1, toNode: 2 }];
    const markers = buildRegionTeleportMarkers(components, edges, unscopedNodeById, cfg, componentColors);
    expect(markers).toEqual([]);
  });

  it("skips edges whose on-floor and off-floor node land in different components", () => {
    const nodeById = new Map<number, NodeDto>([[1, node(1, 3, 4)]]);
    const comps = [[1], [2]];
    const edges: TeleportEdge[] = [{ from: [30, 40], to: [99, 88], oneWay: false, fromNode: 1, toNode: 2, toFloor: 2 }];
    const markers = buildRegionTeleportMarkers(comps, edges, nodeById, cfg, componentColors);
    expect(markers).toEqual([]);
  });
});

describe("RegionOverlayRenderer.render", () => {
  const cfg = {} as never;

  it("draws a clickable hit-circle wired to navigateToFloor for a cross-floor ring marker", () => {
    const cellsContainer = new Container() as unknown as FakeCont;
    const badgesContainer = new Container() as unknown as FakeCont;
    const renderer = new RegionOverlayRenderer(cellsContainer as never, badgesContainer as never);

    const nodes: NodeDto[] = [node(1, 0, 0), node(2, 5, 5)];
    const components = [[1, 2]];
    const resolveNodeLevel = (id: number) => (id === 1 ? 0 : 1);
    const allEdges: EdgeDto[] = [{ from: 1, to: 2, kind: "elevator" }];

    renderer.render({
      nodes, components, componentColors: [0xff0000], alpha: 0.5, cfg,
      allEdges, resolveNodeLevel, activeFloorIndex: 0,
    });

    // The constructor already adds one (empty) inner container; `render()` replaces it with a fresh
    // one holding the actual badges, so the populated container is the *last* child, not the first.
    const inner = badgesContainer.children[badgesContainer.children.length - 1] as unknown as FakeCont;
    const hit = inner.children.find((c) => c.listeners?.["pointertap"] !== undefined);
    expect(hit).toBeDefined();

    hit!.listeners!["pointertap"][0]();
    expect(navigateToFloor).toHaveBeenCalledWith(1);
  });

  it("draws a clickable hit-circle wired to navigateToFloor for a cross-floor teleport marker", () => {
    vi.mocked(navigateToFloor).mockClear();
    const cellsContainer = new Container() as unknown as FakeCont;
    const badgesContainer = new Container() as unknown as FakeCont;
    const renderer = new RegionOverlayRenderer(cellsContainer as never, badgesContainer as never);

    const nodes: NodeDto[] = [node(1, 3, 4)];
    const components = [[1, 2]];
    const teleportEdges: TeleportEdge[] = [{ from: [30, 40], to: [99, 88], oneWay: false, fromNode: 1, toNode: 2, toFloor: 2 }];

    renderer.render({
      nodes, components, componentColors: [0xabcdef], alpha: 0.5, cfg, teleportEdges,
    });

    const inner = badgesContainer.children[badgesContainer.children.length - 1] as unknown as FakeCont;
    const hit = inner.children.find((c) => c.listeners?.["pointertap"] !== undefined);
    expect(hit).toBeDefined();

    hit!.listeners!["pointertap"][0]();
    expect(navigateToFloor).toHaveBeenCalledWith(2);
  });
});
