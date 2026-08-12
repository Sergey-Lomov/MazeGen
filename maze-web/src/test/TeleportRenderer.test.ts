import { describe, it, expect, vi } from "vitest";
import { computeMixedCells, clipDistance, resolvePointFillState, planGroupDrawOrder } from "../pixi/renderers/TeleportRenderer";
import { buildTeleportGroups } from "../pixi/selectors/teleportGroups";
import type { TeleportEdge, TeleportLineStyle } from "../pixi/renderers/types";
import type { RoutedConnector } from "../pixi/renderers/teleportConnectorRouting";

// `getCartesianCoords` (wasm) is never reached by the group-customization-off `render()` path
// exercised below (no `TeleportConnectorRouter.route` call needed since `connectorStyle: "none"`),
// but `TeleportRenderer`'s own module graph pulls in `../../store/mazeStore`, which pulls in
// `../wasm/mazeService` at import time — same rationale as `VectorByWallsSettingsPanel.test.tsx`.
vi.mock("../wasm/mazeService", () => ({
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
}));
vi.mock("../wasm/wasmLoader", () => ({
  initWasm: vi.fn(() => Promise.resolve()),
}));

// Fake `Graphics`/`Container` (same minimal pattern as `WallRenderer.test.ts`) recording every draw
// call in order, so the gaps-then-connectors-then-points draw order (GitHub issue #302) is
// verifiable without a real pixi renderer. `circle` is needed since `drawMarkerShape`'s default
// `"circle"` shape (this test's own style) calls `g.circle(...)` directly, not `g.poly(...)`.
vi.mock("pixi.js", () => {
  class FakeGraphics {
    calls: { fn: string; args: unknown[] }[] = [];
    children: unknown[] = [];
    circle(...args: unknown[]) { this.calls.push({ fn: "circle", args }); return this; }
    poly(...args: unknown[]) { this.calls.push({ fn: "poly", args }); return this; }
    roundPoly(...args: unknown[]) { this.calls.push({ fn: "roundPoly", args }); return this; }
    moveTo(...args: unknown[]) { this.calls.push({ fn: "moveTo", args }); return this; }
    lineTo(...args: unknown[]) { this.calls.push({ fn: "lineTo", args }); return this; }
    fill(...args: unknown[]) { this.calls.push({ fn: "fill", args }); return this; }
    stroke(...args: unknown[]) { this.calls.push({ fn: "stroke", args }); return this; }
    clear() { this.calls = []; return this; }
    removeChildren() { const c = this.children; this.children = []; return c; }
    addChild(child: unknown) { this.children.push(child); }
    destroy() {}
    eventMode = "auto";
    cursor = "";
    listeners: Record<string, (() => void)[]> = {};
    on(event: string, cb: () => void) { (this.listeners[event] ??= []).push(cb); return this; }
  }
  class FakeContainer {
    addChild() {}
    destroy() {}
  }
  // `drawFloorBadge` (GitHub issue #337) constructs a real pixi `Text` for the floor-number label —
  // a minimal stand-in recording `anchor`/`x`/`y` writes is enough for tests to assert positioning
  // without a real canvas/font measurement.
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

const { TeleportRenderer } = await import("../pixi/renderers/TeleportRenderer");
const { TeleportConnectorRouter } = await import("../pixi/renderers/teleportConnectorRouter");
const { Container, Graphics } = await import("pixi.js");

function baseLineStyle(overrides: Partial<TeleportLineStyle> = {}): TeleportLineStyle {
  return {
    shape: "circle",
    cornerStyle: "sharp",
    size: 0.2,
    edgeColor: 0x111,
    edgeBorderColor: 0x222,
    borderWidth: 2,
    edgeGapWidth: 3,
    connectorColor: 0x333,
    connectorWidth: 3,
    connectorStyle: "none",
    arrowMode: "none",
    arrowPeriod: 5,
    arrowSize: 10,
    connectorGapWidth: 0,
    floorColor: 0x444,
    ...overrides,
  };
}

describe("computeMixedCells", () => {
  it("no edges — no mixed cells", () => {
    expect(computeMixedCells([]).size).toBe(0);
  });

  it("single two-way teleport — both ends filled, not mixed", () => {
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [1, 1], oneWay: false }];
    expect(computeMixedCells(edges).size).toBe(0);
  });

  it("single one-way teleport — origin filled, destination outline, not mixed", () => {
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [1, 1], oneWay: true }];
    expect(computeMixedCells(edges).size).toBe(0);
  });

  it("two one-way teleports whose destinations both land on the same cell — not mixed (both outline)", () => {
    const edges: TeleportEdge[] = [
      { from: [0, 0], to: [5, 5], oneWay: true },
      { from: [1, 1], to: [5, 5], oneWay: true },
    ];
    expect(computeMixedCells(edges).size).toBe(0);
  });

  it("one-way origin coincides with another one-way's destination on the same cell — mixed", () => {
    const edges: TeleportEdge[] = [
      { from: [5, 5], to: [9, 9], oneWay: true },
      { from: [1, 1], to: [5, 5], oneWay: true },
    ];
    const mixed = computeMixedCells(edges);
    expect(mixed.size).toBe(1);
    expect(mixed.has("5000,5000")).toBe(true);
  });

  it("one-way destination coincides with a two-way endpoint on the same cell — mixed", () => {
    const edges: TeleportEdge[] = [
      { from: [9, 9], to: [2, 2], oneWay: true },
      { from: [0, 0], to: [2, 2], oneWay: false },
    ];
    const mixed = computeMixedCells(edges);
    expect(mixed.size).toBe(1);
    expect(mixed.has("2000,2000")).toBe(true);
  });

  it("cell only ever wanted filled by multiple edges — not mixed", () => {
    const edges: TeleportEdge[] = [
      { from: [0, 0], to: [3, 3], oneWay: false },
      { from: [0, 0], to: [4, 4], oneWay: false },
    ];
    expect(computeMixedCells(edges).size).toBe(0);
  });
});

describe("resolvePointFillState", () => {
  // GitHub issue #293 follow-up: the "grouped" pattern's points now resolve fill/outline/mixed the
  // same way "line"-pattern endpoints do, instead of always drawing filled.
  it("a two-way teleport's endpoint resolves filled", () => {
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [1, 1], oneWay: false }];
    expect(resolvePointFillState(edges, 0, 0)).toBe("filled");
    expect(resolvePointFillState(edges, 1, 1)).toBe("filled");
  });

  it("a one-way teleport's origin resolves filled, destination resolves outline", () => {
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [1, 1], oneWay: true }];
    expect(resolvePointFillState(edges, 0, 0)).toBe("filled");
    expect(resolvePointFillState(edges, 1, 1)).toBe("outline");
  });

  it("a point with no edges landing on it resolves outline (no filled edge wants it)", () => {
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [1, 1], oneWay: true }];
    expect(resolvePointFillState(edges, 9, 9)).toBe("outline");
  });

  it("a point wanted filled by one edge and outline by another resolves mixed", () => {
    const edges: TeleportEdge[] = [
      { from: [5, 5], to: [9, 9], oneWay: true },
      { from: [1, 1], to: [5, 5], oneWay: true },
    ];
    expect(resolvePointFillState(edges, 5, 5)).toBe("mixed");
  });
});

describe("clipDistance", () => {
  const half = 5.6;
  const strokeWidth = 3;

  it("axis-aligned direction — clips to flat side plus half stroke width", () => {
    expect(clipDistance(1, 0, half, strokeWidth)).toBeCloseTo(half + strokeWidth / 2);
    expect(clipDistance(0, 1, half, strokeWidth)).toBeCloseTo(half + strokeWidth / 2);
  });

  it("exact diagonal direction — clips to the square's corner distance plus half stroke width", () => {
    const u = Math.SQRT1_2;
    expect(clipDistance(u, u, half, strokeWidth)).toBeCloseTo(half * Math.SQRT2 + strokeWidth / 2);
  });

  it("shallow non-axis-aligned direction — geometric part of the clip lands exactly on the square's border", () => {
    const ux = 0.9486832980505138;
    const uy = -0.31622776601683794;
    const clip = clipDistance(ux, uy, half, strokeWidth);
    expect(clip).toBeGreaterThan(half + strokeWidth / 2);
    const geometricClip = clip - strokeWidth / 2;
    expect(Math.max(Math.abs(ux * geometricClip), Math.abs(uy * geometricClip))).toBeCloseTo(half);
  });
});

// `planGroupDrawOrder` resolves which groups are visible and buckets each visible group's own
// connectors — `TeleportRenderer.renderGroups` walks this plan in three flat passes (every group's
// gaps, then every group's connectors, then every group's points — GitHub issue #302) rather than
// interleaving per group. Pure, so testable without a `Graphics` mock.
describe("planGroupDrawOrder", () => {
  const routed = (): RoutedConnector => ({ points: [0, 0, 1, 1] });

  it("one group, one connector — single plan entry carrying that connector", () => {
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [5, 5], oneWay: false, fromNode: 1, toNode: 2 }];
    const groups = buildTeleportGroups(edges);
    const connectors = [{ edge: edges[0], routed: routed(), color: 0 }];
    const plan = planGroupDrawOrder(groups, connectors, null);
    expect(plan).toHaveLength(1);
    expect(plan[0].group.key).toBe(groups[0].key);
    expect(plan[0].connectors).toEqual(connectors);
  });

  it("two independent groups — plan preserves groups' own order, each with only its own connector", () => {
    const edges: TeleportEdge[] = [
      { from: [0, 0], to: [5, 5], oneWay: false, fromNode: 1, toNode: 2 },
      { from: [9, 9], to: [3, 3], oneWay: false, fromNode: 10, toNode: 11 },
    ];
    const groups = buildTeleportGroups(edges);
    const connectors = edges.map((edge) => ({ edge, routed: routed(), color: 0 }));
    const plan = planGroupDrawOrder(groups, connectors, null);
    expect(plan).toHaveLength(2);
    expect(plan.map((p) => p.group.key)).toEqual(groups.map((g) => g.key));
    // Each group's bucket contains only the connector whose endpoints land in that group — not
    // every connector globally (the bug this interleave replaces would draw all connectors first).
    for (const entry of plan) {
      expect(entry.connectors).toHaveLength(1);
      expect(groups.find((g) => g.key === entry.group.key)!.edgeKeys).toContain(
        entry.connectors[0].edge.fromNode! < entry.connectors[0].edge.toNode!
          ? `${entry.connectors[0].edge.fromNode}-${entry.connectors[0].edge.toNode}`
          : `${entry.connectors[0].edge.toNode}-${entry.connectors[0].edge.fromNode}`,
      );
    }
  });

  it("selectedKey filters to just the matching group, in visibility order", () => {
    const edges: TeleportEdge[] = [
      { from: [0, 0], to: [5, 5], oneWay: false, fromNode: 1, toNode: 2 },
      { from: [9, 9], to: [3, 3], oneWay: false, fromNode: 10, toNode: 11 },
    ];
    const groups = buildTeleportGroups(edges);
    const connectors = edges.map((edge) => ({ edge, routed: routed(), color: 0 }));
    const plan = planGroupDrawOrder(groups, connectors, groups[0].key);
    expect(plan).toHaveLength(1);
    expect(plan[0].group.key).toBe(groups[0].key);
  });

  it("a connector whose endpoints match no group is dropped from the plan, not thrown", () => {
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [5, 5], oneWay: false, fromNode: 1, toNode: 2 }];
    const groups = buildTeleportGroups(edges);
    const strayEdge: TeleportEdge = { from: [50, 50], to: [60, 60], oneWay: false, fromNode: 99, toNode: 100 };
    const connectors = [{ edge: strayEdge, routed: routed(), color: 0 }];
    const plan = planGroupDrawOrder(groups, connectors, null);
    expect(plan).toHaveLength(1);
    expect(plan[0].connectors).toHaveLength(0);
  });

  it("no groups — empty plan", () => {
    expect(planGroupDrawOrder([], [], null)).toEqual([]);
  });
});

// `TeleportRenderer.render` draws each group as its own gaps-then-connectors-then-points block
// (GitHub issue #302) — verified here against the fake `Graphics`'s recorded call order, since
// `planGroupDrawOrder` alone (tested above) only proves the *plan* shape, not that `renderGroups`
// actually walks it in this order.
describe("TeleportRenderer.render draw order", () => {
  it("draws a group's gap ring before its own marker fill/border when edgeGapWidth > 0", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: false, fromNode: 1, toNode: 2 }];
    renderer.render({ edges, lineStyle: baseLineStyle({ edgeGapWidth: 3 }) });
    const g = (renderer as unknown as { view: InstanceType<typeof Graphics> & { calls: { fn: string; args: unknown[] }[] } }).view;

    // `drawGroupGaps` draws both points' gap rings first (its own loop over the whole group), then
    // `drawGroupPoints` draws both points' fill pass, then both points' border pass: circle(gapA),
    // circle(gapB), circle(fillA), circle(fillB), circle(borderA), circle(borderB).
    const circleCalls = g.calls.filter((c) => c.fn === "circle");
    const fillCalls = g.calls.filter((c) => c.fn === "fill");
    // 2 gap rings + 2 markers (fill pass) + 2 markers (border pass) = 6 circle() calls total.
    expect(circleCalls).toHaveLength(6);
    // The gap ring's own radius (size*TILE_SIZE + borderWidth + edgeGapWidth) must exceed the plain
    // marker radius (size*TILE_SIZE) — the first two circle calls (the gap rings) must be larger
    // than the next two (the markers' own fill-pass radius).
    const [gapRadius] = circleCalls[0].args.slice(2) as [number];
    const [markerRadius] = circleCalls[2].args.slice(2) as [number];
    expect(gapRadius).toBeGreaterThan(markerRadius);
    // First fill call is the gap ring's own floor-colored fill, before any marker fill.
    expect(fillCalls[0].args[0]).toBe(0x444);
  });

  it("skips the gap ring entirely when edgeGapWidth is 0 (no-op, not a zero-radius circle)", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: false, fromNode: 1, toNode: 2 }];
    renderer.render({ edges, lineStyle: baseLineStyle({ edgeGapWidth: 0 }) });
    const g = (renderer as unknown as { view: InstanceType<typeof Graphics> & { calls: { fn: string; args: unknown[] }[] } }).view;

    // Just the 2 points' own marker draws (fill pass + border pass), no gap-ring circles.
    expect(g.calls.filter((c) => c.fn === "circle")).toHaveLength(4);
  });

  it("draws two independent groups' whole blocks in group order — group B's gap ring never lands before group A's own marker", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [
      { from: [0, 0], to: [10, 10], oneWay: false, fromNode: 1, toNode: 2 },
      { from: [50, 50], to: [60, 60], oneWay: false, fromNode: 3, toNode: 4 },
    ];
    renderer.render({ edges, lineStyle: baseLineStyle({ edgeGapWidth: 3 }) });
    const g = (renderer as unknown as { view: InstanceType<typeof Graphics> & { calls: { fn: string; args: unknown[] }[] } }).view;

    // Each group draws gap(x2) + marker(x2 circle calls x2 points) = 6 circle calls; two independent
    // groups (no shared points) = 12 total, in two contiguous group-sized blocks.
    const circleCalls = g.calls.filter((c) => c.fn === "circle");
    expect(circleCalls).toHaveLength(12);
    const firstGroupXs = circleCalls.slice(0, 6).map((c) => c.args[0]);
    const secondGroupXs = circleCalls.slice(6, 12).map((c) => c.args[0]);
    expect(new Set(firstGroupXs)).toEqual(new Set([0, 10]));
    expect(new Set(secondGroupXs)).toEqual(new Set([50, 60]));
  });
});

// `computeConnectors` (the orthogonal-routing path) is only reached when `connectorStyle` isn't
// `"none"` — none of the draw-order tests above exercise it. This is exactly the code the router
// collision-radius fix (GitHub issue #302 follow-up: `edgeGapWidth` folded into `markerBorderWidth`)
// touched, so it needs its own coverage independent of the draw-order assertions.
describe("TeleportRenderer.render orthogonal connector routing", () => {
  it("folds edgeGapWidth into the endpointStyle passed to TeleportConnectorRouter.route, so the marker's true visual footprint (fill + border + gap) is what routing avoids cutting through", () => {
    const routeSpy = vi.spyOn(TeleportConnectorRouter.prototype, "route");
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: false, fromNode: 1, toNode: 2 }];
    renderer.render({ edges, lineStyle: baseLineStyle({ connectorStyle: "orthogonal", size: 0.2, borderWidth: 2, edgeGapWidth: 5 }) });

    expect(routeSpy).toHaveBeenCalledTimes(1);
    const [, , maxEndpointOffset, , endpointStyle] = routeSpy.mock.calls[0];
    // size (0.2 * TILE_SIZE 40 = 8) + borderWidth (2) + edgeGapWidth (5) = 15, for both the
    // endpoint-collision-radius input and the corridor-offset clamp.
    expect(endpointStyle).toMatchObject({ markerBorderWidth: 2 + 5 });
    expect(maxEndpointOffset).toBe(8 + 2 + 5);
    routeSpy.mockRestore();
  });
});

// GitHub issue #337 follow-up: a cross-floor teleport's `to` point draws a floor-number badge
// (`drawFloorBadge`) instead of an ordinary marker, optionally wired to click-to-switch-floor
// (`floorNavigable`). None of the draw-order/routing tests above ever set `TeleportEdge.toFloor`,
// so this behavior has no coverage anywhere else.
describe("TeleportRenderer.render cross-floor floor badge", () => {
  it("a toFloor-tagged point draws no ordinary marker circle there — only the badge's own circle/text", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 1 }];
    renderer.render({ edges, lineStyle: baseLineStyle({ edgeGapWidth: 0 }) });
    const g = (renderer as unknown as { view: InstanceType<typeof Graphics> & { calls: { fn: string; args: unknown[] }[]; children: unknown[] } }).view;

    // The badge point draws its own unconditional gap ring (`drawGroupGaps`) plus its own bordered
    // circle (`drawFloorBadge`'s fill + stroke pass), same as `from`'s ordinary marker circle-shape
    // draw (fill + border pass) — not asserting an exact count (an implementation detail of how
    // many passes each draws), just that the badge path actually drew at its own point and that
    // `from`'s normal marker still drew at its own point too (neither point was skipped).
    const circleCalls = g.calls.filter((c) => c.fn === "circle");
    const atBadgePoint = circleCalls.filter((c) => c.args[0] === 10 && c.args[1] === 10);
    const atFromPoint = circleCalls.filter((c) => c.args[0] === 0 && c.args[1] === 0);
    expect(atBadgePoint.length).toBeGreaterThan(0);
    expect(atFromPoint.length).toBeGreaterThan(0);
    // The badge's own label (a `Text` child) is present at the badge point.
    expect(g.children).toHaveLength(1);
  });

  it("badge display number is toFloor + 1 (1-based, matching FloorSwitcher's own convention)", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 2 }];
    renderer.render({ edges, lineStyle: baseLineStyle({ edgeGapWidth: 0 }) });
    const g = (renderer as unknown as { view: { children: { text: string }[] } }).view;
    expect(g.children).toHaveLength(1);
    expect(g.children[0].text).toBe("3");
  });

  it("floorNavigable adds a clickable hit-circle on the badge wired to navigateToFloor(toFloor)", async () => {
    const navigateToFloorModule = await import("../pixi/renderers/floorNavigation");
    const navigateSpy = vi.spyOn(navigateToFloorModule, "navigateToFloor").mockImplementation(() => {});

    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 1 }];
    renderer.render({ edges, lineStyle: baseLineStyle({ edgeGapWidth: 0 }), floorNavigable: true });
    const g = (renderer as unknown as {
      view: { children: { listeners?: Record<string, (() => void)[]> }[] };
    }).view;

    // The badge's own Text child has no `listeners`; a second child (the hit-circle Graphics) does.
    const hit = g.children.find((c) => c.listeners !== undefined);
    expect(hit).toBeDefined();
    expect(navigateSpy).not.toHaveBeenCalled();

    hit!.listeners!["pointertap"][0]();
    // toFloor: 1 is the raw target floor index, not the 1-based display number — the click target
    // is levels_ordered() position (see TeleportEdge.toFloor's own doc comment), unrelated to
    // drawFloorBadge's own +1 display conversion asserted in the previous test.
    expect(navigateSpy).toHaveBeenCalledWith(1);

    navigateSpy.mockRestore();
  });

  it("without floorNavigable, no hit-circle is added even for a toFloor-tagged point", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 1 }];
    renderer.render({ edges, lineStyle: baseLineStyle({ edgeGapWidth: 0 }) });
    const g = (renderer as unknown as { view: { children: { on?: (event: string, cb: () => void) => void }[] } }).view;
    const hit = g.children.find((c) => typeof c.on === "function");
    expect(hit).toBeUndefined();
  });

  it("a same-floor (toFloor undefined) point draws no badge at all", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: false }];
    renderer.render({ edges, lineStyle: baseLineStyle({ edgeGapWidth: 0 }), floorNavigable: true });
    const g = (renderer as unknown as { view: { children: unknown[] } }).view;
    expect(g.children).toHaveLength(0);
  });
});
