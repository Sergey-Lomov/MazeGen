import { describe, it, expect, vi, beforeEach } from "vitest";
import { Graphics } from "pixi.js";
import { VectorByCorridorsRenderer, buildTeleportWidenMarkers, computeDiagonalGapPatchGeometry } from "../pixi/imageExport/VectorByCorridorsRenderer";
import { computeSquareCapPatch } from "../pixi/renderers/wallUtils";
import { buildCorridorSegments, buildMazeMarkers, buildTeleportEdges, buildSplitPassages } from "../pixi/selectors/mazeSelectors";
import { buildTeleportGroups } from "../pixi/selectors/teleportGroups";
import { TILE_SIZE } from "../pixi/constants";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import type { VectorByCorridorsSettings } from "../store/storeTypes";

// Minimal stand-in for Pixi v8's `Bounds` (`getRequiredExportMargin`'s pixel-accurate path
// only ever reads `.minX/.minY/.maxX/.maxY` and calls `.clone()`/`.addBounds()`).
interface FakeBounds { minX: number; minY: number; maxX: number; maxY: number; clone(): FakeBounds; addBounds(b: FakeBounds): void }
function makeBounds(minX: number, minY: number, maxX: number, maxY: number): FakeBounds {
  return {
    minX, minY, maxX, maxY,
    clone() { return makeBounds(this.minX, this.minY, this.maxX, this.maxY); },
    addBounds(b: FakeBounds) {
      this.minX = Math.min(this.minX, b.minX);
      this.minY = Math.min(this.minY, b.minY);
      this.maxX = Math.max(this.maxX, b.maxX);
      this.maxY = Math.max(this.maxY, b.maxY);
    },
  };
}
function makeEmptyBounds(): FakeBounds {
  return makeBounds(Infinity, Infinity, -Infinity, -Infinity);
}

// getCartesian (cartesianCache.ts) delegates to wasm, unavailable in this unit-test environment —
// same square-tessellation mock as exportFit.test.ts/exportMargins.test.ts, needed since
// getRequiredExportMargin's pixel-accurate path calls cellCenterBounds/getCellCenter directly.
vi.mock("../pixi/cartesianCache", () => ({
  getCartesian: (x: number, y: number): [number, number] => [x, y],
}));

vi.mock("../pixi/selectors/mazeSelectors", () => ({
  buildCorridorSegments: vi.fn(() => []),
  buildMazeMarkers: vi.fn(() => []),
  buildTeleportEdges: vi.fn(() => []),
  buildSplitPassages: vi.fn(() => ({ passages: [], wallFaces: [], specialShapes: [] })),
  maxSplitNodeCount: vi.fn(() => 0),
}));

vi.mock("../pixi/renderers/WallRenderer", () => ({
  chainSegmentsAtSharedVertices: vi.fn(() => []),
}));

vi.mock("../pixi/renderers/TeleportRenderer", () => ({
  TeleportRenderer: vi.fn().mockImplementation(function (this: { render: () => void; destroy: () => void }) {
    this.render = vi.fn();
    this.destroy = vi.fn();
  }),
}));

vi.mock("../pixi/renderers/GridRenderer", () => ({
  GridRenderer: vi.fn().mockImplementation(function (this: { render: () => void; destroy: () => void }) {
    this.render = vi.fn();
    this.destroy = vi.fn();
  }),
}));

let subscribeCallback: ((state: unknown) => void) | null = null;
let currentState: Record<string, unknown>;

vi.mock("../store/mazeStore", () => ({
  useMazeStore: {
    getState: vi.fn(() => currentState),
    subscribe: vi.fn((cb: (state: unknown) => void) => {
      subscribeCallback = cb;
      return () => { subscribeCallback = null; };
    }),
  },
}));

vi.mock("pixi.js", () => ({
  Container: vi.fn().mockImplementation(function (this: { addChild: () => void; addChildAt: () => void; destroy: () => void; visible: boolean; getLocalBounds: () => unknown }) {
    this.addChild = vi.fn();
    this.addChildAt = vi.fn();
    this.destroy = vi.fn();
    this.visible = false;
    // Empty by default (Infinity/-Infinity, pixi's own "nothing drawn" convention) — tests that
    // care about `getRequiredExportMargin`'s pixel-accurate path override this per-container.
    this.getLocalBounds = vi.fn(() => makeEmptyBounds());
  }),
  Graphics: vi.fn().mockImplementation(function (this: { clear: () => void; moveTo: () => unknown; lineTo: () => unknown; arcTo: () => unknown; quadraticCurveTo: () => unknown; bezierCurveTo: () => unknown; closePath: () => unknown; stroke: () => unknown; circle: () => unknown; poly: () => unknown; rect: () => unknown; fill: () => unknown; setStrokeStyle: () => unknown; destroy: () => void }) {
    this.clear = vi.fn();
    this.moveTo = vi.fn(() => this);
    this.lineTo = vi.fn(() => this);
    this.arcTo = vi.fn(() => this);
    this.quadraticCurveTo = vi.fn(() => this);
    this.bezierCurveTo = vi.fn(() => this);
    this.closePath = vi.fn(() => this);
    this.stroke = vi.fn(() => this);
    this.circle = vi.fn(() => this);
    this.poly = vi.fn(() => this);
    this.rect = vi.fn(() => this);
    this.fill = vi.fn(() => this);
    this.setStrokeStyle = vi.fn(() => this);
    this.destroy = vi.fn();
  }),
}));

const startMarker: VectorByCorridorsSettings["startMarker"] = { shape: "circle", cornerStyle: "sharp", fillColor: 0, borderColor: 0, borderWidth: 0, gapWidth: 0, size: 0.1 };
const finishMarker: VectorByCorridorsSettings["finishMarker"] = { shape: "circle", cornerStyle: "sharp", fillColor: 0, borderColor: 0, borderWidth: 0, gapWidth: 0, size: 0.1 };
const teleportDefaults: Pick<VectorByCorridorsSettings,
  "teleportLineCornerStyle" | "teleportLineShape" | "teleportLineSize" | "teleportEdgeColor" | "teleportEdgeBorderColor" |
  "teleportEdgeBorderWidth" | "teleportEdgeGapWidth" | "teleportConnectorColor" | "teleportConnectorWidth" | "teleportConnectorStyle" |
  "teleportAvoidFieldExit" | "teleportArrowMode" | "teleportArrowPeriod" | "teleportArrowSize" | "teleportConnectorGapWidth" |
  "teleportGroupCustomization" | "teleportGroupOverrides"
> = {
  teleportLineCornerStyle: "sharp", teleportLineShape: "diamond", teleportLineSize: 0.16,
  teleportEdgeColor: 0, teleportEdgeBorderColor: 0, teleportEdgeBorderWidth: 3, teleportEdgeGapWidth: 3,
  teleportConnectorColor: 0, teleportConnectorWidth: 3, teleportConnectorStyle: "orthogonal", teleportAvoidFieldExit: false,
  teleportArrowMode: "periodic", teleportArrowPeriod: 5, teleportArrowSize: 10, teleportConnectorGapWidth: 3,
  teleportGroupCustomization: false, teleportGroupOverrides: {},
};
const oneWayDefaults: Pick<VectorByCorridorsSettings, "oneWayColor" | "oneWayCount" | "oneWayThickness" | "oneWayGap" | "oneWayWidth" | "oneWayLength" | "oneWayJoin"> = {
  oneWayColor: 0, oneWayCount: 1, oneWayThickness: 4, oneWayGap: 4, oneWayWidth: 1, oneWayLength: 10, oneWayJoin: "round",
};
const splitDefaults: Pick<VectorByCorridorsSettings, "splitNodeColors" | "splitSpecialShapes" | "splitGapWidth" | "splitDiagonalBowAmount"> = {
  splitNodeColors: [], splitSpecialShapes: true, splitGapWidth: 3, splitDiagonalBowAmount: 0.15,
};
const sharedStyle: VectorByCorridorsSettings["sharedStyle"] = { cornerStyle: "round", markerSize: 0.16, markerBorderWidth: 3, gapWidth: 3, overrides: {} };
const settingsA: VectorByCorridorsSettings = { background: 0x000000, showGrid: true, gridColor: 0x333333, color: 0x111111, thickness: 10, join: "round", startMarker, finishMarker, markerWidenPadding: 4, markerWidenShape: "match_marker", ...oneWayDefaults, ...teleportDefaults, ...splitDefaults, sharedStyle };
const settingsB: VectorByCorridorsSettings = { background: 0x000000, showGrid: true, gridColor: 0x333333, color: 0x222222, thickness: 20, join: "miter", startMarker, finishMarker, markerWidenPadding: 4, markerWidenShape: "match_marker", ...oneWayDefaults, ...teleportDefaults, ...splitDefaults, sharedStyle };

// Stable references reused across `baseState()` calls — the renderer's own geometry cache keys off
// reference-equality of `nodes`/`edges`/`activeTessellationConfig` (same convention as
// `VectorByWallsRenderer`'s own cache), so a fresh literal on every call would look like a data
// change even when a test means to vary only `vectorByCorridorsSettings`.
const stableNodes: NodeDto[] = [];
const stableEdges: EdgeDto[] = [];
const stableCfg: TessellationConfig = { type: "square", width: 4, height: 4 };

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    openCard: "image_export",
    nodes: stableNodes,
    edges: stableEdges,
    activeTessellationConfig: stableCfg,
    vectorByCorridorsSettings: settingsA,
    vectorByCorridorsSectionsExpanded: {},
    start: null,
    finish: null,
    postEditMeta: null,
    postEditDraftSplitPoints: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  subscribeCallback = null;
  currentState = baseState();
});

describe("buildTeleportWidenMarkers", () => {
  it("emits one marker per unique teleport point, deduping shared endpoints across edges", () => {
    const edges = [
      { from: [0, 0] as [number, number], to: [1, 1] as [number, number], oneWay: false },
      { from: [1, 1] as [number, number], to: [2, 2] as [number, number], oneWay: false },
    ];
    const markers = buildTeleportWidenMarkers(edges, settingsA, []);
    expect(markers.map((m) => m.pos)).toEqual([[0, 0], [1, 1], [2, 2]]);
  });

  it("uses the base teleportLineShape/teleportLineCornerStyle/border/gap when group customization is off", () => {
    const [marker] = buildTeleportWidenMarkers([{ from: [0, 0], to: [1, 1], oneWay: false }], settingsA, []);
    expect(marker.shape).toBe(settingsA.teleportLineShape);
    expect(marker.cornerStyle).toBe(settingsA.teleportLineCornerStyle);
    expect(marker.borderWidth).toBe(settingsA.teleportEdgeBorderWidth);
    expect(marker.gapWidth).toBe(settingsA.teleportEdgeGapWidth);
    expect(marker.radius).toBe(settingsA.teleportLineSize * TILE_SIZE);
  });

  it("uses a group's own override shape for its points when group customization is on", () => {
    const groupKey = "0-1";
    const settings: VectorByCorridorsSettings = {
      ...settingsA,
      teleportGroupCustomization: true,
      teleportGroupOverrides: { [groupKey]: { shape: "square" } },
    };
    const edges = [{ from: [0, 0] as [number, number], to: [1, 1] as [number, number], oneWay: false, fromNode: 0, toNode: 1 }];
    const [marker] = buildTeleportWidenMarkers(edges, settings, buildTeleportGroups(edges));
    expect(marker.shape).toBe("square");
  });

  it("falls back to the base shape for a group with no override, even with customization on", () => {
    const settings: VectorByCorridorsSettings = { ...settingsA, teleportGroupCustomization: true, teleportGroupOverrides: {} };
    const edges = [{ from: [0, 0] as [number, number], to: [1, 1] as [number, number], oneWay: false }];
    const [marker] = buildTeleportWidenMarkers(edges, settings, buildTeleportGroups(edges));
    expect(marker.shape).toBe(settingsA.teleportLineShape);
  });

  it("ignores teleportGroupOverrides entirely when group customization is off", () => {
    const groupKey = "0-1";
    const settings: VectorByCorridorsSettings = {
      ...settingsA,
      teleportGroupCustomization: false,
      teleportGroupOverrides: { [groupKey]: { shape: "square" } },
    };
    const edges = [{ from: [0, 0] as [number, number], to: [1, 1] as [number, number], oneWay: false, fromNode: 0, toNode: 1 }];
    const [marker] = buildTeleportWidenMarkers(edges, settings, []);
    expect(marker.shape).toBe(settingsA.teleportLineShape);
  });

  it("returns an empty list for no teleport edges", () => {
    expect(buildTeleportWidenMarkers([], settingsA, [])).toEqual([]);
  });
});

describe("computeSquareCapPatch", () => {
  it("extends width/2 past freeEnd along the path's own direction, centered on the perpendicular", () => {
    const freeEnd = { x: 10, y: 0 };
    const neighbor = { x: 0, y: 0 }; // path runs along +x, so freeEnd's own direction is +x
    const [p0, p1, p2, p3] = computeSquareCapPatch(freeEnd, neighbor, 4);
    // half = 2: two corners at freeEnd +/- perpendicular, two at the tip (freeEnd + 2 along +x) +/- perpendicular.
    expect(p0).toEqual({ x: 10, y: 2 });
    expect(p1).toEqual({ x: 12, y: 2 });
    expect(p2).toEqual({ x: 12, y: -2 });
    expect(p3).toEqual({ x: 10, y: -2 });
  });

  it("falls back to a unit direction when freeEnd and neighbor coincide, instead of producing NaN", () => {
    const p = { x: 5, y: 5 };
    const [p0, p1, p2, p3] = computeSquareCapPatch(p, p, 2);
    for (const corner of [p0, p1, p2, p3]) {
      expect(Number.isFinite(corner.x)).toBe(true);
      expect(Number.isFinite(corner.y)).toBe(true);
    }
  });
});

describe("computeDiagonalGapPatchGeometry", () => {
  it("pulls gapFrom/gapTo inward from from/to by gridInset, along each face's own perpendicular", () => {
    // Two faces both running along +x (a straight-through connector, parallel faces) — the inward
    // direction is then perpendicular to +x, i.e. along +/-y.
    const from = { x: 0, y: 0 };
    const to = { x: 20, y: 0 };
    const fromFaceDir = { x: 1, y: 0 };
    const toFaceDir = { x: 1, y: 0 };
    const { gapFrom, gapTo } = computeDiagonalGapPatchGeometry(from, to, fromFaceDir, toFaceDir, 3, 10);
    expect(gapFrom.x).toBeCloseTo(0, 5);
    expect(Math.abs(gapFrom.y)).toBeCloseTo(3, 5);
    expect(gapTo.x).toBeCloseTo(20, 5);
    expect(Math.abs(gapTo.y)).toBeCloseTo(3, 5);
  });

  it("does not clamp gapWidth for parallel faces (never intersect, so the ray-intersection cap is a no-op)", () => {
    const from = { x: 0, y: 0 };
    const to = { x: 20, y: 0 };
    const fromFaceDir = { x: 1, y: 0 };
    const toFaceDir = { x: 1, y: 0 };
    const { clampedGapWidth } = computeDiagonalGapPatchGeometry(from, to, fromFaceDir, toFaceDir, 0, 10);
    expect(clampedGapWidth).toBe(10);
  });

  it("clamps gapWidth so the patch's own short ends never cross their own lines' intersection point", () => {
    // Two faces at a right angle, meeting close to from/to (a sharp corner) — the intersection of
    // the two short-end lines is nearby, so a large requested gapWidth must be clamped down.
    const from = { x: 0, y: 0 };
    const to = { x: 1, y: 0 };
    const fromFaceDir = { x: 0, y: 1 };
    const toFaceDir = { x: 1, y: 0 };
    const { clampedGapWidth } = computeDiagonalGapPatchGeometry(from, to, fromFaceDir, toFaceDir, 0, 1000);
    expect(clampedGapWidth).toBeLessThan(1000);
    expect(clampedGapWidth).toBeGreaterThanOrEqual(0);
  });
});

describe("VectorByCorridorsRenderer", () => {
  it("getRequiredExportMargin returns zero margin when this maze has no nodes (nothing drawn)", () => {
    currentState = baseState({ vectorByCorridorsSettings: settingsB });
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    expect(renderer.getRequiredExportMargin()).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
  });

  it("getRequiredExportMargin reads the actual drawn content's pixel bounds, not a settings-derived approximation (GitHub issue #324 follow-up)", () => {
    // TILE_SIZE=40, 3x3 grid — cellCenterBounds for this grid is minX=20,maxX=100,minY=-100,maxY=-20
    // (verified directly against squareCenter's own Y-flip/half-tile-offset convention).
    const nodes: NodeDto[] = [];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) nodes.push({ id: y * 3 + x, x, y, i: 0 });
    currentState = baseState({ nodes, vectorByCorridorsSettings: settingsA, activeTessellationConfig: { type: "square", width: 3, height: 3 } });
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);

    const asAny = renderer as unknown as {
      corridorsContainer: { getLocalBounds: () => FakeBounds };
      splitShapesLayer: { getLocalBounds: () => FakeBounds };
      teleportContainer: { getLocalBounds: () => FakeBounds };
      markersContainer: { getLocalBounds: () => FakeBounds };
    };
    // Simulate a teleport marker's own widen patch drawn well past the corridor lines' own bbox on
    // the top edge only (screen minY) — corridors/splits/markers stay at the plain cell-center
    // bbox, teleport pokes 30px past it on top alone.
    asAny.corridorsContainer.getLocalBounds = () => makeBounds(20, -100, 100, -20);
    asAny.splitShapesLayer.getLocalBounds = () => makeEmptyBounds();
    asAny.teleportContainer.getLocalBounds = () => makeBounds(20, -130, 100, -20);
    asAny.markersContainer.getLocalBounds = () => makeEmptyBounds();

    const margin = renderer.getRequiredExportMargin();
    expect(margin).toEqual({ left: 0, right: 0, top: 30, bottom: 0 });
  });

  it("getBackgroundColor resolves to the mode's own configurable background (GitHub issue #309)", () => {
    currentState = baseState({ vectorByCorridorsSettings: settingsB });
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    expect(renderer.getBackgroundColor()).toBe(settingsB.background);
  });

  it("onViewportChanged redraws the background and grid against the new viewport while the image-export card is open (GitHub issue #309)", () => {
    currentState = baseState({ vectorByCorridorsSettings: settingsB });
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    const backgroundGrid = (renderer as unknown as { backgroundGrid: { grid: { render: ReturnType<typeof vi.fn> }; background: { rect: ReturnType<typeof vi.fn> } } }).backgroundGrid;
    vi.mocked(backgroundGrid.grid.render).mockClear();
    vi.mocked(backgroundGrid.background.rect).mockClear();

    renderer.onViewportChanged(10, 20, 800, 600, 2);

    expect(backgroundGrid.background.rect).toHaveBeenCalledTimes(1);
    expect(backgroundGrid.grid.render).toHaveBeenCalledWith(
      { viewport: { x: 10, y: 20, w: 800, h: 600, scale: 2 }, color: settingsB.gridColor },
      currentState.activeTessellationConfig,
    );
  });

  it("onViewportChanged does not redraw while the image-export card is closed", () => {
    currentState = baseState({ openCard: "generation" });
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    const backgroundGrid = (renderer as unknown as { backgroundGrid: { grid: { render: ReturnType<typeof vi.fn> }; background: { rect: ReturnType<typeof vi.fn> } } }).backgroundGrid;
    vi.mocked(backgroundGrid.grid.render).mockClear();
    vi.mocked(backgroundGrid.background.rect).mockClear();

    renderer.onViewportChanged(10, 20, 800, 600, 2);

    expect(backgroundGrid.background.rect).not.toHaveBeenCalled();
    expect(backgroundGrid.grid.render).not.toHaveBeenCalled();
  });

  it("onViewportChanged skips the grid draw when showGrid is off, but still redraws the background", () => {
    currentState = baseState({ vectorByCorridorsSettings: { ...settingsB, showGrid: false } });
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    const backgroundGrid = (renderer as unknown as { backgroundGrid: { grid: { render: ReturnType<typeof vi.fn> }; background: { rect: ReturnType<typeof vi.fn> } } }).backgroundGrid;
    vi.mocked(backgroundGrid.grid.render).mockClear();
    vi.mocked(backgroundGrid.background.rect).mockClear();

    renderer.onViewportChanged(10, 20, 800, 600, 2);

    expect(backgroundGrid.background.rect).toHaveBeenCalledTimes(1);
    expect(backgroundGrid.grid.render).not.toHaveBeenCalled();
  });

  it("container starts hidden and becomes visible only while the image-export card is open", () => {
    currentState = baseState({ openCard: "generation" });
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    expect((renderer as unknown as { corridorsContainer: { visible: boolean } }).corridorsContainer.visible).toBe(false);
  });

  it("a data change while the image-export card is open triggers a re-render (geometry rebuilt)", () => {
    new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    vi.mocked(buildCorridorSegments).mockClear();

    const nextState = baseState({ nodes: [{ id: 0, x: 0, y: 0, i: 0 }] });
    subscribeCallback?.(nextState);

    expect(buildCorridorSegments).toHaveBeenCalledTimes(1);
  });

  it("a settings-only change re-renders without rebuilding geometry (cache reused)", () => {
    new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    vi.mocked(buildCorridorSegments).mockClear();

    // `color`-only change — `thickness` stays the same as `settingsA`'s own (unlike `settingsB`,
    // which also changes `thickness`, itself now a geometry-cache key since GitHub issue #314's
    // split-connector corridor-width division depends on it).
    const nextState = baseState({ vectorByCorridorsSettings: { ...settingsA, color: 0x999999 } });
    subscribeCallback?.(nextState);

    expect(buildCorridorSegments).not.toHaveBeenCalled();
  });

  it("a thickness-only change rebuilds geometry (split-connector corridor-width division depends on it, GitHub issue #314)", () => {
    new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    vi.mocked(buildCorridorSegments).mockClear();

    const nextState = baseState({ vectorByCorridorsSettings: settingsB });
    subscribeCallback?.(nextState);

    expect(buildCorridorSegments).toHaveBeenCalledTimes(1);
  });

  it("a data change while the image-export card is closed does not re-render", () => {
    new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    vi.mocked(buildCorridorSegments).mockClear();

    const nextState = baseState({ openCard: "generation", nodes: [{ id: 0, x: 0, y: 0, i: 0 }] });
    subscribeCallback?.(nextState);

    expect(buildCorridorSegments).not.toHaveBeenCalled();
  });

  it("switching openCard to image_export re-renders even with no data/settings change", () => {
    currentState = baseState({ openCard: "generation" });
    new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    vi.mocked(buildCorridorSegments).mockClear();

    const nextState = baseState({ openCard: "image_export" });
    subscribeCallback?.(nextState);

    expect(buildCorridorSegments).toHaveBeenCalledTimes(1);
  });

  it("destroy unsubscribes from the store and destroys its own Graphics/Container", () => {
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    expect(subscribeCallback).not.toBeNull();
    renderer.destroy();
    expect(subscribeCallback).toBeNull();
  });

  it("resolves start/finish through resolveEffectiveEndpoints and passes them to buildMazeMarkers", () => {
    currentState = baseState({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }],
      start: 0,
      finish: 1,
    });
    new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    expect(buildMazeMarkers).toHaveBeenCalledWith(
      expect.any(Map), 0, 1, stableCfg,
      expect.objectContaining(startMarker),
      expect.objectContaining(finishMarker),
      expect.any(Array),
    );
  });

  it("a start/finish change alone (no node/edge change) triggers a re-render", () => {
    new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    vi.mocked(buildMazeMarkers).mockClear();

    const nextState = baseState({ start: 5 });
    subscribeCallback?.(nextState);

    expect(buildMazeMarkers).toHaveBeenCalledTimes(1);
  });

  it("draws a widen patch (fill in the corridor's own color) under each marker before drawing the markers", () => {
    vi.mocked(buildMazeMarkers).mockReturnValueOnce([{ pos: [5, 5], color: 0x999, radius: 4 }]);
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    const corridorsGraphics = (renderer as unknown as { corridors: { fill: ReturnType<typeof vi.fn> } }).corridors;
    expect(corridorsGraphics.fill).toHaveBeenCalledWith(settingsA.color);
  });

  it("also widens the corridor under teleport markers, reusing the same markerWidenPadding setting (no separate teleport padding)", () => {
    vi.mocked(buildTeleportEdges).mockReturnValueOnce([{ from: [7, 7], to: [9, 9], oneWay: false }]);
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    const corridorsGraphics = (renderer as unknown as { corridors: { poly: ReturnType<typeof vi.fn>; circle: ReturnType<typeof vi.fn>; fill: ReturnType<typeof vi.fn> } }).corridors;
    // settingsA.teleportLineShape is "diamond" — drawn via `poly`, not `circle` (see drawMarkerShape).
    expect(corridorsGraphics.fill).toHaveBeenCalledWith(settingsA.color);
    expect(corridorsGraphics.poly).toHaveBeenCalled();
  });

  it("draws every widen patch (waypoint and teleport alike) in a fixed square when markerWidenShape isn't 'match_marker', regardless of each marker's own shape", () => {
    // startMarker/teleportLineShape are non-square ("circle"/"diamond") in these fixtures — with
    // markerWidenShape:"square" every widen patch must draw as a square (via `arcTo`, since
    // settingsA.join is "round" — rounded-square corners), never `circle`, regardless of each
    // marker's own shape (GitHub issue #313 follow-up).
    vi.mocked(buildMazeMarkers).mockReturnValueOnce([{ pos: [5, 5], color: 0x999, radius: 4, shape: "circle" }]);
    vi.mocked(buildTeleportEdges).mockReturnValueOnce([{ from: [7, 7], to: [9, 9], oneWay: false }]);
    currentState = baseState({ vectorByCorridorsSettings: { ...settingsA, markerWidenShape: "square" } });
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    const corridorsGraphics = (renderer as unknown as { corridors: { arcTo: ReturnType<typeof vi.fn>; circle: ReturnType<typeof vi.fn> } }).corridors;
    expect(corridorsGraphics.circle).not.toHaveBeenCalled();
    expect(corridorsGraphics.arcTo).toHaveBeenCalled();
  });

  it("renders teleports via its own TeleportRenderer, styled from vectorByCorridorsSettings with the corridor's own color as floorColor", () => {
    vi.mocked(buildMazeMarkers).mockReturnValueOnce([{ pos: [5, 5], color: 0x999, radius: 4 }]);
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    const teleports = (renderer as unknown as { teleports: { render: ReturnType<typeof vi.fn> } }).teleports;
    expect(teleports.render).toHaveBeenCalledWith(expect.objectContaining({
      edges: [],
      // floorColor is the corridor's own color here, not the canvas background (GitHub issue #313
      // follow-up) — a teleport point sits on the passage line, not on an empty floor tile.
      lineStyle: expect.objectContaining({ shape: settingsA.teleportLineShape, floorColor: settingsA.color }),
      groupCustomization: settingsA.teleportGroupCustomization,
      groupOverrides: settingsA.teleportGroupOverrides,
      interactive: false,
      cfg: stableCfg,
      waypoints: [[5, 5]],
      avoidFieldExit: settingsA.teleportAvoidFieldExit,
    }));
  });

  it("marks the Teleports section interactive only while vectorByCorridorsSectionsExpanded.teleports is true", () => {
    currentState = baseState({ vectorByCorridorsSectionsExpanded: { teleports: true } });
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    const teleports = (renderer as unknown as { teleports: { render: ReturnType<typeof vi.fn> } }).teleports;
    expect(teleports.render).toHaveBeenCalledWith(expect.objectContaining({ interactive: true }));
  });

  it("destroy destroys its own TeleportRenderer and its container", () => {
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    const teleports = (renderer as unknown as { teleports: { destroy: ReturnType<typeof vi.fn> } }).teleports;
    const teleportContainer = (renderer as unknown as { teleportContainer: { destroy: ReturnType<typeof vi.fn> } }).teleportContainer;
    renderer.destroy();
    expect(teleports.destroy).toHaveBeenCalled();
    expect(teleportContainer.destroy).toHaveBeenCalled();
  });

  describe("one-way chevron row (GitHub issue #312)", () => {
    it("draws oneWayCount chevrons (one moveTo/lineTo/lineTo/stroke each) for a one-way segment, none for a plain one", () => {
      vi.mocked(buildCorridorSegments).mockReturnValueOnce([
        { v0: { x: 0, y: 0 }, v1: { x: 100, y: 0 }, oneWayDir: { dx: 1, dy: 0 }, fromNode: 0, toNode: 1 },
        { v0: { x: 200, y: 0 }, v1: { x: 300, y: 0 }, fromNode: 2, toNode: 3 }, // plain, no oneWayDir
      ]);
      currentState = baseState({ vectorByCorridorsSettings: { ...settingsA, oneWayCount: 3 } });
      const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
      const corridorsGraphics = (renderer as unknown as { corridors: { moveTo: ReturnType<typeof vi.fn>; stroke: ReturnType<typeof vi.fn> } }).corridors;

      // Each chevron issues exactly one moveTo (drawOneWayChevron's own `path`) — 3 for the one-way
      // segment's row, 0 for the plain segment (chainSegmentsAtSharedVertices is mocked to `[]`, so
      // the corridor stroke itself issues none here — every moveTo call is a chevron's).
      expect(corridorsGraphics.moveTo).toHaveBeenCalledTimes(3);
    });

    it("centers the chevron row on the one-way segment's own midpoint, along its oneWayDir", () => {
      vi.mocked(buildCorridorSegments).mockReturnValueOnce([
        { v0: { x: 0, y: 0 }, v1: { x: 100, y: 0 }, oneWayDir: { dx: 1, dy: 0 }, fromNode: 0, toNode: 1 },
      ]);
      currentState = baseState({ vectorByCorridorsSettings: { ...settingsA, oneWayCount: 1 } });
      const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
      const corridorsGraphics = (renderer as unknown as { corridors: { lineTo: ReturnType<typeof vi.fn> } }).corridors;

      // A single centered chevron's tip sits at midpoint (50,0) + oneWayLengthPx along (1,0).
      const fullWidth = settingsA.oneWayWidth * settingsA.thickness;
      const lengthPx = settingsA.oneWayLength * fullWidth;
      const tipCall = corridorsGraphics.lineTo.mock.calls.find(([x, y]) => y === 0 && Math.abs(x - (50 + lengthPx)) < 1e-6);
      expect(tipCall).toBeDefined();
    });

    it("draws no chevrons when no segment is one-way", () => {
      vi.mocked(buildCorridorSegments).mockReturnValueOnce([
        { v0: { x: 0, y: 0 }, v1: { x: 100, y: 0 }, fromNode: 0, toNode: 1 },
      ]);
      const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
      const corridorsGraphics = (renderer as unknown as { corridors: { moveTo: ReturnType<typeof vi.fn> } }).corridors;
      expect(corridorsGraphics.moveTo).not.toHaveBeenCalled();
    });
  });

  describe("split points (GitHub issue #314)", () => {
    it("draws each node's own face share as a straight line from the point's own center, one stroke per share", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [
          {
            color: 0xaaaaaa, pointKey: "0,0", center: { x: 5, y: 5 },
            wallSegments: [{ v0: { x: 0, y: 0 }, v1: { x: 0, y: 10 }, center: { x: 10, y: 5 }, isUndefined: false, atFaceStart: false, atFaceEnd: false }],
            connectors: [],
          },
          {
            color: 0xbbbbbb, pointKey: "0,0", center: { x: 5, y: 5 },
            wallSegments: [{ v0: { x: 0, y: 0 }, v1: { x: 10, y: 0 }, center: { x: 5, y: 10 }, isUndefined: false, atFaceStart: false, atFaceEnd: false }],
            connectors: [],
          },
        ],
        wallFaces: [],
        specialShapes: [],
      });
      const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
      const corridorsGraphics = (renderer as unknown as { corridors: { stroke: ReturnType<typeof vi.fn>; moveTo: ReturnType<typeof vi.fn> } }).corridors;
      const colors = corridorsGraphics.stroke.mock.calls.map((call: unknown[]) => (call[0] as { color: number }).color);
      expect(colors).toContain(0xaaaaaa);
      expect(colors).toContain(0xbbbbbb);
      // Every line starts at the point's own center (5,5), never a hub offset.
      expect(corridorsGraphics.moveTo).toHaveBeenCalledWith(5, 5);
    });

    it("a node with 3+ face shares draws one straight line per share, all from the same center — no hub fan-out", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [{
          color: 0xaaaaaa, pointKey: "0,0", center: { x: 5, y: 5 },
          wallSegments: [
            { v0: { x: 0, y: 0 }, v1: { x: 0, y: 0 }, center: { x: 10, y: 5 }, isUndefined: false, atFaceStart: false, atFaceEnd: false },
            { v0: { x: 0, y: 0 }, v1: { x: 0, y: 0 }, center: { x: 0, y: 5 }, isUndefined: false, atFaceStart: false, atFaceEnd: false },
            { v0: { x: 0, y: 0 }, v1: { x: 0, y: 0 }, center: { x: 5, y: 10 }, isUndefined: false, atFaceStart: false, atFaceEnd: false },
          ],
          connectors: [],
        }],
        wallFaces: [],
        specialShapes: [],
      });
      const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
      const corridorsGraphics = (renderer as unknown as { corridors: { stroke: ReturnType<typeof vi.fn>; moveTo: ReturnType<typeof vi.fn> } }).corridors;
      expect(corridorsGraphics.stroke).toHaveBeenCalledTimes(3);
      expect(corridorsGraphics.moveTo.mock.calls.every((call: unknown[]) => call[0] === 5 && call[1] === 5)).toBe(true);
    });

    it("draws an undefined (tentative) share in a desaturated version of the node's color, not the plain color", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [{
          color: 0xff0000, pointKey: "0,0", center: { x: 5, y: 5 },
          wallSegments: [{ v0: { x: 0, y: 0 }, v1: { x: 10, y: 0 }, center: { x: 5, y: 0 }, isUndefined: true, atFaceStart: false, atFaceEnd: false }],
          connectors: [],
        }],
        wallFaces: [],
        specialShapes: [],
      });
      const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
      const corridorsGraphics = (renderer as unknown as { corridors: { stroke: ReturnType<typeof vi.fn> } }).corridors;
      const colors = corridorsGraphics.stroke.mock.calls.map((call: unknown[]) => (call[0] as { color: number }).color);
      expect(colors).not.toContain(0xff0000);
    });

    it("plain (non-special) shares draw at half the corridor's own thickness", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [{
          color: 0xaaaaaa, pointKey: "0,0", center: { x: 5, y: 5 },
          wallSegments: [{ v0: { x: 0, y: 0 }, v1: { x: 10, y: 0 }, center: { x: 5, y: 0 }, isUndefined: false, atFaceStart: false, atFaceEnd: false }],
          connectors: [],
        }],
        wallFaces: [],
        specialShapes: [],
      });
      const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
      const corridorsGraphics = (renderer as unknown as { corridors: { stroke: ReturnType<typeof vi.fn> } }).corridors;
      const widths = corridorsGraphics.stroke.mock.calls.map((call: unknown[]) => (call[0] as { width: number }).width);
      expect(widths).toContain(settingsA.thickness / 2);
    });

    it("bridge special shape: draws the through line, the cross line, and a background-colored gap stroke at their intersection when splitGapWidth > 0, both in the plain corridor color", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [{
          color: 0xaaaaaa, pointKey: "0,0", center: { x: 20, y: 20 },
          wallSegments: [{ v0: { x: 0, y: 20 }, v1: { x: 0, y: 20 }, center: { x: 0, y: 20 }, isUndefined: false, atFaceStart: false, atFaceEnd: false }],
          connectors: [],
        }],
        wallFaces: [],
        specialShapes: [{
          kind: "bridge", pointKey: "0,0",
          crossFaces: [{ v0: { x: 20, y: 0 }, v1: { x: 20, y: 0 } }, { v0: { x: 20, y: 40 }, v1: { x: 20, y: 40 } }],
          edge0: [{ x: 10, y: 0 }, { x: 14, y: 8 }, { x: 14, y: 32 }, { x: 10, y: 40 }],
          edge1: [{ x: 30, y: 0 }, { x: 26, y: 8 }, { x: 26, y: 32 }, { x: 30, y: 40 }],
          throughLine: [{ x: 0, y: 20 }, { x: 40, y: 20 }],
        }],
      });
      currentState = baseState({ vectorByCorridorsSettings: { ...settingsA, splitSpecialShapes: true, splitGapWidth: 3 } });
      const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
      const corridorsGraphics = (renderer as unknown as { corridors: { stroke: ReturnType<typeof vi.fn> } }).corridors;
      // The through/cross lines and the background gap patch all draw on their own throwaway
      // tile-masked `clipView` (GitHub issue #314 follow-up), never on the shared `corridors`
      // graphics — so the point's own ordinary passage share must not appear there either, and
      // neither must the special shape's own lines.
      const corridorsStrokeCalls = corridorsGraphics.stroke.mock.calls.map((call: unknown[]) => call[0] as { color: number; width: number });
      expect(corridorsStrokeCalls.some((s) => s.color === 0xaaaaaa)).toBe(false);
      expect(corridorsStrokeCalls.length).toBe(0);

      const graphicsInstances = vi.mocked(Graphics).mock.results.map((r) => r.value as { stroke: ReturnType<typeof vi.fn> });
      const groupGraphics = graphicsInstances.filter((g) => g !== corridorsGraphics);
      const allStrokeCalls = groupGraphics.flatMap((g) => g.stroke.mock.calls.map((call: unknown[]) => call[0] as { color: number; width: number }));
      // Through line and cross line both draw in the plain corridor color, at full thickness — 2
      // separate stroke calls at that color (through, then cross, on top); the gap patch is a
      // separate stroke in `settings.background`, all on the same `clipView`.
      const fullColorCalls = allStrokeCalls.filter((s) => s.color === settingsA.color && s.width === settingsA.thickness);
      expect(fullColorCalls.length).toBe(2);
      expect(allStrokeCalls.some((s) => s.color === settingsA.background)).toBe(true);
    });

    it("bridge special shape: draws no background gap stroke when splitGapWidth is 0", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [{ color: 0xaaaaaa, pointKey: "0,0", center: { x: 20, y: 20 }, wallSegments: [], connectors: [] }],
        wallFaces: [],
        specialShapes: [{
          kind: "bridge", pointKey: "0,0",
          crossFaces: [{ v0: { x: 20, y: 0 }, v1: { x: 20, y: 0 } }, { v0: { x: 20, y: 40 }, v1: { x: 20, y: 40 } }],
          edge0: [{ x: 10, y: 0 }, { x: 14, y: 8 }, { x: 14, y: 32 }, { x: 10, y: 40 }],
          edge1: [{ x: 30, y: 0 }, { x: 26, y: 8 }, { x: 26, y: 32 }, { x: 30, y: 40 }],
          throughLine: [{ x: 0, y: 20 }, { x: 40, y: 20 }],
        }],
      });
      currentState = baseState({ vectorByCorridorsSettings: { ...settingsA, splitSpecialShapes: true, splitGapWidth: 0 } });
      const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
      const corridorsGraphics = (renderer as unknown as { corridors: { stroke: ReturnType<typeof vi.fn> } }).corridors;
      const graphicsInstances = vi.mocked(Graphics).mock.results.map((r) => r.value as { stroke: ReturnType<typeof vi.fn> });
      const groupGraphics = graphicsInstances.filter((g) => g !== corridorsGraphics);
      const allStrokeCalls = groupGraphics.flatMap((g) => g.stroke.mock.calls.map((call: unknown[]) => call[0] as { color: number }));
      expect(allStrokeCalls.some((s) => s.color === settingsA.background)).toBe(false);
    });

    it("diagonal special shape: draws each node's connector as a bowed ribbon (bezierCurveTo), not a straight line, when splitDiagonalBowAmount > 0, in the plain corridor color", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [
          { color: 0xaaaaaa, pointKey: "1,1", center: { x: 20, y: 20 }, wallSegments: [], connectors: [{ from: { x: 0, y: 20 }, to: { x: 20, y: 0 }, isUndefined: false }] },
          { color: 0xbbbbbb, pointKey: "1,1", center: { x: 20, y: 20 }, wallSegments: [], connectors: [{ from: { x: 20, y: 40 }, to: { x: 40, y: 20 }, isUndefined: false }] },
        ],
        wallFaces: [],
        specialShapes: [{ kind: "diagonal", pointKey: "1,1", corner0: { x: 0, y: 0 }, corner1: { x: 40, y: 40 } }],
      });
      currentState = baseState({ vectorByCorridorsSettings: { ...settingsA, splitSpecialShapes: true, splitDiagonalBowAmount: 0.15, splitGapWidth: 0 } });
      const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
      const corridorsGraphics = (renderer as unknown as { corridors: { bezierCurveTo: ReturnType<typeof vi.fn>; stroke: ReturnType<typeof vi.fn>; fill: ReturnType<typeof vi.fn> } }).corridors;
      // Each ribbon draws on its own throwaway tile-masked `clipView` (GitHub issue #314
      // follow-up), never on the shared `corridors` graphics.
      expect(corridorsGraphics.bezierCurveTo).not.toHaveBeenCalled();
      const graphicsInstances = vi.mocked(Graphics).mock.results.map((r) => r.value as { bezierCurveTo: ReturnType<typeof vi.fn>; fill: ReturnType<typeof vi.fn> });
      const groupGraphics = graphicsInstances.filter((g) => g !== corridorsGraphics);
      // splitGapWidth: 0 -> no gap-patch pass, 2 bezierCurveTo calls per ribbon (one per long
      // edge), 2 connectors total -> 4.
      const totalBezier = groupGraphics.reduce((sum, g) => sum + g.bezierCurveTo.mock.calls.length, 0);
      expect(totalBezier).toBe(4);
      const allFillCalls = groupGraphics.flatMap((g) => g.fill.mock.calls.map((call: unknown[]) => call[0] as number));
      expect(allFillCalls.some((c) => c === settingsA.color)).toBe(true);
      expect(allFillCalls.some((c) => c === settingsA.background)).toBe(false);
    });

    it("diagonal special shape: draws a background-colored gap frame around each arc when splitGapWidth > 0", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [
          { color: 0xaaaaaa, pointKey: "1,1", center: { x: 20, y: 20 }, wallSegments: [], connectors: [{ from: { x: 0, y: 20 }, to: { x: 20, y: 0 }, isUndefined: false }] },
        ],
        wallFaces: [],
        specialShapes: [{ kind: "diagonal", pointKey: "1,1", corner0: { x: 0, y: 0 }, corner1: { x: 40, y: 40 } }],
      });
      currentState = baseState({ vectorByCorridorsSettings: { ...settingsA, splitSpecialShapes: true, splitDiagonalBowAmount: 0.15, splitGapWidth: 3 } });
      const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
      const corridorsGraphics = (renderer as unknown as { corridors: { bezierCurveTo: ReturnType<typeof vi.fn>; stroke: ReturnType<typeof vi.fn>; fill: ReturnType<typeof vi.fn> } }).corridors;
      // The ribbon's own line and its background gap frame draw on two separate `Graphics`
      // (`clipView`/`gapView`, GitHub issue #314 follow-up) — never on the shared `corridors`
      // graphics. Each is its own filled ribbon (2 bezierCurveTo calls, one per long edge).
      const graphicsInstances = vi.mocked(Graphics).mock.results.map((r) => r.value as { bezierCurveTo: ReturnType<typeof vi.fn>; fill: ReturnType<typeof vi.fn> });
      const groupGraphics = graphicsInstances.filter((g) => g !== corridorsGraphics);
      const totalBezier = groupGraphics.reduce((sum, g) => sum + g.bezierCurveTo.mock.calls.length, 0);
      expect(totalBezier).toBe(4);
      const allFillCalls = groupGraphics.flatMap((g) => g.fill.mock.calls.map((call: unknown[]) => call[0] as number));
      expect(allFillCalls.some((c) => c === settingsA.background)).toBe(true);
      expect(allFillCalls.some((c) => c === settingsA.color)).toBe(true);
      expect(corridorsGraphics.bezierCurveTo).not.toHaveBeenCalled();
    });

    it("splitSpecialShapes off: special-shape points fall back to the ordinary per-node face-share reading", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [{
          color: 0xaaaaaa, pointKey: "0,0", center: { x: 20, y: 20 },
          wallSegments: [{ v0: { x: 0, y: 20 }, v1: { x: 0, y: 20 }, center: { x: 0, y: 20 }, isUndefined: false, atFaceStart: false, atFaceEnd: false }],
          connectors: [],
        }],
        wallFaces: [],
        specialShapes: [{
          kind: "bridge", pointKey: "0,0",
          crossFaces: [{ v0: { x: 20, y: 0 }, v1: { x: 20, y: 0 } }, { v0: { x: 20, y: 40 }, v1: { x: 20, y: 40 } }],
          edge0: [{ x: 10, y: 0 }, { x: 14, y: 8 }, { x: 14, y: 32 }, { x: 10, y: 40 }],
          edge1: [{ x: 30, y: 0 }, { x: 26, y: 8 }, { x: 26, y: 32 }, { x: 30, y: 40 }],
          throughLine: [{ x: 0, y: 20 }, { x: 40, y: 20 }],
        }],
      });
      currentState = baseState({ vectorByCorridorsSettings: { ...settingsA, splitSpecialShapes: false } });
      const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
      const corridorsGraphics = (renderer as unknown as { corridors: { stroke: ReturnType<typeof vi.fn> } }).corridors;
      const strokeArgs = corridorsGraphics.stroke.mock.calls.map((call: unknown[]) => (call[0] as { color: number }).color);
      expect(strokeArgs).toContain(0xaaaaaa);
    });
  });
});
