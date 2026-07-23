import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import { presetEndpoint } from "../pixi/presetEndpoint";

vi.mock("../wasm/mazeService", () => ({
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
}));
vi.mock("../wasm/wasmLoader", () => ({
  initWasm: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
  useMazeStore.setState({
    tessellationKind: "square",
    tessellationConfig: { type: "square", width: 3, height: 3 },
    isEditingField: false,
    fieldPoints: new Set<number>(),
    presetConnections: new Map(),
    lockedNodes: new Map(),
    autoLockedNodes: new Set(),
    autoLock: true,
  });
});

describe("mazeStore preset connections", () => {
  it("setPresetConnectionsTool updates tool", () => {
    useMazeStore.getState().setPresetConnectionsTool("passage");
    expect(useMazeStore.getState().presetConnectionsTool).toBe("passage");
  });

  it("applyPresetConnectionsTool('wall') sets a wall entry and marks presetsDirty", () => {
    useMazeStore.setState({ presetConnectionsTool: "wall" });
    useMazeStore.getState().applyPresetConnectionsTool("0,0-1,0", [0, 0], [1, 0]);
    const s = useMazeStore.getState();
    expect(s.presetConnections.get("0,0-1,0")?.state).toBe("wall");
    expect(s.presetsDirty).toBe(true);
  });

  it("applyPresetConnectionsTool('passage') sets a passage entry", () => {
    useMazeStore.setState({ presetConnectionsTool: "passage" });
    useMazeStore.getState().applyPresetConnectionsTool("0,0-1,0", [0, 0], [1, 0]);
    expect(useMazeStore.getState().presetConnections.get("0,0-1,0")?.state).toBe("passage");
  });

  it("applyPresetConnectionsTool recomputes autoLockedNodes when fully surrounding a cell", () => {
    // width=2 centers cells at x=-1 and x=0 (see configAllCells offset math)
    useMazeStore.setState({
      tessellationConfig: { type: "square", width: 2, height: 1 },
      presetConnectionsTool: "wall",
    });
    useMazeStore.getState().applyPresetConnectionsTool("-1,0-0,0", [-1, 0], [0, 0]);
    const s = useMazeStore.getState();
    expect(s.autoLockedNodes.has("-1,0")).toBe(true);
    expect(s.autoLockedNodes.has("0,0")).toBe(true);
  });

  it("applyPresetConnectionsReset clears an existing entry when default is undefined", () => {
    useMazeStore.setState({
      presetConnections: new Map([["0,0-1,0", { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "wall", source: "user" }]]),
    });
    useMazeStore.getState().applyPresetConnectionsReset("0,0-1,0");
    expect(useMazeStore.getState().presetConnections.has("0,0-1,0")).toBe(false);
  });

  it("applyPresetConnectionsReset materializes the current default as a source:\"default\" entry", () => {
    useMazeStore.setState({
      defaultEdgeState: "wall",
      presetConnections: new Map([["0,0-1,0", { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "passage", source: "user" }]]),
    });
    useMazeStore.getState().applyPresetConnectionsReset("0,0-1,0");
    expect(useMazeStore.getState().presetConnections.get("0,0-1,0")).toMatchObject({ state: "wall", source: "default" });
  });

  it("applyPresetConnectionsReset recomputes autoLockedNodes when the materialized default fully surrounds a cell", () => {
    // width=2 centers cells at x=-1 and x=0 (see configAllCells offset math)
    useMazeStore.setState({
      tessellationConfig: { type: "square", width: 2, height: 1 },
      defaultEdgeState: "wall",
      presetConnections: new Map([["-1,0-0,0", { from: presetEndpoint([-1, 0]), to: presetEndpoint([0, 0]), state: "undefined", source: "user" }]]),
    });
    useMazeStore.getState().applyPresetConnectionsReset("-1,0-0,0");
    const s = useMazeStore.getState();
    expect(s.autoLockedNodes.has("-1,0")).toBe(true);
    expect(s.autoLockedNodes.has("0,0")).toBe(true);
  });

  it("applyPresetConnectionsReset is no-op for missing key", () => {
    useMazeStore.getState().applyPresetConnectionsReset("9,9-9,8");
    expect(useMazeStore.getState().presetConnections.size).toBe(0);
  });

  it("clearInvalidPresetConnections removes entries outside the field", () => {
    useMazeStore.setState({
      tessellationConfig: { type: "square", width: 1, height: 1 },
      presetConnections: new Map([["5,5-6,5", { from: presetEndpoint([5, 5]), to: presetEndpoint([6, 5]), state: "wall", source: "user" }]]),
    });
    useMazeStore.getState().clearInvalidPresetConnections();
    expect(useMazeStore.getState().presetConnections.size).toBe(0);
  });

  it("clearInvalidPresetConnections clears start/finish markers that fall outside the field", () => {
    useMazeStore.setState({
      tessellationConfig: { type: "square", width: 1, height: 1 },
      presetStart: presetEndpoint([5, 5]),
      presetFinish: presetEndpoint([0, 0]),
    });
    useMazeStore.getState().clearInvalidPresetConnections();
    const s = useMazeStore.getState();
    expect(s.presetStart).toBeNull();
    expect(s.presetFinish).toEqual(presetEndpoint([0, 0]));
  });

  it("resetPresetConnections clears all preset state", () => {
    useMazeStore.setState({
      presetConnections: new Map([["0,0-1,0", { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "wall", source: "user" }]]),
      defaultEdgeState: "wall",
      presetStart: presetEndpoint([0, 0]),
      presetFinish: presetEndpoint([1, 1]),
      presetGenSource: presetEndpoint([2, 2]),
      lockedNodes: new Map([["0,0", "both"]]),
      autoLockedNodes: new Set(["0,0"]),
    });
    useMazeStore.getState().resetPresetConnections();
    const s = useMazeStore.getState();
    expect(s.presetConnections.size).toBe(0);
    expect(s.defaultEdgeState).toBe("undefined");
    expect(s.presetStart).toBeNull();
    expect(s.presetFinish).toBeNull();
    expect(s.presetGenSource).toBeNull();
    expect(s.lockedNodes.size).toBe(0);
    expect(s.autoLockedNodes.size).toBe(0);
  });

  it("setPresetStart/Finish/GenSource update respective cells", () => {
    useMazeStore.getState().setPresetStart([1, 1]);
    useMazeStore.getState().setPresetFinish([2, 2]);
    useMazeStore.getState().setPresetGenSource([3, 3]);
    const s = useMazeStore.getState();
    expect(s.presetStart).toEqual(presetEndpoint([1, 1]));
    expect(s.presetFinish).toEqual(presetEndpoint([2, 2]));
    expect(s.presetGenSource).toEqual(presetEndpoint([3, 3]));
  });

  it("setDefaultEdgeState('wall') fills all interior edges as walls", () => {
    // width=2 centers cells at x=-1 and x=0 (see configAllCells offset math)
    useMazeStore.setState({ tessellationConfig: { type: "square", width: 2, height: 1 } });
    useMazeStore.getState().setDefaultEdgeState("wall");
    const s = useMazeStore.getState();
    expect(s.defaultEdgeState).toBe("wall");
    expect(s.presetConnections.get("-1,0-0,0")?.state).toBe("wall");
    expect(s.presetConnections.get("-1,0-0,0")?.source).toBe("default");
  });

  it("setDefaultEdgeState('undefined') removes default-sourced entries", () => {
    useMazeStore.setState({
      tessellationConfig: { type: "square", width: 2, height: 1 },
      presetConnections: new Map([["-1,0-0,0", { from: presetEndpoint([-1, 0]), to: presetEndpoint([0, 0]), state: "wall", source: "default" }]]),
    });
    useMazeStore.getState().setDefaultEdgeState("undefined");
    expect(useMazeStore.getState().presetConnections.size).toBe(0);
  });

  it("setHighlightInvalidPresets / setHighlightIsolatedNodes toggle flags", () => {
    useMazeStore.getState().setHighlightInvalidPresets(true);
    useMazeStore.getState().setHighlightIsolatedNodes(true);
    const s = useMazeStore.getState();
    expect(s.highlightInvalidPresets).toBe(true);
    expect(s.highlightIsolatedNodes).toBe(true);
  });

  it("setShowPresetOrigin toggles flag", () => {
    useMazeStore.getState().setShowPresetOrigin(true);
    expect(useMazeStore.getState().showPresetOrigin).toBe(true);
  });

  it("setLockedNode adds a lock entry", () => {
    useMazeStore.getState().setLockedNode(2, 3, "both");
    expect(useMazeStore.getState().lockedNodes.get("2,3")).toBe("both");
  });

  it("removeLockedNode removes an existing entry", () => {
    useMazeStore.setState({ lockedNodes: new Map([["2,3", "both"]]) });
    useMazeStore.getState().removeLockedNode(2, 3);
    expect(useMazeStore.getState().lockedNodes.has("2,3")).toBe(false);
  });

  it("removeLockedNode is no-op for missing key", () => {
    useMazeStore.getState().removeLockedNode(9, 9);
    expect(useMazeStore.getState().lockedNodes.size).toBe(0);
  });

  it("clearLockedNodes empties locks and autoLocks", () => {
    useMazeStore.setState({ lockedNodes: new Map([["0,0", "both"]]), autoLockedNodes: new Set(["0,0"]) });
    useMazeStore.getState().clearLockedNodes();
    const s = useMazeStore.getState();
    expect(s.lockedNodes.size).toBe(0);
    expect(s.autoLockedNodes.size).toBe(0);
  });

  it("setAutoLock(false) clears autoLockedNodes", () => {
    useMazeStore.setState({ autoLock: true, autoLockedNodes: new Set(["0,0"]) });
    useMazeStore.getState().setAutoLock(false);
    const s = useMazeStore.getState();
    expect(s.autoLock).toBe(false);
    expect(s.autoLockedNodes.size).toBe(0);
  });

  it("setAutoLock(true) recomputes autoLockedNodes", () => {
    // width=2 centers cells at x=-1 and x=0 (see configAllCells offset math)
    useMazeStore.setState({
      tessellationConfig: { type: "square", width: 2, height: 1 },
      presetConnections: new Map([["-1,0-0,0", { from: presetEndpoint([-1, 0]), to: presetEndpoint([0, 0]), state: "wall", source: "user" }]]),
      autoLock: false,
      autoLockedNodes: new Set(),
    });
    useMazeStore.getState().setAutoLock(true);
    const s = useMazeStore.getState();
    expect(s.autoLock).toBe(true);
    expect(s.autoLockedNodes.has("-1,0")).toBe(true);
  });

  describe("preset split nodes (GitHub issue #231)", () => {
    it("addPresetSplitNode mints slot 0 and sets it active", () => {
      useMazeStore.getState().addPresetSplitNode([0, 0]);
      const s = useMazeStore.getState();
      expect(s.presetSplitPoints["0,0"]).toEqual([0]);
      expect(s.presetActiveSplitNode["0,0"]).toEqual(presetEndpoint([0, 0], 0));
      expect(s.presetsDirty).toBe(true);
    });

    it("addPresetSplitNode mints the next slot after an existing one", () => {
      useMazeStore.setState({ presetSplitPoints: { "0,0": [0] } });
      useMazeStore.getState().addPresetSplitNode([0, 0]);
      expect(useMazeStore.getState().presetSplitPoints["0,0"]).toEqual([0, 1]);
    });

    it("removePresetSplitNode removes the slot and clears referencing connections/teleports", () => {
      useMazeStore.setState({
        presetSplitPoints: { "0,0": [0] },
        presetConnections: new Map([
          ["0,0:0-1,0", { from: presetEndpoint([0, 0], 0), to: presetEndpoint([1, 0]), state: "passage", source: "user" }],
        ]),
        presetTeleports: [{ id: 1, from: presetEndpoint([0, 0], 0), to: presetEndpoint([5, 5]), direction: "forward" }],
      });
      useMazeStore.getState().removePresetSplitNode([0, 0], 0);
      const s = useMazeStore.getState();
      expect(s.presetSplitPoints["0,0"]).toBeUndefined();
      expect(s.presetConnections.size).toBe(0);
      expect(s.presetTeleports).toHaveLength(0);
      expect(s.presetsDirty).toBe(true);
    });

    it("removePresetSplitNode clears the active-slot entry when the removed slot was active", () => {
      useMazeStore.setState({
        presetSplitPoints: { "0,0": [0] },
        presetActiveSplitNode: { "0,0": presetEndpoint([0, 0], 0) },
      });
      useMazeStore.getState().removePresetSplitNode([0, 0], 0);
      expect(useMazeStore.getState().presetActiveSplitNode["0,0"]).toBeUndefined();
    });

    it("removePresetSplitNode leaves an unrelated connection untouched", () => {
      const untouched = { from: presetEndpoint([2, 2]), to: presetEndpoint([3, 2]), state: "wall" as const, source: "user" as const };
      useMazeStore.setState({
        presetSplitPoints: { "0,0": [0] },
        presetConnections: new Map([["2,2-3,2", untouched]]),
      });
      useMazeStore.getState().removePresetSplitNode([0, 0], 0);
      expect(useMazeStore.getState().presetConnections.get("2,2-3,2")).toEqual(untouched);
    });

    it("removePresetSplitNode is rejected when the slot is assigned as presetStart, and does not mutate state", () => {
      useMazeStore.setState({
        presetSplitPoints: { "0,0": [0] },
        presetStart: presetEndpoint([0, 0], 0),
      });
      useMazeStore.getState().removePresetSplitNode([0, 0], 0);
      const s = useMazeStore.getState();
      expect(s.presetSplitPoints["0,0"]).toEqual([0]);
      expect(s.error).toContain("start/finish/gen-source");
    });

    it("removePresetSplitNode is rejected when the slot is assigned as presetFinish", () => {
      useMazeStore.setState({
        presetSplitPoints: { "0,0": [0] },
        presetFinish: presetEndpoint([0, 0], 0),
      });
      useMazeStore.getState().removePresetSplitNode([0, 0], 0);
      expect(useMazeStore.getState().presetSplitPoints["0,0"]).toEqual([0]);
    });

    it("removePresetSplitNode is rejected when the slot is assigned as presetGenSource", () => {
      useMazeStore.setState({
        presetSplitPoints: { "0,0": [0] },
        presetGenSource: presetEndpoint([0, 0], 0),
      });
      useMazeStore.getState().removePresetSplitNode([0, 0], 0);
      expect(useMazeStore.getState().presetSplitPoints["0,0"]).toEqual([0]);
    });

    it("cyclePresetActiveSplitNode cycles original -> slot 0 -> back to original", () => {
      useMazeStore.setState({ presetSplitPoints: { "0,0": [0] } });
      useMazeStore.getState().cyclePresetActiveSplitNode([0, 0]);
      expect(useMazeStore.getState().presetActiveSplitNode["0,0"]).toEqual(presetEndpoint([0, 0], 0));
      useMazeStore.getState().cyclePresetActiveSplitNode([0, 0]);
      expect(useMazeStore.getState().presetActiveSplitNode["0,0"]).toBeUndefined();
    });

    it("setPresetActiveSplitNode sets a specific slot active, and clears the entry for the original node", () => {
      useMazeStore.setState({ presetSplitPoints: { "0,0": [0] } });
      useMazeStore.getState().setPresetActiveSplitNode([0, 0], presetEndpoint([0, 0], 0));
      expect(useMazeStore.getState().presetActiveSplitNode["0,0"]).toEqual(presetEndpoint([0, 0], 0));
      useMazeStore.getState().setPresetActiveSplitNode([0, 0], presetEndpoint([0, 0]));
      expect(useMazeStore.getState().presetActiveSplitNode["0,0"]).toBeUndefined();
    });

    it("setPresetFocusedPoint sets and clears the focused point", () => {
      useMazeStore.getState().setPresetFocusedPoint([1, 2]);
      expect(useMazeStore.getState().presetFocusedPoint).toEqual([1, 2]);
      useMazeStore.getState().setPresetFocusedPoint(null);
      expect(useMazeStore.getState().presetFocusedPoint).toBeNull();
    });
  });
});
