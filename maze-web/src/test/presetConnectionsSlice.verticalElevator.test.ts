import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { presetEndpoint, presetEndpointsEqual } from "../pixi/presetEndpoint";
import { fieldOf } from "./fieldConfigFixtures";
import { noticeCodes, noticeParams } from "./notificationTestHelpers";
import {
  ELEVATOR_DRAG_FAILED, VERTICAL_PASSAGE_DRAG_FAILED, VERTICAL_PASSAGE_NO_ADJACENT_CELL,
} from "../notifications/editRefusalNotifications";
import { formatTargetLabel } from "../pixi/targetLabel";
import { addFloor, usePresetStateReset } from "./presetConnectionsSliceKit";

vi.mock("../wasm/mazeService", async (importActual) =>
  (await import("./postEditSliceMocks")).mazeServiceMock(await importActual<typeof import("../wasm/mazeService")>()));
vi.mock("../wasm/wasmLoader", async (importActual) =>
  (await import("./postEditSliceMocks")).wasmLoaderMock(await importActual<typeof import("../wasm/wasmLoader")>()));

usePresetStateReset();

describe("mazeStore preset vertical passages and elevators", () => {
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
      addFloor(FLOOR_2_ID, "Floor 2");
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
      addFloor("floor_3", "Floor 3");
      // Origin on floor 1 (the middle floor) has both a floor below (0) and above (2).
      useMazeStore.getState().startPresetVerticalPassagePlacement(presetEndpoint([0, 0], undefined, 1), "vertical_passage_one_way");
      const s = useMazeStore.getState();
      expect(s.presetVerticalPassagePending).not.toBeNull();
      expect(s.presetVerticalPassagePending?.availableDirections.sort()).toEqual(["down", "up"]);
      expect(s.presetVerticalPassages).toHaveLength(0);
    });

    it("startPresetVerticalPassagePlacement explains when neither direction has a cell", () => {
      // Single floor -> no floor above, and origin is already floor 0 -> no floor below either.
      useMazeStore.getState().startPresetVerticalPassagePlacement(presetEndpoint([0, 0]), "vertical_passage_two_way");
      const s = useMazeStore.getState();
      expect(s.presetVerticalPassagePending).toBeNull();
      expect(noticeCodes()).toEqual([`preset_connections/${VERTICAL_PASSAGE_NO_ADJACENT_CELL}`]);
      expect(s.presetVerticalPassages).toHaveLength(0);
    });

    it("choosePresetVerticalPassageDirection('down') creates a passage to the floor below and clears the pending dialog", () => {
      setTwoFloors();
      addFloor("floor_3", "Floor 3");
      useMazeStore.getState().startPresetVerticalPassagePlacement(presetEndpoint([0, 0], undefined, 1), "vertical_passage_two_way");
      useMazeStore.getState().choosePresetVerticalPassageDirection("down");
      const s = useMazeStore.getState();
      expect(s.presetVerticalPassagePending).toBeNull();
      expect(s.presetVerticalPassages).toHaveLength(1);
      // toLevel === 0 must normalize to `undefined`, not an explicit level: 0 — every `(level ?? 0)`
      // comparison downstream depends on this convention.
      expect(s.presetVerticalPassages[0].to).toEqual(presetEndpoint([0, 0]));
    });

    it("re-clicking a cell with an existing passage adds another passage (GitHub issue #748)", () => {
      setTwoFloors();
      useMazeStore.setState({
        presetVerticalPassages: [{ id: 7, from: presetEndpoint([0, 0]), to: presetEndpoint([0, 0], undefined, 1), direction: "forward" }],
        _nextPresetVerticalPassageId: 8,
      });
      useMazeStore.getState().startPresetVerticalPassagePlacement(presetEndpoint([0, 0]), "vertical_passage_one_way");
      const s = useMazeStore.getState();
      expect(s.presetVerticalPassages).toHaveLength(2);
      expect(s.presetVerticalPassages[0]).toMatchObject({ id: 7, direction: "forward" });
      expect(s.presetVerticalPassages[1]).toMatchObject({ id: 8, direction: "forward" });
    });

    it("offers every available direction even when a passage already occupies one (GitHub issue #748)", () => {
      setTwoFloors();
      addFloor("floor_3", "Floor 3");
      useMazeStore.setState({
        presetVerticalPassages: [{ id: 7, from: presetEndpoint([0, 0], undefined, 1), to: presetEndpoint([0, 0], undefined, 2), direction: "forward" }],
        _nextPresetVerticalPassageId: 8,
      });
      useMazeStore.getState().startPresetVerticalPassagePlacement(presetEndpoint([0, 0], undefined, 1), "vertical_passage_two_way");
      const s = useMazeStore.getState();
      expect(s.presetVerticalPassagePending?.availableDirections.sort()).toEqual(["down", "up"]);
      expect(s.presetVerticalPassages).toHaveLength(1);
    });

    it("cancelPresetVerticalPassagePlacement clears the pending dialog without creating a passage", () => {
      setTwoFloors();
      addFloor("floor_3", "Floor 3");
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
        expect(noticeCodes()).toEqual([`preset_connections/${VERTICAL_PASSAGE_DRAG_FAILED}`]);
        expect(noticeParams(VERTICAL_PASSAGE_DRAG_FAILED)).toEqual({ coords: formatTargetLabel([9, 9], 1, true, undefined) });
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
          floorFields: { ...state.floorFields, [FLOOR_2_ID]: { ...state.floorFields[FLOOR_2_ID], fieldConfig: fieldOf("square", { shape: "rect", cols: 1, rows: 1 }) } },
        }));
        useMazeStore.getState().applyPresetSplitTargetPick(9);
        const s = useMazeStore.getState();
        expect(s.presetSplitTargetPrompt).toBeNull();
        expect(noticeCodes()).toEqual([`preset_connections/${VERTICAL_PASSAGE_DRAG_FAILED}`]);
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
          floorFields: { ...state.floorFields, [FLOOR_2_ID]: { ...state.floorFields[FLOOR_2_ID], fieldConfig: fieldOf("square", { shape: "rect", cols: 1, rows: 1 }) } },
        }));
        useMazeStore.getState().applyPresetSplitTargetPick(4);
        const s = useMazeStore.getState();
        expect(s.presetSplitTargetPrompt).toBeNull();
        expect(noticeCodes()).toEqual([`preset_connections/${ELEVATOR_DRAG_FAILED}`]);
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
        expect(noticeCodes()).toEqual([`preset_connections/${ELEVATOR_DRAG_FAILED}`]);
      });

      it("elevator with two split target floors ends up created after both picks", () => {
        setTwoFloors();
        addFloor("floor_3", "Floor 3");
        useMazeStore.setState({
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
        addFloor("floor_3", "Floor 3");
        useMazeStore.setState({
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

});
