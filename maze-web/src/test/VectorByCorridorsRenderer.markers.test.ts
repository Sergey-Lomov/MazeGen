import { describe, it, expect, vi } from "vitest";
import { buildCorridorSegments, buildMazeMarkers, buildTeleportEdges } from "../pixi/selectors/mazeSelectors";
import { settingsA, baseState, stableCfg, startMarker, finishMarker, makeRenderer, useRendererReset } from "./vbcKit";

import { mockStore } from "./vbcMocks";

vi.mock("../pixi/selectors/mazeSelectors", async () => (await import("./vbcMocks")).mazeSelectorsMock());
vi.mock("../pixi/renderers/WallRenderer", async () => (await import("./vbcMocks")).wallRendererMock());
vi.mock("../pixi/renderers/TeleportRenderer", async () => (await import("./vbcMocks")).teleportRendererMock());
vi.mock("../pixi/renderers/VerticalConnectionRenderer", async () => (await import("./vbcMocks")).verticalConnectionRendererMock());
vi.mock("../pixi/renderers/GridRenderer", async () => (await import("./vbcMocks")).gridRendererMock());
vi.mock("../store/mazeStore", async () => (await import("./vbcMocks")).mazeStoreMock());
vi.mock("pixi.js", async () => (await import("./vbcMocks")).pixiMock());

useRendererReset();

describe("VectorByCorridorsRenderer markers, teleports and one-way chevrons", () => {
  it("resolves start/finish through resolveEffectiveEndpoints and passes them to buildMazeMarkers", () => {
    mockStore.current = baseState({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }],
      start: 0,
      finish: 1,
    });
    makeRenderer();
    expect(buildMazeMarkers).toHaveBeenCalledWith(
      expect.any(Map), 0, 1, stableCfg,
      expect.objectContaining(startMarker),
      expect.objectContaining(finishMarker),
      expect.any(Array),
    );
  });

  it("passes a floor context and badge-spread bag to buildTeleportEdges (cross-floor teleports, issue #481)", () => {
    makeRenderer();
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
    makeRenderer();
    vi.mocked(buildTeleportEdges).mockClear();

    mockStore.subscribeCallback?.(baseState({ vectorByCorridorsSettings: { ...settingsA, teleportAvoidFieldExit: true } }));

    expect(buildTeleportEdges).toHaveBeenCalledTimes(1);
    expect(buildTeleportEdges).toHaveBeenLastCalledWith(
      expect.any(Map), expect.any(Array), stableCfg,
      expect.any(Object),
      expect.objectContaining({ allowOutOfField: false }),
    );
  });

  it("a start/finish change alone (no node/edge change) triggers a re-render", () => {
    makeRenderer();
    vi.mocked(buildMazeMarkers).mockClear();

    const nextState = baseState({ start: 5 });
    mockStore.subscribeCallback?.(nextState);

    expect(buildMazeMarkers).toHaveBeenCalledTimes(1);
  });

  it("draws a widen patch (fill in the corridor's own color) under each marker before drawing the markers", () => {
    vi.mocked(buildMazeMarkers).mockReturnValueOnce([{ pos: [5, 5], color: 0x999, radius: 4 }]);
    const renderer = makeRenderer();
    const markerWidenGraphics = (renderer as unknown as { markerWiden: { fill: ReturnType<typeof vi.fn> } }).markerWiden;
    expect(markerWidenGraphics.fill).toHaveBeenCalledWith({ color: settingsA.color });
  });

  it("also widens the corridor under teleport markers, reusing the same markerWidenPadding setting (no separate teleport padding)", () => {
    vi.mocked(buildTeleportEdges).mockReturnValueOnce([{ from: [7, 7], to: [9, 9], oneWay: false }]);
    const renderer = makeRenderer();
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
    mockStore.current = baseState({ vectorByCorridorsSettings: { ...settingsA, markerWidenShape: "square" } });
    const renderer = makeRenderer();
    const markerWidenGraphics = (renderer as unknown as { markerWiden: { poly: ReturnType<typeof vi.fn>; circle: ReturnType<typeof vi.fn> } }).markerWiden;
    expect(markerWidenGraphics.circle).not.toHaveBeenCalled();
    expect(markerWidenGraphics.poly).toHaveBeenCalled();
  });

  it("renders teleports via its own TeleportRenderer, styled from vectorByCorridorsSettings with the corridor's own color as floorColor", () => {
    vi.mocked(buildMazeMarkers).mockReturnValueOnce([{ pos: [5, 5], color: 0x999, radius: 4 }]);
    const renderer = makeRenderer();
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
    mockStore.current = baseState();
    const renderer = makeRenderer();
    const teleports = (renderer as unknown as { teleports: { render: ReturnType<typeof vi.fn> } }).teleports;
    const verticalConnections = (renderer as unknown as { verticalConnections: { render: ReturnType<typeof vi.fn> } }).verticalConnections;
    expect(teleports.render).toHaveBeenCalledWith(expect.objectContaining({ floorNavigable: true }));
    expect(verticalConnections.render).toHaveBeenCalledWith(expect.objectContaining({ interactive: true }));
  });

  it("destroy destroys its own TeleportRenderer and its container", () => {
    const renderer = makeRenderer();
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
      mockStore.current = baseState({ vectorByCorridorsSettings: { ...settingsA, oneWayCount: 3, oneWayColor: 0xABCDEF } });
      const renderer = makeRenderer();
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
      mockStore.current = baseState({ vectorByCorridorsSettings: { ...settingsA, oneWayCount: 1 } });
      const renderer = makeRenderer();
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
      mockStore.current = baseState({ vectorByCorridorsSettings: { ...settingsA, oneWayColor: 0xABCDEF } });
      const renderer = makeRenderer();
      const corridorsGraphics = (renderer as unknown as { corridors: { stroke: ReturnType<typeof vi.fn> } }).corridors;
      // The contour fills, but no chevron strokes in `oneWayColor`.
      const chevronStrokes = corridorsGraphics.stroke.mock.calls.filter(
        ([s]) => s && typeof s === "object" && (s as { color?: number }).color === 0xABCDEF,
      );
      expect(chevronStrokes.length).toBe(0);
    });
  });
});
