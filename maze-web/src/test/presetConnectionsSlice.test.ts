import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import { presetEndpoint, presetEndpointsEqual } from "../pixi/presetEndpoint";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

/** Patches the active floor's own field config — presetConnectionsSlice reads tessellationConfig/
 * fieldPoints/isEditingField through floorFields[activeFloorId] (GitHub issue #338). */
function setActiveFieldConfig(patch: { tessellationConfig?: TessellationConfig; isEditingField?: boolean; fieldPoints?: Set<number> }) {
  const state = useMazeStore.getState();
  useMazeStore.setState({
    floorFields: {
      ...state.floorFields,
      [state.activeFloorId]: { ...state.floorFields[state.activeFloorId], ...patch },
    },
  });
}

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
    presetConnections: new Map(),
    lockedNodes: new Map(),
    autoLockedNodes: new Set(),
    autoLock: true,
    defaultEdgeState: "undefined",
  });
  setActiveFieldConfig({ tessellationConfig: { type: "square", width: 3, height: 3 }, isEditingField: false, fieldPoints: new Set<number>() });
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
    setActiveFieldConfig({ tessellationConfig: { type: "square", width: 2, height: 1 } });
    useMazeStore.setState({ presetConnectionsTool: "wall" });
    useMazeStore.getState().applyPresetConnectionsTool("-1,0-0,0", [-1, 0], [0, 0]);
    const s = useMazeStore.getState();
    expect(s.autoLockedNodes.has("-1,0")).toBe(true);
    expect(s.autoLockedNodes.has("0,0")).toBe(true);
  });

  it("applyPresetConnectionsToolAt('reset', ...) clears an existing entry when default is undefined", () => {
    useMazeStore.setState({
      presetConnections: new Map([["0,0-1,0", { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "wall", source: "user" }]]),
    });
    useMazeStore.getState().applyPresetConnectionsToolAt("reset", "0,0-1,0", [0, 0], [1, 0]);
    expect(useMazeStore.getState().presetConnections.has("0,0-1,0")).toBe(false);
  });

  it("applyPresetConnectionsToolAt('reset', ...) materializes the current default as a source:\"default\" entry", () => {
    useMazeStore.setState({
      defaultEdgeState: "wall",
      presetConnections: new Map([["0,0-1,0", { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "passage", source: "user" }]]),
    });
    useMazeStore.getState().applyPresetConnectionsToolAt("reset", "0,0-1,0", [0, 0], [1, 0]);
    expect(useMazeStore.getState().presetConnections.get("0,0-1,0")).toMatchObject({ state: "wall", source: "default" });
  });

  it("applyPresetConnectionsToolAt('reset', ...) recomputes autoLockedNodes when the materialized default fully surrounds a cell", () => {
    // width=2 centers cells at x=-1 and x=0 (see configAllCells offset math)
    setActiveFieldConfig({ tessellationConfig: { type: "square", width: 2, height: 1 } });
    useMazeStore.setState({
      defaultEdgeState: "wall",
      presetConnections: new Map([["-1,0-0,0", { from: presetEndpoint([-1, 0]), to: presetEndpoint([0, 0]), state: "undefined", source: "user" }]]),
    });
    useMazeStore.getState().applyPresetConnectionsToolAt("reset", "-1,0-0,0", [-1, 0], [0, 0]);
    const s = useMazeStore.getState();
    expect(s.autoLockedNodes.has("-1,0")).toBe(true);
    expect(s.autoLockedNodes.has("0,0")).toBe(true);
  });

  it("applyPresetConnectionsToolAt('reset', ...) is no-op for missing key", () => {
    useMazeStore.getState().applyPresetConnectionsToolAt("reset", "9,9-9,8", [9, 9], [9, 8]);
    expect(useMazeStore.getState().presetConnections.size).toBe(0);
  });

  it("applyPresetConnectionsToolAt('reset', ...) resolves the level-suffixed key on floor 1, not the bare geometric key (GitHub issue #433)", () => {
    const state = useMazeStore.getState();
    useMazeStore.setState({
      floors: [{ id: "f0", title: "Floor 1" }, { id: "f1", title: "Floor 2" }],
      activeFloorId: "f1",
      floorFields: { ...state.floorFields, f0: state.floorFields[state.activeFloorId], f1: state.floorFields[state.activeFloorId] },
      presetConnections: new Map([["0,0@1-1,0@1", { from: presetEndpoint([0, 0], undefined, 1), to: presetEndpoint([1, 0], undefined, 1), state: "wall", source: "user" }]]),
    });
    useMazeStore.getState().applyPresetConnectionsToolAt("reset", "0,0-1,0", [0, 0], [1, 0]);
    expect(useMazeStore.getState().presetConnections.has("0,0@1-1,0@1")).toBe(false);
  });

  it("clearInvalidPresetConnections removes entries outside the field", () => {
    setActiveFieldConfig({ tessellationConfig: { type: "square", width: 1, height: 1 } });
    useMazeStore.setState({
      presetConnections: new Map([["5,5-6,5", { from: presetEndpoint([5, 5]), to: presetEndpoint([6, 5]), state: "wall", source: "user" }]]),
    });
    useMazeStore.getState().clearInvalidPresetConnections();
    expect(useMazeStore.getState().presetConnections.size).toBe(0);
  });

  it("clearInvalidPresetConnections clears start/finish markers that fall outside the field", () => {
    setActiveFieldConfig({ tessellationConfig: { type: "square", width: 1, height: 1 } });
    useMazeStore.setState({
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
    setActiveFieldConfig({ tessellationConfig: { type: "square", width: 2, height: 1 } });
    useMazeStore.getState().setDefaultEdgeState("wall");
    const s = useMazeStore.getState();
    expect(s.defaultEdgeState).toBe("wall");
    expect(s.presetConnections.get("-1,0-0,0")?.state).toBe("wall");
    expect(s.presetConnections.get("-1,0-0,0")?.source).toBe("default");
  });

  it("setDefaultEdgeState('undefined') removes default-sourced entries", () => {
    setActiveFieldConfig({ tessellationConfig: { type: "square", width: 2, height: 1 } });
    useMazeStore.setState({
      presetConnections: new Map([["-1,0-0,0", { from: presetEndpoint([-1, 0]), to: presetEndpoint([0, 0]), state: "wall", source: "default" }]]),
    });
    useMazeStore.getState().setDefaultEdgeState("undefined");
    expect(useMazeStore.getState().presetConnections.size).toBe(0);
  });

  it("setDefaultEdgeState('wall') fills interior edges on every floor, not just the active one (GitHub issue #434)", () => {
    // width=2 centers cells at x=-1 and x=0 (see configAllCells offset math)
    const cfg: TessellationConfig = { type: "square", width: 2, height: 1 };
    const state = useMazeStore.getState();
    useMazeStore.setState({
      floors: [{ id: "f0", title: "Floor 1" }, { id: "f1", title: "Floor 2" }],
      activeFloorId: "f0",
      floorFields: {
        ...state.floorFields,
        f0: { ...state.floorFields[state.activeFloorId], tessellationConfig: cfg },
        f1: { ...state.floorFields[state.activeFloorId], tessellationConfig: cfg },
      },
    });
    useMazeStore.getState().setDefaultEdgeState("wall");
    const s = useMazeStore.getState();
    expect(s.presetConnections.get("-1,0-0,0")?.state).toBe("wall");
    expect(s.presetConnections.get("-1,0@1-0,0@1")?.state).toBe("wall");
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
    setActiveFieldConfig({ tessellationConfig: { type: "square", width: 2, height: 1 } });
    useMazeStore.setState({
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

  describe("resetPresetPoint (GitHub issue #340's \"clear\" tool)", () => {
    it("removes every connection with an endpoint at the point", () => {
      useMazeStore.setState({
        presetConnections: new Map([
          ["0,0-1,0", { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "wall", source: "user" }],
          ["0,0-0,1", { from: presetEndpoint([0, 0]), to: presetEndpoint([0, 1]), state: "passage", source: "user" }],
          ["2,2-3,2", { from: presetEndpoint([2, 2]), to: presetEndpoint([3, 2]), state: "wall", source: "user" }],
        ]),
      });
      useMazeStore.getState().resetPresetPoint([0, 0]);
      const s = useMazeStore.getState();
      expect(s.presetConnections.has("0,0-1,0")).toBe(false);
      expect(s.presetConnections.has("0,0-0,1")).toBe(false);
      expect(s.presetConnections.get("2,2-3,2")).toBeDefined();
      expect(s.presetsDirty).toBe(true);
    });

    it("removes every teleport with an endpoint at the point", () => {
      useMazeStore.setState({
        presetTeleports: [
          { id: 1, from: presetEndpoint([0, 0]), to: presetEndpoint([5, 5]), direction: "forward" },
          { id: 2, from: presetEndpoint([1, 1]), to: presetEndpoint([2, 2]), direction: "forward" },
        ],
      });
      useMazeStore.getState().resetPresetPoint([0, 0]);
      const s = useMazeStore.getState();
      expect(s.presetTeleports.map((t) => t.id)).toEqual([2]);
    });

    it("removes the point's declared split slots and active-slot selection", () => {
      useMazeStore.setState({
        presetSplitPoints: { "0,0": [0, 1], "2,2": [0] },
        presetActiveSplitNode: { "0,0": presetEndpoint([0, 0], 0) },
      });
      useMazeStore.getState().resetPresetPoint([0, 0]);
      const s = useMazeStore.getState();
      expect(s.presetSplitPoints["0,0"]).toBeUndefined();
      expect(s.presetSplitPoints["2,2"]).toEqual([0]);
      expect(s.presetActiveSplitNode["0,0"]).toBeUndefined();
    });

    it("clears presetStart/presetFinish/presetGenSource when they address the point", () => {
      useMazeStore.setState({
        presetStart: presetEndpoint([0, 0]),
        presetFinish: presetEndpoint([1, 1]),
        presetGenSource: presetEndpoint([0, 0]),
      });
      useMazeStore.getState().resetPresetPoint([0, 0]);
      const s = useMazeStore.getState();
      expect(s.presetStart).toBeNull();
      expect(s.presetFinish).toEqual(presetEndpoint([1, 1]));
      expect(s.presetGenSource).toBeNull();
    });

    it("removes the point's own locked-node entry", () => {
      useMazeStore.setState({ lockedNodes: new Map([["0,0", "both"], ["1,1", "in"]]) });
      useMazeStore.getState().resetPresetPoint([0, 0]);
      const s = useMazeStore.getState();
      expect(s.lockedNodes.has("0,0")).toBe(false);
      expect(s.lockedNodes.get("1,1")).toBe("in");
    });

    it("also removes a slot's endpoints — a connection addressing a declared slot at the point is cleared too", () => {
      useMazeStore.setState({
        presetSplitPoints: { "0,0": [0] },
        presetConnections: new Map([
          ["0,0:0-1,0", { from: presetEndpoint([0, 0], 0), to: presetEndpoint([1, 0]), state: "passage", source: "user" }],
        ]),
      });
      useMazeStore.getState().resetPresetPoint([0, 0]);
      expect(useMazeStore.getState().presetConnections.size).toBe(0);
    });

    it("is a no-op (still recomputes, no error) when nothing at the point", () => {
      useMazeStore.getState().resetPresetPoint([9, 9]);
      expect(useMazeStore.getState().error).toBeNull();
    });
  });

  describe("applyPresetSplitBlueprint (GitHub issue #235)", () => {
    // Square field is centered on the origin (`ox = floor(width/2)`, see `configAllCells`) —
    // width 9 covers x,y in [-4, 4], wide enough for the origin plus every one of its neighbors.
    const wideField = { type: "square" as const, width: 9, height: 9 };
    const square = { id: 0, degree: 4, nodeFaces: [[0, 2], [1, 3]] };

    it("mints one slot per extra blueprint node and wires passage connections to in-field neighbors", () => {
      setActiveFieldConfig({ tessellationConfig: wideField });
      useMazeStore.setState({ presetSplitPoints: {}, presetActiveSplitNode: {} });
      useMazeStore.getState().applyPresetSplitBlueprint([0, 0], square);
      const s = useMazeStore.getState();
      expect(s.presetSplitPoints["0,0"]).toEqual([0]);
      const slot0 = presetEndpoint([0, 0], 0);
      // node0 faces [0,2] = E,W -> neighbors (1,0), (-1,0)
      expect(s.presetConnections.get("-1,0-0,0")?.state).toBe("passage");
      expect(s.presetConnections.get("0,0-1,0")?.state).toBe("passage");
      // node0's other two faces (N,S — not required by node0) get an explicit wall, not left undefined
      expect(s.presetConnections.get("0,0-0,1")?.state).toBe("wall");
      expect(s.presetConnections.get("0,-1-0,0")?.state).toBe("wall");
      // node1 (slot0) faces [1,3] = N,S -> neighbors (0,1), (0,-1); its E,W faces get an explicit wall
      const slotConnections = [...s.presetConnections.values()].filter((e) => presetEndpointsEqual(e.from, slot0) || presetEndpointsEqual(e.to, slot0));
      expect(slotConnections).toHaveLength(4);
      const slotPassages = slotConnections.filter((e) => e.state === "passage");
      const slotWalls = slotConnections.filter((e) => e.state === "wall");
      expect(slotPassages).toHaveLength(2);
      expect(slotWalls).toHaveLength(2);
      expect(s.presetsDirty).toBe(true);
    });

    it("replaces an existing split point entirely, dropping stale slots/connections", () => {
      const staleTarget = presetEndpoint([0, 0], 5);
      setActiveFieldConfig({ tessellationConfig: wideField });
      useMazeStore.setState({
        presetSplitPoints: { "0,0": [5] },
        presetConnections: new Map([["0,0:5-5,5", { from: staleTarget, to: presetEndpoint([5, 5]), state: "passage" as const, source: "user" as const }]]),
      });
      useMazeStore.getState().applyPresetSplitBlueprint([0, 0], square);
      const s = useMazeStore.getState();
      expect(s.presetSplitPoints["0,0"]).toEqual([0]);
      expect(s.presetConnections.has("0,0:5-5,5")).toBe(false);
    });

    it("rejects applying a blueprint while an existing slot is assigned as presetStart", () => {
      setActiveFieldConfig({ tessellationConfig: wideField });
      useMazeStore.setState({
        presetSplitPoints: { "0,0": [0] },
        presetStart: presetEndpoint([0, 0], 0),
      });
      useMazeStore.getState().applyPresetSplitBlueprint([0, 0], square);
      const s = useMazeStore.getState();
      expect(s.presetSplitPoints["0,0"]).toEqual([0]);
      expect(s.error).toContain("start/finish/gen-source");
    });

    it("skips a face index beyond the tile's real degree instead of throwing (blueprint authored for a different degree)", () => {
      // Square tiles have 4 faces (offsets.length === 4) — a hex blueprint's face index 5 has
      // nothing to destructure from `offsets[5]` on a square tile.
      const oversized = { id: 0, degree: 6, nodeFaces: [[0, 5]] };
      setActiveFieldConfig({ tessellationConfig: wideField });
      useMazeStore.setState({ presetSplitPoints: {}, presetActiveSplitNode: {} });
      expect(() => useMazeStore.getState().applyPresetSplitBlueprint([0, 0], oversized)).not.toThrow();
      // Face 0 (in range) still wires normally; face 5 (out of range) is silently skipped.
      expect(useMazeStore.getState().presetConnections.get("0,0-1,0")?.state).toBe("passage");
    });

    it("skips a face pointing outside the field instead of writing a connection to it", () => {
      // width=3 centers cells at x,y in [-1, 1] — the origin's east neighbor (1,0) is in-field,
      // but its own east neighbor (2,0) (face 0 of a shifted point) would be out of field.
      const narrowField = { type: "square" as const, width: 1, height: 1 };
      setActiveFieldConfig({ tessellationConfig: narrowField });
      useMazeStore.setState({ presetSplitPoints: {}, presetActiveSplitNode: {} });
      useMazeStore.getState().applyPresetSplitBlueprint([0, 0], square);
      const s = useMazeStore.getState();
      // Every face of (0,0) points outside a 1x1 field — no connection should be written at all.
      expect(s.presetConnections.size).toBe(0);
    });

    it("clears presetSplitPoints for a single-node blueprint (no extra slots to mint)", () => {
      const singleNode = { id: 0, degree: 4, nodeFaces: [[0, 2]] };
      setActiveFieldConfig({ tessellationConfig: wideField });
      useMazeStore.setState({
        presetSplitPoints: { "0,0": [0, 1] },
        presetActiveSplitNode: {},
        presetStart: null,
        presetFinish: null,
        presetGenSource: null,
      });
      useMazeStore.getState().applyPresetSplitBlueprint([0, 0], singleNode);
      expect(useMazeStore.getState().presetSplitPoints["0,0"]).toBeUndefined();
    });

    it("wires two adjacent split points to each other's real connecting slot, not the active one (GitHub issue #243)", () => {
      // Square offsets: index0=E(1,0) index1=S(0,1) index2=W(-1,0) index3=N(0,-1)
      // node0(original): S,N faces. node1(slot0): E,W faces — slot0 is the node that actually
      // faces the neighboring cell on either side.
      const eastWestBlueprint = { id: 0, degree: 4, nodeFaces: [[1, 3], [0, 2]] };
      setActiveFieldConfig({ tessellationConfig: wideField });
      useMazeStore.setState({ presetSplitPoints: {}, presetActiveSplitNode: {} });

      useMazeStore.getState().applyPresetSplitBlueprint([0, 0], eastWestBlueprint);
      useMazeStore.getState().applyPresetSplitBlueprint([1, 0], eastWestBlueprint);
      const s = useMazeStore.getState();

      const c1Slot0 = presetEndpoint([0, 0], 0);
      const c2Slot0 = presetEndpoint([1, 0], 0);
      const realEntry = s.presetConnections.get("0,0:0-1,0:0");
      expect(realEntry?.state).toBe("passage");
      expect(realEntry?.from).toEqual(c1Slot0);
      expect(realEntry?.to).toEqual(c2Slot0);

      // No entry should wrongly link either cell's original (non-connecting) node to the other cell
      // as a passage — and every one of those non-connecting pairs gets an explicit `wall`, not an
      // undecided gap (GitHub issue #243 follow-up).
      expect(s.presetConnections.get("0,0-1,0")?.state).toBe("wall");
      expect(s.presetConnections.get("0,0-1,0:0")?.state).toBe("wall");
      expect(s.presetConnections.get("0,0:0-1,0")?.state).toBe("wall");
    });
  });

  describe("preset vertical passages/elevators (GitHub issue #357)", () => {
    const FLOOR_2_ID = "floor_2";

    beforeEach(() => {
      // The outer beforeEach's `baseStoreState()` shallow-merges (zustand `setState`, not a
      // replace) and doesn't mention these fields, so a prior test's entries would otherwise leak
      // into the next one.
      useMazeStore.setState({
        presetVerticalPassages: [], presetVerticalPassagePending: null,
        presetElevators: [], presetElevatorPending: null,
      });
    });

    // Two floors, both with a real cell at (0,0) (isEditingField: false -> every in-bounds point
    // exists, same convention setActiveFieldConfig's own default relies on).
    function setTwoFloors() {
      const state = useMazeStore.getState();
      useMazeStore.setState({
        floors: [...state.floors, { id: FLOOR_2_ID, title: "Floor 2" }],
        floorFields: {
          ...state.floorFields,
          [FLOOR_2_ID]: { ...state.floorFields[state.activeFloorId], tessellationConfig: { type: "square", width: 3, height: 3 } },
        },
      });
    }

    it("startPresetVerticalPassagePlacement commits immediately when only one direction is available (origin on floor 0)", () => {
      setTwoFloors();
      useMazeStore.getState().startPresetVerticalPassagePlacement(presetEndpoint([0, 0]), "vertical_passage_two_way");
      const s = useMazeStore.getState();
      // Floor 0 has no floor below it, so "up" (to floor 1) is the only available direction —
      // no dialog, the passage is created right away.
      expect(s.presetVerticalPassagePending).toBeNull();
      expect(s.presetVerticalPassages).toHaveLength(1);
      expect(s.presetVerticalPassages[0].from).toEqual(presetEndpoint([0, 0]));
      expect(s.presetVerticalPassages[0].to).toEqual(presetEndpoint([0, 0], undefined, 1));
      expect(s.presetVerticalPassages[0].direction).toBe("two_way");
    });

    it("startPresetVerticalPassagePlacement opens the direction dialog when both up and down are available", () => {
      setTwoFloors();
      useMazeStore.setState({
        floors: [...useMazeStore.getState().floors, { id: "floor_3", title: "Floor 3" }],
        floorFields: {
          ...useMazeStore.getState().floorFields,
          floor_3: { ...useMazeStore.getState().floorFields[FLOOR_2_ID] },
        },
      });
      // Origin on floor 1 (the middle floor) has both a floor below (0) and above (2).
      useMazeStore.getState().startPresetVerticalPassagePlacement(presetEndpoint([0, 0], undefined, 1), "vertical_passage_one_way");
      const s = useMazeStore.getState();
      expect(s.presetVerticalPassagePending).not.toBeNull();
      expect(s.presetVerticalPassagePending?.availableDirections.sort()).toEqual(["down", "up"]);
      expect(s.presetVerticalPassages).toHaveLength(0);
    });

    it("startPresetVerticalPassagePlacement is a no-op when neither direction has a cell", () => {
      // Single floor -> no floor above, and origin is already floor 0 -> no floor below either.
      useMazeStore.getState().startPresetVerticalPassagePlacement(presetEndpoint([0, 0]), "vertical_passage_two_way");
      const s = useMazeStore.getState();
      expect(s.presetVerticalPassagePending).toBeNull();
      expect(s.presetVerticalPassages).toHaveLength(0);
    });

    it("choosePresetVerticalPassageDirection('down') creates a passage to the floor below and clears the pending dialog", () => {
      setTwoFloors();
      useMazeStore.setState({
        floors: [...useMazeStore.getState().floors, { id: "floor_3", title: "Floor 3" }],
        floorFields: {
          ...useMazeStore.getState().floorFields,
          floor_3: { ...useMazeStore.getState().floorFields[FLOOR_2_ID] },
        },
      });
      useMazeStore.getState().startPresetVerticalPassagePlacement(presetEndpoint([0, 0], undefined, 1), "vertical_passage_two_way");
      useMazeStore.getState().choosePresetVerticalPassageDirection("down");
      const s = useMazeStore.getState();
      expect(s.presetVerticalPassagePending).toBeNull();
      expect(s.presetVerticalPassages).toHaveLength(1);
      // toLevel === 0 must normalize to `undefined`, not an explicit level: 0 — every `(level ?? 0)`
      // comparison downstream depends on this convention.
      expect(s.presetVerticalPassages[0].to).toEqual(presetEndpoint([0, 0]));
    });

    it("cancelPresetVerticalPassagePlacement clears the pending dialog without creating a passage", () => {
      setTwoFloors();
      useMazeStore.setState({
        floors: [...useMazeStore.getState().floors, { id: "floor_3", title: "Floor 3" }],
        floorFields: {
          ...useMazeStore.getState().floorFields,
          floor_3: { ...useMazeStore.getState().floorFields[FLOOR_2_ID] },
        },
      });
      useMazeStore.getState().startPresetVerticalPassagePlacement(presetEndpoint([0, 0], undefined, 1), "vertical_passage_two_way");
      useMazeStore.getState().cancelPresetVerticalPassagePlacement();
      const s = useMazeStore.getState();
      expect(s.presetVerticalPassagePending).toBeNull();
      expect(s.presetVerticalPassages).toHaveLength(0);
    });

    it("startPresetElevatorPlacement seeds pending.floors with only the origin's own level", () => {
      setTwoFloors();
      useMazeStore.getState().startPresetElevatorPlacement(presetEndpoint([0, 0]));
      expect(useMazeStore.getState().presetElevatorPending?.floors).toEqual(new Set([0]));
    });

    it("togglePresetElevatorFloor cannot remove the origin floor", () => {
      setTwoFloors();
      useMazeStore.getState().startPresetElevatorPlacement(presetEndpoint([0, 0]));
      useMazeStore.getState().togglePresetElevatorFloor(0);
      expect(useMazeStore.getState().presetElevatorPending?.floors).toEqual(new Set([0]));
    });

    it("confirmPresetElevatorPlacement is a no-op when fewer than two floors are selected", () => {
      setTwoFloors();
      useMazeStore.getState().startPresetElevatorPlacement(presetEndpoint([0, 0]));
      useMazeStore.getState().confirmPresetElevatorPlacement();
      const s = useMazeStore.getState();
      // Still pending (only the origin floor selected) -- nothing was created.
      expect(s.presetElevatorPending).not.toBeNull();
      expect(s.presetElevators).toHaveLength(0);
    });

    it("confirmPresetElevatorPlacement creates one entry sorted by level, with level 0 normalized to undefined", () => {
      setTwoFloors();
      useMazeStore.getState().startPresetElevatorPlacement(presetEndpoint([0, 0], undefined, 1));
      useMazeStore.getState().togglePresetElevatorFloor(0);
      useMazeStore.getState().confirmPresetElevatorPlacement();
      const s = useMazeStore.getState();
      expect(s.presetElevatorPending).toBeNull();
      expect(s.presetElevators).toHaveLength(1);
      expect(s.presetElevators[0].floors).toEqual([presetEndpoint([0, 0]), presetEndpoint([0, 0], undefined, 1)]);
    });

    it("removePresetVerticalPassage removes the matching entry", () => {
      setTwoFloors();
      useMazeStore.getState().startPresetVerticalPassagePlacement(presetEndpoint([0, 0]), "vertical_passage_two_way");
      const id = useMazeStore.getState().presetVerticalPassages[0].id;
      useMazeStore.getState().removePresetVerticalPassage(id);
      expect(useMazeStore.getState().presetVerticalPassages).toHaveLength(0);
    });

    it("removePresetElevator removes the matching entry", () => {
      setTwoFloors();
      useMazeStore.getState().startPresetElevatorPlacement(presetEndpoint([0, 0]));
      useMazeStore.getState().togglePresetElevatorFloor(1);
      useMazeStore.getState().confirmPresetElevatorPlacement();
      const id = useMazeStore.getState().presetElevators[0].id;
      useMazeStore.getState().removePresetElevator(id);
      expect(useMazeStore.getState().presetElevators).toHaveLength(0);
    });
  });

  describe("applyPresetSplitTargetPick (GitHub issue #474)", () => {
    const FLOOR_2_ID = "floor_2";

    beforeEach(() => {
      useMazeStore.setState({
        presetStart: null, presetFinish: null,
        presetTeleports: [], presetTeleportPendingFrom: null,
        presetVerticalPassages: [], presetVerticalPassagePending: null,
        presetElevators: [], presetElevatorPending: null,
        presetSplitTargetPrompt: null,
      });
    });

    const openPrompt = (action: NonNullable<ReturnType<typeof useMazeStore.getState>["presetSplitTargetPrompt"]>["action"]) =>
      useMazeStore.getState().requestPresetSplitTarget({ point: [0, 0], slotIds: [0], action });

    it("set_start dispatches setPresetStartEndpoint to the picked slot and clears the prompt", () => {
      openPrompt({ tool: "set_start" });
      useMazeStore.getState().applyPresetSplitTargetPick(0);
      const s = useMazeStore.getState();
      expect(s.presetSplitTargetPrompt).toBeNull();
      expect(presetEndpointsEqual(s.presetStart!, presetEndpoint([0, 0], 0))).toBe(true);
    });

    it("set_finish with slotId undefined attaches to the original node", () => {
      openPrompt({ tool: "set_finish" });
      useMazeStore.getState().applyPresetSplitTargetPick(undefined);
      expect(presetEndpointsEqual(useMazeStore.getState().presetFinish!, presetEndpoint([0, 0]))).toBe(true);
    });

    it("teleport first pick sets the pending origin, second pick completes the link", () => {
      openPrompt({ tool: "teleport_two_way" });
      useMazeStore.getState().applyPresetSplitTargetPick(undefined);
      expect(presetEndpointsEqual(useMazeStore.getState().presetTeleportPendingFrom!, presetEndpoint([0, 0]))).toBe(true);

      useMazeStore.getState().requestPresetSplitTarget({ point: [1, 0], slotIds: [], action: { tool: "teleport_two_way" } });
      useMazeStore.getState().applyPresetSplitTargetPick(undefined);
      const s = useMazeStore.getState();
      expect(s.presetTeleportPendingFrom).toBeNull();
      expect(s.presetTeleports).toHaveLength(1);
      expect(s.presetTeleports[0]).toMatchObject({ direction: "two_way" });
      expect(presetEndpointsEqual(s.presetTeleports[0].from, presetEndpoint([0, 0]))).toBe(true);
      expect(presetEndpointsEqual(s.presetTeleports[0].to, presetEndpoint([1, 0]))).toBe(true);
    });

    it("elevator opens an elevator placement anchored on the picked slot", () => {
      // Elevator needs a second floor to be a valid placement anchor.
      const state = useMazeStore.getState();
      useMazeStore.setState({
        floors: [...state.floors, { id: FLOOR_2_ID, title: "Floor 2" }],
        floorFields: {
          ...state.floorFields,
          [FLOOR_2_ID]: { ...state.floorFields[state.activeFloorId], tessellationConfig: { type: "square", width: 3, height: 3 } },
        },
      });
      openPrompt({ tool: "elevator" });
      useMazeStore.getState().applyPresetSplitTargetPick(0);
      expect(presetEndpointsEqual(useMazeStore.getState().presetElevatorPending!.origin, presetEndpoint([0, 0], 0))).toBe(true);
    });

    it("vertical passage places a passage anchored on the picked slot, carrying the tool", () => {
      // A vertical passage needs a floor above to auto-commit (single available direction).
      const state = useMazeStore.getState();
      useMazeStore.setState({
        floors: [...state.floors, { id: FLOOR_2_ID, title: "Floor 2" }],
        floorFields: {
          ...state.floorFields,
          [FLOOR_2_ID]: { ...state.floorFields[state.activeFloorId], tessellationConfig: { type: "square", width: 3, height: 3 } },
        },
      });
      openPrompt({ tool: "vertical_passage_one_way" });
      useMazeStore.getState().applyPresetSplitTargetPick(0);
      const s = useMazeStore.getState();
      expect(s.presetVerticalPassages).toHaveLength(1);
      expect(presetEndpointsEqual(s.presetVerticalPassages[0].from, presetEndpoint([0, 0], 0))).toBe(true);
    });

    it("is a no-op when no prompt is open", () => {
      useMazeStore.getState().applyPresetSplitTargetPick(0);
      expect(useMazeStore.getState().presetStart).toBeNull();
    });

    it("cancelPresetSplitTarget drops the prompt without placing anything", () => {
      openPrompt({ tool: "set_start" });
      useMazeStore.getState().cancelPresetSplitTarget();
      const s = useMazeStore.getState();
      expect(s.presetSplitTargetPrompt).toBeNull();
      expect(s.presetStart).toBeNull();
    });
  });
});
