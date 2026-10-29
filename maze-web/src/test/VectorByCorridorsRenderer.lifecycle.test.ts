import { describe, it, expect, vi } from "vitest";
import { buildCorridorSegments } from "../pixi/selectors/mazeSelectors";
import type { NodeDto } from "../wasm/types";
import { fieldOf } from "./fieldConfigFixtures";
import { settingsA, settingsB, baseState, makeRenderer, useRendererReset } from "./vbcKit";

import { FakeBounds, makeBounds, makeEmptyBounds, mockStore } from "./vbcMocks";

vi.mock("../pixi/selectors/mazeSelectors", async () => (await import("./vbcMocks")).mazeSelectorsMock());
vi.mock("../pixi/renderers/WallRenderer", async () => (await import("./vbcMocks")).wallRendererMock());
vi.mock("../pixi/renderers/TeleportRenderer", async () => (await import("./vbcMocks")).teleportRendererMock());
vi.mock("../pixi/renderers/VerticalConnectionRenderer", async () => (await import("./vbcMocks")).verticalConnectionRendererMock());
vi.mock("../pixi/renderers/GridRenderer", async () => (await import("./vbcMocks")).gridRendererMock());
vi.mock("../store/mazeStore", async () => (await import("./vbcMocks")).mazeStoreMock());
vi.mock("pixi.js", async () => (await import("./vbcMocks")).pixiMock());

useRendererReset();

describe("VectorByCorridorsRenderer lifecycle and rendering", () => {
  it("getRequiredExportMargin returns zero margin when this maze has no nodes (nothing drawn)", () => {
    mockStore.current = baseState({ vectorByCorridorsSettings: settingsB });
    const renderer = makeRenderer();
    expect(renderer.getRequiredExportMargin()).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
  });

  it("getRequiredExportMargin reads the actual drawn content's pixel bounds, not a settings-derived approximation (GitHub issue #324 follow-up)", () => {
    // TILE_SIZE=40, 3x3 grid — cellCenterBounds for this grid is minX=20,maxX=100,minY=-100,maxY=-20
    // (verified directly against squareCenter's own Y-flip/half-tile-offset convention).
    const nodes: NodeDto[] = [];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) nodes.push({ id: y * 3 + x, x, y, i: 0 });
    mockStore.current = baseState({ nodes, vectorByCorridorsSettings: settingsA, activeFieldConfig: fieldOf("square", { shape: "rect", cols: 3, rows: 3 }) });
    const renderer = makeRenderer();

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
    mockStore.current = baseState({ vectorByCorridorsSettings: settingsB });
    const renderer = makeRenderer();
    expect(renderer.getBackgroundColor()).toBe(settingsB.background);
  });

  it("onViewportChanged redraws the background and grid against the new viewport while the image-export card is open (GitHub issue #309)", () => {
    mockStore.current = baseState({ vectorByCorridorsSettings: settingsB });
    const renderer = makeRenderer();
    const backgroundGrid = (renderer as unknown as { backgroundGrid: { grid: { render: ReturnType<typeof vi.fn> }; background: { rect: ReturnType<typeof vi.fn> } } }).backgroundGrid;
    vi.mocked(backgroundGrid.grid.render).mockClear();
    vi.mocked(backgroundGrid.background.rect).mockClear();

    renderer.onViewportChanged(10, 20, 800, 600, 2);

    expect(backgroundGrid.background.rect).toHaveBeenCalledTimes(1);
    expect(backgroundGrid.grid.render).toHaveBeenCalledWith(
      { viewport: { x: 10, y: 20, w: 800, h: 600, scale: 2 }, color: settingsB.gridColor },
      mockStore.current.activeFieldConfig,
    );
  });

  it("onViewportChanged does not redraw while the image-export card is closed", () => {
    mockStore.current = baseState({ openCard: "generation" });
    const renderer = makeRenderer();
    const backgroundGrid = (renderer as unknown as { backgroundGrid: { grid: { render: ReturnType<typeof vi.fn> }; background: { rect: ReturnType<typeof vi.fn> } } }).backgroundGrid;
    vi.mocked(backgroundGrid.grid.render).mockClear();
    vi.mocked(backgroundGrid.background.rect).mockClear();

    renderer.onViewportChanged(10, 20, 800, 600, 2);

    expect(backgroundGrid.background.rect).not.toHaveBeenCalled();
    expect(backgroundGrid.grid.render).not.toHaveBeenCalled();
  });

  it("onViewportChanged skips the grid draw when showGrid is off, but still redraws the background", () => {
    mockStore.current = baseState({ vectorByCorridorsSettings: { ...settingsB, showGrid: false } });
    const renderer = makeRenderer();
    const backgroundGrid = (renderer as unknown as { backgroundGrid: { grid: { render: ReturnType<typeof vi.fn> }; background: { rect: ReturnType<typeof vi.fn> } } }).backgroundGrid;
    vi.mocked(backgroundGrid.grid.render).mockClear();
    vi.mocked(backgroundGrid.background.rect).mockClear();

    renderer.onViewportChanged(10, 20, 800, 600, 2);

    expect(backgroundGrid.background.rect).toHaveBeenCalledTimes(1);
    expect(backgroundGrid.grid.render).not.toHaveBeenCalled();
  });

  it("container starts hidden and becomes visible only while the image-export card is open", () => {
    mockStore.current = baseState({ openCard: "generation" });
    const renderer = makeRenderer();
    expect((renderer as unknown as { corridorsContainer: { visible: boolean } }).corridorsContainer.visible).toBe(false);
  });

  it("a data change while the image-export card is open triggers a re-render (geometry rebuilt)", () => {
    makeRenderer();
    vi.mocked(buildCorridorSegments).mockClear();

    const nextState = baseState({ nodes: [{ id: 0, x: 0, y: 0, i: 0 }] });
    mockStore.subscribeCallback?.(nextState);

    expect(buildCorridorSegments).toHaveBeenCalledTimes(1);
  });

  it("a settings-only change re-renders without rebuilding geometry (cache reused)", () => {
    makeRenderer();
    vi.mocked(buildCorridorSegments).mockClear();

    // `color`-only change — `thickness` stays the same as `settingsA`'s own (unlike `settingsB`,
    // which also changes `thickness`, itself now a geometry-cache key since GitHub issue #314's
    // split-connector corridor-width division depends on it).
    const nextState = baseState({ vectorByCorridorsSettings: { ...settingsA, color: 0x999999 } });
    mockStore.subscribeCallback?.(nextState);

    expect(buildCorridorSegments).not.toHaveBeenCalled();
  });

  it("a thickness-only change rebuilds geometry (split-connector corridor-width division depends on it, GitHub issue #314)", () => {
    makeRenderer();
    vi.mocked(buildCorridorSegments).mockClear();

    const nextState = baseState({ vectorByCorridorsSettings: settingsB });
    mockStore.subscribeCallback?.(nextState);

    expect(buildCorridorSegments).toHaveBeenCalledTimes(1);
  });

  it("a data change while the image-export card is closed does not re-render", () => {
    makeRenderer();
    vi.mocked(buildCorridorSegments).mockClear();

    const nextState = baseState({ openCard: "generation", nodes: [{ id: 0, x: 0, y: 0, i: 0 }] });
    mockStore.subscribeCallback?.(nextState);

    expect(buildCorridorSegments).not.toHaveBeenCalled();
  });

  it("switching openCard to image_export re-renders even with no data/settings change", () => {
    mockStore.current = baseState({ openCard: "generation" });
    makeRenderer();
    vi.mocked(buildCorridorSegments).mockClear();

    const nextState = baseState({ openCard: "image_export" });
    mockStore.subscribeCallback?.(nextState);

    expect(buildCorridorSegments).toHaveBeenCalledTimes(1);
  });

  it("destroy unsubscribes from the store and destroys its own Graphics/Container", () => {
    const renderer = makeRenderer();
    expect(mockStore.subscribeCallback).not.toBeNull();
    renderer.destroy();
    expect(mockStore.subscribeCallback).toBeNull();
  });
});
