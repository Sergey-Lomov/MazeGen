import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import * as m from "~/paraglide/messages";
import { presetEndpoint, presetEndpointsEqual } from "../pixi/presetEndpoint";
import { buildPresetPointEntities } from "../pixi/pointEntities";
import { usePresetStateReset } from "./presetConnectionsSliceKit";

vi.mock("../wasm/mazeService", async (importActual) =>
  (await import("./postEditSliceMocks")).mazeServiceMock(await importActual<typeof import("../wasm/mazeService")>()));
vi.mock("../wasm/wasmLoader", async (importActual) =>
  (await import("./postEditSliceMocks")).wasmLoaderMock(await importActual<typeof import("../wasm/wasmLoader")>()));

usePresetStateReset();

describe("mazeStore preset entity delete", () => {
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

    it("treats a multi-node split tile as one entity for deletion dispatch", () => {
      useMazeStore.setState({ presetSplitPoints: { "0,0": [0, 1, 2] } });
      useMazeStore.getState().requestPresetEntityDelete([0, 0], undefined, { kind: "point_all" });

      const s = useMazeStore.getState();
      expect(s.presetEntityDeletePrompt).toBeNull();
      expect(s.presetSplitPoints["0,0"]).toBeUndefined();
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

    it("represents every node of a split tile with one split_node row", () => {
      useMazeStore.setState({
        presetSplitPoints: { "0,0": [0, 1] },
        presetConnections: new Map([
          ["0,0:0-1,0", { from: presetEndpoint([0, 0], 0), to: presetEndpoint([1, 0]), state: "passage" as const, source: "user" as const }],
          ["0,0:1-0,1", { from: presetEndpoint([0, 0], 1), to: presetEndpoint([0, 1]), state: "passage" as const, source: "user" as const }],
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
      expect(splitRow!.id).toBe("split_node");
      expect(splitRow!.endpoint).toEqual(presetEndpoint([0, 0]));
      expect(splitRow!.title).toBe(m["preset.split_tile"]()); // no recognized special shape here — falls back
      // Every slot's edge is folded into the single split row, not listed separately.
      expect(entities.filter((e) => e.kind === "edge")).toHaveLength(0);
      expect(entities.filter((e) => e.kind === "split_node")).toHaveLength(1);
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
        presetSplitPoints: { "0,0": [0, 1] },
        presetConnections: new Map([
          ["0,0:0-1,0", { from: presetEndpoint([0, 0], 0), to: presetEndpoint([1, 0]), state: "passage" as const, source: "user" as const }],
          ["0,0:1-0,1", { from: presetEndpoint([0, 0], 1), to: presetEndpoint([0, 1]), state: "passage" as const, source: "user" as const }],
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
      expect(after.presetConnections.has("0,0:1-0,1")).toBe(false);
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
