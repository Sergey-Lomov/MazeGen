import { beforeEach, describe, expect, it, vi } from "vitest";

const graphSpies = vi.hoisted(() => ({
  buildCrossFloorMarkers: vi.fn(() => [{
    nodeId: 1,
    nodePos: { x: 10, y: 20 },
    badgePos: { x: 30, y: 40 },
    targetFloorIndex: 1,
    direction: "toBadge" as const,
  }]),
  drawCrossFloorMarkers: vi.fn(),
}));

const regionRenderSpy = vi.hoisted(() => vi.fn());
const edgeRenderSpy = vi.hoisted(() => vi.fn());
const splitWallAndLineEdgesSpy = vi.hoisted(() =>
  vi.fn((_g: unknown, edges: { from: unknown; to: unknown; asWall: boolean }[]) =>
    edges.filter((e) => !e.asWall).map(({ from, to }) => ({ from, to }))),
);

vi.mock("pixi.js", () => {
  class FakeContainer {
    children: unknown[] = [];
    addChild(child: unknown) { this.children.push(child); return child; }
    removeChildren() { const children = this.children; this.children = []; return children; }
    destroy() {}
  }
  class FakeGraphics {
    calls: { fn: string; args: unknown[] }[] = [];
    circle(...args: unknown[]) { this.calls.push({ fn: "circle", args }); return this; }
    fill(...args: unknown[]) { this.calls.push({ fn: "fill", args }); return this; }
    clear() { this.calls.push({ fn: "clear", args: [] }); return this; }
    destroy() {}
  }
  return { Container: FakeContainer, Graphics: FakeGraphics };
});

vi.mock("../pixi/BaseGraphRenderer", () => graphSpies);
vi.mock("../pixi/tessellationGeometry", () => ({
  buildNodePositions: () => new Map([[1, { x: 10, y: 20 }]]),
}));
vi.mock("../pixi/renderers/NodeEdgeHighlightRenderer", () => ({
  NodeEdgeHighlightRenderer: class { render(...args: unknown[]) { edgeRenderSpy(...args); } clear() {} destroy() {} },
}));
vi.mock("../pixi/renderers/RegionHighlightRenderer", () => ({
  RegionHighlightRenderer: class { render(...args: unknown[]) { regionRenderSpy(...args); } clear() {} destroy() {} },
}));
vi.mock("../pixi/renderers/wallUtils", () => ({
  drawCellBoundaryHighlight: vi.fn(() => false),
  splitWallAndLineEdges: splitWallAndLineEdgesSpy,
}));

import { Container, Graphics } from "pixi.js";
import { DebugRefHighlightOverlay } from "../pixi/DebugRefHighlightOverlay";
import { NODE_RADIUS } from "../pixi/renderConstants";
import { canvas } from "../pixi/colorTokens";
import { fieldOf } from "./fieldConfigFixtures";

type FakeContainer = InstanceType<typeof Container> & { children: unknown[] };
type FakeGraphics = InstanceType<typeof Graphics> & { calls: { fn: string; args: unknown[] }[] };

describe("DebugRefHighlightOverlay cross-floor refs (GitHub issue #449)", () => {
  it("renders the shared floor badge with debug line styling and an on-floor node marker", () => {
    const root = new Container() as FakeContainer;
    const overlay = new DebugRefHighlightOverlay(root as never);
    const resolveNodeLevel = (id: number) => id === 2 ? 1 : 0;
    const resolveNodeCell = (id: number): [number, number] | undefined => id === 1 ? [0, 0] : [0, 0];

    overlay.render({
      nodes: [{ id: 1, i: 0, x: 0, y: 0, level: 0 }],
      allNodes: [],
      edges: [{ from: 1, to: 2, kind: "vertical_passage" }],
      ref: { kind: "edge", from: 1n, to: 2n, bidirectional: false },
      cfg: fieldOf("square", { shape: "rect", cols: 2, rows: 2 }),
      resolveNodeLevel,
      resolveNodeCell,
      activeFloorIndex: 0,
    });

    expect(graphSpies.buildCrossFloorMarkers).toHaveBeenCalledWith(
      [{ from: 1, to: 2 }], expect.any(Map), resolveNodeLevel, resolveNodeCell,
      0, expect.objectContaining({ tessellation: { kind: "square", params: {} } }), NODE_RADIUS,
    );
    expect(graphSpies.drawCrossFloorMarkers).toHaveBeenCalledWith(
      root.children[3], root.children[4], expect.any(Array), NODE_RADIUS,
      canvas.debug.refHighlight, canvas.debug.refHighlight, canvas.debug.refHighlight, 3, 1,
    );

    const nodeLayer = root.children[4] as FakeContainer;
    const nodeMarker = nodeLayer.children[0] as FakeGraphics;
    expect(nodeMarker.calls).toContainEqual({ fn: "circle", args: [10, 20, NODE_RADIUS] });
    expect(nodeMarker.calls).toContainEqual({
      fn: "fill", args: [{ color: canvas.debug.refHighlight, alpha: 1 }],
    });
  });
});

describe("DebugRefHighlightOverlay issue refs (GitHub issue #619)", () => {
  beforeEach(() => {
    regionRenderSpy.mockClear();
    edgeRenderSpy.mockClear();
    splitWallAndLineEdgesSpy.mockClear();
  });

  const baseData = {
    nodes: [{ id: 1, i: 0, x: 0, y: 0, level: 0 }, { id: 2, i: 1, x: 1, y: 0, level: 0 }],
    allNodes: [],
    edges: [],
    cfg: fieldOf("square", { shape: "rect", cols: 2, rows: 2 }),
  };

  it("a null target renders neither edges nor a region", () => {
    const overlay = new DebugRefHighlightOverlay(new Container() as never);
    overlay.render({
      ...baseData,
      ref: { kind: "issue", issueKind: "excessive_scc_count", target: null, reasons: [] },
    });

    expect(edgeRenderSpy).toHaveBeenCalledWith([]);
    expect(regionRenderSpy).toHaveBeenCalledWith(expect.objectContaining({ regionGroups: [] }));
    expect(splitWallAndLineEdgesSpy).not.toHaveBeenCalled();
  });

  it("a cycle-only target with asWall draws the wall/line split via the shared splitWallAndLineEdges helper and renders no region", () => {
    const overlay = new DebugRefHighlightOverlay(new Container() as never);
    overlay.render({
      ...baseData,
      ref: {
        kind: "issue", issueKind: "invalid_one_way",
        target: { cycle: { edges: [[1n, 2n]], asWall: true }, region: null },
        reasons: [],
      },
    });

    expect(splitWallAndLineEdgesSpy).toHaveBeenCalledTimes(1);
    const [, wallEdges] = splitWallAndLineEdgesSpy.mock.calls[0];
    expect(wallEdges).toEqual([{ from: 1n, to: 2n, asWall: true }]);
    expect(regionRenderSpy).toHaveBeenCalledWith(expect.objectContaining({ regionGroups: [] }));
  });

  it("a cycle-only target without asWall passes every edge straight through as a line, none as a wall", () => {
    const overlay = new DebugRefHighlightOverlay(new Container() as never);
    overlay.render({
      ...baseData,
      ref: {
        kind: "issue", issueKind: "invalid_loop",
        target: { cycle: { edges: [[1n, 2n]], asWall: false }, region: null },
        reasons: [],
      },
    });

    const [, wallEdges] = splitWallAndLineEdgesSpy.mock.calls[0];
    expect(wallEdges).toEqual([{ from: 1n, to: 2n, asWall: false }]);
    // The mocked `buildNodePositions` only resolves node 1's position (see the module mock above),
    // so this edge's other endpoint (node 2) has no resolvable position and is dropped -- this
    // asserts `splitWallAndLineEdges`'s line-edges were fed into `edgeHighlightsFor` at all, not
    // the position-lookup behavior itself (already covered by the cross-floor describe block).
    expect(edgeRenderSpy).toHaveBeenCalledWith([]);
  });

  it("a region-only target splits groups into inset (isSplit: false) and outset (isSplit: true) batches and renders no edges", () => {
    const overlay = new DebugRefHighlightOverlay(new Container() as never);
    overlay.render({
      ...baseData,
      ref: {
        kind: "issue", issueKind: "invalid_cross_element_group",
        target: { cycle: null, region: { groups: [{ nodes: [1n], isSplit: false }, { nodes: [1n, 2n], isSplit: true }] } },
        reasons: [],
      },
    });

    expect(edgeRenderSpy).toHaveBeenCalledWith([]);
    expect(regionRenderSpy).toHaveBeenCalledWith(expect.objectContaining({
      groups: [
        { regionGroups: [[1]], color: canvas.debug.issueHighlight, insetMode: "inset" },
        { regionGroups: [[1, 2]], color: canvas.debug.issueHighlight, insetMode: "outset" },
      ],
    }));
  });

  it("a mixed cycle+region target (e.g. a one-way member paired with a split member) renders both independently, not one or the other", () => {
    const overlay = new DebugRefHighlightOverlay(new Container() as never);
    overlay.render({
      ...baseData,
      ref: {
        kind: "issue", issueKind: "invalid_cross_element_group",
        target: {
          cycle: { edges: [[1n, 2n]], asWall: true },
          region: { groups: [{ nodes: [1n, 2n], isSplit: true }] },
        },
        reasons: [],
      },
    });

    expect(splitWallAndLineEdgesSpy).toHaveBeenCalledTimes(1);
    expect(regionRenderSpy).toHaveBeenCalledWith(expect.objectContaining({
      groups: [
        { regionGroups: [], color: canvas.debug.issueHighlight, insetMode: "inset" },
        { regionGroups: [[1, 2]], color: canvas.debug.issueHighlight, insetMode: "outset" },
      ],
    }));
  });
});
