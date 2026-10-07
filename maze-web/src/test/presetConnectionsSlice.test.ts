import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import { presetEndpoint, presetEndpointsEqual } from "../pixi/presetEndpoint";
import { buildPresetPointEntities } from "../pixi/pointEntities";
import * as m from "~/paraglide/messages";
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

  it("clears the split-node panel selection when another tool becomes active", () => {
    useMazeStore.setState({ presetConnectionsTool: "manage_split_nodes", presetFocusedPoint: [1, 2] });
    useMazeStore.getState().setPresetConnectionsTool("passage");
    expect(useMazeStore.getState().presetFocusedPoint).toBeNull();

    useMazeStore.setState({ presetFocusedPoint: [2, 3] });
    useMazeStore.getState().setPresetConnectionsTool("manage_split_nodes");
    expect(useMazeStore.getState().presetFocusedPoint).toEqual([2, 3]);
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

  it("cyclePresetConnectionDirection flips a one-way edge without changing its endpoints", () => {
    const from = presetEndpoint([0, 0]);
    const to = presetEndpoint([1, 0]);
    useMazeStore.setState({
      presetConnections: new Map([["0,0-1,0", { from, to, state: "one_way_forward", source: "user" }]]),
    });

    useMazeStore.getState().cyclePresetConnectionDirection("0,0-1,0");

    expect(useMazeStore.getState().presetConnections.get("0,0-1,0")).toEqual({
      from, to, state: "one_way_backward", source: "user",
    });
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

  it("applyPresetConnectionsToolAt('reset', ...) restores the selected default", () => {
    useMazeStore.setState({
      presetConnections: new Map([["0,0-1,0", { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "wall", source: "user" }]]),
    });
    useMazeStore.getState().applyPresetConnectionsToolAt("reset", "0,0-1,0", [0, 0], [1, 0]);
    expect(useMazeStore.getState().presetConnections.has("0,0-1,0")).toBe(false);
  });

  it("applyPresetConnectionsToolAt('reset', ...) restores wall instead of undefined", () => {
    useMazeStore.setState({
      defaultEdgeState: "wall",
      presetConnections: new Map([["0,0-1,0", { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "passage", source: "user" }]]),
    });
    useMazeStore.getState().applyPresetConnectionsToolAt("reset", "0,0-1,0", [0, 0], [1, 0]);
    expect(useMazeStore.getState().presetConnections.get("0,0-1,0")).toMatchObject({ state: "wall", source: "default" });
  });

  it("applyPresetConnectionsToolAt('reset', ...) restores the default and recomputes auto-locks", () => {
    // width=2 centers cells at x=-1 and x=0 (see configAllCells offset math)
    setActiveFieldConfig({ tessellationConfig: { type: "square", width: 2, height: 1 } });
    useMazeStore.setState({
      defaultEdgeState: "wall",
      presetConnections: new Map([["-1,0-0,0", { from: presetEndpoint([-1, 0]), to: presetEndpoint([0, 0]), state: "undefined", source: "user" }]]),
    });
    useMazeStore.getState().applyPresetConnectionsToolAt("reset", "-1,0-0,0", [-1, 0], [0, 0]);
    const s = useMazeStore.getState();
    expect(s.presetConnections.get("-1,0-0,0")).toMatchObject({ state: "wall", source: "default" });
    expect(s.autoLockedNodes.has("-1,0")).toBe(true);
    expect(s.autoLockedNodes.has("0,0")).toBe(true);
  });

  it("applyPresetConnectionsToolAt('reset', ...) ignores an edge without a user preset", () => {
    const before = useMazeStore.getState();
    useMazeStore.getState().applyPresetConnectionsToolAt("reset", "9,9-9,8", [9, 9], [9, 8]);
    const state = useMazeStore.getState();
    expect(state).toBe(before);
    expect(state.presetConnections.has("9,8-9,9")).toBe(false);
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

  it("clearInvalidPresetConnections clears a generation source outside the field", () => {
    setActiveFieldConfig({ tessellationConfig: { type: "square", width: 1, height: 1 } });
    useMazeStore.setState({ presetGenSource: presetEndpoint([5, 5]) });
    useMazeStore.getState().clearInvalidPresetConnections();
    expect(useMazeStore.getState().presetGenSource).toBeNull();
  });

  it("clearInvalidPresetConnections clears locks outside the field", () => {
    setActiveFieldConfig({ tessellationConfig: { type: "square", width: 1, height: 1 } });
    useMazeStore.setState({ lockedNodes: new Map([["5,5", "both"]]) });
    useMazeStore.getState().clearInvalidPresetConnections();
    expect(useMazeStore.getState().lockedNodes.size).toBe(0);
  });

  it("clearInvalidPresetConnections removes list metadata for invalid entities", () => {
    setActiveFieldConfig({ tessellationConfig: { type: "square", width: 1, height: 1 } });
    useMazeStore.setState({
      presetSplitPoints: { "99,99": [0] },
      presetSplitPointIds: { "99,99": "s1" },
      presetEntityOrder: ["split:99,99", "lock:99,99", "edge:5,5-6,5"],
      lockedNodes: new Map([["99,99", "in"]]),
      presetConnections: new Map([[
        "5,5-6,5",
        { from: presetEndpoint([5, 5]), to: presetEndpoint([6, 5]), state: "wall", source: "user" },
      ]]),
    });

    useMazeStore.getState().clearInvalidPresetConnections();

    const s = useMazeStore.getState();
    expect(s.presetSplitPoints).toEqual({});
    expect(s.presetSplitPointIds).toEqual({});
    expect(s.presetEntityOrder).toEqual([]);
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

  it("setShowPresetLocks toggles lock marker visibility", () => {
    expect(useMazeStore.getState().showPresetLocks).toBe(true);
    useMazeStore.getState().setShowPresetLocks(false);
    expect(useMazeStore.getState().showPresetLocks).toBe(false);
  });

  it("lock tools force lock marker visibility", () => {
    useMazeStore.getState().setShowPresetLocks(false);
    useMazeStore.getState().setPresetConnectionsTool("full_lock");
    expect(useMazeStore.getState().showPresetLocks).toBe(true);
    useMazeStore.getState().setPresetConnectionsTool("wall");
    expect(useMazeStore.getState().showPresetLocks).toBe(false);
  });

  it("restores enabled lock visibility after leaving lock tools", () => {
    useMazeStore.getState().setShowPresetLocks(true);
    useMazeStore.getState().setPresetConnectionsTool("lock_in");
    useMazeStore.getState().setPresetConnectionsTool("lock_out");
    expect(useMazeStore.getState().showPresetLocks).toBe(true);
    useMazeStore.getState().setPresetConnectionsTool("wall");
    expect(useMazeStore.getState().showPresetLocks).toBe(true);
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

    it("removes list order and split id metadata for cleared entities", () => {
      useMazeStore.setState({
        presetConnections: new Map([
          ["0,0-1,0", { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "wall", source: "user" }],
        ]),
        presetSplitPoints: { "0,0": [0] },
        presetSplitPointIds: { "0,0": "s1" },
        presetEntityOrder: ["edge:0,0-1,0", "split:0,0"],
      });
      useMazeStore.getState().resetPresetPoint([0, 0]);
      const s = useMazeStore.getState();
      expect(s.presetEntityOrder).toEqual([]);
      expect(s.presetSplitPointIds).toEqual({});
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

    it("removes locks from every node when resetting a split point", () => {
      useMazeStore.setState({
        presetSplitPoints: { "0,0": [0, 1] },
        lockedNodes: new Map([["0,0", "both"], ["0,0:0", "in"], ["0,0:1", "out"], ["1,1", "both"]]),
      });
      useMazeStore.getState().resetPresetPoint([0, 0]);
      const locks = useMazeStore.getState().lockedNodes;
      expect(locks.has("0,0")).toBe(false);
      expect(locks.has("0,0:0")).toBe(false);
      expect(locks.has("0,0:1")).toBe(false);
      expect(locks.get("1,1")).toBe("both");
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

    it("preserves a preset start marker assigned to a slot while applying a blueprint", () => {
      setActiveFieldConfig({ tessellationConfig: wideField });
      useMazeStore.setState({
        presetSplitPoints: { "0,0": [0] },
        presetStart: presetEndpoint([0, 0], 0),
      });
      useMazeStore.getState().applyPresetSplitBlueprint([0, 0], square);
      const s = useMazeStore.getState();
      expect(s.presetSplitPoints["0,0"]).toEqual([0]);
      expect(s.presetStart).toEqual(presetEndpoint([0, 0], 0));
      expect(s.error).toBeNull();
    });

    it("moves occupied preset elements from a dropped slot onto the original node", () => {
      const oldSlot = presetEndpoint([0, 0], 5);
      const singleNode = { id: 1, degree: 4, nodeFaces: [[0, 2]] };
      setActiveFieldConfig({ tessellationConfig: wideField });
      useMazeStore.setState({
        presetSplitPoints: { "0,0": [5] },
        presetStart: oldSlot,
        presetFinish: oldSlot,
        presetGenSource: oldSlot,
        presetTeleports: [{ id: 1, from: oldSlot, to: presetEndpoint([1, 0]), direction: "forward" }],
        presetVerticalPassages: [{ id: 2, from: oldSlot, to: presetEndpoint([1, 0], undefined, 1), direction: "two_way" }],
        presetElevators: [{ id: 3, floors: [oldSlot, presetEndpoint([0, 0], undefined, 1)] }],
      });

      useMazeStore.getState().applyPresetSplitBlueprint([0, 0], singleNode);
      const s = useMazeStore.getState();
      const original = presetEndpoint([0, 0]);
      expect(s.presetSplitPoints["0,0"]).toBeUndefined();
      expect(s.presetStart).toEqual(original);
      expect(s.presetFinish).toEqual(original);
      expect(s.presetGenSource).toEqual(original);
      expect(s.presetTeleports[0]).toMatchObject({ from: original });
      expect(s.presetVerticalPassages[0]).toMatchObject({ from: original });
      expect(s.presetElevators[0].floors[0]).toEqual(original);
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
        presetSplitPoints: {}, presetSplitTargetPrompt: null,
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

    it("re-clicking a cell with an existing one-way passage cycles it instead of adding a duplicate (GitHub issue #495)", () => {
      setTwoFloors();
      useMazeStore.setState({
        presetVerticalPassages: [{ id: 7, from: presetEndpoint([0, 0]), to: presetEndpoint([0, 0], undefined, 1), direction: "forward" }],
        _nextPresetVerticalPassageId: 8,
      });
      useMazeStore.getState().startPresetVerticalPassagePlacement(presetEndpoint([0, 0]), "vertical_passage_one_way");
      const s = useMazeStore.getState();
      expect(s.presetVerticalPassages).toHaveLength(1);
      expect(s.presetVerticalPassages[0]).toMatchObject({ id: 7, direction: "backward" });
    });

    it("filters an already occupied direction before committing a new adjacent-floor passage (GitHub issue #495)", () => {
      setTwoFloors();
      useMazeStore.setState({
        floors: [...useMazeStore.getState().floors, { id: "floor_3", title: "Floor 3" }],
        floorFields: { ...useMazeStore.getState().floorFields, floor_3: { ...useMazeStore.getState().floorFields[FLOOR_2_ID] } },
        presetVerticalPassages: [{ id: 7, from: presetEndpoint([0, 0], undefined, 1), to: presetEndpoint([0, 0], undefined, 2), direction: "forward" }],
        _nextPresetVerticalPassageId: 8,
      });
      useMazeStore.getState().startPresetVerticalPassagePlacement(presetEndpoint([0, 0], undefined, 1), "vertical_passage_two_way");
      const s = useMazeStore.getState();
      expect(s.presetVerticalPassagePending).toBeNull();
      expect(s.presetVerticalPassages).toHaveLength(2);
      expect(s.presetVerticalPassages[1]).toMatchObject({ from: presetEndpoint([0, 0], undefined, 1), to: presetEndpoint([0, 0]), direction: "two_way" });
    });

    it("does not add a duplicate when both adjacent floors already have independent passages (GitHub issue #495)", () => {
      setTwoFloors();
      useMazeStore.setState({
        floors: [...useMazeStore.getState().floors, { id: "floor_3", title: "Floor 3" }],
        floorFields: { ...useMazeStore.getState().floorFields, floor_3: { ...useMazeStore.getState().floorFields[FLOOR_2_ID] } },
        presetVerticalPassages: [
          { id: 1, from: presetEndpoint([0, 0], undefined, 1), to: presetEndpoint([0, 0]), direction: "forward" },
          { id: 2, from: presetEndpoint([0, 0], undefined, 1), to: presetEndpoint([0, 0], undefined, 2), direction: "forward" },
        ],
        _nextPresetVerticalPassageId: 3,
      });
      useMazeStore.getState().startPresetVerticalPassagePlacement(presetEndpoint([0, 0], undefined, 1), "vertical_passage_one_way");
      const s = useMazeStore.getState();
      expect(s.presetVerticalPassages).toHaveLength(2);
      expect(s.presetVerticalPassagePending).toBeNull();
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

    describe("target-floor split-tile parity with post-edit (GitHub issue #594)", () => {
      it("startPresetVerticalPassagePlacement defers to presetSplitTargetPrompt when the TARGET floor is split", () => {
        setTwoFloors();
        useMazeStore.setState({ presetSplitPoints: { "0,0@1": [5] } });
        useMazeStore.getState().startPresetVerticalPassagePlacement(presetEndpoint([0, 0]), "vertical_passage_two_way");
        const s = useMazeStore.getState();
        expect(s.presetVerticalPassages).toHaveLength(0);
        expect(s.presetSplitTargetPrompt).toMatchObject({ point: [0, 0], level: 1, slotIds: [5], action: { tool: "place_vertical_passage_target" } });
      });

      it("picking a slot for the deferred vertical-passage target commits with the split endpoint", () => {
        setTwoFloors();
        useMazeStore.setState({ presetSplitPoints: { "0,0@1": [5] } });
        useMazeStore.getState().startPresetVerticalPassagePlacement(presetEndpoint([0, 0]), "vertical_passage_two_way");
        useMazeStore.getState().applyPresetSplitTargetPick(5);
        const s = useMazeStore.getState();
        expect(s.presetSplitTargetPrompt).toBeNull();
        expect(s.presetVerticalPassages).toHaveLength(1);
        expect(presetEndpointsEqual(s.presetVerticalPassages[0].to, presetEndpoint([0, 0], 5, 1))).toBe(true);
      });

      it("confirmPresetElevatorPlacement defers to presetSplitTargetPrompt when a non-origin floor is split", () => {
        setTwoFloors();
        useMazeStore.setState({ presetSplitPoints: { "0,0@1": [3] } });
        useMazeStore.getState().startPresetElevatorPlacement(presetEndpoint([0, 0]));
        useMazeStore.getState().togglePresetElevatorFloor(1);
        useMazeStore.getState().confirmPresetElevatorPlacement();
        const s = useMazeStore.getState();
        expect(s.presetElevators).toHaveLength(0);
        expect(s.presetSplitTargetPrompt).toMatchObject({ point: [0, 0], level: 1, slotIds: [3], action: { tool: "place_elevator_target" } });
      });

      it("picking a slot for the deferred elevator floor commits with the split endpoint", () => {
        setTwoFloors();
        useMazeStore.setState({ presetSplitPoints: { "0,0@1": [3] } });
        useMazeStore.getState().startPresetElevatorPlacement(presetEndpoint([0, 0]));
        useMazeStore.getState().togglePresetElevatorFloor(1);
        useMazeStore.getState().confirmPresetElevatorPlacement();
        useMazeStore.getState().applyPresetSplitTargetPick(3);
        const s = useMazeStore.getState();
        expect(s.presetSplitTargetPrompt).toBeNull();
        expect(s.presetElevators).toHaveLength(1);
        expect(s.presetElevators[0].floors).toHaveLength(2);
        expect(presetEndpointsEqual(s.presetElevators[0].floors[1], presetEndpoint([0, 0], 3, 1))).toBe(true);
      });

      it("movePresetVerticalPassageEndpoint defers when the dragged-to point is split", () => {
        setTwoFloors();
        useMazeStore.setState({
          presetVerticalPassages: [{ id: 1, from: presetEndpoint([0, 0]), to: presetEndpoint([0, 0], undefined, 1), direction: "forward" }],
          presetSplitPoints: { "1,0": [9] },
        });
        useMazeStore.getState().movePresetVerticalPassageEndpoint(1, "from", [1, 0]);
        const s = useMazeStore.getState();
        expect(s.presetVerticalPassages[0].from).toEqual(presetEndpoint([0, 0]));
        expect(s.presetSplitTargetPrompt).toMatchObject({ point: [1, 0], slotIds: [9], action: { tool: "move_vertical_passage_endpoint", id: 1, end: "from" } });
      });

      // Same ordering fix as the elevator test above: the OTHER end's cell existence is checked
      // before any split dialog opens, even when the dragged point itself is a declared split point.
      it("movePresetVerticalPassageEndpoint fails immediately when the other floor has no cell, without opening a split dialog", () => {
        setTwoFloors();
        useMazeStore.setState({
          presetVerticalPassages: [{ id: 1, from: presetEndpoint([0, 0]), to: presetEndpoint([0, 0], undefined, 1), direction: "forward" }],
          presetSplitPoints: { "9,9": [9] },
        });
        useMazeStore.getState().movePresetVerticalPassageEndpoint(1, "from", [9, 9]);
        const s = useMazeStore.getState();
        expect(s.presetSplitTargetPrompt).toBeNull();
        expect(s.presetVerticalPassages[0].from).toEqual(presetEndpoint([0, 0]));
        expect(s.presetDragFailureMessage).toMatchObject({ entityKind: "vertical_passage", level: 1, point: [9, 9] });
      });

      it("picking a slot for the deferred vertical-passage drag commits with the split endpoint", () => {
        setTwoFloors();
        useMazeStore.setState({
          presetVerticalPassages: [{ id: 1, from: presetEndpoint([0, 0]), to: presetEndpoint([0, 0], undefined, 1), direction: "forward" }],
          presetSplitPoints: { "1,0": [9] },
        });
        useMazeStore.getState().movePresetVerticalPassageEndpoint(1, "from", [1, 0]);
        useMazeStore.getState().applyPresetSplitTargetPick(9);
        const s = useMazeStore.getState();
        expect(s.presetSplitTargetPrompt).toBeNull();
        expect(presetEndpointsEqual(s.presetVerticalPassages[0].from, presetEndpoint([1, 0], 9))).toBe(true);
        expect(presetEndpointsEqual(s.presetVerticalPassages[0].to, presetEndpoint([1, 0], undefined, 1))).toBe(true);
      });

      // The upfront `cellExistsAt` pre-check only catches a floor that's ALREADY missing the cell at
      // the moment the drag starts — if the field changes between opening the split dialog and the
      // user's final pick (e.g. another action shrinks the floor mid-dialog), `moveVerticalPassageEndpoint`'s
      // own internal check still runs at dispatch time and can still fail. Exercises the
      // `result.failure` branch inside `applyPresetSplitTargetPick`'s queue-drain dispatch.
      it("picking a slot for a deferred vertical-passage drag surfaces a failure if the other floor's cell disappeared meanwhile", () => {
        setTwoFloors();
        useMazeStore.setState({
          presetVerticalPassages: [{ id: 1, from: presetEndpoint([0, 0]), to: presetEndpoint([0, 0], undefined, 1), direction: "forward" }],
          presetSplitPoints: { "1,0": [9] },
        });
        useMazeStore.getState().movePresetVerticalPassageEndpoint(1, "from", [1, 0]);
        // Shrink floor 1's field so [1, 0] no longer exists there, between the defer and the pick.
        useMazeStore.setState((state) => ({
          floorFields: { ...state.floorFields, [FLOOR_2_ID]: { ...state.floorFields[FLOOR_2_ID], tessellationConfig: { type: "square", width: 1, height: 1 } } },
        }));
        useMazeStore.getState().applyPresetSplitTargetPick(9);
        const s = useMazeStore.getState();
        expect(s.presetSplitTargetPrompt).toBeNull();
        expect(s.presetDragFailureMessage).toMatchObject({ entityKind: "vertical_passage", level: 1, point: [1, 0] });
        expect(presetEndpointsEqual(s.presetVerticalPassages[0].from, presetEndpoint([0, 0]))).toBe(true);
      });

      it("movePresetElevatorEndpoint defers when any floor's own landing point is split", () => {
        setTwoFloors();
        useMazeStore.setState({
          presetElevators: [{ id: 1, floors: [presetEndpoint([0, 0]), presetEndpoint([0, 0], undefined, 1)] }],
          presetSplitPoints: { "1,0@1": [4] },
        });
        useMazeStore.getState().movePresetElevatorEndpoint(1, 0, [1, 0]);
        const s = useMazeStore.getState();
        expect(s.presetElevators[0].floors[0]).toEqual(presetEndpoint([0, 0]));
        expect(s.presetSplitTargetPrompt).toMatchObject({ point: [1, 0], level: 1, slotIds: [4], action: { tool: "move_elevator_endpoint", id: 1 } });
      });

      it("picking a slot for the deferred elevator drag commits with the split endpoint", () => {
        setTwoFloors();
        useMazeStore.setState({
          presetElevators: [{ id: 1, floors: [presetEndpoint([0, 0]), presetEndpoint([0, 0], undefined, 1)] }],
          presetSplitPoints: { "1,0@1": [4] },
        });
        useMazeStore.getState().movePresetElevatorEndpoint(1, 0, [1, 0]);
        useMazeStore.getState().applyPresetSplitTargetPick(4);
        const s = useMazeStore.getState();
        expect(s.presetSplitTargetPrompt).toBeNull();
        expect(presetEndpointsEqual(s.presetElevators[0].floors[0], presetEndpoint([1, 0]))).toBe(true);
        expect(presetEndpointsEqual(s.presetElevators[0].floors[1], presetEndpoint([1, 0], 4, 1))).toBe(true);
      });

      // Same defensive-branch coverage as the vertical-passage drag test above — a floor's cell can
      // disappear between the split dialog opening and the user's final pick, so
      // `moveElevatorEndpoint`'s own internal check can still fail even though the upfront
      // `cellExistsAt` pre-check passed when the drag started. Exercises the `result.failure` branch
      // inside `applyPresetSplitTargetPick`'s `move_elevator_endpoint` queue-drain dispatch.
      it("picking a slot for a deferred elevator drag surfaces a failure if another floor's cell disappeared meanwhile", () => {
        setTwoFloors();
        useMazeStore.setState({
          presetElevators: [{ id: 1, floors: [presetEndpoint([0, 0]), presetEndpoint([0, 0], undefined, 1)] }],
          presetSplitPoints: { "1,0@1": [4] },
        });
        useMazeStore.getState().movePresetElevatorEndpoint(1, 0, [1, 0]);
        // Shrink floor 1's field so [1, 0] no longer exists there, between the defer and the pick.
        useMazeStore.setState((state) => ({
          floorFields: { ...state.floorFields, [FLOOR_2_ID]: { ...state.floorFields[FLOOR_2_ID], tessellationConfig: { type: "square", width: 1, height: 1 } } },
        }));
        useMazeStore.getState().applyPresetSplitTargetPick(4);
        const s = useMazeStore.getState();
        expect(s.presetSplitTargetPrompt).toBeNull();
        expect(s.presetDragFailureMessage).toMatchObject({ entityKind: "elevator", level: 1, point: [1, 0] });
        expect(s.presetElevators[0].floors[0]).toEqual(presetEndpoint([0, 0]));
      });

      // Cell-existence is checked BEFORE any split-target dialog opens (user-reported follow-up to
      // GitHub issue #594) — a floor that has no cell at all at the new point must fail immediately,
      // even when some OTHER floor at that point is a declared split point, instead of making the
      // user answer a "which node?" prompt first only to be told the drag failed anyway.
      it("movePresetElevatorEndpoint fails immediately when a floor has no cell, without opening a split dialog", () => {
        setTwoFloors();
        useMazeStore.setState({
          presetElevators: [{ id: 1, floors: [presetEndpoint([0, 0]), presetEndpoint([0, 0], undefined, 1)] }],
          presetSplitPoints: { "1,0": [4] },
        });
        // Floor 1 is a 3x3 square field — [9, 9] has no cell on either floor, but floor 0's own
        // landing point ("1,0" origin-level key) is also declared split, to prove the cell check
        // still runs first.
        useMazeStore.getState().movePresetElevatorEndpoint(1, 0, [9, 9]);
        const s = useMazeStore.getState();
        expect(s.presetSplitTargetPrompt).toBeNull();
        expect(s.presetElevators[0].floors[0]).toEqual(presetEndpoint([0, 0]));
        expect(s.presetDragFailureMessage).toMatchObject({ entityKind: "elevator", level: 1, point: [9, 9] });
      });

      it("elevator with two split target floors ends up created after both picks", () => {
        setTwoFloors();
        useMazeStore.setState({
          floors: [...useMazeStore.getState().floors, { id: "floor_3", title: "Floor 3" }],
          floorFields: { ...useMazeStore.getState().floorFields, floor_3: { ...useMazeStore.getState().floorFields[FLOOR_2_ID] } },
          presetSplitPoints: { "0,0@1": [3], "0,0@2": [5] },
        });
        useMazeStore.getState().startPresetElevatorPlacement(presetEndpoint([0, 0]));
        useMazeStore.getState().togglePresetElevatorFloor(1);
        useMazeStore.getState().togglePresetElevatorFloor(2);
        useMazeStore.getState().confirmPresetElevatorPlacement();
        useMazeStore.getState().applyPresetSplitTargetPick(3);
        useMazeStore.getState().applyPresetSplitTargetPick(5);
        const s = useMazeStore.getState();
        expect(s.presetSplitTargetPrompt).toBeNull();
        expect(s.presetElevators).toHaveLength(1);
        expect(s.presetElevators[0].floors).toEqual([
          presetEndpoint([0, 0]),
          presetEndpoint([0, 0], 3, 1),
          presetEndpoint([0, 0], 5, 2),
        ]);
      });

      // GitHub issue #594 follow-up: when the ORIGIN point is itself a declared split point
      // (resolved earlier via a `PresetSplitTargetDialog` pick, before `startPresetElevatorPlacement`
      // ran), `confirmPresetElevatorPlacement` used to re-check the origin's own floor for
      // split-ness too, adding a redundant queue entry the user never gets asked to fill — the
      // queue then never drained and the elevator was silently never created.
      it("elevator placement still completes when the origin point itself is split", () => {
        setTwoFloors();
        useMazeStore.setState({
          floors: [...useMazeStore.getState().floors, { id: "floor_3", title: "Floor 3" }],
          floorFields: { ...useMazeStore.getState().floorFields, floor_3: { ...useMazeStore.getState().floorFields[FLOOR_2_ID] } },
          presetSplitPoints: { "0,0": [2], "0,0@1": [3], "0,0@2": [5] },
        });
        // Real UX: user clicks the split origin cell with the "elevator" tool -> split-target prompt
        // for ORIGIN -> picks slot 2 -> startPresetElevatorPlacement(endpoint with slotId 2).
        useMazeStore.getState().requestPresetSplitTarget({ point: [0, 0], slotIds: [2], action: { tool: "elevator" } });
        useMazeStore.getState().applyPresetSplitTargetPick(2);
        useMazeStore.getState().togglePresetElevatorFloor(1);
        useMazeStore.getState().togglePresetElevatorFloor(2);
        useMazeStore.getState().confirmPresetElevatorPlacement();
        useMazeStore.getState().applyPresetSplitTargetPick(3);
        useMazeStore.getState().applyPresetSplitTargetPick(5);
        const s = useMazeStore.getState();
        expect(s.presetSplitTargetPrompt).toBeNull();
        expect(s.presetElevators).toHaveLength(1);
        expect(s.presetElevators[0].floors).toEqual([
          presetEndpoint([0, 0], 2),
          presetEndpoint([0, 0], 3, 1),
          presetEndpoint([0, 0], 5, 2),
        ]);
      });
    });
  });

  describe("applyPresetSplitTargetPick (GitHub issue #474)", () => {
    const FLOOR_2_ID = "floor_2";

    beforeEach(() => {
      useMazeStore.setState({
        presetStart: null, presetFinish: null, presetGenSource: null,
        presetTeleports: [], presetTeleportPendingFrom: null,
        presetVerticalPassages: [], presetVerticalPassagePending: null,
        presetElevators: [], presetElevatorPending: null,
        presetSplitTargetPrompt: null,
        // `presetSplitPoints` also needs resetting — zustand `setState` shallow-merges, so a later
        // describe block's split-point fixture (e.g. GitHub issue #594's target-floor parity tests)
        // otherwise leaks into these tests via file-scoped `beforeEach` ordering.
        presetSplitPoints: {},
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

    it("lock pick toggles the exact split node and replaces a different lock kind", () => {
      openPrompt({ tool: "lock_in" });
      useMazeStore.getState().applyPresetSplitTargetPick(0);
      expect(useMazeStore.getState().lockedNodes.get("0,0:0")).toBe("in");

      openPrompt({ tool: "lock_out" });
      useMazeStore.getState().applyPresetSplitTargetPick(0);
      expect(useMazeStore.getState().lockedNodes.get("0,0:0")).toBe("out");

      openPrompt({ tool: "lock_out" });
      useMazeStore.getState().applyPresetSplitTargetPick(0);
      expect(useMazeStore.getState().lockedNodes.has("0,0:0")).toBe(false);
    });

    it("gen_source dispatches setPresetGenSourceEndpoint to the picked slot and clears the prompt (GitHub issue #494)", () => {
      openPrompt({ tool: "gen_source" });
      useMazeStore.getState().applyPresetSplitTargetPick(0);
      const s = useMazeStore.getState();
      expect(s.presetSplitTargetPrompt).toBeNull();
      expect(presetEndpointsEqual(s.presetGenSource!, presetEndpoint([0, 0], 0))).toBe(true);
    });

    it("gen_source pick overwrites an existing gen source (no toggle), matching set_start", () => {
      useMazeStore.getState().setPresetGenSourceEndpoint(presetEndpoint([0, 0], 0));
      openPrompt({ tool: "gen_source" });
      useMazeStore.getState().applyPresetSplitTargetPick(undefined);
      expect(presetEndpointsEqual(useMazeStore.getState().presetGenSource!, presetEndpoint([0, 0]))).toBe(true);
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

    it("moving a teleport endpoint through the store preserves its floor", () => {
      useMazeStore.setState({
        presetTeleports: [{
          id: 1,
          from: presetEndpoint([0, 0], undefined, 1),
          to: presetEndpoint([1, 0], undefined, 0),
          direction: "forward",
        }],
      });
      useMazeStore.getState().movePresetTeleportEndpoint(1, "from", [2, 2], 1);
      const teleport = useMazeStore.getState().presetTeleports[0];
      expect(teleport.from).toEqual(presetEndpoint([2, 2], undefined, 1));
      expect(teleport.to).toEqual(presetEndpoint([1, 0], undefined, 0));
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

  describe("preset entity-delete dialog (GitHub issue #540)", () => {
    beforeEach(() => {
      useMazeStore.setState({
        presetStart: null, presetFinish: null, presetGenSource: null,
        presetTeleports: [], presetVerticalPassages: [], presetElevators: [],
        presetConnections: new Map(), lockedNodes: new Map(), autoLockedNodes: new Set(),
        presetSplitPoints: {}, presetActiveSplitNode: {},
        presetSplitTargetPrompt: null, presetEntityDeletePrompt: null,
      });
    });

    it("requestPresetEntityDelete is a no-op when the point has nothing", () => {
      useMazeStore.getState().requestPresetEntityDelete([0, 0], undefined, { kind: "point_all" });
      expect(useMazeStore.getState().presetEntityDeletePrompt).toBeNull();
    });

    it("requestPresetEntityDelete with exactly one entity removes it directly, no dialog", () => {
      useMazeStore.setState({ presetStart: presetEndpoint([0, 0]) });
      useMazeStore.getState().requestPresetEntityDelete([0, 0], undefined, { kind: "point_all" });
      const s = useMazeStore.getState();
      expect(s.presetEntityDeletePrompt).toBeNull();
      expect(s.presetStart).toBeNull();
    });

    it("clear finds a teleport endpoint moved on floor 0", () => {
      useMazeStore.setState({
        presetTeleports: [{ id: 1, from: presetEndpoint([0, 0]), to: presetEndpoint([1, 1]), direction: "forward" }],
      });

      useMazeStore.getState().movePresetTeleportEndpoint(1, "from", [1, 0], 0);
      useMazeStore.getState().requestPresetEntityDelete([1, 0], undefined, { kind: "point_all" });

      expect(useMazeStore.getState().presetTeleports).toEqual([]);
    });

    it("requestPresetEntityDelete with more than one entity opens the dialog", () => {
      useMazeStore.setState({
        presetStart: presetEndpoint([0, 0]),
        presetFinish: presetEndpoint([0, 0]),
      });
      useMazeStore.getState().requestPresetEntityDelete([0, 0], undefined, { kind: "point_all" });
      expect(useMazeStore.getState().presetEntityDeletePrompt).not.toBeNull();
    });

    it("requestPresetEntityDelete with bulk:true removes everything at once, no dialog", () => {
      useMazeStore.setState({
        presetStart: presetEndpoint([0, 0]),
        presetFinish: presetEndpoint([0, 0]),
      });
      useMazeStore.getState().requestPresetEntityDelete([0, 0], undefined, { kind: "point_all" }, true);
      const s = useMazeStore.getState();
      expect(s.presetEntityDeletePrompt).toBeNull();
      expect(s.presetStart).toBeNull();
      expect(s.presetFinish).toBeNull();
    });

    it("requestPresetEntityDelete with bulk:true on a vertex_markers scope removes only that scope's entities", () => {
      useMazeStore.setState({
        presetStart: presetEndpoint([0, 0]),
        presetFinish: presetEndpoint([1, 0]),
      });
      useMazeStore.getState().requestPresetEntityDelete([0, 0], undefined, { kind: "vertex_markers", endpoints: [presetEndpoint([0, 0])] }, true);
      const s = useMazeStore.getState();
      expect(s.presetEntityDeletePrompt).toBeNull();
      expect(s.presetStart).toBeNull();
      expect(s.presetFinish).not.toBeNull();
    });

    it("requestPresetEntityDelete closes an open split-target prompt (mutual exclusion)", () => {
      useMazeStore.getState().requestPresetSplitTarget({ point: [0, 0], slotIds: [0], action: { tool: "set_start" } });
      useMazeStore.setState({ presetStart: presetEndpoint([0, 0]), presetFinish: presetEndpoint([0, 0]) });
      useMazeStore.getState().requestPresetEntityDelete([0, 0], undefined, { kind: "point_all" });
      const s = useMazeStore.getState();
      expect(s.presetSplitTargetPrompt).toBeNull();
      expect(s.presetEntityDeletePrompt).not.toBeNull();
    });

    it("requestPresetSplitTarget closes an open entity-delete prompt (mutual exclusion)", () => {
      useMazeStore.setState({
        presetSplitPoints: { "0,0": [0] },
        presetStart: presetEndpoint([0, 0]),
        presetFinish: presetEndpoint([0, 0], 0),
      });
      useMazeStore.getState().requestPresetEntityDelete([0, 0], undefined, { kind: "point_all" });
      expect(useMazeStore.getState().presetEntityDeletePrompt).not.toBeNull();
      useMazeStore.getState().requestPresetSplitTarget({ point: [0, 0], slotIds: [0], action: { tool: "set_start" } });
      expect(useMazeStore.getState().presetEntityDeletePrompt).toBeNull();
    });

    it("vertex_markers scope on a split point only sees the endpoint(s) passed, not the neighbor node", () => {
      useMazeStore.setState({
        presetSplitPoints: { "0,0": [0] },
        presetStart: presetEndpoint([0, 0]),
        presetFinish: presetEndpoint([0, 0], 0),
      });
      useMazeStore.getState().requestPresetEntityDelete([0, 0], undefined, { kind: "vertex_markers", endpoints: [presetEndpoint([0, 0])] });
      // Only presetStart is in scope (bound to the original node) -> count is 1, direct removal, no dialog.
      const s = useMazeStore.getState();
      expect(s.presetEntityDeletePrompt).toBeNull();
      expect(s.presetStart).toBeNull();
      expect(presetEndpointsEqual(s.presetFinish!, presetEndpoint([0, 0], 0))).toBe(true);
    });

    it("removePresetPointEntity removes exactly the targeted entity and leaves others", () => {
      useMazeStore.setState({
        presetStart: presetEndpoint([0, 0]),
        presetFinish: presetEndpoint([1, 1]),
      });
      useMazeStore.getState().requestPresetEntityDelete([0, 0], undefined, { kind: "point_all" });
      const s0 = useMazeStore.getState();
      expect(s0.presetStart).toBeNull(); // count===1 -> direct removal already happened
      expect(s0.presetFinish).toEqual(presetEndpoint([1, 1]));
    });

    it("removePresetPointEntity on the last remaining row closes the open prompt", () => {
      useMazeStore.setState({
        presetStart: presetEndpoint([0, 0]),
        presetFinish: presetEndpoint([0, 0]),
      });
      useMazeStore.getState().requestPresetEntityDelete([0, 0], undefined, { kind: "point_all" });
      const prompt = useMazeStore.getState().presetEntityDeletePrompt!;
      const entities = buildPresetPointEntities(prompt.point, prompt.level, 0, prompt.scope, {
        presetSplitPoints: {}, presetStart: presetEndpoint([0, 0]), presetFinish: presetEndpoint([0, 0]),
        presetGenSource: null, presetTeleports: [], presetVerticalPassages: [], presetElevators: [],
        presetConnections: new Map(), lockedNodes: new Map(), autoLockedNodes: new Set(),
      });
      useMazeStore.getState().removePresetPointEntity(entities[0]);
      expect(useMazeStore.getState().presetEntityDeletePrompt).not.toBeNull();
      useMazeStore.getState().removePresetPointEntity(entities[1]);
      expect(useMazeStore.getState().presetEntityDeletePrompt).toBeNull();
    });

    it("cancelPresetEntityDelete drops the prompt without removing anything", () => {
      useMazeStore.setState({
        presetStart: presetEndpoint([0, 0]),
        presetFinish: presetEndpoint([0, 0]),
      });
      useMazeStore.getState().requestPresetEntityDelete([0, 0], undefined, { kind: "point_all" });
      useMazeStore.getState().cancelPresetEntityDelete();
      const s = useMazeStore.getState();
      expect(s.presetEntityDeletePrompt).toBeNull();
      expect(s.presetStart).not.toBeNull();
      expect(s.presetFinish).not.toBeNull();
    });

    it("removeAllPresetPointEntities on point_all scope matches resetPresetPoint's end state", () => {
      const setup = () => useMazeStore.setState({
        presetConnections: new Map([
          ["0,0-1,0", { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "wall" as const, source: "user" as const }],
        ]),
        presetTeleports: [{ id: 1, from: presetEndpoint([0, 0]), to: presetEndpoint([5, 5]), direction: "forward" as const }],
        presetStart: presetEndpoint([0, 0]),
        presetFinish: presetEndpoint([1, 1]),
        presetGenSource: presetEndpoint([0, 0]),
        lockedNodes: new Map([["0,0", "both" as const]]),
      });

      setup();
      useMazeStore.getState().requestPresetEntityDelete([0, 0], undefined, { kind: "point_all" });
      useMazeStore.getState().removeAllPresetPointEntities();
      const viaDialog = useMazeStore.getState();

      setup();
      useMazeStore.getState().resetPresetPoint([0, 0]);
      const viaLegacy = useMazeStore.getState();

      expect(viaDialog.presetConnections).toEqual(viaLegacy.presetConnections);
      expect(viaDialog.presetTeleports).toEqual(viaLegacy.presetTeleports);
      expect(viaDialog.presetStart).toEqual(viaLegacy.presetStart);
      expect(viaDialog.presetFinish).toEqual(viaLegacy.presetFinish);
      expect(viaDialog.presetGenSource).toEqual(viaLegacy.presetGenSource);
      expect(viaDialog.lockedNodes).toEqual(viaLegacy.lockedNodes);
    });

    it("removeAllPresetPointEntities on vertex_markers scope doesn't touch out-of-scope entities", () => {
      useMazeStore.setState({
        presetConnections: new Map([
          ["0,0-1,0", { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "wall" as const, source: "user" as const }],
        ]),
        lockedNodes: new Map([["0,0", "both" as const]]),
        presetStart: presetEndpoint([0, 0]),
        presetFinish: presetEndpoint([0, 0]),
      });
      useMazeStore.getState().requestPresetEntityDelete([0, 0], undefined, { kind: "vertex_markers", endpoints: [presetEndpoint([0, 0])] });
      useMazeStore.getState().removeAllPresetPointEntities();
      const s = useMazeStore.getState();
      expect(s.presetStart).toBeNull();
      expect(s.presetFinish).toBeNull();
      // Edge and lock are out of vertex_markers scope — untouched.
      expect(s.presetConnections.has("0,0-1,0")).toBe(true);
      expect(s.lockedNodes.has("0,0")).toBe(true);
    });

    it("an auto-computed lock doesn't get its own row (it isn't user-removable)", () => {
      const state = useMazeStore.getState();
      const entities = buildPresetPointEntities([0, 0], undefined, 0, { kind: "point_all" }, {
        presetSplitPoints: state.presetSplitPoints, presetStart: null, presetFinish: null, presetGenSource: null,
        presetTeleports: [], presetVerticalPassages: [], presetElevators: [],
        presetConnections: new Map(), lockedNodes: new Map(), autoLockedNodes: new Set(["0,0"]),
      });
      expect(entities.filter((e) => e.kind === "lock")).toHaveLength(0);
    });

    it("lock row title reflects the lock kind (in/out/both)", () => {
      const state = useMazeStore.getState();
      const buildFor = (kind: "in" | "out" | "both") => buildPresetPointEntities([0, 0], undefined, 0, { kind: "point_all" }, {
        presetSplitPoints: state.presetSplitPoints, presetStart: null, presetFinish: null, presetGenSource: null,
        presetTeleports: [], presetVerticalPassages: [], presetElevators: [],
        presetConnections: new Map(), lockedNodes: new Map([["0,0", kind]]), autoLockedNodes: new Set(),
      });
      expect(buildFor("in").find((e) => e.kind === "lock")!.title).toBe(m["status.cell_lock"]({ kind: m["status.cell_lock_in"]() }));
      expect(buildFor("out").find((e) => e.kind === "lock")!.title).toBe(m["status.cell_lock"]({ kind: m["status.cell_lock_out"]() }));
      expect(buildFor("both").find((e) => e.kind === "lock")!.title).toBe(m["status.cell_lock"]({ kind: m["status.cell_lock_both"]() }));
    });

    it("one-way edge row title shows the arrow pointing away from the row's anchor node", () => {
      useMazeStore.setState({
        presetConnections: new Map([
          ["0,0-1,0", { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "one_way_forward" as const, source: "user" as const }],
          ["0,0-0,1", { from: presetEndpoint([0, 1]), to: presetEndpoint([0, 0]), state: "one_way_backward" as const, source: "user" as const }],
        ]),
      });
      const state = useMazeStore.getState();
      const entities = buildPresetPointEntities([0, 0], undefined, 0, { kind: "point_all" }, {
        presetSplitPoints: state.presetSplitPoints, presetStart: null, presetFinish: null, presetGenSource: null,
        presetTeleports: [], presetVerticalPassages: [], presetElevators: [],
        presetConnections: state.presetConnections, lockedNodes: new Map(), autoLockedNodes: new Set(),
      });
      // Both edges are directed away from (0,0) towards the neighbor, so both rows show "->"
      // even though one is stored one_way_forward (from=here) and the other one_way_backward (to=here).
      const forwardRow = entities.find((e) => e.kind === "edge" && e.id === "0,0-1,0")!;
      const backwardRow = entities.find((e) => e.kind === "edge" && e.id === "0,0-0,1")!;
      expect(forwardRow.title).toBe(`${m["preset.one_way"]()} -> (1:0)`);
      expect(backwardRow.title).toBe(`${m["preset.one_way"]()} -> (0:1)`);
    });

    it("builds endpoint bubbles while leaving start and finish rows without coordinate bubbles", () => {
      useMazeStore.setState({
        presetStart: presetEndpoint([0, 0]),
        presetFinish: presetEndpoint([0, 0]),
        presetConnections: new Map([
          ["0,0-1,0", { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "wall" as const, source: "user" as const }],
        ]),
      });
      const state = useMazeStore.getState();
      const entities = buildPresetPointEntities([0, 0], undefined, 0, { kind: "point_all" }, {
        presetSplitPoints: {}, presetStart: state.presetStart, presetFinish: state.presetFinish, presetGenSource: null,
        presetTeleports: [], presetVerticalPassages: [], presetElevators: [], presetConnections: state.presetConnections,
        lockedNodes: new Map(), autoLockedNodes: new Set(),
      });
      expect(entities.find((e) => e.kind === "start")?.bubbles).toEqual([]);
      expect(entities.find((e) => e.kind === "finish")?.bubbles).toEqual([]);
      expect(entities.find((e) => e.kind === "edge")?.bubbles).toEqual(["0:0", "1:0"]);
    });

    it("labels every endpoint bubble with its floor for cross-floor teleports and elevators", () => {
      const teleports = [{ id: 4, from: presetEndpoint([0, 0]), to: presetEndpoint([2, 2], undefined, 1), direction: "two_way" as const }];
      const elevators = [{ id: 7, floors: [presetEndpoint([0, 0]), presetEndpoint([0, 0], undefined, 1), presetEndpoint([0, 0], undefined, 2)] }];
      const entities = buildPresetPointEntities([0, 0], undefined, 0, { kind: "point_all" }, {
        presetSplitPoints: {}, presetStart: null, presetFinish: null, presetGenSource: null,
        presetTeleports: teleports, presetVerticalPassages: [], presetElevators: elevators,
        presetConnections: new Map(), lockedNodes: new Map(), autoLockedNodes: new Set(),
      });
      expect(entities.find((e) => e.kind === "teleport")?.bubbles).toEqual(["L1 0:0", "L2 2:2"]);
      expect(entities.find((e) => e.kind === "elevator")?.bubbles).toEqual(["L1 0:0", "L2 0:0", "L3 0:0"]);
    });

    it("split_node row is present regardless of whether the slot still carries other entities", () => {
      useMazeStore.setState({
        presetSplitPoints: { "0,0": [0] },
        presetConnections: new Map([
          ["0,0:0-1,0", { from: presetEndpoint([0, 0], 0), to: presetEndpoint([1, 0]), state: "passage" as const, source: "user" as const }],
        ]),
      });
      const state = useMazeStore.getState();
      const entities = buildPresetPointEntities([0, 0], undefined, 0, { kind: "point_all" }, {
        presetSplitPoints: state.presetSplitPoints, presetStart: null, presetFinish: null, presetGenSource: null,
        presetTeleports: [], presetVerticalPassages: [], presetElevators: [],
        presetConnections: state.presetConnections, lockedNodes: new Map(), autoLockedNodes: new Set(),
      });
      const splitRow = entities.find((e) => e.kind === "split_node");
      expect(splitRow).toBeDefined();
      expect(splitRow!.title).toBe("Node 2"); // no recognized special shape here — falls back
      // The slot node's own edge is folded into the single split row, not listed separately.
      expect(entities.filter((e) => e.kind === "edge")).toHaveLength(0);
    });

    it("original node's own edges are folded into the split row too, not listed separately", () => {
      // A recognized bridge/diagonal shape draws across faces of *both* the original and the slot
      // node — reported bug: the original node's own edges kept showing as separate rows even
      // after the split row appeared, duplicating what "Bridge" already covers.
      useMazeStore.setState({
        presetSplitPoints: { "0,0": [0] },
        presetConnections: new Map([
          ["0,0-1,0", { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "passage" as const, source: "user" as const }],
          ["0,0-0,1", { from: presetEndpoint([0, 0]), to: presetEndpoint([0, 1]), state: "passage" as const, source: "user" as const }],
          ["0,0:0-1,0", { from: presetEndpoint([0, 0], 0), to: presetEndpoint([1, 0]), state: "passage" as const, source: "user" as const }],
        ]),
      });
      const state = useMazeStore.getState();
      const entities = buildPresetPointEntities([0, 0], undefined, 0, { kind: "point_all" }, {
        presetSplitPoints: state.presetSplitPoints, presetStart: null, presetFinish: null, presetGenSource: null,
        presetTeleports: [], presetVerticalPassages: [], presetElevators: [],
        presetConnections: state.presetConnections, lockedNodes: new Map(), autoLockedNodes: new Set(),
      });
      expect(entities.filter((e) => e.kind === "edge")).toHaveLength(0);
      expect(entities.filter((e) => e.kind === "split_node")).toHaveLength(1);
    });

    it("removing the split_node row removes the whole split (including the original node's own edges) and migrates its entities to the original node", () => {
      useMazeStore.setState({
        presetSplitPoints: { "0,0": [0] },
        presetConnections: new Map([
          ["0,0:0-1,0", { from: presetEndpoint([0, 0], 0), to: presetEndpoint([1, 0]), state: "passage" as const, source: "user" as const }],
          // The original node's own edge — part of the bridge shape, must drop too, not survive.
          ["0,0-0,1", { from: presetEndpoint([0, 0]), to: presetEndpoint([0, 1]), state: "passage" as const, source: "user" as const }],
        ]),
        presetTeleports: [{ id: 1, from: presetEndpoint([0, 0], 0), to: presetEndpoint([2, 2]), direction: "two_way" as const }],
      });
      const state = useMazeStore.getState();
      const entities = buildPresetPointEntities([0, 0], undefined, 0, { kind: "point_all" }, {
        presetSplitPoints: state.presetSplitPoints, presetStart: null, presetFinish: null, presetGenSource: null,
        presetTeleports: state.presetTeleports, presetVerticalPassages: [], presetElevators: [],
        presetConnections: state.presetConnections, lockedNodes: new Map(), autoLockedNodes: new Set(),
      });
      const splitRow = entities.find((e) => e.kind === "split_node")!;
      useMazeStore.getState().removePresetPointEntity(splitRow);

      const after = useMazeStore.getState();
      expect(after.presetSplitPoints["0,0"]).toBeUndefined();
      // The edge from the removed node drops (reverts to default/undefined) rather than moving.
      expect(after.presetConnections.has("0,0:0-1,0")).toBe(false);
      expect(after.presetConnections.has("0,0-1,0")).toBe(false);
      // The original node's own edge is part of the shape too — also dropped, not left standing.
      expect(after.presetConnections.has("0,0-0,1")).toBe(false);
      // The teleport migrates onto the original node instead of being deleted.
      expect(after.presetTeleports).toHaveLength(1);
      expect(presetEndpointsEqual(after.presetTeleports[0].from, presetEndpoint([0, 0]))).toBe(true);
    });

    it("removing a split reverts the original node's external edge to the current default state, not undefined", () => {
      useMazeStore.setState({
        defaultEdgeState: "wall",
        presetSplitPoints: { "0,0": [0] },
        presetConnections: new Map([
          // The original node's edge to a real external neighbor (0,1) — should come back as the
          // configured default ("wall") once the split is gone, not silently regress to undefined.
          ["0,0-0,1", { from: presetEndpoint([0, 0]), to: presetEndpoint([0, 1]), state: "passage" as const, source: "user" as const }],
        ]),
      });
      useMazeStore.getState().removePresetSplitAll([0, 0], undefined);
      const after = useMazeStore.getState();
      expect(after.presetConnections.get("0,0-0,1")).toMatchObject({ state: "wall", source: "default" });
    });

    it("a default-source edge (from defaultEdgeState's field-wide fill-in) doesn't get its own row", () => {
      useMazeStore.setState({
        presetConnections: new Map([
          ["0,0-1,0", { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "wall" as const, source: "default" as const }],
          ["0,0-0,1", { from: presetEndpoint([0, 0]), to: presetEndpoint([0, 1]), state: "passage" as const, source: "user" as const }],
        ]),
      });
      const state = useMazeStore.getState();
      const entities = buildPresetPointEntities([0, 0], undefined, 0, { kind: "point_all" }, {
        presetSplitPoints: state.presetSplitPoints, presetStart: null, presetFinish: null, presetGenSource: null,
        presetTeleports: [], presetVerticalPassages: [], presetElevators: [],
        presetConnections: state.presetConnections, lockedNodes: new Map(), autoLockedNodes: new Set(),
      });
      const edgeRows = entities.filter((e) => e.kind === "edge");
      expect(edgeRows).toHaveLength(1);
      expect(edgeRows[0].id).toBe("0,0-0,1");
    });

    it("shows an explicitly assigned undefined edge in the entity picker", () => {
      useMazeStore.setState({
        defaultEdgeState: "wall",
        presetConnections: new Map([
          ["0,0-1,0", { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "undefined" as const, source: "user" as const }],
        ]),
      });
      const state = useMazeStore.getState();
      const entities = buildPresetPointEntities([0, 0], undefined, 0, { kind: "point_all" }, {
        presetSplitPoints: state.presetSplitPoints, presetStart: null, presetFinish: null, presetGenSource: null,
        presetTeleports: [], presetVerticalPassages: [], presetElevators: [],
        presetConnections: state.presetConnections, lockedNodes: new Map(), autoLockedNodes: new Set(),
      });
      expect(entities.filter((e) => e.kind === "edge")).toHaveLength(1);
      expect(entities.find((e) => e.kind === "edge")?.title).toContain(m["preset.default_undefined"]());
    });

    it("removing a single edge row reverts it to the current default state, not undefined", () => {
      useMazeStore.setState({
        defaultEdgeState: "wall",
        presetConnections: new Map([
          ["0,0-1,0", { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "passage" as const, source: "user" as const }],
        ]),
      });
      const descriptor = {
        kind: "edge" as const, id: "0,0-1,0", endpoint: presetEndpoint([0, 0]), nodeIndex: 0, title: "",
      };
      useMazeStore.getState().removePresetPointEntity(descriptor);
      const after = useMazeStore.getState();
      expect(after.presetConnections.get("0,0-1,0")).toMatchObject({ state: "wall", source: "default" });
    });

    it("clears the preset-list hover when removing an edge row", () => {
      const from = presetEndpoint([0, 0]);
      const to = presetEndpoint([1, 0]);
      useMazeStore.setState({
        presetConnections: new Map([
          ["0,0-1,0", { from, to, state: "wall" as const, source: "user" as const }],
        ]),
        presetHoveredLink: { from, to, highlightStyle: "boundary" },
        presetHoveredEntity: [from],
      });

      useMazeStore.getState().removePresetPointEntity({
        kind: "edge", id: "0,0-1,0", endpoint: from, nodeIndex: 0, title: "",
      });

      const after = useMazeStore.getState();
      expect(after.presetHoveredLink).toBeNull();
      expect(after.presetHoveredEntity).toBeNull();
    });

    it("removing an explicit undefined edge restores the current default", () => {
      useMazeStore.setState({
        defaultEdgeState: "wall",
        presetConnections: new Map([
          ["0,0-1,0", { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "undefined" as const, source: "user" as const }],
        ]),
      });
      useMazeStore.getState().removePresetPointEntity({
        kind: "edge", id: "0,0-1,0", endpoint: presetEndpoint([0, 0]), nodeIndex: 0, title: "",
      });
      expect(useMazeStore.getState().presetConnections.get("0,0-1,0")).toMatchObject({ state: "wall", source: "default" });
    });

    it("removing an explicit undefined edge deletes it when the default is undefined", () => {
      useMazeStore.setState({
        defaultEdgeState: "undefined",
        presetConnections: new Map([
          ["0,0-1,0", { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "undefined" as const, source: "user" as const }],
        ]),
      });
      useMazeStore.getState().removePresetPointEntity({
        kind: "edge", id: "0,0-1,0", endpoint: presetEndpoint([0, 0]), nodeIndex: 0, title: "",
      });
      expect(useMazeStore.getState().presetConnections.has("0,0-1,0")).toBe(false);
    });

    it("removePresetSplitAll migrates presetStart off a removed slot instead of refusing", () => {
      useMazeStore.setState({
        presetSplitPoints: { "0,0": [0] },
        presetStart: presetEndpoint([0, 0], 0),
      });
      useMazeStore.getState().removePresetSplitAll([0, 0], undefined);
      const s = useMazeStore.getState();
      expect(s.presetSplitPoints["0,0"]).toBeUndefined();
      expect(presetEndpointsEqual(s.presetStart!, presetEndpoint([0, 0]))).toBe(true);
    });
  });
});
