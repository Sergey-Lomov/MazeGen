import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState, mockSnapshot, resetGenerationMocks, baseFloorFieldConfig, TEST_FLOOR_ID } from "./storeTestHelpers";

vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
  getCellCenters: vi.fn((config: Parameters<typeof fakeCellCenters>[0]) => fakeCellCenters(config)),
}));
vi.mock("../wasm/wasmLoader", async (importActual) => ({
  ...(await importActual<typeof import("../wasm/wasmLoader")>()),
  initWasm: vi.fn(() => Promise.resolve()),
}));

import { generateMaze, computeAnalytics } from "../wasm/mazeService";
import { initWasm } from "../wasm/wasmLoader";
import { fakeCellCenters } from "./cellCentersFake";

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
  resetGenerationMocks(vi.mocked(generateMaze), vi.mocked(computeAnalytics), vi.mocked(initWasm));
});

// GitHub issue #425: a split point generated on floor index 1+ must keep its `postEditDraftEdges`/
// `postEditDraftSplitPoints` resolvable — `generateConfigBuilder.ts` used to build one global,
// level-unaware `pointNodeMap`/`generatedSplitPoints` across every floor's nodes combined, so a
// floor-0 node and a floor-1 node sharing the same (x, y) collided into one bogus split-point
// group, and `splitEndpoint` was never stamped with its floor's `level` at all. That made every
// split-point edge on any floor above the first fail to resolve on the very first render (shown
// as fully isolated cells in Post-Edit), without needing any user edit or confirm round-trip.
describe("generate() — multi-floor split points (GitHub issue #425)", () => {
  it("stamps generated split points and draft edges with their own floor's level", () => {
    const snapshot = {
      ...mockSnapshot,
      nodes: [
        { id: 1, x: 0, y: 0, i: 0, level: 0 },
        { id: 10, x: 0, y: 0, i: 0, level: 1 },
        { id: 11, x: 0, y: 0, i: 1, level: 1 },
        { id: 12, x: 1, y: 0, i: 0, level: 1 },
      ],
      edges: [
        { from: 10, to: 12, kind: "basic" as const },
        { from: 12, to: 10, kind: "basic" as const },
      ],
      start: 10,
      finish: 12,
    };
    vi.mocked(generateMaze).mockReturnValue({ snapshot, debugTape: undefined });
    vi.mocked(computeAnalytics).mockReturnValue(snapshot);

    useMazeStore.setState({
      seed: 7,
      randomSeed: false,
      rules: [],
      floors: [{ id: "floor_0", title: "Floor 1" }, { id: TEST_FLOOR_ID, title: "Floor 2" }],
      floorFields: {
        floor_0: baseFloorFieldConfig(),
        [TEST_FLOOR_ID]: baseFloorFieldConfig(),
      },
    });
    useMazeStore.getState().generate();

    const s = useMazeStore.getState();
    // The floor-1 split point must be registered under its own "@1"-suffixed key, not the bare
    // floor-0 key (which would collide with floor 0's own node at the same (x, y)).
    expect(s.postEditDraftSplitPoints["0,0@1"]).toEqual([0]);
    expect(s.postEditDraftSplitPoints["0,0"]).toBeUndefined();

    // Both directions of the split node's edge must resolve to a `split` endpoint carrying level 1.
    const edges = Object.values(s.postEditDraftEdges ?? {});
    expect(edges.length).toBe(2);
    for (const e of edges) {
      for (const ep of [e.from, e.to]) {
        if (ep.kind === "split") {
          expect(ep.level).toBe(1);
        }
      }
    }
  });
});
