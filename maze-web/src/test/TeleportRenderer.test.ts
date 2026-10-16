import { describe, it, expect, vi } from "vitest";
import { computeMixedCells, clipDistance, resolvePointFillState, planGroupDrawOrder } from "../pixi/renderers/TeleportRenderer";
import { buildTeleportGroups } from "../pixi/selectors/teleportGroups";
import type { TeleportEdge, TeleportLineStyle } from "../pixi/renderers/types";
import type { RoutedConnector } from "../pixi/renderers/teleportConnectorRouting";

// `getCellCenters` (wasm) is never reached by the group-customization-off `render()` path
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
// verifiable without a real pixi renderer. `poly` is needed because `drawMarkerShape` represents
// even its `"circle"` shape as an adaptive polygon to avoid raster seams.
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
    listeners: Record<string, ((e?: unknown) => void)[]> = {};
    on(event: string, cb: (e?: unknown) => void) { (this.listeners[event] ??= []).push(cb); return this; }
    off(event: string) { delete this.listeners[event]; return this; }
    toLocal(p: { x: number; y: number }) { return p; }
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
    cornerStyle: "miter",
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
    floorBadge: { shape: "circle", labelType: "arabic", cornerStyle: "round", gapWidth: 3, size: 0.2, fillColor: 0x123456, borderColor: 0x123456, borderWidth: 3, textColor: 0x123456, textFontWeight: "bold", textSize: 12, textMargin: 1 },
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

// `planGroupDrawOrder` buckets each group's own
// connectors — `TeleportRenderer.renderGroups` walks this plan in three flat passes (every group's
// gaps, then every group's connectors, then every group's points — GitHub issue #302) rather than
// interleaving per group. Pure, so testable without a `Graphics` mock.
describe("planGroupDrawOrder", () => {
  const routed = (): RoutedConnector => ({ points: [0, 0, 1, 1] });

  it("one group, one connector — single plan entry carrying that connector", () => {
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [5, 5], oneWay: false, fromNode: 1, toNode: 2 }];
    const groups = buildTeleportGroups(edges);
    const connectors = [{ edge: edges[0], routed: routed(), color: 0 }];
    const plan = planGroupDrawOrder(groups, connectors);
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
    const plan = planGroupDrawOrder(groups, connectors);
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

  it("a connector whose endpoints match no group is dropped from the plan, not thrown", () => {
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [5, 5], oneWay: false, fromNode: 1, toNode: 2 }];
    const groups = buildTeleportGroups(edges);
    const strayEdge: TeleportEdge = { from: [50, 50], to: [60, 60], oneWay: false, fromNode: 99, toNode: 100 };
    const connectors = [{ edge: strayEdge, routed: routed(), color: 0 }];
    const plan = planGroupDrawOrder(groups, connectors);
    expect(plan).toHaveLength(1);
    expect(plan[0].connectors).toHaveLength(0);
  });

  it("no groups — empty plan", () => {
    expect(planGroupDrawOrder([], [])).toEqual([]);
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
    renderer.render({ edges, waypoints: [], lineStyle: baseLineStyle({ connectorStyle: "none" }) });
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
    renderer.render({ edges, waypoints: [], lineStyle: baseLineStyle({ edgeGapWidth: 3 }) });
    const g = (renderer as unknown as { view: InstanceType<typeof Graphics> & { calls: { fn: string; args: unknown[] }[] } }).view;

    // `drawGroupGaps` draws both points' gap rings first, then `drawGroupPoints` draws each point's
    // outer border silhouette and inner fill: 2 gap points + 2 marker points x 2 = 6.
    const polyCalls = g.calls.filter((c) => c.fn === "poly");
    const fillCalls = g.calls.filter((c) => c.fn === "fill");
    expect(polyCalls).toHaveLength(6);
    const polygonRadius = (call: { args: unknown[] }, cx: number, cy: number): number => {
      const points = call.args[0] as number[];
      return Math.max(...Array.from({ length: points.length / 2 }, (_, i) =>
        Math.hypot(points[i * 2] - cx, points[i * 2 + 1] - cy)));
    };
    expect(polygonRadius(polyCalls[0], 0, 0)).toBeGreaterThan(polygonRadius(polyCalls[2], 0, 0));
    // First fill call is the gap ring's own floor-colored fill, before any marker fill.
    expect((fillCalls[0].args[0] as { color: number }).color).toBe(0x444);
  });

  it("skips the gap ring entirely when edgeGapWidth is 0 (no-op, not a zero-radius circle)", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: false, fromNode: 1, toNode: 2 }];
    renderer.render({ edges, waypoints: [], lineStyle: baseLineStyle({ edgeGapWidth: 0 }) });
    const g = (renderer as unknown as { view: InstanceType<typeof Graphics> & { calls: { fn: string; args: unknown[] }[] } }).view;

    // Just the 2 points' own marker draws (fill pass + border pass), no gap-ring circles.
    expect(g.calls.filter((c) => c.fn === "poly")).toHaveLength(4);
  });

  it("draws two independent groups' whole blocks in group order — group B's gap ring never lands before group A's own marker", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [
      { from: [0, 0], to: [10, 10], oneWay: false, fromNode: 1, toNode: 2 },
      { from: [50, 50], to: [60, 60], oneWay: false, fromNode: 3, toNode: 4 },
    ];
    renderer.render({ edges, waypoints: [], lineStyle: baseLineStyle({ edgeGapWidth: 3 }) });
    const g = (renderer as unknown as { view: InstanceType<typeof Graphics> & { calls: { fn: string; args: unknown[] }[] } }).view;

    // Each group draws gap(x2 points x2 poly calls each) + marker(x2 poly calls x2 points) = 8
    // polygon calls; two independent groups (no shared points) = 16 total, in two contiguous
    // group-sized blocks.
    const polyCalls = g.calls.filter((c) => c.fn === "poly");
    expect(polyCalls).toHaveLength(12);
    const centerX = (call: { args: unknown[] }): number => {
      const points = call.args[0] as number[];
      let sum = 0;
      for (let i = 0; i < points.length; i += 2) sum += points[i];
      return sum / (points.length / 2);
    };
    const firstGroupXs = polyCalls.slice(0, 8).map(centerX);
    const secondGroupXs = polyCalls.slice(8, 16).map(centerX);
    expect(firstGroupXs).toEqual(expect.arrayContaining([expect.closeTo(0, 8), expect.closeTo(10, 8)]));
    expect(secondGroupXs).toEqual(expect.arrayContaining([expect.closeTo(50, 8), expect.closeTo(60, 8)]));
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
    renderer.render({ edges, waypoints: [], lineStyle: baseLineStyle({ connectorStyle: "orthogonal", size: 8, borderWidth: 2, edgeGapWidth: 5 }) });

    expect(routeSpy).toHaveBeenCalledTimes(1);
    const [, , maxEndpointOffset, , endpointStyle] = routeSpy.mock.calls[0];
    // size (8, a diameter in px — GitHub issue #681 diameter follow-up) / 2 + borderWidth (2) +
    // edgeGapWidth (5) = 11, for both the endpoint-collision-radius input and the corridor-offset
    // clamp.
    expect(endpointStyle).toMatchObject({ markerBorderWidth: 2 + 5 });
    expect(maxEndpointOffset).toBe(8 / 2 + 2 + 5);
    routeSpy.mockRestore();
  });
});

// GitHub issue #337 follow-up: a cross-floor teleport's `to` point draws a floor-number badge
// (`drawFloorBadge`) instead of an ordinary marker, optionally wired to click-to-switch-floor
// (`floorNavigable`). None of the draw-order/routing tests above ever set `TeleportEdge.toFloor`,
// so this behavior has no coverage anywhere else.
describe("TeleportRenderer.render cross-floor floor badge", () => {
  const polygonRadiusAt = (points: number[], cx: number, cy: number): number => {
    let max = 0;
    for (let i = 0; i < points.length; i += 2) max = Math.max(max, Math.hypot(points[i] - cx, points[i + 1] - cy));
    return max;
  };
  it("a toFloor-tagged point draws no ordinary marker circle there — only the badge's own circle/text", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 1 }];
    renderer.render({ edges, waypoints: [], lineStyle: baseLineStyle({ connectorStyle: "straight", edgeGapWidth: 0 }) });
    const g = (renderer as unknown as { view: InstanceType<typeof Graphics> & { calls: { fn: string; args: unknown[] }[]; children: unknown[] } }).view;
    const overlay = (renderer as unknown as { overlayLayer: { children: unknown[] } }).overlayLayer;

    // The badge point draws its own unconditional gap ring (`drawGroupGaps`) plus its own bordered
    // circle (`drawFloorBadge`'s fill + stroke pass), same as `from`'s ordinary marker circle-shape
    // draw (fill + border pass) — not asserting an exact count (an implementation detail of how
    // many passes each draws), just that the badge path actually drew at its own point and that
    // `from`'s normal marker still drew at its own point too (neither point was skipped).
    const polygonCalls = g.calls.filter((c) => c.fn === "poly");
    expect(polygonCalls.length).toBeGreaterThan(0);
    // The badge's own label (a `Text` child) is present at the badge point, in `overlayLayer`
    // (a `Container` sibling of `view` — a `Graphics` instance can't host it, GitHub issue #432).
    expect(overlay.children).toHaveLength(1);
  });

  it("badge display number is toFloor + 1 (1-based, matching FloorSwitcher's own convention)", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 2 }];
    renderer.render({ edges, waypoints: [], lineStyle: baseLineStyle({ connectorStyle: "straight", edgeGapWidth: 0 }) });
    const overlay = (renderer as unknown as { overlayLayer: { children: { text: string }[] } }).overlayLayer;
    expect(overlay.children).toHaveLength(1);
    expect(overlay.children[0].text).toBe("3");
  });

  it("floorNavigable adds a clickable hit-circle on the badge wired to navigateToFloor(toFloor)", async () => {
    const navigateToFloorModule = await import("../pixi/renderers/floorNavigation");
    const navigateSpy = vi.spyOn(navigateToFloorModule, "navigateToFloor").mockImplementation(() => {});

    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 1 }];
    renderer.render({ edges, waypoints: [], lineStyle: baseLineStyle({ connectorStyle: "straight", edgeGapWidth: 0 }), floorNavigable: true });
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
    renderer.render({ edges, waypoints: [], lineStyle: baseLineStyle({ connectorStyle: "straight", edgeGapWidth: 0 }) });
    const overlay = (renderer as unknown as { overlayLayer: { children: { on?: (event: string, cb: () => void) => void }[] } }).overlayLayer;
    const hit = overlay.children.find((c) => typeof c.on === "function");
    expect(hit).toBeUndefined();
  });

  // GitHub issue #519: a floor badge stands in for the connector's off-floor endpoint, so it must
  // follow the connector's own visibility rule — no badge when the connector display is off.
  it("connectorStyle: \"none\" draws no badge even for a toFloor-tagged point", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 1 }];
    renderer.render({ edges, waypoints: [], lineStyle: baseLineStyle({ connectorStyle: "none", edgeGapWidth: 0 }), floorNavigable: true });
    const overlay = (renderer as unknown as { overlayLayer: { children: unknown[] } }).overlayLayer;
    expect(overlay.children).toHaveLength(0);
    // Not just "no badge" — the badge point draws nothing at all, not even a fallback ordinary
    // marker: it's a synthetic midpoint, not a real teleport node (GitHub issue #519).
    const g = (renderer as unknown as { view: { calls: { fn: string; args: unknown[] }[] } }).view;
    expect(g.calls.some((c) => c.fn === "circle" && c.args[0] === 10 && c.args[1] === 10)).toBe(false);
  });

  it("a same-floor (toFloor undefined) point draws no badge at all", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: false }];
    renderer.render({ edges, waypoints: [], lineStyle: baseLineStyle({ connectorStyle: "straight", edgeGapWidth: 0 }), floorNavigable: true });
    const overlay = (renderer as unknown as { overlayLayer: { children: unknown[] } }).overlayLayer;
    expect(overlay.children).toHaveLength(0);
  });

  // GitHub issue #485: the badge draws its own configurable `floorBadge` shape/label/size, not the
  // edge marker's own `shape`/`style.size`.
  it("badge label follows floorBadge.labelType (roman)", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 3 }];
    renderer.render({ edges, waypoints: [], lineStyle: baseLineStyle({ connectorStyle: "straight", edgeGapWidth: 0, floorBadge: { shape: "circle", labelType: "roman", cornerStyle: "round", gapWidth: 3, size: 0.2, fillColor: 0x123456, borderColor: 0x123456, borderWidth: 3, textColor: 0x123456, textFontWeight: "bold", textSize: 12, textMargin: 1 } }) });
    const overlay = (renderer as unknown as { overlayLayer: { children: { text: string }[] } }).overlayLayer;
    // toFloor 3 -> display 4 -> "IV"
    expect(overlay.children[0].text).toBe("IV");
  });

  it("badge radius follows floorBadge.size, independent of the edge marker's own style.size", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 1 }];
    renderer.render({ edges, waypoints: [], lineStyle: baseLineStyle({ connectorStyle: "straight", edgeGapWidth: 0, size: 8, floorBadge: { shape: "circle", labelType: "arabic", cornerStyle: "round", gapWidth: 3, size: 20, fillColor: 0x123456, borderColor: 0x123456, borderWidth: 3, textColor: 0x123456, textFontWeight: "bold", textSize: 12, textMargin: 1 } }) });
    const g = (renderer as unknown as { view: { calls: { fn: string; args: unknown[] }[] } }).view;
    // The badge's own fill circle at the badge point — radius is floorBadge.size (px), not size.
    const badgePolygon = g.calls.find((c) => c.fn === "poly" && Array.isArray(c.args[0]) &&
      polygonRadiusAt(c.args[0] as number[], 10, 10) > 8);
    expect(badgePolygon).toBeDefined();
  });

  it("badge label draws in floorBadge.textColor, not floorColor", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 1 }];
    renderer.render({
      edges,
      waypoints: [],
      lineStyle: baseLineStyle({ connectorStyle: "straight", edgeGapWidth: 0, floorColor: 0x444444, floorBadge: { shape: "circle", labelType: "arabic", cornerStyle: "round", gapWidth: 3, size: 0.2, fillColor: 0x123456, borderColor: 0x123456, borderWidth: 3, textColor: 0xabcdef, textFontWeight: "bold", textSize: 12, textMargin: 1 } }),
    });
    const overlay = (renderer as unknown as { overlayLayer: { children: { style: { fill?: number } }[] } }).overlayLayer;
    expect(overlay.children[0].style.fill).toBe(0xabcdef);
  });

  // GitHub issue #701: badge text size is an absolute px value (`floorBadge.textSize`) — no shared
  // per-maze fit, so labels of different widths render at the same size.
  it("badge font size follows floorBadge.textSize regardless of label width", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [
      { from: [0, 0], to: [10, 10], oneWay: true, toFloor: 0 }, // display "1"
      { from: [20, 20], to: [30, 30], oneWay: true, toFloor: 11 }, // display "12"
    ];
    const floorBadge = { shape: "circle" as const, labelType: "arabic" as const, cornerStyle: "round" as const, gapWidth: 3, borderWidth: 3, size: 0.2, fillColor: 0x123456, borderColor: 0x123456, textColor: 0x123456, textFontWeight: "bold" as const, textSize: 21, textMargin: 1 };
    renderer.render({ edges, waypoints: [], lineStyle: baseLineStyle({ connectorStyle: "straight", edgeGapWidth: 0, floorBadge }) });
    const overlay = (renderer as unknown as { overlayLayer: { children: { text: string; style: { fontSize?: number } }[] } }).overlayLayer;
    const labels = overlay.children.filter((c) => c.text === "1" || c.text === "12");
    expect(labels).toHaveLength(2);
    expect(labels[0].style.fontSize).toBe(21);
    expect(labels[1].style.fontSize).toBe(21);
  });

  // GitHub issue #485 follow-up item 2: the badge border follows the edge marker's own
  // `borderWidth`, not a fixed constant.
  it("badge border width follows the edge marker's borderWidth", () => {
    const thin = new TeleportRenderer(new Container());
    thin.render({ edges: [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 1 }], waypoints: [], lineStyle: baseLineStyle({ connectorStyle: "straight", edgeGapWidth: 0, borderWidth: 1 }) });
    const thick = new TeleportRenderer(new Container());
    thick.render({ edges: [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 1 }], waypoints: [], lineStyle: baseLineStyle({ connectorStyle: "straight", edgeGapWidth: 0, borderWidth: 8 }) });
    // `connectorStyle: "straight"` still strokes the connector line itself; marker and badge
    // borders are filled silhouettes and therefore do not add GPU strokes.
    const strokeWidthsOf = (r: InstanceType<typeof TeleportRenderer>, borderWidth: number) => {
      const g = (r as unknown as { view: { calls: { fn: string; args: unknown[] }[] } }).view;
      return g.calls.filter((c) => c.fn === "stroke").map((c) => (c.args[0] as { width: number }).width).filter((w) => w !== 3 && w !== borderWidth + 1);
    };
    expect(strokeWidthsOf(thin, 1)).toHaveLength(0);
    expect(strokeWidthsOf(thick, 8)).toHaveLength(0);
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
      waypoints: [],
      lineStyle: baseLineStyle({ connectorStyle: "straight", edgeGapWidth: 4, floorBadge: { shape: "square", labelType: "arabic", cornerStyle: "round", gapWidth: 3, size: 0.2, fillColor: 0x123456, borderColor: 0x123456, borderWidth: 3, textColor: 0x123456, textFontWeight: "bold", textSize: 12, textMargin: 1 } }),
    });
    const g = (renderer as unknown as { view: { calls: { fn: string; args: unknown[] }[] } }).view;
    // No round badge/ring at the badge point — it's a square now.
    expect(g.calls.some((c) => c.fn === "circle" && c.args[0] === 10 && c.args[1] === 10)).toBe(false);
    // The inner body keeps its rounded path; the outer gap is now an explicit offset polygon, so
    // it intentionally uses `poly` instead of a GPU stroke/arc path.
    expect(g.calls.filter((c) => c.fn === "arcTo").length).toBeGreaterThanOrEqual(4);
    expect(g.calls.filter((c) => c.fn === "poly").length).toBeGreaterThanOrEqual(1);
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

describe("TeleportRenderer.render connector / badge color under group customization", () => {
  const colorsDrawn = (renderer: unknown): number[] => {
    const g = (renderer as { view: { calls: { fn: string; args: unknown[] }[] } }).view;
    return g.calls.flatMap((call) => call.args.map((a) => (a as { color?: number } | undefined)?.color)).filter((v): v is number => typeof v === "number");
  };
  const twoWay: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: false }];
  const style = (): TeleportLineStyle => baseLineStyle({ connectorStyle: "straight", edgeGapWidth: 0 });

  it("customization off — connectors use the common connector color", () => {
    const renderer = new TeleportRenderer(new Container());
    renderer.render({ edges: twoWay, waypoints: [], lineStyle: style() });
    expect(colorsDrawn(renderer)).toContain(0x333);
  });

  it("customization on, group without override — connectors use the marker border, never the common connector color", () => {
    const renderer = new TeleportRenderer(new Container());
    renderer.render({ edges: twoWay, waypoints: [], lineStyle: style(), groupCustomization: true, groupOverrides: {} });
    const colors = colorsDrawn(renderer);
    expect(colors).not.toContain(0x333);
    expect(colors).toContain(0x222);
  });

  it("customization on, group with a border override — connectors and floor badges follow it", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 1 }];
    const [group] = buildTeleportGroups(edges);
    renderer.render({ edges, waypoints: [], lineStyle: style(), groupCustomization: true, groupOverrides: { [group.key]: { borderColor: 0xabcdef } } });
    const colors = colorsDrawn(renderer);
    expect(colors).toContain(0xabcdef);
    expect(colors).not.toContain(0x333);
    expect(colors).not.toContain(0x123456); // common floorBadge fill/border
  });

  it("customization on, badge in a group without override — badge uses the marker border, not the common badge colors", () => {
    const renderer = new TeleportRenderer(new Container());
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 1 }];
    renderer.render({ edges, waypoints: [], lineStyle: style(), groupCustomization: true, groupOverrides: {} });
    expect(colorsDrawn(renderer)).not.toContain(0x123456);
  });
});
