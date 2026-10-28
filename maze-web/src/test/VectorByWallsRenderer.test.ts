import { describe, it, expect, vi, beforeEach } from "vitest";
import { nodeEndpoint, splitEndpoint } from "../pixi/postEditEndpoint";
import type { NodeDto } from "../wasm/types";
import { splitSlotColor } from "../pixi/colorUtils";
import { canvas } from "../pixi/colorTokens";
import type { VectorByWallsSettings } from "../store/storeTypes";
import { buildTeleportEdges } from "../pixi/selectors/mazeSelectors";
import { DEFAULT_VECTOR_BY_WALLS_LINKS } from "../store/slices/parameterLinksDefaults";
import { DEFAULT_FLOOR_LABEL_SETTINGS } from "../store/slices/imageExportDefaults";
import { fieldOf } from "./fieldConfigFixtures";

// Minimal stand-in for Pixi v8's `Bounds` (`getRequiredExportMargin`'s pixel-accurate path only
// ever reads `.minX/.minY/.maxX/.maxY` and calls `.clone()`/`.addBounds()`) — same convention as
// `VectorByCorridorsRenderer.test.ts`'s own `FakeBounds`.
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

vi.mock("../pixi/selectors/mazeSelectors", () => ({
  buildMazeWalls: vi.fn(() => []),
  buildMazeMarkers: vi.fn(() => []),
  buildTeleportEdges: vi.fn(() => []),
  buildTeleportFloorInputs: vi.fn((opts: { unscopedEdges: unknown; allowOutOfField: boolean; fieldCells?: unknown }) => ({
    floorContext: { resolveNodeLevel: () => undefined, unscopedNodeById: new Map(), unscopedEdges: opts.unscopedEdges, activeFloorIndex: 0 },
    spread: { blockedCellsByFloor: new Map(), allowOutOfField: opts.allowOutOfField, ...(opts.fieldCells ? { fieldCells: opts.fieldCells } : {}) },
  })),
  buildClosedCells: vi.fn(() => []),
  buildSplitPassages: vi.fn(() => ({ passages: [], wallFaces: [], specialShapes: [] })),
  maxSplitNodeCount: vi.fn(() => 0),
  buildVerticalConnectionMarkers: vi.fn(() => []),
  buildTeleportAvoidanceWaypoints: vi.fn(() => []),
  selectNodeLevelResolver: vi.fn(() => () => undefined),
  selectVerticalPassagePairSet: vi.fn(() => new Set()),
  selectFloorScopedMaze: vi.fn((nodes: unknown[], edges: unknown[], _floors: unknown, _activeFloorId: unknown, start: number | null = null, finish: number | null = null) => ({
    nodes, edges, start, finish,
  })),
}));

vi.mock("../pixi/renderers/WallRenderer", () => ({
  WallRenderer: vi.fn().mockImplementation(function (this: { render: () => void; destroy: () => void }) {
    this.render = vi.fn();
    this.destroy = vi.fn();
  }),
  chainSegmentsAtSharedVertices: vi.fn(() => []),
}));

vi.mock("../pixi/renderers/CellFillRenderer", () => ({
  CellFillRenderer: vi.fn().mockImplementation(function (this: { render: () => void; destroy: () => void }) {
    this.render = vi.fn();
    this.destroy = vi.fn();
  }),
}));

vi.mock("../pixi/renderers/SplitJunctionRenderer", () => ({
  SplitJunctionRenderer: vi.fn().mockImplementation(function (this: { render: () => void; destroy: () => void }) {
    this.render = vi.fn();
    this.destroy = vi.fn();
  }),
  collectSplitWallPaths: vi.fn().mockReturnValue({ paths: [], noCapPoints: [] }),
}));

vi.mock("../pixi/renderers/TeleportRenderer", () => ({
  TeleportRenderer: vi.fn().mockImplementation(function (this: { render: () => void; destroy: () => void }) {
    this.render = vi.fn();
    this.destroy = vi.fn();
  }),
}));

vi.mock("../pixi/renderers/VerticalConnectionRenderer", () => ({
  VerticalConnectionRenderer: vi.fn().mockImplementation(function (this: { render: () => void; destroy: () => void }) {
    this.render = vi.fn();
    this.destroy = vi.fn();
  }),
}));

vi.mock("../pixi/renderers/WaypointsRenderer", () => ({
  WaypointsRenderer: vi.fn().mockImplementation(function (this: { render: () => void; destroy: () => void }) {
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

vi.mock("../pixi/renderers/RegionHighlightRenderer", () => ({
  RegionHighlightRenderer: vi.fn().mockImplementation(function (this: { render: () => void; clear: () => void; destroy: () => void }) {
    this.render = vi.fn();
    this.clear = vi.fn();
    this.destroy = vi.fn();
  }),
}));

let currentState: Record<string, unknown>;

vi.mock("../store/mazeStore", () => ({
  useMazeStore: {
    getState: vi.fn(() => currentState),
    subscribe: vi.fn((_cb: (state: unknown) => void) => {
      return () => {};
    }),
  },
}));

vi.mock("pixi.js", () => ({
  Container: vi.fn().mockImplementation(function (this: { addChild: () => void; addChildAt: () => void; removeChildren: () => unknown[]; destroy: () => void; visible: boolean; getLocalBounds: () => unknown }) {
    this.addChild = vi.fn();
    this.addChildAt = vi.fn();
    this.removeChildren = vi.fn(() => []);
    this.destroy = vi.fn();
    this.visible = false;
    // Empty by default (Infinity/-Infinity, pixi's own "nothing drawn" convention) — tests that
    // care about `getRequiredExportMargin`'s pixel-accurate path override this per-container.
    this.getLocalBounds = vi.fn(() => makeEmptyBounds());
  }),
  Graphics: vi.fn().mockImplementation(function (this: { clear: () => void; moveTo: () => unknown; lineTo: () => unknown; arcTo: () => unknown; quadraticCurveTo: () => unknown; bezierCurveTo: () => unknown; closePath: () => unknown; stroke: () => unknown; circle: () => unknown; poly: () => unknown; rect: () => unknown; fill: () => unknown; setStrokeStyle: () => unknown; addChild: () => void; removeChildren: () => unknown[]; destroy: () => void }) {
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
    this.addChild = vi.fn();
    this.removeChildren = vi.fn(() => []);
    this.destroy = vi.fn();
  }),
}));

const {
  VectorByWallsRenderer, BackgroundGridLayer,
  viewportWorldRect, buildWallStyle, buildOneWayStyle, buildTeleportLineStyle, buildEffectiveSplitNodeColors, buildMarkerStyle, resolveEffectiveEndpoints,
} = await import("../pixi/imageExport/VectorByWallsRenderer");

function baseSettings(overrides: Partial<VectorByWallsSettings> = {}): VectorByWallsSettings {
  return {
    floorLabel: DEFAULT_FLOOR_LABEL_SETTINGS,
    replaceTwoFloorElevatorsWithStairs: true,
    background: 0x111111,
    showGrid: true,
    gridColor: 0x222222,
    showInnerGrid: false,
    innerGridColor: 0x222222,
    floorColor: 0x333333,
    wallColor: 0x444444,
    randomWallColorMode: "off",
    wallJoin: "round",
    wallThickness: 3,
    oneWayPattern: "triangle",
    oneWayColor: 0x555555,
    oneWayGapWidth: 3,
    oneWaySize: 0.3,
    oneWayThickness: 4,
    oneWayJoin: "round",
    markerLayout: "auto", markerScale: 1,
    startMarker: { sizeAdaptation: 0, shape: "circle", cornerStyle: "miter", fillColor: 0, borderColor: 0, borderWidth: 0, gapWidth: 0, size: 0.225, text: "S" },
    finishMarker: { sizeAdaptation: 0, shape: "circle", cornerStyle: "miter", fillColor: 0, borderColor: 0, borderWidth: 0, gapWidth: 0, size: 0.225, text: "F" },
    teleportMarker: { sizeAdaptation: 0, cornerStyle: "miter", shape: "square", size: 0.3, fillColor: 0, borderColor: 0, borderWidth: 3, gapWidth: 0 },
    teleportConnectorColor: 0,
    teleportConnectorWidth: 3,
    teleportConnectorStyle: "straight",
    teleportAvoidFieldExit: false, teleportMergeMode: true,
    teleportArrowMode: "center",
    teleportArrowPeriod: 5,
    teleportArrowSize: 6,
    teleportConnectorGapWidth: 0,
    teleportFloorBadge: { sizeAdaptation: 0, shape: "circle", labelType: "arabic", cornerStyle: "round", gapWidth: 3, size: 0.16, fillColor: 0x123456, borderColor: 0x123456, borderWidth: 3, textColor: 0x123456, textFontWeight: "bold", textSize: 12, textMargin: 1 },
    teleportGroupCustomization: false,
    teleportGroupOverrides: {},
    verticalStyle: "abstract",
    twoWayPassageMarker: { sizeAdaptation: 0, shape: "square", cornerStyle: "round", fillColor: 0x33bbff, borderColor: 0x33bbff, borderWidth: 0, gapWidth: 3, size: 0.2, text: "" },
    oneWayPassageMarker: { sizeAdaptation: 0, shape: "square", cornerStyle: "round", fillColor: 0x111111, borderColor: 0x33bbff, borderWidth: 0, gapWidth: 3, size: 0.2, text: "" },
    elevatorMarker: { sizeAdaptation: 0, shape: "hexagon", cornerStyle: "round", fillColor: 0x9955ff, borderColor: 0x9955ff, borderWidth: 0, gapWidth: 3, size: 0.2, text: "" },
    twoWayArrowColor: 0x111111,
    twoWayArrowSize: 0.6,
    twoWayArrowStyle: "triangle",
    twoWayArrowCornerStyle: "round",
    oneWayArrowColor: 0x111111,
    oneWayArrowSize: 0.6,
    oneWayArrowStyle: "triangle",
    oneWayArrowCornerStyle: "round",
    elevatorArrowColor: 0x111111,
    elevatorArrowSize: 0.6,
    elevatorArrowStyle: "triangle",
    elevatorArrowCornerStyle: "round",
    decorativeStairsTwoWay: { sizeAdaptation: 0, lineColor: 0x33bbff, lineWidth: 3, size: 0.22 },
    decorativeStairsOneWay: { sizeAdaptation: 0, lineColor: 0x33bbff, lineWidth: 3, size: 0.22 },
    decorativeElevator: { sizeAdaptation: 0, lineColor: 0x9955ff, lineWidth: 3, size: 0.22 },
    decorativeStairsArrowColor: 0x111111,
    decorativeStairsArrowSize: 0.6,
    decorativeStairsOneWayArrowColor: 0x2a2a2a,
    decorativeStairsOneWayArrowSize: 0.6,
    elevatorBadges: { enabled: false, labelType: "arabic", size: 0.5, placement: "left_right", distance: 4, gap: 1, gapWidth: 0, cornerStyle: "round", evenDistribution: true, shape: "circle", fillColor: 0x555555, borderColor: 0x555555, borderWidth: 0, textColor: 0x666666, textFontWeight: "bold", textSize: 16.66, textMargin: 1 },
    splitNodeColors: [],
    splitSpecialShapes: false,
    markerIndex: { enabled: false, labelStyle: "roman", height: 14, offset: 0, cornerRadius: 1.2, width: 16, textSize: 10, textMargin: 1, gap: 0, fillColor: 0xf0c900, textColor: 0x333333, borderColor: 0x444444, borderColorFromMarker: false, borderWidthFromMarker: false, borderWidth: 0, textFontWeight: "bold", coverage: { singleFloorTeleport: true, crossFloorTeleport: true, verticalPassage: true, elevator: true } },
    cornerStyle: "round",
    markerSize: 0.16,
    markerBorderWidth: 3, markerShape: "circle", markerFillColor: 0, markerBorderColor: 0,
    gapWidth: 3, markerTextSize: 17, markerTextMargin: 1, markerTextFontWeight: "bold", floorLabelType: "letters",
    verticalCornerStyle: "round",
    verticalShape: "circle",
    verticalSize: 0.2,
    verticalBorderWidth: 0,
    verticalGapWidth: 3,
    verticalFillColor: 0x33bbff,
    verticalArrowColor: 0x111111,
    verticalArrowSize: 0.6,
    verticalArrowStyle: "triangle",
    verticalArrowCornerStyle: "round",
    verticalDecorativeLineColor: 0x33bbff,
    verticalDecorativeLineWidth: 3,
    verticalDecorativeSize: 0.22, verticalDecorativeSizeAdaptation: 0, verticalSizeAdaptation: 0, markerSizeAdaptation: 0,
    verticalDecorativeArrowSize: 0.75,
    links: DEFAULT_VECTOR_BY_WALLS_LINKS,
    ...overrides,
  };
}

const stableNodes: NodeDto[] = [];
const stableEdges: never[] = [];
const stableCfg = fieldOf("square", { shape: "rect", cols: 4, rows: 4 });

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    openCard: "image_export",
    nodes: stableNodes,
    edges: stableEdges,
    activeFieldConfig: stableCfg,
    vectorByWallsSettings: baseSettings(),
    vectorByWallsSectionsExpanded: {},
    start: null,
    finish: null,
    postEditMeta: null,
    postEditDraftSplitPoints: {},
    hoveredExportWarningKey: null,
    floors: [{ id: "floor_1", title: "Floor 1" }],
    activeFloorId: "floor_1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentState = baseState();
});

describe("viewportWorldRect", () => {
  it("inverts the viewport's screen-space offset and scale into world-space", () => {
    expect(viewportWorldRect({ x: 100, y: 50, w: 800, h: 600, scale: 2 })).toEqual({ x: -50, y: -25, w: 400, h: 300 });
  });
});

describe("buildWallStyle", () => {
  it("maps color/width straight through and derives cap from join", () => {
    expect(buildWallStyle(baseSettings({ wallColor: 0xabc, wallThickness: 7, wallJoin: "round" })))
      .toEqual({ color: 0xabc, width: 7, join: "round", cap: "round" });
  });

  it("derives a square cap for a miter join", () => {
    expect(buildWallStyle(baseSettings({ wallJoin: "miter" })).cap).toBe("square");
  });
});

describe("buildOneWayStyle", () => {
  it("maps pattern/color/gapWidth/thickness straight through", () => {
    const style = buildOneWayStyle(baseSettings({ oneWayPattern: "chevron", oneWayColor: 0xaaa, oneWayGapWidth: 5, oneWayThickness: 8 }));
    expect(style.pattern).toBe("chevron");
    expect(style.color).toBe(0xaaa);
    expect(style.gapWidth).toBe(5);
    expect(style.thickness).toBe(8);
  });

  it("mirrors floorColor as the gap color, independent of oneWayColor", () => {
    const style = buildOneWayStyle(baseSettings({ floorColor: 0xdead00, oneWayColor: 0xbeef00 }));
    expect(style.gapColor).toBe(0xdead00);
  });

  it("passes oneWaySize through unchanged — already in world-space px (GitHub issue #681)", () => {
    const style = buildOneWayStyle(baseSettings({ oneWaySize: 20 }));
    expect(style.size).toBe(20);
  });

  it("derives a square cap for a miter join, round for round", () => {
    expect(buildOneWayStyle(baseSettings({ oneWayJoin: "miter" })).cap).toBe("square");
    expect(buildOneWayStyle(baseSettings({ oneWayJoin: "round" })).cap).toBe("round");
  });
});

describe("buildTeleportLineStyle", () => {
  it("maps line-pattern settings straight through", () => {
    const style = buildTeleportLineStyle(baseSettings({
      teleportMarker: { sizeAdaptation: 0, cornerStyle: "round", shape: "star", size: 0.4, fillColor: 0x111, borderColor: 0x112, borderWidth: 5, gapWidth: 6 },
      teleportConnectorColor: 0x222,
      teleportConnectorWidth: 7,
      teleportConnectorStyle: "orthogonal",
      teleportArrowMode: "periodic",
      teleportArrowPeriod: 8,
      teleportArrowSize: 11,
      teleportConnectorGapWidth: 9,
    }), 0x999);
    expect(style).toEqual({
      shape: "star", cornerStyle: "round", size: 0.4, sizeAdaptation: 0, edgeColor: 0x111, edgeBorderColor: 0x112, borderWidth: 5, edgeGapWidth: 6,
      connectorColor: 0x222, connectorWidth: 7, connectorStyle: "orthogonal", curveDirection: "inward", curveStrength: 0.25,
      arrowMode: "periodic", arrowPeriod: 8, arrowSize: 11, connectorGapWidth: 9, floorColor: 0x999,
      floorBadge: { shape: "circle", cornerStyle: "round", gapWidth: 3, labelType: "arabic", size: 0.16, sizeAdaptation: 0, fillColor: 0x123456, borderColor: 0x123456, borderWidth: 3, textColor: 0x123456, textFontWeight: "bold", textSize: 12, textMargin: 1 },
    });
  });

  it("passes explicit curved connector settings through the shared renderer style", () => {
    const style = buildTeleportLineStyle(baseSettings({
      teleportConnectorStyle: "curved",
      teleportCurveDirection: "outward",
      teleportCurveStrength: 0.6,
    }), 0x999);
    expect(style).toMatchObject({ connectorStyle: "curved", curveDirection: "outward", curveStrength: 0.6 });
  });
});

describe("buildMarkerStyle", () => {
  it("spreads MarkerSettings straight through and sets gapColor to the given floorColor", () => {
    const settings = { shape: "star" as const, cornerStyle: "round" as const, fillColor: 0x111, borderColor: 0x222, borderWidth: 4, gapWidth: 3, size: 0.5, text: "S", sizeAdaptation: 0 };
    const style = buildMarkerStyle(settings, 0xdead00);
    expect(style).toEqual({ ...settings, gapColor: 0xdead00 });
  });

  it("gapColor tracks floorColor independently of the marker's own fillColor/borderColor", () => {
    const settings = { shape: "circle" as const, cornerStyle: "miter" as const, fillColor: 0xaaa, borderColor: 0xbbb, borderWidth: 0, gapWidth: 0, size: 0.225, text: "", sizeAdaptation: 0 };
    expect(buildMarkerStyle(settings, 0x111).gapColor).toBe(0x111);
    expect(buildMarkerStyle(settings, 0x222).gapColor).toBe(0x222);
  });
});

describe("buildEffectiveSplitNodeColors", () => {
  it("an untouched (empty) splitNodeColors falls back to splitSlotColor's own default palette — GitHub issue: colors mismatched panel vs. canvas until first edit", () => {
    const result = buildEffectiveSplitNodeColors([], 2);
    expect(result).toEqual([splitSlotColor(0, canvas.node.splitSlots), splitSlotColor(1, canvas.node.splitSlots)]);
  });

  it("a user-set slot overrides the default, untouched slots still fall back", () => {
    const result = buildEffectiveSplitNodeColors([0xabcdef], 3);
    expect(result).toEqual([0xabcdef, splitSlotColor(1, canvas.node.splitSlots), splitSlotColor(2, canvas.node.splitSlots)]);
  });

  it("returns at least splitNodeColors.length entries even when maxSplit is smaller (e.g. after a maze regenerate shrinks the point)", () => {
    const result = buildEffectiveSplitNodeColors([0x111, 0x222, 0x333], 1);
    expect(result).toEqual([0x111, 0x222, 0x333]);
  });
});

describe("resolveEffectiveEndpoints", () => {
  const nodes: NodeDto[] = [
    { id: 1, x: 0, y: 0, i: 0 },
    { id: 2, x: 1, y: 0, i: 0 },
    { id: 3, x: 2, y: 0, i: 0 },
  ];

  it("falls back to state.start/finish when post-edit was never confirmed", () => {
    expect(resolveEffectiveEndpoints({ nodes, start: 1, finish: 2, postEditMeta: null, postEditDraftSplitPoints: {} }))
      .toEqual({ start: 1, finish: 2 });
  });

  it("uses postEditMeta's endpoints once post-edit has confirmed, ignoring the stale generated start/finish — GitHub issue #303", () => {
    expect(resolveEffectiveEndpoints({
      nodes,
      start: 1,
      finish: 2,
      postEditMeta: { start: nodeEndpoint(3), finish: nodeEndpoint(2) },
      postEditDraftSplitPoints: {},
    })).toEqual({ start: 3, finish: 2 });
  });

  it("resolves a null postEditMeta endpoint (cleared marker) to null even though state.start/finish still holds the generated id", () => {
    expect(resolveEffectiveEndpoints({
      nodes,
      start: 1,
      finish: 2,
      postEditMeta: { start: null, finish: nodeEndpoint(2) },
      postEditDraftSplitPoints: {},
    })).toEqual({ start: null, finish: 2 });
  });

  it("resolves a split-endpoint start to its confirmed slot node, not the point's original node", () => {
    const splitNodes: NodeDto[] = [
      { id: 1, x: 0, y: 0, i: 0 },
      { id: 4, x: 0, y: 0, i: 1 }, // confirmed slot 7 at the same point
      { id: 2, x: 1, y: 0, i: 0 },
    ];
    expect(resolveEffectiveEndpoints({
      nodes: splitNodes,
      start: 1,
      finish: 2,
      postEditMeta: { start: splitEndpoint([0, 0], 7), finish: nodeEndpoint(2) },
      postEditDraftSplitPoints: { "0,0": [7] },
    })).toEqual({ start: 4, finish: 2 });
  });

  it("resolves an unconfirmed split-endpoint start to null rather than falling back to the stale generated id", () => {
    expect(resolveEffectiveEndpoints({
      nodes,
      start: 1,
      finish: 2,
      postEditMeta: { start: splitEndpoint([0, 0], 7), finish: nodeEndpoint(2) },
      postEditDraftSplitPoints: { "0,0": [7] },
    })).toEqual({ start: null, finish: 2 });
  });
});

describe("VectorByWallsRenderer", () => {
  it("uses the active floor's tessellation config for rendered geometry", () => {
    const secondFloorCfg = fieldOf("square", { shape: "rect", cols: 9, rows: 2 });
    currentState = baseState({
      floors: [{ id: "floor_1", title: "Floor 1" }, { id: "floor_2", title: "Floor 2" }],
      activeFloorId: "floor_2",
      activeFieldConfig: secondFloorCfg,
      floorFields: {
        floor_1: { fieldConfig: stableCfg },
        floor_2: { fieldConfig: secondFloorCfg },
      },
    });

    const renderer = new VectorByWallsRenderer({ addChild: vi.fn() } as never);
    const floor = (renderer as unknown as { floor: { render: ReturnType<typeof vi.fn> } }).floor;

    expect(floor.render).toHaveBeenCalledWith(expect.anything(), secondFloorCfg);
  });

  it("keeps the original background grid separate from the optional inner grid", () => {
    const nodes: NodeDto[] = [
      { id: 10, x: 0, y: 0, i: 0 },
      { id: 11, x: 2, y: -1, i: 0 },
    ];
    currentState = baseState({ nodes });
    const renderer = new VectorByWallsRenderer({ addChild: vi.fn() } as never);
    const asAny = renderer as unknown as {
      backgroundGrid: InstanceType<typeof BackgroundGridLayer>;
      innerGrid: { render: ReturnType<typeof vi.fn> };
    };
    const backgroundGrid = asAny.backgroundGrid;
    const background = (backgroundGrid as unknown as { grid: { render: ReturnType<typeof vi.fn> } }).grid;

    expect(background.render).toHaveBeenCalledWith(
      { viewport: { x: 0, y: 0, w: 0, h: 0, scale: 1 }, color: baseSettings().gridColor },
      stableCfg,
    );
    expect(asAny.innerGrid.render).not.toHaveBeenCalled();

    currentState = baseState({ nodes, vectorByWallsSettings: baseSettings({ showInnerGrid: true, innerGridColor: 0xabcdef }) });
    const innerRenderer = new VectorByWallsRenderer({ addChild: vi.fn() } as never);
    const innerGrid = (innerRenderer as unknown as { innerGrid: { render: ReturnType<typeof vi.fn> } }).innerGrid;
    expect(innerGrid.render).toHaveBeenCalledWith(
      { viewport: { x: 0, y: 0, w: 0, h: 0, scale: 1 }, color: 0xabcdef },
      stableCfg,
      [[0, 0], [2, -1]],
    );
  });

  it("getRequiredExportMargin returns zero margin when this maze has no nodes (nothing drawn)", () => {
    currentState = baseState();
    const renderer = new VectorByWallsRenderer({ addChild: vi.fn() } as never);
    expect(renderer.getRequiredExportMargin()).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
  });

  it("getRequiredExportMargin reads the actual drawn content's pixel bounds, not a settings-derived approximation (GitHub issue #324 follow-up)", () => {
    // TILE_SIZE=40, 3x3 grid — exactCellBounds for this grid is minX=0,minY=-120,maxX=120,maxY=0
    // (verified directly against the tessellation's own cell-polygon math).
    const nodes: NodeDto[] = [];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) nodes.push({ id: y * 3 + x, x, y, i: 0 });
    currentState = baseState({ nodes, activeFieldConfig: fieldOf("square", { shape: "rect", cols: 3, rows: 3 }) });
    const renderer = new VectorByWallsRenderer({ addChild: vi.fn() } as never);

    const asAny = renderer as unknown as {
      floorContainer: { getLocalBounds: () => FakeBounds };
      closedCellsContainer: { getLocalBounds: () => FakeBounds };
      wallsContainer: { getLocalBounds: () => FakeBounds };
      splitJunctionContainer: { getLocalBounds: () => FakeBounds };
      teleportContainer: { getLocalBounds: () => FakeBounds };
      markersContainer: { getLocalBounds: () => FakeBounds };
    };
    // Simulate a start marker's own bulge drawn past the floor fill's own bbox on the left edge
    // only (screen minX) — every other container stays at the plain cell-polygon bbox, the marker
    // pokes 15px past it on the left alone.
    asAny.floorContainer.getLocalBounds = () => makeBounds(0, -120, 120, 0);
    asAny.closedCellsContainer.getLocalBounds = () => makeEmptyBounds();
    asAny.wallsContainer.getLocalBounds = () => makeEmptyBounds();
    asAny.splitJunctionContainer.getLocalBounds = () => makeEmptyBounds();
    asAny.teleportContainer.getLocalBounds = () => makeEmptyBounds();
    asAny.markersContainer.getLocalBounds = () => makeBounds(-15, -120, 120, 0);

    const margin = renderer.getRequiredExportMargin();
    expect(margin).toEqual({ left: 15, right: 0, top: 0, bottom: 0 });
  });

  it("getBackgroundColor resolves to the mode's own configurable background", () => {
    currentState = baseState({ vectorByWallsSettings: baseSettings({ background: 0xabcdef }) });
    const renderer = new VectorByWallsRenderer({ addChild: vi.fn() } as never);
    expect(renderer.getBackgroundColor()).toBe(0xabcdef);
  });

  it("passes allowOutOfField to buildTeleportEdges as the negation of teleportAvoidFieldExit", () => {
    currentState = baseState({ vectorByWallsSettings: baseSettings({ teleportAvoidFieldExit: true }) });
    new VectorByWallsRenderer({ addChild: vi.fn() } as never);
    expect(buildTeleportEdges).toHaveBeenLastCalledWith(
      expect.any(Map), expect.any(Array), stableCfg,
      expect.any(Object),
      expect.objectContaining({ allowOutOfField: false }),
    );

    vi.mocked(buildTeleportEdges).mockClear();
    currentState = baseState({ vectorByWallsSettings: baseSettings({ teleportAvoidFieldExit: false }) });
    new VectorByWallsRenderer({ addChild: vi.fn() } as never);
    expect(buildTeleportEdges).toHaveBeenLastCalledWith(
      expect.any(Map), expect.any(Array), stableCfg,
      expect.any(Object),
      expect.objectContaining({ allowOutOfField: true }),
    );
  });

  it("wires cross-floor teleport badges and vertical-passage markers as always-on click-to-switch-floor (GitHub issue #478)", () => {
    currentState = baseState();
    const renderer = new VectorByWallsRenderer({ addChild: vi.fn() } as never);
    const teleports = (renderer as unknown as { teleports: { render: ReturnType<typeof vi.fn> } }).teleports;
    const verticalConnections = (renderer as unknown as { verticalConnections: { render: ReturnType<typeof vi.fn> } }).verticalConnections;
    expect(teleports.render).toHaveBeenCalledWith(expect.objectContaining({ floorNavigable: true }));
    expect(verticalConnections.render).toHaveBeenCalledWith(expect.objectContaining({ interactive: true }));
  });
});
