import { describe, expect, it, vi } from "vitest";

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
  NodeEdgeHighlightRenderer: class { render() {} clear() {} destroy() {} },
}));
vi.mock("../pixi/renderers/RegionHighlightRenderer", () => ({
  RegionHighlightRenderer: class { render() {} clear() {} destroy() {} },
}));
vi.mock("../pixi/renderers/wallUtils", () => ({ drawOneWayWallHighlight: vi.fn(() => false) }));

import { Container, Graphics } from "pixi.js";
import { DebugRefHighlightOverlay } from "../pixi/DebugRefHighlightOverlay";
import { NODE_RADIUS } from "../pixi/renderConstants";
import { canvas } from "../pixi/colorTokens";

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
      cfg: { type: "square", width: 2, height: 2 },
      resolveNodeLevel,
      resolveNodeCell,
      activeFloorIndex: 0,
    });

    expect(graphSpies.buildCrossFloorMarkers).toHaveBeenCalledWith(
      [{ from: 1, to: 2 }], expect.any(Map), resolveNodeLevel, resolveNodeCell,
      0, expect.objectContaining({ type: "square" }), NODE_RADIUS,
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
