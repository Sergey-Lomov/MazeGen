import { describe, it, expect, vi } from "vitest";
import { buildCorridorSegments, shortestCorridorFaceAcrossFloors } from "../pixi/selectors/mazeSelectors";
import type { FieldConfig } from "../fieldConfig";
import type { VectorByCorridorsSettings } from "../store/storeTypes";
import { fieldOf } from "./fieldConfigFixtures";
import { settingsA, settingsB, baseState, stableCfg, tilesOf, tileAt, corridorsOf, turn, makeRenderer, useRendererReset } from "./vbcKit";

import { mockStore } from "./vbcMocks";

vi.mock("../pixi/selectors/mazeSelectors", async () => (await import("./vbcMocks")).mazeSelectorsMock());
vi.mock("../pixi/renderers/WallRenderer", async () => (await import("./vbcMocks")).wallRendererMock());
vi.mock("../pixi/renderers/TeleportRenderer", async () => (await import("./vbcMocks")).teleportRendererMock());
vi.mock("../pixi/renderers/VerticalConnectionRenderer", async () => (await import("./vbcMocks")).verticalConnectionRendererMock());
vi.mock("../pixi/renderers/GridRenderer", async () => (await import("./vbcMocks")).gridRendererMock());
vi.mock("../store/mazeStore", async () => (await import("./vbcMocks")).mazeStoreMock());
vi.mock("pixi.js", async () => (await import("./vbcMocks")).pixiMock());

useRendererReset();

describe("VectorByCorridorsRenderer tiles", () => {
  it("uses the active floor's tessellation config for rendered geometry", () => {
    const secondFloorCfg = fieldOf("square", { shape: "rect", cols: 9, rows: 2 });
    mockStore.current = baseState({
      floors: [{ id: "floor_1", title: "Floor 1" }, { id: "floor_2", title: "Floor 2" }],
      activeFloorId: "floor_2",
      activeFieldConfig: secondFloorCfg,
      floorFields: {
        floor_1: { fieldConfig: stableCfg },
        floor_2: { fieldConfig: secondFloorCfg },
      },
    });

    const renderer = makeRenderer();
    const internals = renderer as unknown as {
      backgroundGrid: { render: (settings: VectorByCorridorsSettings, cfg: FieldConfig) => void };
      renderAll: (state: typeof mockStore.current) => void;
    };
    const renderGrid = vi.spyOn(internals.backgroundGrid, "render");
    internals.renderAll(mockStore.current);

    expect(renderGrid).toHaveBeenCalledWith(settingsA, secondFloorCfg);
  });

  it("round contour style fills one tinted contour tile per cell (no per-segment stroke)", () => {
    turn({ x: 0, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 80 });
    mockStore.current = baseState({ vectorByCorridorsSettings: settingsA }); // join: "round"
    const renderer = makeRenderer();
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
    mockStore.current = baseState({ vectorByCorridorsSettings: settingsA }); // thickness 10
    const renderer = makeRenderer();
    for (const tile of tilesOf(renderer)) expect(tile.key.startsWith("contour/3/")).toBe(true);
    vi.mocked(shortestCorridorFaceAcrossFloors).mockReturnValue(Infinity);
  });

  it("does not recompute the maze-wide face limit when only the thickness changes", () => {
    makeRenderer();
    vi.mocked(shortestCorridorFaceAcrossFloors).mockClear();
    mockStore.subscribeCallback?.(baseState({ vectorByCorridorsSettings: settingsB }));
    expect(shortestCorridorFaceAcrossFloors).not.toHaveBeenCalled();
  });

  it("shares one context per tile shape, recolors by tint and updates only changed cells", () => {
    // A straight 4-cell run: two dead ends (mirror shapes) and two identical straight tiles.
    const pts = [0, 40, 80, 120].map((x) => ({ x, y: 20 }));
    const segs = [0, 1, 2].map((i) => ({ v0: pts[i], v1: pts[i + 1], fromNode: i + 1, toNode: i + 2 }));
    vi.mocked(buildCorridorSegments).mockReturnValueOnce(segs as never);
    mockStore.current = baseState({ vectorByCorridorsSettings: settingsA });
    const renderer = makeRenderer();
    const before = new Map(tilesOf(renderer).map((tile) => [tile.offset.x, tile.graphics]));
    expect(before.size).toBe(4);
    expect(new Set([...before.values()].map((g) => g.context)).size).toBe(3);
    expect(before.get(40)!.context).toBe(before.get(80)!.context);

    // Same maze data, new color: the geometry cache hits, so the tiles are only re-tinted.
    const renderAll = (state: unknown) => (renderer as unknown as { renderAll: (state: unknown) => void }).renderAll(state);
    renderAll({ ...mockStore.current, vectorByCorridorsSettings: { ...settingsA, color: 0xabcdef } });
    for (const tile of tilesOf(renderer)) {
      expect(tile.graphics).toBe(before.get(tile.offset.x));
      expect(tile.graphics.tint).toBe(0xabcdef);
    }

    // Extend the run by one cell: untouched cells keep their objects, the former dead end at 120
    // switches to the shared straight context in place, and only the new cell is created.
    const extended = [...pts, { x: 160, y: 20 }];
    vi.mocked(buildCorridorSegments).mockReturnValueOnce([0, 1, 2, 3].map((i) => ({ v0: extended[i], v1: extended[i + 1], fromNode: i + 1, toNode: i + 2 })) as never);
    renderAll({ ...mockStore.current, nodes: [...(mockStore.current.nodes as unknown[])], vectorByCorridorsSettings: { ...settingsA, color: 0xabcdef } });
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
    mockStore.current = baseState({ vectorByCorridorsSettings: settingsA });
    const renderer = makeRenderer();
    // Only the free end's cell gets a tile; the split cell is drawn by `drawSplitPassages`.
    expect(tilesOf(renderer).map((tile) => tile.offset)).toEqual([{ x: 0, y: 20 }]);
    expect(tilesOf(renderer)[0].graphics.context.fill).toHaveBeenCalledWith(0xffffff);
  });

  it("rebuilds tiles in place when the shape settings change, keeping each cell's object", () => {
    const pts = [0, 40, 80].map((x) => ({ x, y: 20 }));
    vi.mocked(buildCorridorSegments).mockReturnValueOnce([0, 1].map((i) => ({ v0: pts[i], v1: pts[i + 1], fromNode: i + 1, toNode: i + 2 })) as never);
    mockStore.current = baseState({ vectorByCorridorsSettings: settingsA });
    const renderer = makeRenderer();
    const renderAll = (settings: VectorByCorridorsSettings) =>
      (renderer as unknown as { renderAll: (state: unknown) => void }).renderAll({ ...mockStore.current, vectorByCorridorsSettings: settings });
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
    mockStore.current = baseState({ vectorByCorridorsSettings: settingsB }); // join: "miter"
    const renderer = makeRenderer();
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
});
