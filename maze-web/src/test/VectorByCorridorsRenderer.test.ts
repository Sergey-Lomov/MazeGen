import { describe, it, expect, vi, beforeEach } from "vitest";
import { VectorByCorridorsRenderer, buildTeleportWidenMarkers } from "../pixi/imageExport/VectorByCorridorsRenderer";
import { buildCorridorSegments, buildMazeMarkers, buildTeleportEdges } from "../pixi/selectors/mazeSelectors";
import { buildTeleportGroups } from "../pixi/selectors/teleportGroups";
import { canvas } from "../pixi/colorTokens";
import { TILE_SIZE } from "../pixi/constants";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import type { VectorByCorridorsSettings } from "../store/storeTypes";

vi.mock("../pixi/selectors/mazeSelectors", () => ({
  buildCorridorSegments: vi.fn(() => []),
  buildMazeMarkers: vi.fn(() => []),
  buildTeleportEdges: vi.fn(() => []),
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
  Container: vi.fn().mockImplementation(function (this: { addChild: () => void; destroy: () => void; visible: boolean }) {
    this.addChild = vi.fn();
    this.destroy = vi.fn();
    this.visible = false;
  }),
  Graphics: vi.fn().mockImplementation(function (this: { clear: () => void; moveTo: () => unknown; lineTo: () => unknown; arcTo: () => unknown; closePath: () => unknown; stroke: () => unknown; circle: () => unknown; poly: () => unknown; fill: () => unknown; destroy: () => void }) {
    this.clear = vi.fn();
    this.moveTo = vi.fn(() => this);
    this.lineTo = vi.fn(() => this);
    this.arcTo = vi.fn(() => this);
    this.closePath = vi.fn(() => this);
    this.stroke = vi.fn(() => this);
    this.circle = vi.fn(() => this);
    this.poly = vi.fn(() => this);
    this.fill = vi.fn(() => this);
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
const settingsA: VectorByCorridorsSettings = { color: 0x111111, thickness: 10, join: "round", startMarker, finishMarker, markerWidenPadding: 4, markerWidenShape: "match_marker", ...teleportDefaults };
const settingsB: VectorByCorridorsSettings = { color: 0x222222, thickness: 20, join: "miter", startMarker, finishMarker, markerWidenPadding: 4, markerWidenShape: "match_marker", ...teleportDefaults };

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

describe("VectorByCorridorsRenderer", () => {
  it("getRequiredExportMargin/getRequiredWallExportMargin both return half the current thickness", () => {
    currentState = baseState({ vectorByCorridorsSettings: settingsB });
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    expect(renderer.getRequiredExportMargin()).toEqual({ left: 10, right: 10, top: 10, bottom: 10 });
    expect(renderer.getRequiredWallExportMargin()).toEqual(renderer.getRequiredExportMargin());
  });

  it("getBackgroundColor always resolves to the fixed editor canvas background", () => {
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    expect(renderer.getBackgroundColor()).toBe(canvas.stage.background);
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

    const nextState = baseState({ vectorByCorridorsSettings: settingsB });
    subscribeCallback?.(nextState);

    expect(buildCorridorSegments).not.toHaveBeenCalled();
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
});
