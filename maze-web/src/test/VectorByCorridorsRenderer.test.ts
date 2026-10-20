import { describe, it, expect, vi, beforeEach } from "vitest";
import { Graphics } from "pixi.js";
import { VectorByCorridorsRenderer, buildTeleportWidenMarkers, buildVerticalWidenMarkers, computeDiagonalGapPatchGeometry } from "../pixi/imageExport/VectorByCorridorsRenderer";
import { clipStrokeToConvexPolygon, computeMiterJunctionPatch, selectInwardJunctionWedge, corridorCellStep } from "../pixi/imageExport/vectorByCorridorsGeometry";
import { buildCorridorContour, contourToPolyline, type ContourPath, type PathCmd } from "../pixi/imageExport/vectorByCorridorsContour";
import { computeSquareCapPatch } from "../pixi/renderers/wallUtils";
import { buildCorridorSegments, shortestCorridorFaceAcrossFloors, buildMazeMarkers, buildTeleportEdges, buildSplitPassages } from "../pixi/selectors/mazeSelectors";
import { buildTeleportGroups } from "../pixi/selectors/teleportGroups";
import { buildVerticalConnectionStyle } from "../pixi/imageExport/exportStyleBuilders";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { VerticalConnectionMarker } from "../pixi/renderers/types";
import type { FieldConfig } from "../fieldConfig";
import { getCellVertices, pointInPolygon } from "../pixi/tessellationGeometry";
import type { VectorByCorridorsSettings } from "../store/storeTypes";
import { DEFAULT_VERTICAL_SETTINGS, DEFAULT_VERTICAL_SHARED_STYLE, DEFAULT_MARKER_INDEX_SETTINGS, DEFAULT_FLOOR_LABEL_SETTINGS } from "../store/slices/imageExportDefaults";
import { DEFAULT_VECTOR_BY_CORRIDORS_LINKS } from "../store/slices/parameterLinksDefaults";
import { fieldOf } from "./fieldConfigFixtures";

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

vi.mock("../pixi/selectors/mazeSelectors", () => ({
  buildCorridorSegments: vi.fn(() => []),
  shortestCorridorFaceAcrossFloors: vi.fn(() => Infinity),
  buildMazeMarkers: vi.fn(() => []),
  buildTeleportEdges: vi.fn(() => []),
  buildTeleportFloorInputs: vi.fn((opts: { unscopedEdges: unknown; allowOutOfField: boolean; fieldCells?: unknown }) => ({
    floorContext: { resolveNodeLevel: () => undefined, unscopedNodeById: new Map(), unscopedEdges: opts.unscopedEdges, activeFloorIndex: 0 },
    spread: { blockedCellsByFloor: new Map(), allowOutOfField: opts.allowOutOfField, ...(opts.fieldCells ? { fieldCells: opts.fieldCells } : {}) },
  })),
  buildSplitPassages: vi.fn(() => ({ passages: [], wallFaces: [], specialShapes: [] })),
  maxSplitNodeCount: vi.fn(() => 0),
  buildVerticalConnectionMarkers: vi.fn(() => []),
  buildTeleportAvoidanceWaypoints: vi.fn((sources: { markers?: { pos: [number, number] }[] }) => (sources.markers ?? []).map((m) => m.pos)),
  selectNodeLevelResolver: vi.fn(() => () => undefined),
  selectVerticalPassagePairSet: vi.fn(() => new Set()),
  selectFloorScopedMaze: vi.fn((nodes: unknown[], edges: unknown[], _floors: unknown, _activeFloorId: unknown, start: number | null = null, finish: number | null = null) => ({
    nodes, edges, start, finish,
  })),
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

vi.mock("../pixi/renderers/VerticalConnectionRenderer", () => ({
  VerticalConnectionRenderer: vi.fn().mockImplementation(function (this: { render: () => void; destroy: () => void }) {
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
  Graphics: vi.fn().mockImplementation(function (this: { clear: () => void; moveTo: () => unknown; lineTo: () => unknown; arcTo: () => unknown; arc: () => unknown; quadraticCurveTo: () => unknown; bezierCurveTo: () => unknown; closePath: () => unknown; stroke: () => unknown; circle: () => unknown; poly: () => unknown; rect: () => unknown; fill: () => unknown; setStrokeStyle: () => unknown; addChild: () => void; removeChildren: () => unknown[]; destroy: () => void }, context?: unknown) {
    this.clear = vi.fn();
    this.moveTo = vi.fn(() => this);
    this.lineTo = vi.fn(() => this);
    this.arcTo = vi.fn(() => this);
    this.arc = vi.fn(() => this);
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
    (this as unknown as { context: unknown }).context = context;
    (this as unknown as { position: { set: () => void } }).position = { set: vi.fn() };
  }),
  GraphicsContext: vi.fn().mockImplementation(function (this: { moveTo: () => unknown; lineTo: () => unknown; arc: () => unknown; quadraticCurveTo: () => unknown; bezierCurveTo: () => unknown; closePath: () => unknown; fill: () => unknown; destroy: () => void }) {
    this.moveTo = vi.fn(() => this);
    this.lineTo = vi.fn(() => this);
    this.arc = vi.fn(() => this);
    this.quadraticCurveTo = vi.fn(() => this);
    this.bezierCurveTo = vi.fn(() => this);
    this.closePath = vi.fn(() => this);
    this.fill = vi.fn(() => this);
    (this as unknown as { stroke: () => unknown }).stroke = vi.fn(() => this);
    (this as unknown as { circle: () => unknown }).circle = vi.fn(() => this);
    this.destroy = vi.fn();
  }),
}));

const startMarker: VectorByCorridorsSettings["startMarker"] = { shape: "circle", cornerStyle: "miter", fillColor: 0, borderColor: 0, borderWidth: 0, gapWidth: 0, size: 0.1, text: "S" };
const finishMarker: VectorByCorridorsSettings["finishMarker"] = { shape: "circle", cornerStyle: "miter", fillColor: 0, borderColor: 0, borderWidth: 0, gapWidth: 0, size: 0.1, text: "F" };
const teleportDefaults: Pick<VectorByCorridorsSettings,
  "teleportMarker" | "teleportConnectorColor" | "teleportConnectorWidth" | "teleportConnectorStyle" |
  "teleportAvoidFieldExit" | "teleportArrowMode" | "teleportArrowPeriod" | "teleportArrowSize" | "teleportConnectorGapWidth" |
  "teleportFloorBadge" | "teleportGroupCustomization" | "teleportGroupOverrides"
> = {
  teleportMarker: { cornerStyle: "miter", shape: "diamond", size: 0.16, fillColor: 0, borderColor: 0, borderWidth: 3, gapWidth: 3 },
  teleportConnectorColor: 0, teleportConnectorWidth: 3, teleportConnectorStyle: "orthogonal", teleportAvoidFieldExit: false,
  teleportArrowMode: "periodic", teleportArrowPeriod: 5, teleportArrowSize: 10, teleportConnectorGapWidth: 3,
  teleportFloorBadge: { shape: "circle", labelType: "arabic", cornerStyle: "round", gapWidth: 3, size: 0.16, fillColor: 0x123456, borderColor: 0x123456, borderWidth: 3, textColor: 0x123456, textFontWeight: "bold", textSize: 12, textMargin: 1 },
  teleportGroupCustomization: false, teleportGroupOverrides: {},
};
const oneWayDefaults: Pick<VectorByCorridorsSettings, "oneWayColor" | "oneWayCount" | "oneWayThickness" | "oneWayGap" | "oneWayWidth" | "oneWayLength" | "oneWayJoin"> = {
  oneWayColor: 0, oneWayCount: 1, oneWayThickness: 4, oneWayGap: 4, oneWayWidth: 1, oneWayLength: 10, oneWayJoin: "round",
};
const splitDefaults: Pick<VectorByCorridorsSettings, "splitNodeColors" | "splitSpecialShapes" | "splitGapWidth" | "splitDiagonalBowAmount"> = {
  splitNodeColors: [], splitSpecialShapes: true, splitGapWidth: 3, splitDiagonalBowAmount: 0.15,
};
const sharedStyleSource = { markerShape: "circle" as const, markerFillColor: 0, markerBorderColor: 0, cornerStyle: "round" as const, markerSize: 0.16, markerBorderWidth: 3, gapWidth: 3, markerTextSize: 17, markerTextMargin: 1, markerTextFontWeight: "bold" as const, floorLabelType: "letters" as const };
const settingsA: VectorByCorridorsSettings = { background: 0x000000, showGrid: true, gridColor: 0x333333, color: 0x111111, thickness: 10, junctionRadius: 4, join: "round", renderStyle: "contour", startMarker, finishMarker, markerWidenPadding: 4, markerWidenShape: "match_marker", ...oneWayDefaults, ...teleportDefaults, ...DEFAULT_VERTICAL_SETTINGS, ...DEFAULT_VERTICAL_SHARED_STYLE, ...splitDefaults, markerIndex: DEFAULT_MARKER_INDEX_SETTINGS, floorLabel: DEFAULT_FLOOR_LABEL_SETTINGS, ...sharedStyleSource, links: DEFAULT_VECTOR_BY_CORRIDORS_LINKS };
const settingsB: VectorByCorridorsSettings = { background: 0x000000, showGrid: true, gridColor: 0x333333, color: 0x222222, thickness: 20, junctionRadius: 4, join: "miter", renderStyle: "contour", startMarker, finishMarker, markerWidenPadding: 4, markerWidenShape: "match_marker", ...oneWayDefaults, ...teleportDefaults, ...DEFAULT_VERTICAL_SETTINGS, ...DEFAULT_VERTICAL_SHARED_STYLE, ...splitDefaults, markerIndex: DEFAULT_MARKER_INDEX_SETTINGS, floorLabel: DEFAULT_FLOOR_LABEL_SETTINGS, ...sharedStyleSource, links: DEFAULT_VECTOR_BY_CORRIDORS_LINKS };

// Stable references reused across `baseState()` calls — the renderer's own geometry cache keys off
// reference-equality of `nodes`/`edges`/`activeFieldConfig` (same convention as
// `VectorByWallsRenderer`'s own cache), so a fresh literal on every call would look like a data
// change even when a test means to vary only `vectorByCorridorsSettings`.
const stableNodes: NodeDto[] = [];
const stableEdges: EdgeDto[] = [];
const stableCfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 4, rows: 4 });

const stableFloors = [{ id: "floor_1", title: "Floor 1" }];

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    openCard: "image_export",
    nodes: stableNodes,
    edges: stableEdges,
    activeFieldConfig: stableCfg,
    vectorByCorridorsSettings: settingsA,
    vectorByCorridorsSectionsExpanded: {},
    floors: stableFloors,
    activeFloorId: "floor_1",
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

  it("uses the base teleportMarker.shape/cornerStyle/border/gap when group customization is off", () => {
    const [marker] = buildTeleportWidenMarkers([{ from: [0, 0], to: [1, 1], oneWay: false }], settingsA, []);
    expect(marker.shape).toBe(settingsA.teleportMarker.shape);
    expect(marker.cornerStyle).toBe(settingsA.teleportMarker.cornerStyle);
    expect(marker.borderWidth).toBe(settingsA.teleportMarker.borderWidth);
    expect(marker.gapWidth).toBe(settingsA.teleportMarker.gapWidth);
    expect(marker.radius).toBe(settingsA.teleportMarker.size / 2);
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
    expect(marker.shape).toBe(settingsA.teleportMarker.shape);
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
    expect(marker.shape).toBe(settingsA.teleportMarker.shape);
  });

  it("returns an empty list for no teleport edges", () => {
    expect(buildTeleportWidenMarkers([], settingsA, [])).toEqual([]);
  });

  it("gives a badge widen marker teleportFloorBadge.shape, not teleportMarker.shape (GitHub issue #485)", () => {
    const settings: VectorByCorridorsSettings = {
      ...settingsA,
      teleportMarker: { ...settingsA.teleportMarker, shape: "square" },
      teleportFloorBadge: { ...settingsA.teleportFloorBadge, shape: "hexagon" },
    };
    const markers = buildTeleportWidenMarkers(
      [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 1 }],
      settings,
      [],
    );
    const badge = markers.find((m) => m.pos[0] === 10 && m.pos[1] === 10);
    const real = markers.find((m) => m.pos[0] === 0 && m.pos[1] === 0);
    // The badge marker carries the badge's own shape/corners; `markerWidenShape` still governs the
    // actual patch shape in `drawMarkerWidenPatches` (copied only under `"match_marker"`).
    expect(badge?.shape).toBe("hexagon");
    expect(badge?.cornerStyle).toBe("round");
    expect(real?.shape).toBe("square");
  });

  it("sizes a badge widen patch to teleportFloorBadge.size, not teleportMarker.size (GitHub issue #485)", () => {
    const settings: VectorByCorridorsSettings = {
      ...settingsA,
      teleportMarker: { ...settingsA.teleportMarker, size: 0.16 },
      teleportFloorBadge: { ...settingsA.teleportFloorBadge, size: 0.4 },
    };
    const [real, badge] = buildTeleportWidenMarkers(
      [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 1 }],
      settings,
      [],
    );
    expect(real.radius).toBe(0.16 / 2);
    expect(badge.radius).toBe(0.4 / 2);
  });

  it("shapes a fromFloor-tagged badge endpoint patch as teleportFloorBadge.shape too", () => {
    const settings: VectorByCorridorsSettings = {
      ...settingsA,
      teleportMarker: { ...settingsA.teleportMarker, shape: "square" },
      teleportFloorBadge: { ...settingsA.teleportFloorBadge, shape: "diamond" },
    };
    const [badge] = buildTeleportWidenMarkers(
      [{ from: [0, 0], to: [10, 10], oneWay: true, fromFloor: 1 }],
      settings,
      [],
    );
    expect(badge.pos).toEqual([0, 0]);
    expect(badge.shape).toBe("diamond");
  });

  it("ignores a group override shape for a badge endpoint (uses teleportFloorBadge.shape)", () => {
    const settings: VectorByCorridorsSettings = {
      ...settingsA,
      teleportGroupCustomization: true,
      teleportGroupOverrides: { "0-1": { shape: "square" } },
      teleportFloorBadge: { ...settingsA.teleportFloorBadge, shape: "pentagon" },
    };
    const edges = [{ from: [0, 0] as [number, number], to: [10, 10] as [number, number], oneWay: true, fromNode: 0, toNode: 1, toFloor: 1 }];
    const [, badge] = buildTeleportWidenMarkers(edges, settings, buildTeleportGroups(edges));
    expect(badge.pos).toEqual([10, 10]);
    expect(badge.shape).toBe("pentagon");
  });
});

describe("selectInwardJunctionWedge", () => {
  it("keeps the wedge furthest toward the tile interior", () => {
    const rays = [
      { dir: { x: -1, y: -1 }, width: 10 },
      { dir: { x: 1, y: 0 }, width: 10 },
    ];
    const wedges = computeMiterJunctionPatch(rays);
    expect(wedges).toHaveLength(2);
    const inward = { x: 0, y: 1 };
    const score = (wedge: (typeof wedges)[number]) => wedge.points.reduce(
      (sum, point) => sum + point.x * inward.x + point.y * inward.y,
      0,
    );
    const selected = selectInwardJunctionWedge(rays, inward);
    expect(selected).not.toBeNull();
    expect(score(selected!)).toBe(Math.max(...wedges.map(score)));
  });
});

describe("buildVerticalWidenMarkers", () => {
  function makeMarker(overrides: Partial<VerticalConnectionMarker>): VerticalConnectionMarker {
    return { pos: [0, 0], fromNode: 0, kind: "vertical_passage", filled: true, arrowFilled: true, ...overrides };
  }

  it("uses elevatorMarker's size/shape/cornerStyle for an elevator marker", () => {
    const [marker] = buildVerticalWidenMarkers([makeMarker({ kind: "elevator" })], settingsA);
    expect(marker.radius).toBe(settingsA.elevatorMarker.size / 2);
    expect(marker.shape).toBe(settingsA.elevatorMarker.shape);
    expect(marker.cornerStyle).toBe(settingsA.elevatorMarker.cornerStyle);
    expect(marker.borderWidth).toBe(settingsA.elevatorMarker.borderWidth);
    expect(marker.gapWidth).toBe(settingsA.elevatorMarker.gapWidth);
  });

  it("uses twoWayPassageMarker's size/shape/cornerStyle for a filled vertical_passage marker", () => {
    const [marker] = buildVerticalWidenMarkers([makeMarker({ kind: "vertical_passage", filled: true })], settingsA);
    expect(marker.radius).toBe(settingsA.twoWayPassageMarker.size / 2);
    expect(marker.shape).toBe(settingsA.twoWayPassageMarker.shape);
    expect(marker.cornerStyle).toBe(settingsA.twoWayPassageMarker.cornerStyle);
    expect(marker.borderWidth).toBe(settingsA.twoWayPassageMarker.borderWidth);
    expect(marker.gapWidth).toBe(settingsA.twoWayPassageMarker.gapWidth);
  });

  it("uses oneWayPassageMarker's size/shape/cornerStyle for an unfilled vertical_passage marker", () => {
    const [marker] = buildVerticalWidenMarkers([makeMarker({ kind: "vertical_passage", filled: false })], settingsA);
    expect(marker.radius).toBe(settingsA.oneWayPassageMarker.size / 2);
    expect(marker.shape).toBe(settingsA.oneWayPassageMarker.shape);
    expect(marker.cornerStyle).toBe(settingsA.oneWayPassageMarker.cornerStyle);
    expect(marker.borderWidth).toBe(settingsA.oneWayPassageMarker.borderWidth);
    expect(marker.gapWidth).toBe(settingsA.oneWayPassageMarker.gapWidth);
  });

  it("carries the resolved marker's own borderWidth/gapWidth through (GitHub issue #551)", () => {
    const [marker] = buildVerticalWidenMarkers([makeMarker({ kind: "elevator" })], settingsA);
    expect(marker.borderWidth).toBe(settingsA.elevatorMarker.borderWidth);
    expect(marker.gapWidth).toBe(settingsA.elevatorMarker.gapWidth);
  });

  it("carries each marker's own pos through unchanged", () => {
    const markers = [makeMarker({ pos: [3, 4] }), makeMarker({ pos: [5, 6], kind: "elevator" })];
    expect(buildVerticalWidenMarkers(markers, settingsA).map((m) => m.pos)).toEqual([[3, 4], [5, 6]]);
  });

  it("returns an empty list for no markers", () => {
    expect(buildVerticalWidenMarkers([], settingsA)).toEqual([]);
  });
});

describe("buildVerticalConnectionStyle (Vector by corridors call site, no decorative arg)", () => {
  it("always resolves style to 'abstract' when called without a third (decorative) argument", () => {
    const style = buildVerticalConnectionStyle(settingsA, settingsA.color);
    expect(style.style).toBe("abstract");
  });

  it("carries the caller's own marker/arrow settings through unchanged", () => {
    const style = buildVerticalConnectionStyle(settingsA, settingsA.color);
    expect(style.twoWayArrowColor).toBe(settingsA.twoWayArrowColor);
    expect(style.elevatorArrowStyle).toBe(settingsA.elevatorArrowStyle);
    expect(style.elevatorBadges).toBe(settingsA.elevatorBadges);
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

  it("keeps bridge gap ends independent when clipping a strip to a skewed cell", () => {
    const cell = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 80, y: 100 }, { x: 10, y: 100 }];
    const clipped = clipStrokeToConvexPolygon({ x: 0, y: 50 }, { x: 100, y: 50 }, 40, cell, 1);
    expect(clipped).not.toBeNull();
    const minX = Math.min(...clipped!.map((point) => point.x));
    const maxX = Math.max(...clipped!.map((point) => point.x));
    expect(minX).toBeGreaterThan(0);
    expect(maxX).toBeLessThan(100);
    expect(minX).not.toBeCloseTo(100 - maxX, 5);
  });
});

describe("corridorCellStep", () => {
  it("returns the shortest full-length segment as the grid step", () => {
    const segs = [
      { v0: { x: 0, y: 0 }, v1: { x: 40, y: 0 } },
      { v0: { x: 40, y: 0 }, v1: { x: 40, y: 69.3 } },
    ];
    expect(corridorCellStep(segs, 40)).toBeCloseTo(40, 5);
  });

  it("ignores split-touching segments (they stop at a face midpoint, ~half a step)", () => {
    const segs = [
      { v0: { x: 0, y: 0 }, v1: { x: 69.3, y: 0 } },
      { v0: { x: 69.3, y: 0 }, v1: { x: 104, y: 0 }, v1TouchesSplit: true }, // ~half step
    ];
    expect(corridorCellStep(segs, 40)).toBeCloseTo(69.3, 5);
  });

  it("falls back to the given value when no full segment survives", () => {
    expect(corridorCellStep([], 40)).toBe(40);
    expect(corridorCellStep([{ v0: { x: 1, y: 1 }, v1: { x: 1, y: 1 } }], 40)).toBe(40);
  });
});

const allPts = (paths: ContourPath[]): { x: number; y: number }[] => paths.flatMap((p) => contourToPolyline(p));

describe("buildCorridorContour", () => {
  it("returns nothing for no segments", () => {
    expect(buildCorridorContour([], 10)).toEqual([]);
  });

  // The contour is now built per tile: one closed, non-hole path for every cell that has a passage,
  // shapes meeting edge-to-edge on shared borders (the per-tile rework). No path is ever a hole.
  const arcsOf = (paths: ContourPath[]): { c: { x: number; y: number }; r: number }[] =>
    paths.flatMap((p) => p.cmds).filter((c): c is Extract<PathCmd, { kind: "arc" }> => c.kind === "arc");
  const smoothCurvesOf = (paths: ContourPath[]) =>
    paths.flatMap((p) => p.cmds).filter((c) => c.kind === "quadratic" || c.kind === "bezier");
  const pointDistance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);
  const expectContinuousPath = (path: ContourPath) => {
    let current: { x: number; y: number } | null = null;
    for (const [index, cmd] of path.cmds.entries()) {
      if (cmd.kind === "move") {
        current = cmd.to;
      } else if (cmd.kind === "line") {
        current = cmd.to;
      } else if (cmd.kind === "quadratic") {
        current = cmd.to;
      } else if (cmd.kind === "bezier") {
        current = cmd.to;
      } else {
        const start = { x: cmd.c.x + Math.cos(cmd.a0) * cmd.r, y: cmd.c.y + Math.sin(cmd.a0) * cmd.r };
        const end = { x: cmd.c.x + Math.cos(cmd.a1) * cmd.r, y: cmd.c.y + Math.sin(cmd.a1) * cmd.r };
        expect(current).not.toBeNull();
        expect(pointDistance(current!, start), `disconnected arc at command ${index}`).toBeLessThan(1e-6);
        current = end;
      }
    }
  };

  it("draws a straight corridor tile by tile, no bulge past the walls", () => {
    // Three cells in a row (step 40), corridor width 20.
    const paths = buildCorridorContour(
      [{ v0: { x: 0, y: 0 }, v1: { x: 40, y: 0 } }, { v0: { x: 40, y: 0 }, v1: { x: 80, y: 0 } }],
      20,
    );
    expect(paths.length).toBe(3);
    expect(paths.some((p) => p.hole)).toBe(false);
    // The middle (straight-through) tile never crosses y = +-10.
    const midYs = allPts([paths[1]]).map((p) => p.y);
    expect(Math.min(...midYs)).toBeGreaterThanOrEqual(-10.01);
    expect(Math.max(...midYs)).toBeLessThanOrEqual(10.01);
  });

  it("emits one path per tile for an S-bend, all finite, none a hole", () => {
    const segs = [
      { v0: { x: 0, y: 0 }, v1: { x: 40, y: 0 } },
      { v0: { x: 40, y: 0 }, v1: { x: 40, y: 40 } },
      { v0: { x: 40, y: 40 }, v1: { x: 80, y: 40 } },
    ];
    const paths = buildCorridorContour(segs, 20);
    expect(paths.length).toBe(4); // two dead ends + two turns
    expect(paths.some((p) => p.hole)).toBe(false);
    for (const p of allPts(paths)) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("keeps diagonal segment-adapter output finite", () => {
    const dir = { x: Math.cos(Math.PI / 6), y: Math.sin(Math.PI / 6) }; // 30deg stub axis
    const centre = { x: 0, y: 0 };
    const border = { x: dir.x * 30, y: dir.y * 30 };
    for (const thickness of [7, 8, 8.5, 9, 10, 11, 13, 14, 17, 20, 23, 40]) {
      const paths = buildCorridorContour([{ v0: centre, v1: border }], thickness);
      for (const path of paths) {
        expect(path.hole).toBe(false);
        expectContinuousPath(path);
      }
      for (const point of allPts(paths)) {
        expect(Number.isFinite(point.x)).toBe(true);
        expect(Number.isFinite(point.y)).toBe(true);
      }
    }
  });

  it("builds a 90-degree turn tile with smooth offset rails (#493)", () => {
    // Middle cell of an L (step 40): passages west and north, corridor width 20.
    const paths = buildCorridorContour(
      [{ v0: { x: 0, y: 0 }, v1: { x: 40, y: 0 } }, { v0: { x: 40, y: 0 }, v1: { x: 40, y: 40 } }],
      20,
    );
    const turn = paths[1]; // the turn tile (centre 40,0)
    // The universal contour renderer uses tangent-controlled smooth segments per rail. This keeps
    // both rails tied to the same centreline construction without tangent-intersection kinks.
    expect(smoothCurvesOf([turn]).length).toBeGreaterThan(2);
    // And the bend stays inside the tile — no bulge past its borders.
    const pts = allPts([turn]);
    expect(Math.min(...pts.map((p) => p.x))).toBeGreaterThanOrEqual(19.99);
    expect(Math.min(...pts.map((p) => p.y))).toBeGreaterThanOrEqual(-10.02);
  });

  it("builds a 120-degree hex turn tile with smooth offset rails (#493)", () => {
    // Hex step 60: passages at 0deg and at 120deg from a shared centre.
    const c = { x: 0, y: 0 };
    const a = { x: 60, y: 0 };
    const b = { x: -30, y: 51.96 };
    const paths = buildCorridorContour(
      [{ v0: a, v1: c }, { v0: c, v1: b }],
      20,
    );
    const turn = paths.find((p) => smoothCurvesOf([p]).length > 2)!;
    expect(turn).toBeDefined();
    expect(smoothCurvesOf([turn]).length).toBeGreaterThan(2);
  });

  it("draws a closed loop as four turn tiles, none a hole", () => {
    const p = [
      { x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 60 }, { x: 0, y: 60 },
    ];
    const segs = [
      { v0: p[0], v1: p[1] }, { v0: p[1], v1: p[2] },
      { v0: p[2], v1: p[3] }, { v0: p[3], v1: p[0] },
    ];
    const paths = buildCorridorContour(segs, 12);
    expect(paths.length).toBe(4);
    expect(paths.some((p) => p.hole)).toBe(false);
    // Every tile is a turn with smooth tangent-controlled segments on both rails.
    for (const path of paths) expect(smoothCurvesOf([path]).length).toBeGreaterThan(2);
  });

  it("draws a T-junction as one path per tile, none a hole", () => {
    const segs = [
      { v0: { x: 0, y: 0 }, v1: { x: 40, y: 0 } },
      { v0: { x: 40, y: 0 }, v1: { x: 80, y: 0 } },
      { v0: { x: 40, y: 0 }, v1: { x: 40, y: 40 } },
    ];
    const paths = buildCorridorContour(segs, 12);
    expect(paths.length).toBe(4); // three dead ends + the junction tile
    expect(paths.some((p) => p.hole)).toBe(false);
    const junction = paths.reduce((a, b) => (b.cmds.length > a.cmds.length ? b : a));
    expect(junction.cmds.length).toBeGreaterThan(2);
    for (const p of allPts(paths)) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("keeps a hex junction on 3 adjacent faces continuous at every width", () => {
    const c = { x: 0, y: 0 };
    const nb = (deg: number) => ({ x: 60 * Math.cos((deg * Math.PI) / 180), y: 60 * Math.sin((deg * Math.PI) / 180) });
    for (const h of [8, 12, 16, 20, 22]) {
      const paths = buildCorridorContour(
        [{ v0: c, v1: nb(0) }, { v0: c, v1: nb(60) }, { v0: c, v1: nb(120) }],
        h * 2,
      );
      const junction = paths.reduce((a, b) => (b.cmds.length > a.cmds.length ? b : a));
      expectContinuousPath(junction);
      for (const p of contourToPolyline(junction)) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
    }
  });

  it("draws a 4-way junction as one path per tile, none a hole (#493)", () => {
    const c = { x: 40, y: 40 };
    const segs = [
      { v0: c, v1: { x: 0, y: 40 } },
      { v0: c, v1: { x: 80, y: 40 } },
      { v0: c, v1: { x: 40, y: 0 } },
      { v0: c, v1: { x: 40, y: 80 } },
    ];
    const paths = buildCorridorContour(segs, 20);
    expect(paths.length).toBe(5); // four dead ends + the centre junction
    expect(paths.some((p) => p.hole)).toBe(false);
    const junction = paths.reduce((a, b) => (b.cmds.length > a.cmds.length ? b : a));
    expectContinuousPath(junction);
  });

  it("junctionRadius 0 leaves junction corners sharp; the default radius rounds them", () => {
    const segs = [
      { v0: { x: 0, y: 0 }, v1: { x: 40, y: 0 } },
      { v0: { x: 40, y: 0 }, v1: { x: 80, y: 0 } },
      { v0: { x: 40, y: 0 }, v1: { x: 40, y: 40 } },
    ];
    const junctionOf = (paths: ContourPath[]) => paths.reduce((a, b) => (b.cmds.length > a.cmds.length ? b : a));
    const rounded = junctionOf(buildCorridorContour(segs, 12));
    const sharp = junctionOf(buildCorridorContour(segs, 12, 0));
    expect(arcsOf([sharp])).toHaveLength(0);
    expect(arcsOf([rounded]).length).toBeGreaterThan(0);
  });
});

describe("VectorByCorridorsRenderer", () => {
  // The corridor network is drawn as per-cell tiles sharing one `GraphicsContext` per tile shape
  // (GitHub issue #736). Tile contexts are traced around the cell centre in white; the tile's own
  // `tint` carries the corridor color.
  type MockFn = ReturnType<typeof vi.fn>;
  type TileContext = { moveTo: MockFn; lineTo: MockFn; closePath: MockFn; fill: MockFn; stroke: MockFn; circle: MockFn };
  type Tile = { key: string; offset: { x: number; y: number }; graphics: { tint: number; context: TileContext } };
  const tilesOf = (renderer: VectorByCorridorsRenderer): Tile[] =>
    [...(renderer as unknown as { corridorTiles: { tiles: Map<unknown, Tile> } }).corridorTiles.tiles.values()];
  const tileAt = (renderer: VectorByCorridorsRenderer, p: { x: number; y: number }): Tile => {
    const tile = tilesOf(renderer).find((t) => t.offset.x === p.x && t.offset.y === p.y);
    expect(tile, `tile at ${p.x},${p.y}`).toBeDefined();
    return tile!;
  };
  const corridorsOf = (renderer: VectorByCorridorsRenderer) =>
    (renderer as unknown as { corridors: { stroke: MockFn; fill: MockFn; circle: MockFn } }).corridors;
  const turn = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) => {
    vi.mocked(buildCorridorSegments).mockReturnValueOnce([
      { v0: a, v1: b, fromNode: 1, toNode: 2 },
      { v0: b, v1: c, fromNode: 2, toNode: 3 },
    ] as never);
  };

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

    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    const internals = renderer as unknown as {
      backgroundGrid: { render: (settings: VectorByCorridorsSettings, cfg: FieldConfig) => void };
      renderAll: (state: typeof currentState) => void;
    };
    const renderGrid = vi.spyOn(internals.backgroundGrid, "render");
    internals.renderAll(currentState);

    expect(renderGrid).toHaveBeenCalledWith(settingsA, secondFloorCfg);
  });

  it("round contour style fills one tinted contour tile per cell (no per-segment stroke)", () => {
    turn({ x: 0, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 80 });
    currentState = baseState({ vectorByCorridorsSettings: settingsA }); // join: "round"
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    const tiles = tilesOf(renderer);
    expect(tiles).toHaveLength(3);
    for (const tile of tiles) {
      expect(tile.key.startsWith("contour/")).toBe(true);
      expect(tile.graphics.tint).toBe(settingsA.color);
      expect(tile.graphics.context.closePath).toHaveBeenCalled();
      expect(tile.graphics.context.fill).toHaveBeenCalledWith(0xffffff);
      expect(tile.graphics.context.stroke).not.toHaveBeenCalled();
    }
    expect(corridorsOf(renderer).stroke).not.toHaveBeenCalled();
  });

  it("clamps the contour width to the shortest passage face of the whole maze, across floors", () => {
    turn({ x: 0, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 80 });
    vi.mocked(shortestCorridorFaceAcrossFloors).mockReturnValue(6);
    currentState = baseState({ vectorByCorridorsSettings: settingsA }); // thickness 10
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    for (const tile of tilesOf(renderer)) expect(tile.key.startsWith("contour/3/")).toBe(true);
    vi.mocked(shortestCorridorFaceAcrossFloors).mockReturnValue(Infinity);
  });

  it("does not recompute the maze-wide face limit when only the thickness changes", () => {
    new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    vi.mocked(shortestCorridorFaceAcrossFloors).mockClear();
    subscribeCallback?.(baseState({ vectorByCorridorsSettings: settingsB }));
    expect(shortestCorridorFaceAcrossFloors).not.toHaveBeenCalled();
  });

  it("shares one context per tile shape, recolors by tint and updates only changed cells", () => {
    // A straight 4-cell run: two dead ends (mirror shapes) and two identical straight tiles.
    const pts = [0, 40, 80, 120].map((x) => ({ x, y: 20 }));
    const segs = [0, 1, 2].map((i) => ({ v0: pts[i], v1: pts[i + 1], fromNode: i + 1, toNode: i + 2 }));
    vi.mocked(buildCorridorSegments).mockReturnValueOnce(segs as never);
    currentState = baseState({ vectorByCorridorsSettings: settingsA });
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    const before = new Map(tilesOf(renderer).map((tile) => [tile.offset.x, tile.graphics]));
    expect(before.size).toBe(4);
    expect(new Set([...before.values()].map((g) => g.context)).size).toBe(3);
    expect(before.get(40)!.context).toBe(before.get(80)!.context);

    // Same maze data, new color: the geometry cache hits, so the tiles are only re-tinted.
    const renderAll = (state: unknown) => (renderer as unknown as { renderAll: (state: unknown) => void }).renderAll(state);
    renderAll({ ...currentState, vectorByCorridorsSettings: { ...settingsA, color: 0xabcdef } });
    for (const tile of tilesOf(renderer)) {
      expect(tile.graphics).toBe(before.get(tile.offset.x));
      expect(tile.graphics.tint).toBe(0xabcdef);
    }

    // Extend the run by one cell: untouched cells keep their objects, the former dead end at 120
    // switches to the shared straight context in place, and only the new cell is created.
    const extended = [...pts, { x: 160, y: 20 }];
    vi.mocked(buildCorridorSegments).mockReturnValueOnce([0, 1, 2, 3].map((i) => ({ v0: extended[i], v1: extended[i + 1], fromNode: i + 1, toNode: i + 2 })) as never);
    renderAll({ ...currentState, nodes: [...(currentState.nodes as unknown[])], vectorByCorridorsSettings: { ...settingsA, color: 0xabcdef } });
    const after = new Map(tilesOf(renderer).map((tile) => [tile.offset.x, tile.graphics]));
    expect(after.size).toBe(5);
    for (const x of [0, 40, 80, 120]) expect(after.get(x)).toBe(before.get(x));
    expect(after.get(120)!.context).toBe(before.get(40)!.context);
    expect(after.get(160)!.tint).toBe(0xabcdef);
  });

  it("round contour style still renders a corridor whose far end touches a split point (drawSplitPassages owns that end)", () => {
    vi.mocked(buildCorridorSegments).mockReturnValueOnce([{
      v0: { x: 0, y: 20 }, v1: { x: 40, y: 20 }, fromNode: 1, toNode: 2, v1TouchesSplit: true,
    }] as never);
    currentState = baseState({ vectorByCorridorsSettings: settingsA });
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    // Only the free end's cell gets a tile; the split cell is drawn by `drawSplitPassages`.
    expect(tilesOf(renderer).map((tile) => tile.offset)).toEqual([{ x: 0, y: 20 }]);
    expect(tilesOf(renderer)[0].graphics.context.fill).toHaveBeenCalledWith(0xffffff);
  });

  it("rebuilds tiles in place when the shape settings change, keeping each cell's object", () => {
    const pts = [0, 40, 80].map((x) => ({ x, y: 20 }));
    vi.mocked(buildCorridorSegments).mockReturnValueOnce([0, 1].map((i) => ({ v0: pts[i], v1: pts[i + 1], fromNode: i + 1, toNode: i + 2 })) as never);
    currentState = baseState({ vectorByCorridorsSettings: settingsA });
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    const renderAll = (settings: VectorByCorridorsSettings) =>
      (renderer as unknown as { renderAll: (state: unknown) => void }).renderAll({ ...currentState, vectorByCorridorsSettings: settings });
    const snapshot = () => new Map(tilesOf(renderer).map((tile) => [tile.offset.x, { key: tile.key, graphics: tile.graphics, context: tile.graphics.context }]));
    const before = snapshot();

    // Same segments (geometry cache hit): a new junction radius still reshapes every contour tile.
    renderAll({ ...settingsA, junctionRadius: settingsA.junctionRadius + 2 });
    const radius = snapshot();
    for (const [x, tile] of radius) {
      expect(tile.graphics).toBe(before.get(x)!.graphics);
      expect(tile.key).not.toBe(before.get(x)!.key);
      expect(tile.context).not.toBe(before.get(x)!.context);
    }

    // Switching to miter swaps every cell to a miter line tile, again in place.
    renderAll({ ...settingsA, join: "miter" });
    for (const [x, tile] of snapshot()) {
      expect(tile.graphics).toBe(before.get(x)!.graphics);
      expect(tile.key.startsWith("miter/")).toBe(true);
    }
  });

  it("miter join draws a turn cell as one miter-joined butt polyline through the cell centre", () => {
    const a = { x: 20, y: 20 }, b = { x: 40, y: 20 }, c = { x: 40, y: 40 };
    turn(a, b, c);
    currentState = baseState({ vectorByCorridorsSettings: settingsB }); // join: "miter"
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    const context = tileAt(renderer, b).graphics.context;
    // Ports are the segment midpoints, relative to the centre `b`.
    expect(context.lineTo).toHaveBeenCalledWith(0, 0);
    expect(context.moveTo.mock.calls.concat(context.lineTo.mock.calls)).toEqual(expect.arrayContaining([[-10, 0], [0, 10]]));
    expect(context.stroke).toHaveBeenCalledWith(expect.objectContaining({ join: "miter", cap: "butt", width: settingsB.thickness }));
    // A dead end gets a square cap patch, filled.
    expect(tileAt(renderer, a).graphics.context.fill).toHaveBeenCalledWith(0xffffff);
  });

  // GitHub issue #510 — the "Line" rendering mode (`renderStyle: "legacy_line"`) keeps the pre-#493
  // look. These assert the legacy branch is actually wired (a regression that fell through to the
  // contour shape, or dropped the centre disc, would otherwise pass CI).
  const legacyRound: VectorByCorridorsSettings = { ...settingsA, renderStyle: "legacy_line" }; // join: "round"
  const legacyMiter: VectorByCorridorsSettings = { ...settingsB, renderStyle: "legacy_line" }; // join: "miter"

  it("legacy_line round style draws butt lines to every port plus a centre disc in each cell", () => {
    const a = { x: 0, y: 20 }, b = { x: 60, y: 20 }, c = { x: 60, y: 80 };
    turn(a, b, c);
    currentState = baseState({ vectorByCorridorsSettings: legacyRound });
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    const tiles = tilesOf(renderer);
    expect(tiles).toHaveLength(3);
    for (const tile of tiles) {
      expect(tile.key.startsWith("round/")).toBe(true);
      expect(tile.graphics.context.stroke).toHaveBeenCalledWith(expect.objectContaining({ cap: "butt", width: legacyRound.thickness }));
      expect(tile.graphics.context.circle).toHaveBeenCalledWith(0, 0, legacyRound.thickness / 2);
    }
  });

  it("legacy_line round style gives a split-touching segment to its free cell only (drawSplitPassages owns the split end)", () => {
    const freeEnd = { x: 0, y: 20 }, splitEnd = { x: 40, y: 20 };
    vi.mocked(buildCorridorSegments).mockReturnValueOnce([
      { v0: freeEnd, v1: splitEnd, fromNode: 1, toNode: 2, v1TouchesSplit: true },
    ] as never);
    currentState = baseState({ vectorByCorridorsSettings: legacyRound });
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    const tiles = tilesOf(renderer);
    expect(tiles.map((tile) => tile.offset)).toEqual([freeEnd]);
    // The line runs all the way to the split end, with no disc there.
    expect(tiles[0].graphics.context.lineTo).toHaveBeenCalledWith(40, 0);
    expect(tiles[0].graphics.context.circle).toHaveBeenCalledTimes(1);
  });

  it("legacy_line miter style uses the same miter tiles as contour mode's miter style", () => {
    const shapeKeys = (settings: VectorByCorridorsSettings) => {
      turn({ x: 20, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 40 });
      currentState = baseState({ vectorByCorridorsSettings: settings });
      return tilesOf(new VectorByCorridorsRenderer({ addChild: vi.fn() } as never)).map((tile) => tile.key);
    };
    const keys = shapeKeys(legacyMiter);
    expect(keys.every((key) => key.startsWith("miter/"))).toBe(true);
    expect(keys).toEqual(shapeKeys(settingsB));
  });

  it("legacy_line draws split passages via the legacy path (plain straight connector to each face midpoint, no contour trace)", () => {
    const center = { x: 30, y: 30 };
    const faceMid = { x: 30, y: 0 };
    vi.mocked(buildSplitPassages).mockReturnValueOnce({
      passages: [{
        pointKey: "p1", center, color: 0xabcdef,
        wallSegments: [{ center: faceMid, v0: { x: 15, y: 0 }, v1: { x: 45, y: 0 }, oneWayOut: undefined, isUndefined: false }],
        connectors: [],
      }],
      wallFaces: [], specialShapes: [],
    } as never);
    currentState = baseState({ vectorByCorridorsSettings: legacyRound });
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    const corridors = (renderer as unknown as { corridors: {
      moveTo: ReturnType<typeof vi.fn>;
      lineTo: ReturnType<typeof vi.fn>;
    } }).corridors;
    // A straight line from the node centre to the face midpoint at half the corridor thickness.
    expect(corridors.moveTo).toHaveBeenCalledWith(center.x, center.y);
    expect(corridors.lineTo).toHaveBeenCalledWith(faceMid.x, faceMid.y);
  });

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
    currentState = baseState({ nodes, vectorByCorridorsSettings: settingsA, activeFieldConfig: fieldOf("square", { shape: "rect", cols: 3, rows: 3 }) });
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
      currentState.activeFieldConfig,
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

  it("passes a floor context and badge-spread bag to buildTeleportEdges (cross-floor teleports, issue #481)", () => {
    new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    expect(buildTeleportEdges).toHaveBeenCalledWith(
      expect.any(Map),
      expect.any(Array),
      stableCfg,
      expect.objectContaining({
        resolveNodeLevel: expect.any(Function),
        unscopedNodeById: expect.any(Map),
        unscopedEdges: expect.any(Array),
        activeFloorIndex: expect.any(Number),
      }),
      expect.objectContaining({
        blockedCellsByFloor: expect.any(Map),
        allowOutOfField: expect.any(Boolean),
        fieldCells: expect.any(Array),
      }),
    );
  });

  it("rebuilds teleport edges when teleportAvoidFieldExit toggles", () => {
    new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    vi.mocked(buildTeleportEdges).mockClear();

    subscribeCallback?.(baseState({ vectorByCorridorsSettings: { ...settingsA, teleportAvoidFieldExit: true } }));

    expect(buildTeleportEdges).toHaveBeenCalledTimes(1);
    expect(buildTeleportEdges).toHaveBeenLastCalledWith(
      expect.any(Map), expect.any(Array), stableCfg,
      expect.any(Object),
      expect.objectContaining({ allowOutOfField: false }),
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
    const markerWidenGraphics = (renderer as unknown as { markerWiden: { fill: ReturnType<typeof vi.fn> } }).markerWiden;
    expect(markerWidenGraphics.fill).toHaveBeenCalledWith({ color: settingsA.color });
  });

  it("also widens the corridor under teleport markers, reusing the same markerWidenPadding setting (no separate teleport padding)", () => {
    vi.mocked(buildTeleportEdges).mockReturnValueOnce([{ from: [7, 7], to: [9, 9], oneWay: false }]);
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    const markerWidenGraphics = (renderer as unknown as { markerWiden: { poly: ReturnType<typeof vi.fn>; circle: ReturnType<typeof vi.fn>; fill: ReturnType<typeof vi.fn> } }).markerWiden;
    // settingsA.teleportMarker.shape is "diamond" — drawn via `poly`, not `circle` (see drawMarkerShape).
    expect(markerWidenGraphics.fill).toHaveBeenCalledWith({ color: settingsA.color });
    expect(markerWidenGraphics.poly).toHaveBeenCalled();
  });

  it("draws every widen patch (waypoint and teleport alike) in a fixed square when markerWidenShape isn't 'match_marker', regardless of each marker's own shape", () => {
    // startMarker/teleportMarker.shape are non-square ("circle"/"diamond") in these fixtures — with
    // markerWidenShape:"square" every widen patch must draw as a square (via `arcTo`, since
    // settingsA.join is "round" — rounded-square corners), never `circle`, regardless of each
    // marker's own shape (GitHub issue #313 follow-up).
    vi.mocked(buildMazeMarkers).mockReturnValueOnce([{ pos: [5, 5], color: 0x999, radius: 4, shape: "circle" }]);
    vi.mocked(buildTeleportEdges).mockReturnValueOnce([{ from: [7, 7], to: [9, 9], oneWay: false }]);
    currentState = baseState({ vectorByCorridorsSettings: { ...settingsA, markerWidenShape: "square" } });
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    const markerWidenGraphics = (renderer as unknown as { markerWiden: { poly: ReturnType<typeof vi.fn>; circle: ReturnType<typeof vi.fn> } }).markerWiden;
    expect(markerWidenGraphics.circle).not.toHaveBeenCalled();
    expect(markerWidenGraphics.poly).toHaveBeenCalled();
  });

  it("renders teleports via its own TeleportRenderer, styled from vectorByCorridorsSettings with the corridor's own color as floorColor", () => {
    vi.mocked(buildMazeMarkers).mockReturnValueOnce([{ pos: [5, 5], color: 0x999, radius: 4 }]);
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    const teleports = (renderer as unknown as { teleports: { render: ReturnType<typeof vi.fn> } }).teleports;
    expect(teleports.render).toHaveBeenCalledWith(expect.objectContaining({
      edges: [],
      // floorColor is the corridor's own color here, not the canvas background (GitHub issue #313
      // follow-up) — a teleport point sits on the passage line, not on an empty floor tile.
      lineStyle: expect.objectContaining({ shape: settingsA.teleportMarker.shape, floorColor: settingsA.color }),
      groupCustomization: settingsA.teleportGroupCustomization,
      groupOverrides: settingsA.teleportGroupOverrides,
      cfg: stableCfg,
      waypoints: [[5, 5]],
      avoidFieldExit: settingsA.teleportAvoidFieldExit,
    }));
  });

  it("wires cross-floor teleport badges and vertical-passage markers as always-on click-to-switch-floor (GitHub issue #478)", () => {
    currentState = baseState();
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    const teleports = (renderer as unknown as { teleports: { render: ReturnType<typeof vi.fn> } }).teleports;
    const verticalConnections = (renderer as unknown as { verticalConnections: { render: ReturnType<typeof vi.fn> } }).verticalConnections;
    expect(teleports.render).toHaveBeenCalledWith(expect.objectContaining({ floorNavigable: true }));
    expect(verticalConnections.render).toHaveBeenCalledWith(expect.objectContaining({ interactive: true }));
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
      currentState = baseState({ vectorByCorridorsSettings: { ...settingsA, oneWayCount: 3, oneWayColor: 0xABCDEF } });
      const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
      const corridorsGraphics = (renderer as unknown as { corridors: { stroke: ReturnType<typeof vi.fn> } }).corridors;

      // Each chevron strokes once in `oneWayColor` — 3 for the one-way segment's row, 0 for the
      // plain segment. (The contour fill uses the corridor colour, never `oneWayColor`.)
      const chevronStrokes = corridorsGraphics.stroke.mock.calls.filter(
        ([s]) => s && typeof s === "object" && (s as { color?: number }).color === 0xABCDEF,
      );
      expect(chevronStrokes.length).toBe(3);
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
        { v0: { x: 0, y: 0 }, v1: { x: 100, y: 0 }, fromNode: 0, toNode: 1, oneWayColor: undefined },
      ] as never);
      currentState = baseState({ vectorByCorridorsSettings: { ...settingsA, oneWayColor: 0xABCDEF } });
      const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
      const corridorsGraphics = (renderer as unknown as { corridors: { stroke: ReturnType<typeof vi.fn> } }).corridors;
      // The contour fills, but no chevron strokes in `oneWayColor`.
      const chevronStrokes = corridorsGraphics.stroke.mock.calls.filter(
        ([s]) => s && typeof s === "object" && (s as { color?: number }).color === 0xABCDEF,
      );
      expect(chevronStrokes.length).toBe(0);
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

    it("sharp hex diagonal divider converges each node's three lines at its own off-center junction", () => {
      const segment = (x: number, y: number) => ({
        v0: { x, y }, v1: { x, y }, center: { x, y }, isUndefined: false,
        atFaceStart: false, atFaceEnd: false,
      });
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [
          { color: 0xaaaaaa, pointKey: "0,0", center: { x: 5, y: 5 }, wallSegments: [segment(10, 0), segment(10, 5), segment(10, 10)], connectors: [] },
          { color: 0xbbbbbb, pointKey: "0,0", center: { x: 5, y: 5 }, wallSegments: [segment(0, 0), segment(0, 5), segment(0, 10)], connectors: [] },
        ],
        wallFaces: [],
        specialShapes: [{
          kind: "diagonal", pointKey: "0,0", corner0: { x: 5, y: 0 }, corner1: { x: 5, y: 10 },
          dividerJunctions: [{ x: 7, y: 5 }, { x: 3, y: 5 }],
        }],
      });
      currentState = baseState({ vectorByCorridorsSettings: { ...settingsB, splitSpecialShapes: true } });
      const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
      const corridorsGraphics = (renderer as unknown as { corridors: { moveTo: ReturnType<typeof vi.fn>; stroke: ReturnType<typeof vi.fn>; fill: ReturnType<typeof vi.fn>; quadraticCurveTo: ReturnType<typeof vi.fn>; bezierCurveTo: ReturnType<typeof vi.fn> } }).corridors;
      expect(corridorsGraphics.stroke).toHaveBeenCalledTimes(6);
      expect(corridorsGraphics.moveTo.mock.calls.filter(([x, y]) => x === 7 && y === 5)).toHaveLength(3);
      expect(corridorsGraphics.moveTo.mock.calls.filter(([x, y]) => x === 3 && y === 5)).toHaveLength(3);
      expect(corridorsGraphics.moveTo).not.toHaveBeenCalledWith(5, 5);
      expect(corridorsGraphics.stroke.mock.calls.every(([style]) => style.cap === "butt")).toBe(true);
      expect(corridorsGraphics.stroke.mock.calls.every(([style]) => style.color === settingsB.color)).toBe(true);
      // Only the inward wedge is needed at each seam; the outward stroke halves already overlap.
      expect(corridorsGraphics.fill.mock.calls.filter(([color]) => color === settingsB.color)).toHaveLength(6);
    });

    it("rounded hex diagonal divider uses the rounded junction contour", () => {
      const segment = (x: number, y: number) => ({
        v0: { x, y }, v1: { x, y }, center: { x, y }, isUndefined: false,
        atFaceStart: false, atFaceEnd: false,
      });
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [
          { color: 0xaaaaaa, pointKey: "0,0", center: { x: 5, y: 5 }, wallSegments: [segment(10, 0), segment(10, 5), segment(10, 10)], connectors: [] },
          { color: 0xbbbbbb, pointKey: "0,0", center: { x: 5, y: 5 }, wallSegments: [segment(0, 0), segment(0, 5), segment(0, 10)], connectors: [] },
        ],
        wallFaces: [],
        specialShapes: [{
          kind: "diagonal", pointKey: "0,0", corner0: { x: 5, y: 0 }, corner1: { x: 5, y: 10 },
          dividerJunctions: [{ x: 7, y: 5 }, { x: 3, y: 5 }],
        }],
      });
      currentState = baseState({ vectorByCorridorsSettings: { ...settingsA, splitSpecialShapes: true } });
      const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
      const corridorsGraphics = (renderer as unknown as { corridors: { moveTo: ReturnType<typeof vi.fn>; stroke: ReturnType<typeof vi.fn>; fill: ReturnType<typeof vi.fn>; arc: ReturnType<typeof vi.fn>; quadraticCurveTo: ReturnType<typeof vi.fn>; bezierCurveTo: ReturnType<typeof vi.fn> } }).corridors;
      expect(corridorsGraphics.stroke).not.toHaveBeenCalled();
      // The universal cell-safe contour may use Bezier fallbacks for synthetic split-cell fixtures;
      // the production geometry path is still curved, but no longer relies on Pixi arc commands.
      expect(corridorsGraphics.arc).not.toHaveBeenCalled();
      expect(corridorsGraphics.quadraticCurveTo.mock.calls.length + corridorsGraphics.bezierCurveTo.mock.calls.length).toBeGreaterThan(0);
      expect(corridorsGraphics.fill.mock.calls.filter(([color]) => color === settingsA.background)).toHaveLength(2);
      expect(corridorsGraphics.fill.mock.calls.filter(([color]) => color === settingsA.color)).toHaveLength(4);
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
        passages: [{
          color: 0xaaaaaa, pointKey: "0,0", center: { x: 20, y: 20 },
          wallSegments: [{ v0: { x: 0, y: 0 }, v1: { x: 0, y: 0 }, center: { x: 0, y: 20 }, isUndefined: false, atFaceStart: false, atFaceEnd: false }],
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
      currentState = baseState({ vectorByCorridorsSettings: { ...settingsA, splitSpecialShapes: true, splitGapWidth: 0 } });
      const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
      const corridorsGraphics = (renderer as unknown as { corridors: { stroke: ReturnType<typeof vi.fn> } }).corridors;
      expect(corridorsGraphics.stroke.mock.calls.some(([style]) => (style as { color: number }).color === 0xaaaaaa)).toBe(false);
      const graphicsInstances = vi.mocked(Graphics).mock.results.map((r) => r.value as { stroke: ReturnType<typeof vi.fn> });
      const groupGraphics = graphicsInstances.filter((g) => g !== corridorsGraphics);
      const allStrokeCalls = groupGraphics.flatMap((g) => g.stroke.mock.calls.map((call: unknown[]) => call[0] as { color: number }));
      expect(allStrokeCalls.some((s) => s.color === settingsA.background)).toBe(false);
    });

    // A crossing bridge with no through line: the second node is a 3-face fork (it reaches the
    // extra face midpoint (10, 10)) drawn as the ordinary corridor underlay beneath the deck.
    const bridgeOverFork = () => ({
      passages: [
        {
          color: 0xaaaaaa, pointKey: "0,0", center: { x: 20, y: 20 },
          wallSegments: [
            { v0: { x: 10, y: 0 }, v1: { x: 30, y: 0 }, center: { x: 20, y: 0 }, isUndefined: false, atFaceStart: false, atFaceEnd: false },
            { v0: { x: 10, y: 40 }, v1: { x: 30, y: 40 }, center: { x: 20, y: 40 }, isUndefined: false, atFaceStart: false, atFaceEnd: false },
          ],
          connectors: [],
        },
        {
          color: 0xbbbbbb, pointKey: "0,0", center: { x: 20, y: 20 },
          wallSegments: [
            { v0: { x: 0, y: 10 }, v1: { x: 0, y: 30 }, center: { x: 0, y: 20 }, isUndefined: false, atFaceStart: false, atFaceEnd: false },
            { v0: { x: 40, y: 10 }, v1: { x: 40, y: 30 }, center: { x: 40, y: 20 }, isUndefined: false, atFaceStart: false, atFaceEnd: false },
            { v0: { x: 5, y: 5 }, v1: { x: 15, y: 15 }, center: { x: 10, y: 10 }, isUndefined: false, atFaceStart: false, atFaceEnd: false },
          ],
          connectors: [],
        },
      ],
      wallFaces: [],
      specialShapes: [{
        kind: "bridge", pointKey: "0,0",
        crossFaces: [{ v0: { x: 10, y: 0 }, v1: { x: 30, y: 0 } }, { v0: { x: 10, y: 40 }, v1: { x: 30, y: 40 } }],
        edge0: [{ x: 10, y: 0 }, { x: 14, y: 8 }, { x: 14, y: 32 }, { x: 10, y: 40 }],
        edge1: [{ x: 30, y: 0 }, { x: 26, y: 8 }, { x: 26, y: 32 }, { x: 30, y: 40 }],
      }],
    });

    it("bridge special shape without a through line keeps the underlying fork below the bridge", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce(bridgeOverFork() as never);
      currentState = baseState({ vectorByCorridorsSettings: { ...settingsA, splitSpecialShapes: true, splitGapWidth: 0 } });
      const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
      const corridorsGraphics = (renderer as unknown as { corridors: { stroke: ReturnType<typeof vi.fn>; fill: ReturnType<typeof vi.fn> } }).corridors;
      const graphicsInstances = vi.mocked(Graphics).mock.results.map((r) => r.value as { stroke: ReturnType<typeof vi.fn> });
      const groupGraphics = graphicsInstances.filter((g) => g !== corridorsGraphics);
      const allStrokeCalls = groupGraphics.flatMap((g) => g.stroke.mock.calls.map((call: unknown[]) => call[0] as { color: number; width: number }));
      expect(allStrokeCalls.filter((s) => s.color === settingsA.color && s.width === settingsA.thickness)).toHaveLength(1);
      expect(corridorsGraphics.stroke).not.toHaveBeenCalled();
      expect(corridorsGraphics.fill.mock.calls.every(([color]) => color === settingsA.color)).toBe(true);
    });

    it("miter bridge underlay draws the fork as plain connector lines, not a contour fill", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce(bridgeOverFork() as never);
      currentState = baseState({ vectorByCorridorsSettings: { ...settingsB, splitSpecialShapes: true, splitGapWidth: 0 } });
      const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
      const corridors = (renderer as unknown as { corridors: {
        moveTo: ReturnType<typeof vi.fn>;
        lineTo: ReturnType<typeof vi.fn>;
        closePath: ReturnType<typeof vi.fn>;
      } }).corridors;
      expect(corridors.moveTo).toHaveBeenCalledWith(20, 20);
      expect(corridors.lineTo).toHaveBeenCalledWith(10, 10);
      expect(corridors.closePath).not.toHaveBeenCalled();
    });

    it("clips a Cairo bridge gap as a cell-bounded polygon with independently limited ends", () => {
      const cfg: FieldConfig = fieldOf("cairo", { shape: "rect", cols: 3, rows: 3 });
      const vertices = getCellVertices(2, 1, cfg)!;
      const face = (index: number) => ({ v0: vertices[index], v1: vertices[(index + 1) % vertices.length] });
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [],
        wallFaces: [],
        specialShapes: [{
          kind: "bridge", pointKey: "2,1",
          crossFaces: [face(0), face(2)],
          edge0: [vertices[0], vertices[1], vertices[2], vertices[3]],
          edge1: [vertices[1], vertices[2], vertices[3], vertices[4]],
        }],
      });
      currentState = baseState({
        activeFieldConfig: cfg,
        vectorByCorridorsSettings: { ...settingsA, splitSpecialShapes: true, splitGapWidth: 10 },
      });
      const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
      const corridorsGraphics = (renderer as unknown as { corridors: { stroke: ReturnType<typeof vi.fn> } }).corridors;
      const graphicsInstances = vi.mocked(Graphics).mock.results.map((r) => r.value as { poly: ReturnType<typeof vi.fn>; stroke: ReturnType<typeof vi.fn>; fill: ReturnType<typeof vi.fn> });
      const groupGraphics = graphicsInstances.filter((g) => g !== corridorsGraphics);
      const backgroundPolygons = groupGraphics.flatMap((g) => g.fill.mock.calls.some((call: unknown[]) => call[0] === settingsA.background)
        ? g.poly.mock.calls
        : []);
      expect(backgroundPolygons.length).toBeGreaterThan(0);
      const polygon = backgroundPolygons[0][0] as number[];
      const polygonPoints = Array.from({ length: polygon.length / 2 }, (_, index) => ({ x: polygon[index * 2], y: polygon[index * 2 + 1] }));
      expect(polygonPoints.length).toBeGreaterThan(4);
      expect(polygonPoints.every((point) => pointInPolygon(point, vertices))).toBe(true);
      expect(groupGraphics.flatMap((g) => g.stroke.mock.calls).some((call: unknown[]) => (call[0] as { color?: number }).color === settingsA.background)).toBe(false);
    });

    it("parallel Cairo divider leaves the lower 1-4 connection without a gap underlay", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [
          { nodeIndex: 1, color: 0xaaaaaa, pointKey: "1,1", center: { x: 20, y: 20 }, wallSegments: [], connectors: [{ from: { x: 0, y: 20 }, to: { x: 20, y: 0 }, isUndefined: false }] },
          { nodeIndex: 0, color: 0xbbbbbb, pointKey: "1,1", center: { x: 20, y: 20 }, wallSegments: [], connectors: [{ from: { x: 20, y: 40 }, to: { x: 40, y: 20 }, isUndefined: false }] },
        ],
        wallFaces: [],
        specialShapes: [{ kind: "diagonal", pointKey: "1,1", corner0: { x: 0, y: 0 }, corner1: { x: 40, y: 40 }, topNodeIndex: 0 }],
      });
      currentState = baseState({ vectorByCorridorsSettings: { ...settingsA, splitSpecialShapes: true, splitGapWidth: 3 } });
      const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
      const corridorsGraphics = (renderer as unknown as { corridors: { fill: ReturnType<typeof vi.fn> } }).corridors;
      const graphicsInstances = vi.mocked(Graphics).mock.results.map((r) => r.value as { fill: ReturnType<typeof vi.fn> });
      const groupGraphics = graphicsInstances.filter((g) => g !== corridorsGraphics);
      const fills = groupGraphics.flatMap((g) => g.fill.mock.calls.map((call: unknown[]) => call[0] as number));
      expect(fills.filter((color) => color === settingsA.background)).toHaveLength(1);
      expect(fills.filter((color) => color === settingsA.color)).toHaveLength(2);
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

    it("miter diagonal uses a sharp ribbon and suppresses its gap even when splitGapWidth > 0", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [{
          color: 0xaaaaaa, pointKey: "1,1", center: { x: 20, y: 20 }, wallSegments: [],
          connectors: [{ from: { x: 0, y: 20 }, to: { x: 20, y: 0 }, isUndefined: false }],
        }],
        wallFaces: [],
        specialShapes: [{ kind: "diagonal", pointKey: "1,1", corner0: { x: 0, y: 0 }, corner1: { x: 40, y: 40 } }],
      });
      currentState = baseState({
        vectorByCorridorsSettings: { ...settingsB, splitSpecialShapes: true, splitDiagonalBowAmount: 0.8, splitGapWidth: 8 },
      });

      const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
      const corridorsGraphics = (renderer as unknown as { corridors: { fill: ReturnType<typeof vi.fn> } }).corridors;
      const graphicsInstances = vi.mocked(Graphics).mock.results.map((r) => r.value as {
        bezierCurveTo: ReturnType<typeof vi.fn>;
        fill: ReturnType<typeof vi.fn>;
      });
      const groupGraphics = graphicsInstances.filter((g) => g !== corridorsGraphics);
      expect(groupGraphics.every((g) => g.bezierCurveTo.mock.calls.length === 0)).toBe(true);
      const fills = groupGraphics.flatMap((g) => g.fill.mock.calls.map((call: unknown[]) => call[0] as number));
      expect(fills).toContain(settingsB.color);
      expect(fills).not.toContain(settingsB.background);
    });

    it("hex_triple_corridor: the opposite-pair throughLine draws once (deduped across its 2 diagonal entries), after both ribbons, with its own background gap patch cutting into them when splitGapWidth > 0", () => {
      const throughLine: [{ x: number; y: number }, { x: number; y: number }] = [{ x: 0, y: 20 }, { x: 40, y: 20 }];
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [
          { color: 0xaaaaaa, pointKey: "1,1", center: { x: 20, y: 20 }, wallSegments: [], connectors: [{ from: { x: 0, y: 0 }, to: { x: 20, y: 0 }, isUndefined: false }] },
          { color: 0xbbbbbb, pointKey: "1,1", center: { x: 20, y: 20 }, wallSegments: [], connectors: [{ from: { x: 20, y: 40 }, to: { x: 40, y: 40 }, isUndefined: false }] },
          { color: 0xcccccc, pointKey: "1,1", center: { x: 20, y: 20 }, wallSegments: [], connectors: [{ from: throughLine[0], to: throughLine[1], isUndefined: false }] },
        ],
        wallFaces: [],
        specialShapes: [
          { kind: "diagonal", pointKey: "1,1", corner0: { x: 0, y: 0 }, corner1: { x: 20, y: 40 }, throughLine },
          { kind: "diagonal", pointKey: "1,1", corner0: { x: 20, y: 0 }, corner1: { x: 40, y: 40 } },
        ],
      });
      currentState = baseState({ vectorByCorridorsSettings: { ...settingsA, splitSpecialShapes: true, splitDiagonalBowAmount: 0.15, splitGapWidth: 3 } });
      const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
      const corridorsGraphics = (renderer as unknown as { corridors: { stroke: ReturnType<typeof vi.fn>; bezierCurveTo: ReturnType<typeof vi.fn> } }).corridors;

      const graphicsInstances = vi.mocked(Graphics).mock.results.map((r) => r.value as { stroke: ReturnType<typeof vi.fn>; bezierCurveTo: ReturnType<typeof vi.fn> });
      const groupGraphics = graphicsInstances.filter((g) => g !== corridorsGraphics);

      // Exactly one straight-line stroke at full thickness in the plain corridor color — the
      // throughLine, drawn once despite appearing on both diagonal entries sharing this pointKey.
      const fullColorStrokes = groupGraphics.flatMap((g) => g.stroke.mock.calls.map((call: unknown[]) => call[0] as { color: number; width: number }))
        .filter((s) => s.color === settingsA.color && s.width === settingsA.thickness);
      expect(fullColorStrokes.length).toBe(1);

      // Its own background gap patch (splitGapWidth > 0) exists as a separate background-colored
      // stroke, distinct from the through line's own full-color stroke.
      const backgroundStrokes = groupGraphics.flatMap((g) => g.stroke.mock.calls.map((call: unknown[]) => call[0] as { color: number }))
        .filter((s) => s.color === settingsA.background);
      expect(backgroundStrokes.length).toBeGreaterThan(0);

      // Both ribbons still draw — with splitGapWidth > 0 each ribbon draws its own gap frame plus
      // its own line (2 bezierCurveTo calls each), 2 ribbons -> 8 total.
      const totalBezier = groupGraphics.reduce((sum, g) => sum + g.bezierCurveTo.mock.calls.length, 0);
      expect(totalBezier).toBe(8);
      expect(corridorsGraphics.stroke).not.toHaveBeenCalled();
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

// GitHub issue #701 — a floor badge is its own marker: the widen patch under it follows the badge's
// corner style / border / gap, not the edge marker's.
describe("buildTeleportWidenMarkers floor badges (GitHub issue #701)", () => {
  it("uses teleportFloorBadge's own size, corner style, border and gap for a cross-floor badge point", () => {
    const settings: VectorByCorridorsSettings = {
      ...settingsA,
      teleportMarker: { ...settingsA.teleportMarker, cornerStyle: "round", borderWidth: 1, gapWidth: 1 },
      teleportFloorBadge: { ...settingsA.teleportFloorBadge, size: 14, cornerStyle: "miter", borderWidth: 4, gapWidth: 5 },
    };
    const edges = [{ from: [0, 0] as [number, number], to: [1, 1] as [number, number], oneWay: true, toFloor: 1 }];
    const markers = buildTeleportWidenMarkers(edges, settings, []);
    const badge = markers.find((m) => m.pos[0] === 1 && m.pos[1] === 1);
    expect(badge).toMatchObject({ radius: 7, cornerStyle: "miter", borderWidth: 4, gapWidth: 5 });
    const ordinary = markers.find((m) => m.pos[0] === 0);
    expect(ordinary).toMatchObject({ cornerStyle: "round", borderWidth: 1, gapWidth: 1 });
  });
});
