import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { presetEndpoint, presetEndpointsEqual } from "../pixi/presetEndpoint";
import { addFloor, usePresetStateReset } from "./presetConnectionsSliceKit";

vi.mock("../wasm/mazeService", async (importActual) =>
  (await import("./postEditSliceMocks")).mazeServiceMock(await importActual<typeof import("../wasm/mazeService")>()));
vi.mock("../wasm/wasmLoader", async (importActual) =>
  (await import("./postEditSliceMocks")).wasmLoaderMock(await importActual<typeof import("../wasm/wasmLoader")>()));

usePresetStateReset();

describe("mazeStore preset split target pick", () => {
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

    it("lock pick sets its own kind on the exact split node, never toggling it off (GitHub issue #748)", () => {
      openPrompt({ tool: "lock_in" });
      useMazeStore.getState().applyPresetSplitTargetPick(0);
      expect(useMazeStore.getState().lockedNodes.get("0,0:0")).toBe("in");

      openPrompt({ tool: "lock_out" });
      useMazeStore.getState().applyPresetSplitTargetPick(0);
      expect(useMazeStore.getState().lockedNodes.get("0,0:0")).toBe("out");

      openPrompt({ tool: "lock_out" });
      useMazeStore.getState().applyPresetSplitTargetPick(0);
      expect(useMazeStore.getState().lockedNodes.get("0,0:0")).toBe("out");
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
      addFloor(FLOOR_2_ID, "Floor 2");
      openPrompt({ tool: "elevator" });
      useMazeStore.getState().applyPresetSplitTargetPick(0);
      expect(presetEndpointsEqual(useMazeStore.getState().presetElevatorPending!.origin, presetEndpoint([0, 0], 0))).toBe(true);
    });

    it("vertical passage places a passage anchored on the picked slot, carrying the tool", () => {
      // A vertical passage needs a floor above to auto-commit (single available direction).
      addFloor(FLOOR_2_ID, "Floor 2");
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
