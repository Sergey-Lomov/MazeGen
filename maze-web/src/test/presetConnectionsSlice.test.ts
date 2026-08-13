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
    setActiveFieldConfig({ tessellationConfig: { type: "square", width: 2, height: 1 } });
    useMazeStore.setState({
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
});
