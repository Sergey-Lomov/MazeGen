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
    arcTo(...args: unknown[]) { this.calls.push({ fn: "arcTo", args }); return this; }
    lineTo(...args: unknown[]) { this.calls.push({ fn: "lineTo", args }); return this; }
    closePath() { this.calls.push({ fn: "closePath", args: [] }); return this; }
    fill(...args: unknown[]) { this.calls.push({ fn: "fill", args }); return this; }
    stroke(...args: unknown[]) { this.calls.push({ fn: "stroke", args }); return this; }
    clear() { this.calls = []; return this; }
    removeChildren() { const c = this.children; this.children = []; return c; }
    addChild(child: unknown) { this.children.push(child); }
    destroy: () => void = vi.fn();
    eventMode = "auto";
    cursor = "";
    mask: unknown = null;
    listeners: Record<string, (() => void)[]> = {};
    on(event: string, cb: () => void) { (this.listeners[event] ??= []).push(cb); return this; }
  }
  class FakeContainer {
    children: unknown[] = [];
    addChild(child: unknown) { this.children.push(child); }
    removeChildren() { const c = this.children; this.children = []; return c; }
    destroy: () => void = vi.fn();
  }
  // `drawFloorBadge` (GitHub issue #337) constructs a pixi `BitmapText` (GitHub issue #352 — MSDF
  // label font) for the floor-number label — a minimal stand-in recording `anchor`/`x`/`y` writes
  // is enough for tests to assert positioning without a real canvas/font measurement.
  class FakeBitmapText {
    anchor = { set: vi.fn() };
    pivot = { y: 0 };
    x = 0;
    y = 0;
    text: string;
    style: { fontSize?: number; fill?: number };
    // Crude width model so `fitTeleportBadgeFontSize`'s probe loop (GitHub issue #485 follow-up)
    // has something to measure: 0.6em per character. Enough for tests to assert the shared font
    // shrinks for a wider label and that every badge then uses that one size.
    constructor(opts: { text: string; style?: { fontSize?: number; fill?: number } }) {
      this.text = opts.text;
      this.style = opts.style ?? {};
    }
    get width() { return this.text.length * (this.style.fontSize ?? 0) * 0.6; }
    destroy() {}
  }
  return { Container: FakeContainer, Graphics: FakeGraphics, BitmapText: FakeBitmapText, Cache: { get: () => undefined } };
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
    floorBadge: { shape: "circle", labelType: "arabic", size: 0.2, textColor: 0x123456, textPadding: 0 },
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

  // A single-point edge (`from`/`to` at the same coordinate) must resolve to a plain "filled"
  // state, not "mixed" — the ordinary `to` = outline reading would otherwise fight `from`'s own
  // "filled" reading at that same point.
  it("a single-point edge (from === to) resolves filled, not mixed", () => {
    const edges: TeleportEdge[] = [{ from: [3, 4], to: [3, 4], oneWay: true }];
    expect(resolvePointFillState(edges, 3, 4)).toBe("filled");
    expect(computeMixedCells(edges).size).toBe(0);
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
// GitHub issue #432: `drawMarker`'s `mixed` branch (drawn for a point resolved "mixed" by
// `resolvePointFillState`, see that describe block above) must add its mask/half-fill `Graphics`
// pair to `overlayLayer`, not `view` itself (a `Graphics` instance — PixiJS v8 deprecates
// `addChild` on non-`Container` objects).
describe("TeleportRenderer.render mixed-marker overlay placement (GitHub issue #432)", () => {
  it("adds the mixed marker's mask/half-fill pair to overlayLayer, not view", () => {
    const renderer = new TeleportRenderer(new Container());
    // Same edge pair the `resolvePointFillState` describe block above proves resolves [5,5] to
    // "mixed" — one edge wants it filled (its origin), the other wants it outline (its destination).
    const edges: TeleportEdge[] = [
      { from: [5, 5], to: [9, 9], oneWay: true, fromNode: 1, toNode: 2 },
      { from: [1, 1], to: [5, 5], oneWay: true, fromNode: 3, toNode: 4 },
    ];
    renderer.render({ edges, lineStyle: baseLineStyle({ connectorStyle: "none" }) });
    const view = (renderer as unknown as { view: InstanceType<typeof Graphics> & { children: unknown[] } }).view;
    const overlay = (renderer as unknown as { overlayLayer: { children: unknown[] } }).overlayLayer;

    // view stays a pure drawing surface — no mask/half-fill children land on it.
    expect(view.children).toHaveLength(0);
    // overlayLayer gets exactly the mask + half-fill pair for the one mixed point.
    expect(overlay.children).toHaveLength(2);
  });
});

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
    const overlay = (renderer as unknown as { overlayLayer: { children: unknown[] } }).overlayLayer;

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
    // The badge's own label (a `Text` child) is present at the badge point, in `overlayLayer`
    // (a `Container` sibling of `view` — a `Graphics` instance can't host it, GitHub issue #432).
    expect(overlay.children).toHaveLength(1);
  });

  it("badge display number is toFloor + 1 (1-based, matching FloorSwitcher's own convention)", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 2 }];
    renderer.render({ edges, lineStyle: baseLineStyle({ edgeGapWidth: 0 }) });
    const overlay = (renderer as unknown as { overlayLayer: { children: { text: string }[] } }).overlayLayer;
    expect(overlay.children).toHaveLength(1);
    expect(overlay.children[0].text).toBe("3");
  });

  it("floorNavigable adds a clickable hit-circle on the badge wired to navigateToFloor(toFloor)", async () => {
    const navigateToFloorModule = await import("../pixi/renderers/floorNavigation");
    const navigateSpy = vi.spyOn(navigateToFloorModule, "navigateToFloor").mockImplementation(() => {});

    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 1 }];
    renderer.render({ edges, lineStyle: baseLineStyle({ edgeGapWidth: 0 }), floorNavigable: true });
    const overlay = (renderer as unknown as {
      overlayLayer: { children: { listeners?: Record<string, (() => void)[]> }[] };
    }).overlayLayer;

    // The badge's own Text child has no `listeners`; a second child (the hit-circle Graphics) does.
    const hit = overlay.children.find((c) => c.listeners !== undefined);
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
    const overlay = (renderer as unknown as { overlayLayer: { children: { on?: (event: string, cb: () => void) => void }[] } }).overlayLayer;
    const hit = overlay.children.find((c) => typeof c.on === "function");
    expect(hit).toBeUndefined();
  });

  it("a same-floor (toFloor undefined) point draws no badge at all", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: false }];
    renderer.render({ edges, lineStyle: baseLineStyle({ edgeGapWidth: 0 }), floorNavigable: true });
    const overlay = (renderer as unknown as { overlayLayer: { children: unknown[] } }).overlayLayer;
    expect(overlay.children).toHaveLength(0);
  });

  // GitHub issue #485: the badge draws its own configurable `floorBadge` shape/label/size, not the
  // edge marker's own `shape`/`style.size`.
  it("badge label follows floorBadge.labelType (roman)", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 3 }];
    renderer.render({ edges, lineStyle: baseLineStyle({ edgeGapWidth: 0, floorBadge: { shape: "circle", labelType: "roman", size: 0.2, textColor: 0x123456, textPadding: 0 } }) });
    const overlay = (renderer as unknown as { overlayLayer: { children: { text: string }[] } }).overlayLayer;
    // toFloor 3 -> display 4 -> "IV"
    expect(overlay.children[0].text).toBe("IV");
  });

  it("badge radius follows floorBadge.size, independent of the edge marker's own style.size", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 1 }];
    renderer.render({ edges, lineStyle: baseLineStyle({ edgeGapWidth: 0, size: 0.2, floorBadge: { shape: "circle", labelType: "arabic", size: 0.5, textColor: 0x123456, textPadding: 0 } }) });
    const g = (renderer as unknown as { view: { calls: { fn: string; args: unknown[] }[] } }).view;
    // The badge's own fill circle at the badge point — radius is floorBadge.size * TILE_SIZE, not size * TILE_SIZE.
    const badgeCircle = g.calls.find((c) => c.fn === "circle" && c.args[0] === 10 && c.args[1] === 10 && typeof c.args[2] === "number" && (c.args[2] as number) > 0.2 * 40);
    expect(badgeCircle).toBeDefined();
  });

  it("badge label draws in floorBadge.textColor, not floorColor", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 1 }];
    renderer.render({
      edges,
      lineStyle: baseLineStyle({ edgeGapWidth: 0, floorColor: 0x444444, floorBadge: { shape: "circle", labelType: "arabic", size: 0.2, textColor: 0xabcdef, textPadding: 0 } }),
    });
    const overlay = (renderer as unknown as { overlayLayer: { children: { style: { fill?: number } }[] } }).overlayLayer;
    expect(overlay.children[0].style.fill).toBe(0xabcdef);
  });

  // GitHub issue #485 follow-up item 5: every badge in the maze uses one shared font size, fitted
  // to the widest label present — so a "I" badge and a "VIII" badge render at the same size.
  it("all badges share one font size, fitted to the widest label", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [
      { from: [0, 0], to: [10, 10], oneWay: true, toFloor: 0 }, // display "1"
      { from: [20, 20], to: [30, 30], oneWay: true, toFloor: 7 }, // display "8"
    ];
    renderer.render({ edges, lineStyle: baseLineStyle({ edgeGapWidth: 0 }) });
    const overlay = (renderer as unknown as { overlayLayer: { children: { text: string; style: { fontSize?: number } }[] } }).overlayLayer;
    const labels = overlay.children.filter((c) => c.text === "1" || c.text === "8");
    expect(labels).toHaveLength(2);
    expect(labels[0].style.fontSize).toBe(labels[1].style.fontSize);
    expect(labels[0].style.fontSize).toBeGreaterThan(0);
  });

  it("floorCount fits the shared font to the widest label any floor could carry, not just visible badges", () => {
    // Only one visible badge ("1"), but 12 floors — the font must be sized for "12" (arabic),
    // so it stays constant when the user switches to a floor whose badge reads "12".
    const many = new TeleportRenderer(new Container());
    many.render({
      edges: [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 0 }],
      lineStyle: baseLineStyle({ edgeGapWidth: 0, floorBadge: { shape: "circle", labelType: "arabic", size: 0.2, textColor: 0x123456, textPadding: 0 } }),
      floorCount: 12,
    });
    const few = new TeleportRenderer(new Container());
    few.render({
      edges: [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 0 }],
      lineStyle: baseLineStyle({ edgeGapWidth: 0, floorBadge: { shape: "circle", labelType: "arabic", size: 0.2, textColor: 0x123456, textPadding: 0 } }),
      floorCount: 3,
    });
    const fontOf = (r: InstanceType<typeof TeleportRenderer>) =>
      (r as unknown as { overlayLayer: { children: { text: string; style: { fontSize?: number } }[] } }).overlayLayer.children[0].style.fontSize!;
    // "12" is two chars vs. "3" one, so the 12-floor project's shared font is smaller.
    expect(fontOf(many)).toBeLessThan(fontOf(few));
  });

  it("a wider label present shrinks the shared font below the single-badge baseline", () => {
    const wide = new TeleportRenderer(new Container());
    // Roman "VIII" (toFloor 7 -> display 8) is wide; textPadding 0 so the fit is flush.
    wide.render({
      edges: [
        { from: [0, 0], to: [10, 10], oneWay: true, toFloor: 0 },
        { from: [20, 20], to: [30, 30], oneWay: true, toFloor: 7 },
      ],
      lineStyle: baseLineStyle({ edgeGapWidth: 0, floorBadge: { shape: "circle", labelType: "roman", size: 0.2, textColor: 0x123456, textPadding: 0 } }),
    });
    const narrow = new TeleportRenderer(new Container());
    narrow.render({
      edges: [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 0 }],
      lineStyle: baseLineStyle({ edgeGapWidth: 0, floorBadge: { shape: "circle", labelType: "roman", size: 0.2, textColor: 0x123456, textPadding: 0 } }),
    });
    const fontOf = (r: InstanceType<typeof TeleportRenderer>) =>
      (r as unknown as { overlayLayer: { children: { text: string; style: { fontSize?: number } }[] } }).overlayLayer.children[0].style.fontSize!;
    expect(fontOf(wide)).toBeLessThan(fontOf(narrow));
  });

  // GitHub issue #485 follow-up item 2: the badge border follows the edge marker's own
  // `borderWidth`, not a fixed constant.
  it("badge border width follows the edge marker's borderWidth", () => {
    const thin = new TeleportRenderer(new Container());
    thin.render({ edges: [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 1 }], lineStyle: baseLineStyle({ edgeGapWidth: 0, borderWidth: 1 }) });
    const thick = new TeleportRenderer(new Container());
    thick.render({ edges: [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 1 }], lineStyle: baseLineStyle({ edgeGapWidth: 0, borderWidth: 8 }) });
    const strokeWidthsOf = (r: InstanceType<typeof TeleportRenderer>) => {
      const g = (r as unknown as { view: { calls: { fn: string; args: unknown[] }[] } }).view;
      return g.calls.filter((c) => c.fn === "stroke").map((c) => (c.args[0] as { width: number }).width);
    };
    // Both the origin marker and the badge stroke at the edge marker's own borderWidth.
    expect(strokeWidthsOf(thin).every((w) => w === 1)).toBe(true);
    expect(strokeWidthsOf(thick).every((w) => w === 8)).toBe(true);
    expect(strokeWidthsOf(thick).length).toBeGreaterThanOrEqual(1);
  });

  // GitHub issue #485 follow-up item 3: textPadding 0 fits the label to the whole badge including
  // its border ring, so a wider border → larger shared font (bigger fit target).
  it("textPadding 0 fits the label across the badge including its border", () => {
    const thinBorder = new TeleportRenderer(new Container());
    thinBorder.render({
      edges: [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 0 }],
      lineStyle: baseLineStyle({ edgeGapWidth: 0, borderWidth: 1, floorBadge: { shape: "circle", labelType: "arabic", size: 0.2, textColor: 0x123456, textPadding: 0 } }),
    });
    const thickBorder = new TeleportRenderer(new Container());
    thickBorder.render({
      edges: [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 0 }],
      lineStyle: baseLineStyle({ edgeGapWidth: 0, borderWidth: 10, floorBadge: { shape: "circle", labelType: "arabic", size: 0.2, textColor: 0x123456, textPadding: 0 } }),
    });
    const fontOf = (r: InstanceType<typeof TeleportRenderer>) =>
      (r as unknown as { overlayLayer: { children: { style: { fontSize?: number } }[] } }).overlayLayer.children[0].style.fontSize!;
    expect(fontOf(thickBorder)).toBeGreaterThan(fontOf(thinBorder));
  });

  // GitHub issue #485: a non-circle `floorBadge.shape` must reach both the badge body
  // (`drawGroupPoints` -> `drawFloorBadge`) and the gap ring (`drawGroupGaps`) via
  // `drawMarkerShape(g, style.floorBadge.shape, ..., rounded=true)` — a rounded polygon draws
  // through `moveTo`/`arcTo`/`closePath`, never `circle`.
  it("draws a non-circle floorBadge.shape as a rounded polygon for both the body and the gap ring", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 1 }];
    renderer.render({
      edges,
      lineStyle: baseLineStyle({ edgeGapWidth: 4, floorBadge: { shape: "square", labelType: "arabic", size: 0.2, textColor: 0x123456, textPadding: 0 } }),
    });
    const g = (renderer as unknown as { view: { calls: { fn: string; args: unknown[] }[] } }).view;
    // No round badge/ring at the badge point — it's a square now.
    expect(g.calls.some((c) => c.fn === "circle" && c.args[0] === 10 && c.args[1] === 10)).toBe(false);
    // Rounded-polygon path (moveTo + arcTo per corner + closePath) ran for both the gap ring and
    // the body — a 4-gon is 4 arcTo each, so >= 8 total, and >= 2 closePath.
    expect(g.calls.filter((c) => c.fn === "arcTo").length).toBeGreaterThanOrEqual(8);
    expect(g.calls.filter((c) => c.fn === "closePath").length).toBeGreaterThanOrEqual(2);
  });
});

// GitHub issue #432 follow-up: `destroy()` must destroy both `view` and the newer `overlayLayer`
// sibling — the latter was easy to miss since it was added after `destroy()` already existed.
describe("TeleportRenderer.destroy", () => {
  it("destroys both view and overlayLayer", () => {
    const renderer = new TeleportRenderer(new Container());
    const view = (renderer as unknown as { view: { destroy: ReturnType<typeof vi.fn> } }).view;
    const overlayLayer = (renderer as unknown as { overlayLayer: { destroy: ReturnType<typeof vi.fn> } }).overlayLayer;
    view.destroy = vi.fn();
    overlayLayer.destroy = vi.fn();

    renderer.destroy();

    expect(view.destroy).toHaveBeenCalledWith({ children: true });
    expect(overlayLayer.destroy).toHaveBeenCalledWith({ children: true });
  });
});
