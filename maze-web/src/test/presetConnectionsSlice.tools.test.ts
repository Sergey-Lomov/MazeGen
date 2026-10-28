import { describe, it, expect, vi } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { presetEndpoint } from "../pixi/presetEndpoint";
import type { FieldConfig } from "../fieldConfig";
import { fieldOf } from "./fieldConfigFixtures";
import { noticeCodes } from "./notificationTestHelpers";
import {
  SPLIT_ROTATION_OUTSIDE_FIELD,
} from "../notifications/editRefusalNotifications";
import { setActiveFieldConfig, usePresetStateReset } from "./presetConnectionsSliceKit";

vi.mock("../wasm/mazeService", async (importActual) =>
  (await import("./postEditSliceMocks")).mazeServiceMock(await importActual<typeof import("../wasm/mazeService")>()));
vi.mock("../wasm/wasmLoader", async (importActual) =>
  (await import("./postEditSliceMocks")).wasmLoaderMock(await importActual<typeof import("../wasm/wasmLoader")>()));

usePresetStateReset();

describe("mazeStore preset connections", () => {
  it("a boundary-refused split rotation emits one notice and preserves connections", () => {
    setActiveFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 3, rows: 3 }) });
    const from = presetEndpoint([-1, -1]);
    const to = presetEndpoint([-1, 0]);
    const key = "-1,-1--1,0";
    useMazeStore.setState({
      presetConnections: new Map([[key, { from, to, state: "passage", source: "user" }]]),
    });

    useMazeStore.getState().rotatePresetSplitPoint([-1, -1], 1);
    useMazeStore.getState().rotatePresetSplitPoint([-1, -1], 1);

    expect(useMazeStore.getState().presetConnections.get(key)?.state).toBe("passage");
    expect(noticeCodes()).toEqual([`preset_connections/${SPLIT_ROTATION_OUTSIDE_FIELD}`]);
  });
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
    setActiveFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 2, rows: 1 }) });
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
    setActiveFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 2, rows: 1 }) });
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
    setActiveFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 1, rows: 1 }) });
    useMazeStore.setState({
      presetConnections: new Map([["5,5-6,5", { from: presetEndpoint([5, 5]), to: presetEndpoint([6, 5]), state: "wall", source: "user" }]]),
    });
    useMazeStore.getState().clearInvalidPresetConnections();
    expect(useMazeStore.getState().presetConnections.size).toBe(0);
  });

  it("clearInvalidPresetConnections clears start/finish markers that fall outside the field", () => {
    setActiveFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 1, rows: 1 }) });
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
    setActiveFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 1, rows: 1 }) });
    useMazeStore.setState({ presetGenSource: presetEndpoint([5, 5]) });
    useMazeStore.getState().clearInvalidPresetConnections();
    expect(useMazeStore.getState().presetGenSource).toBeNull();
  });

  it("clearInvalidPresetConnections clears locks outside the field", () => {
    setActiveFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 1, rows: 1 }) });
    useMazeStore.setState({ lockedNodes: new Map([["5,5", "both"]]) });
    useMazeStore.getState().clearInvalidPresetConnections();
    expect(useMazeStore.getState().lockedNodes.size).toBe(0);
  });

  it("clearInvalidPresetConnections removes list metadata for invalid entities", () => {
    setActiveFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 1, rows: 1 }) });
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
    setActiveFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 2, rows: 1 }) });
    useMazeStore.getState().setDefaultEdgeState("wall");
    const s = useMazeStore.getState();
    expect(s.defaultEdgeState).toBe("wall");
    expect(s.presetConnections.get("-1,0-0,0")?.state).toBe("wall");
    expect(s.presetConnections.get("-1,0-0,0")?.source).toBe("default");
  });

  it("setDefaultEdgeState('undefined') removes default-sourced entries", () => {
    setActiveFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 2, rows: 1 }) });
    useMazeStore.setState({
      presetConnections: new Map([["-1,0-0,0", { from: presetEndpoint([-1, 0]), to: presetEndpoint([0, 0]), state: "wall", source: "default" }]]),
    });
    useMazeStore.getState().setDefaultEdgeState("undefined");
    expect(useMazeStore.getState().presetConnections.size).toBe(0);
  });

  it("setDefaultEdgeState('wall') fills interior edges on every floor, not just the active one (GitHub issue #434)", () => {
    // width=2 centers cells at x=-1 and x=0 (see configAllCells offset math)
    const cfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 2, rows: 1 });
    const state = useMazeStore.getState();
    useMazeStore.setState({
      floors: [{ id: "f0", title: "Floor 1" }, { id: "f1", title: "Floor 2" }],
      activeFloorId: "f0",
      floorFields: {
        ...state.floorFields,
        f0: { ...state.floorFields[state.activeFloorId], fieldConfig: cfg },
        f1: { ...state.floorFields[state.activeFloorId], fieldConfig: cfg },
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
    setActiveFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 2, rows: 1 }) });
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

});
