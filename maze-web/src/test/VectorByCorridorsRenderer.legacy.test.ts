import { describe, it, expect, vi } from "vitest";
import { buildCorridorSegments, buildSplitPassages } from "../pixi/selectors/mazeSelectors";
import type { VectorByCorridorsSettings } from "../store/storeTypes";
import { settingsA, settingsB, baseState, tilesOf, turn, makeRenderer, useRendererReset } from "./vbcKit";

import { mockStore } from "./vbcMocks";

vi.mock("../pixi/selectors/mazeSelectors", async () => (await import("./vbcMocks")).mazeSelectorsMock());
vi.mock("../pixi/renderers/WallRenderer", async () => (await import("./vbcMocks")).wallRendererMock());
vi.mock("../pixi/renderers/TeleportRenderer", async () => (await import("./vbcMocks")).teleportRendererMock());
vi.mock("../pixi/renderers/VerticalConnectionRenderer", async () => (await import("./vbcMocks")).verticalConnectionRendererMock());
vi.mock("../pixi/renderers/GridRenderer", async () => (await import("./vbcMocks")).gridRendererMock());
vi.mock("../store/mazeStore", async () => (await import("./vbcMocks")).mazeStoreMock());
vi.mock("pixi.js", async () => (await import("./vbcMocks")).pixiMock());

useRendererReset();

describe("VectorByCorridorsRenderer legacy_line style", () => {
  const legacyRound: VectorByCorridorsSettings = { ...settingsA, renderStyle: "legacy_line" }; // join: "round"
  const legacyMiter: VectorByCorridorsSettings = { ...settingsB, renderStyle: "legacy_line" }; // join: "miter"

  it("legacy_line round style draws butt lines to every port plus a centre disc in each cell", () => {
    const a = { x: 0, y: 20 }, b = { x: 60, y: 20 }, c = { x: 60, y: 80 };
    turn(a, b, c);
    mockStore.current = baseState({ vectorByCorridorsSettings: legacyRound });
    const renderer = makeRenderer();
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
    mockStore.current = baseState({ vectorByCorridorsSettings: legacyRound });
    const renderer = makeRenderer();
    const tiles = tilesOf(renderer);
    expect(tiles.map((tile) => tile.offset)).toEqual([freeEnd]);
    // The line runs all the way to the split end, with no disc there.
    expect(tiles[0].graphics.context.lineTo).toHaveBeenCalledWith(40, 0);
    expect(tiles[0].graphics.context.circle).toHaveBeenCalledTimes(1);
  });

  it("legacy_line miter style uses the same miter tiles as contour mode's miter style", () => {
    const shapeKeys = (settings: VectorByCorridorsSettings) => {
      turn({ x: 20, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 40 });
      mockStore.current = baseState({ vectorByCorridorsSettings: settings });
      return tilesOf(makeRenderer()).map((tile) => tile.key);
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
    mockStore.current = baseState({ vectorByCorridorsSettings: legacyRound });
    const renderer = makeRenderer();
    const corridors = (renderer as unknown as { corridors: {
      moveTo: ReturnType<typeof vi.fn>;
      lineTo: ReturnType<typeof vi.fn>;
    } }).corridors;
    // A straight line from the node centre to the face midpoint at half the corridor thickness.
    expect(corridors.moveTo).toHaveBeenCalledWith(center.x, center.y);
    expect(corridors.lineTo).toHaveBeenCalledWith(faceMid.x, faceMid.y);
  });
});
