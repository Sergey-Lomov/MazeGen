import { describe, it, expect, vi } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { presetEndpoint, presetEndpointsEqual } from "../pixi/presetEndpoint";
import { fieldOf } from "./fieldConfigFixtures";
import { noticeCodes } from "./notificationTestHelpers";
import { setActiveFieldConfig, usePresetStateReset } from "./presetConnectionsSliceKit";

vi.mock("../wasm/mazeService", async (importActual) =>
  (await import("./postEditSliceMocks")).mazeServiceMock(await importActual<typeof import("../wasm/mazeService")>()));
vi.mock("../wasm/wasmLoader", async (importActual) =>
  (await import("./postEditSliceMocks")).wasmLoaderMock(await importActual<typeof import("../wasm/wasmLoader")>()));

usePresetStateReset();

describe("mazeStore preset split nodes, point reset and blueprints", () => {
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
      expect(noticeCodes()).toEqual([]);
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
      expect(noticeCodes()).toEqual(["preset_connections/preset_connections.remove_endpoint_node_rejected"]);
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
      expect(noticeCodes()).toEqual([]);
    });
  });

  describe("applyPresetSplitBlueprint (GitHub issue #235)", () => {
    // Square field is centered on the origin (`ox = floor(width/2)`, see `configAllCells`) —
    // width 9 covers x,y in [-4, 4], wide enough for the origin plus every one of its neighbors.
    const wideField = fieldOf("square", { shape: "rect", cols: 9, rows: 9 });
    const square = { id: 0, degree: 4, nodeFaces: [[0, 2], [1, 3]] };

    it("mints one slot per extra blueprint node and wires passage connections to in-field neighbors", () => {
      setActiveFieldConfig({ fieldConfig: wideField });
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
      setActiveFieldConfig({ fieldConfig: wideField });
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
      setActiveFieldConfig({ fieldConfig: wideField });
      useMazeStore.setState({
        presetSplitPoints: { "0,0": [0] },
        presetStart: presetEndpoint([0, 0], 0),
      });
      useMazeStore.getState().applyPresetSplitBlueprint([0, 0], square);
      const s = useMazeStore.getState();
      expect(s.presetSplitPoints["0,0"]).toEqual([0]);
      expect(s.presetStart).toEqual(presetEndpoint([0, 0], 0));
      expect(noticeCodes()).toEqual([]);
    });

    it("moves occupied preset elements from a dropped slot onto the original node", () => {
      const oldSlot = presetEndpoint([0, 0], 5);
      const singleNode = { id: 1, degree: 4, nodeFaces: [[0, 2]] };
      setActiveFieldConfig({ fieldConfig: wideField });
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
      setActiveFieldConfig({ fieldConfig: wideField });
      useMazeStore.setState({ presetSplitPoints: {}, presetActiveSplitNode: {} });
      expect(() => useMazeStore.getState().applyPresetSplitBlueprint([0, 0], oversized)).not.toThrow();
      // Face 0 (in range) still wires normally; face 5 (out of range) is silently skipped.
      expect(useMazeStore.getState().presetConnections.get("0,0-1,0")?.state).toBe("passage");
    });

    it("skips a face pointing outside the field instead of writing a connection to it", () => {
      // width=3 centers cells at x,y in [-1, 1] — the origin's east neighbor (1,0) is in-field,
      // but its own east neighbor (2,0) (face 0 of a shifted point) would be out of field.
      const narrowField = fieldOf("square", { shape: "rect", cols: 1, rows: 1 });
      setActiveFieldConfig({ fieldConfig: narrowField });
      useMazeStore.setState({ presetSplitPoints: {}, presetActiveSplitNode: {} });
      useMazeStore.getState().applyPresetSplitBlueprint([0, 0], square);
      const s = useMazeStore.getState();
      // Every face of (0,0) points outside a 1x1 field — no connection should be written at all.
      expect(s.presetConnections.size).toBe(0);
    });

    it("clears presetSplitPoints for a single-node blueprint (no extra slots to mint)", () => {
      const singleNode = { id: 0, degree: 4, nodeFaces: [[0, 2]] };
      setActiveFieldConfig({ fieldConfig: wideField });
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
      setActiveFieldConfig({ fieldConfig: wideField });
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
