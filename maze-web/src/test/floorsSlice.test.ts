import { describe, it, expect, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseFloorFieldConfig } from "./storeTestHelpers";
import { presetEndpoint } from "../pixi/presetEndpoint";
import { presetEdgeKey } from "../pixi/presetSplitResolve";
import { fieldOf } from "./fieldConfigFixtures";
import { DEFAULT_VECTOR_BY_WALLS_SETTINGS, DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS } from "../store/slices/imageExportDefaults";

beforeEach(() => {
  useMazeStore.setState({
    floors: [{ id: "floor_1", title: "Floor 1" }],
    nextFloorNumber: 2,
    activeFloorId: "floor_1",
    floorFields: { floor_1: baseFloorFieldConfig() },
  });
});

describe("floorsSlice", () => {
  it("starts with a single default floor", () => {
    // Fresh module state (before beforeEach's explicit reset) is asserted separately in
    // storeTypes-level defaults; here we only check the slice's own actions against a known base.
    expect(useMazeStore.getState().floors).toEqual([{ id: "floor_1", title: "Floor 1" }]);
  });

  describe("addFloor", () => {
    it("clears generation and post-edit results but preserves presets", () => {
      const preset = useMazeStore.getState().presetConnections;
      useMazeStore.setState({
        nodes: [{ id: 1, x: 0, y: 0, i: 0 }],
        edges: [{ from: 1, to: 1, kind: "basic" }],
        statistics: {} as never,
        mazeDirty: true,
        postEditDirty: true,
        postEditAnalytics: {} as never,
        presetConnections: new Map([["keep", { from: { point: [0, 0] }, to: { point: [1, 0] }, state: "passage", source: "user" }]]),
      });
      useMazeStore.getState().addFloor();
      const state = useMazeStore.getState();
      expect(state.nodes).toEqual([]);
      expect(state.edges).toEqual([]);
      expect(state.postEditAnalytics).toBeNull();
      expect(state.mazeDirty).toBe(false);
      expect(state.postEditDirty).toBe(false);
      expect(state.presetConnections).not.toBe(preset);
      expect(state.presetConnections.has("keep")).toBe(true);
    });

    it("appends a new floor at the end with the next default title", () => {
      useMazeStore.getState().addFloor();
      const { floors, nextFloorNumber } = useMazeStore.getState();
      expect(floors).toHaveLength(2);
      expect(floors[1].title).toBe("Floor 2");
      expect(nextFloorNumber).toBe(3);
    });

    it("never reuses a floor number after the floor bearing it was removed", () => {
      useMazeStore.getState().addFloor(); // Floor 2
      const secondId = useMazeStore.getState().floors[1].id;
      useMazeStore.getState().removeFloor(secondId);
      useMazeStore.getState().addFloor();
      expect(useMazeStore.getState().floors.at(-1)?.title).toBe("Floor 3");
    });

    it("copies the topmost floor's own FloorFieldConfig, not the active floor's", () => {
      // floor_1 (topmost so far) gets a distinctive config before adding floor 2, then floor_1
      // is made active again before adding floor 3 — floor 3 must copy floor 2 (the current
      // topmost floor), not floor_1 (the active one), proving addFloor's copy source is
      // floors[floors.length - 1], not activeFloorId.
      useMazeStore.setState({
        floorFields: { floor_1: baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 3, rows: 4 }) }) },
      });
      useMazeStore.getState().addFloor(); // Floor 2, copies floor_1's 3x4 config
      const floor2Id = useMazeStore.getState().floors[1].id;
      useMazeStore.setState({
        floorFields: {
          ...useMazeStore.getState().floorFields,
          [floor2Id]: baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 7, rows: 8 }) }),
        },
      });
      useMazeStore.getState().setActiveFloorId("floor_1");

      useMazeStore.getState().addFloor(); // Floor 3 — active floor is floor_1, topmost is floor 2

      const { floors, floorFields } = useMazeStore.getState();
      const floor3Id = floors[2].id;
      expect(floorFields[floor3Id].fieldConfig).toEqual(fieldOf("square", { shape: "rect", cols: 7, rows: 8 }));
    });

    it("copies into an independent object, not a shared reference", () => {
      useMazeStore.getState().addFloor();
      const floor2Id = useMazeStore.getState().floors[1].id;
      useMazeStore.getState().setActiveFloorId(floor2Id);
      useMazeStore.getState().setFieldEditMode("custom");
      useMazeStore.getState().addFieldPoint(5, 5);
      const floor1Config = useMazeStore.getState().floorFields.floor_1;
      const floor2Config = useMazeStore.getState().floorFields[floor2Id];
      expect(floor1Config).not.toBe(floor2Config);
      expect(floor1Config.isEditingField).toBe(false);
      expect(floor2Config.isEditingField).toBe(true);
    });
  });

  describe("removeFloor", () => {
    it("removes the given floor by id", () => {
      useMazeStore.getState().addFloor();
      const secondId = useMazeStore.getState().floors[1].id;
      useMazeStore.getState().removeFloor(secondId);
      expect(useMazeStore.getState().floors).toEqual([{ id: "floor_1", title: "Floor 1" }]);
    });

    it("is a no-op when only one floor remains", () => {
      const onlyId = useMazeStore.getState().floors[0].id;
      useMazeStore.getState().removeFloor(onlyId);
      expect(useMazeStore.getState().floors).toHaveLength(1);
    });

    it("is a no-op for an unknown id", () => {
      useMazeStore.getState().addFloor();
      const before = useMazeStore.getState().floors;
      useMazeStore.getState().removeFloor("not_a_real_id");
      expect(useMazeStore.getState().floors).toEqual(before);
    });

    it("drops presets on the removed floor and shifts presets on floors above it down by one", () => {
      useMazeStore.getState().addFloor(); // Floor 2
      useMazeStore.getState().addFloor(); // Floor 3
      const [, f2, f3] = useMazeStore.getState().floors;
      const epF2 = presetEndpoint([0, 0], undefined, 1); // on the floor about to be removed
      const epF3 = presetEndpoint([1, 1], undefined, 2); // on the floor above it
      useMazeStore.setState({
        presetStart: epF2,
        presetFinish: epF3,
        lockedNodes: new Map([["0,0@1", "both"], ["1,1@2", "in"]]),
        presetSplitPoints: { "1,1@2": [0] },
      });

      useMazeStore.getState().removeFloor(f2.id);

      expect(useMazeStore.getState().presetStart).toBeNull(); // orphaned along with its floor
      expect(useMazeStore.getState().presetFinish).toEqual(presetEndpoint([1, 1], undefined, 1)); // level 2 -> 1
      expect(useMazeStore.getState().lockedNodes.has("0,0@1")).toBe(false);
      expect(useMazeStore.getState().lockedNodes.has("1,1@1")).toBe(true);
      expect(useMazeStore.getState().presetSplitPoints).toEqual({ "1,1@1": [0] });
      expect(f3).toBeDefined();
    });

    it("leaves floor-0 presets untouched when a higher floor is removed", () => {
      useMazeStore.getState().addFloor();
      const [, f2] = useMazeStore.getState().floors;
      const epFloor0 = presetEndpoint([3, 3]);
      useMazeStore.setState({ presetStart: epFloor0 });
      useMazeStore.getState().removeFloor(f2.id);
      expect(useMazeStore.getState().presetStart).toEqual(epFloor0);
    });
  });

  describe("renameFloor", () => {
    it("updates the floor's title", () => {
      const id = useMazeStore.getState().floors[0].id;
      useMazeStore.getState().renameFloor(id, "Ground Floor");
      expect(useMazeStore.getState().floors[0].title).toBe("Ground Floor");
      expect(useMazeStore.getState().floors[0].titleCustomized).toBe(true);
    });

    it("makes reset renderer settings default to title-based floor labels", () => {
      useMazeStore.getState().resetVectorByWallsSettings();
      expect(useMazeStore.getState().vectorByWallsSettings.floorLabel.labelMode).toBe("index");
      useMazeStore.getState().renameFloor(useMazeStore.getState().floors[0].id, "Ground");
      expect(useMazeStore.getState().vectorByWallsSettings.floorLabel.labelMode).toBe("index");
      useMazeStore.getState().resetVectorByWallsSettings();
      useMazeStore.getState().resetVectorByCorridorsSettings();
      expect(useMazeStore.getState().vectorByWallsSettings.floorLabel.labelMode).toBe("title");
      expect(useMazeStore.getState().vectorByCorridorsSettings.floorLabel.labelMode).toBe("title");
    });

    it("trims surrounding whitespace", () => {
      const id = useMazeStore.getState().floors[0].id;
      useMazeStore.getState().renameFloor(id, "  Attic  ");
      expect(useMazeStore.getState().floors[0].title).toBe("Attic");
    });

    it("is a no-op on an empty/whitespace-only title", () => {
      const id = useMazeStore.getState().floors[0].id;
      useMazeStore.getState().renameFloor(id, "   ");
      expect(useMazeStore.getState().floors[0].title).toBe("Floor 1");
      expect(useMazeStore.getState().floors[0].titleCustomized).toBeUndefined();
    });

    it("does not mark the title customized when committed unchanged", () => {
      useMazeStore.getState().renameFloor("floor_1", " Floor 1 ");
      expect(useMazeStore.getState().floors[0].titleCustomized).toBeUndefined();
    });
  });

  describe("floor-label mode on first Image Export open", () => {
    it("picks title mode once when a floor was renamed, then keeps manual choices", () => {
      useMazeStore.setState({ floorLabelModeChosen: false, vectorByWallsSettings: DEFAULT_VECTOR_BY_WALLS_SETTINGS, vectorByCorridorsSettings: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS });
      useMazeStore.getState().renameFloor("floor_1", "Ground");
      useMazeStore.getState().setOpenCard("image_export");
      expect(useMazeStore.getState().floorLabelModeChosen).toBe(true);
      expect(useMazeStore.getState().vectorByWallsSettings.floorLabel.labelMode).toBe("title");
      expect(useMazeStore.getState().vectorByCorridorsSettings.floorLabel.labelMode).toBe("title");

      const walls = useMazeStore.getState().vectorByWallsSettings;
      useMazeStore.setState({ vectorByWallsSettings: { ...walls, floorLabel: { ...walls.floorLabel, labelMode: "index" } } });
      useMazeStore.getState().setOpenCard("basic_config");
      useMazeStore.getState().setOpenCard("image_export");
      expect(useMazeStore.getState().vectorByWallsSettings.floorLabel.labelMode).toBe("index");
    });

    it("keeps index mode when no floor was renamed", () => {
      useMazeStore.setState({ floorLabelModeChosen: false, vectorByWallsSettings: DEFAULT_VECTOR_BY_WALLS_SETTINGS, vectorByCorridorsSettings: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS });
      useMazeStore.getState().setOpenCard("image_export");
      expect(useMazeStore.getState().floorLabelModeChosen).toBe(true);
      expect(useMazeStore.getState().vectorByWallsSettings.floorLabel.labelMode).toBe("index");
    });
  });

  describe("moveFloor", () => {
    beforeEach(() => {
      useMazeStore.getState().addFloor(); // Floor 2
      useMazeStore.getState().addFloor(); // Floor 3
    });

    it("swaps with the adjacent entry toward the array's end on \"down\"", () => {
      const [f1, f2] = useMazeStore.getState().floors;
      useMazeStore.getState().moveFloor(f1.id, "down");
      const floors = useMazeStore.getState().floors;
      expect(floors[0].id).toBe(f2.id);
      expect(floors[1].id).toBe(f1.id);
    });

    it("swaps with the adjacent entry toward the array's start on \"up\"", () => {
      const floorsBefore = useMazeStore.getState().floors;
      const last = floorsBefore[floorsBefore.length - 1];
      const middle = floorsBefore[floorsBefore.length - 2];
      useMazeStore.getState().moveFloor(last.id, "up");
      const floors = useMazeStore.getState().floors;
      expect(floors[floors.length - 1].id).toBe(middle.id);
      expect(floors[floors.length - 2].id).toBe(last.id);
    });

    it("is a no-op moving \"up\" past the start of the array", () => {
      const before = useMazeStore.getState().floors;
      const firstId = before[0].id;
      useMazeStore.getState().moveFloor(firstId, "up");
      expect(useMazeStore.getState().floors).toEqual(before);
    });

    it("is a no-op moving \"down\" past the end of the array", () => {
      const before = useMazeStore.getState().floors;
      const lastId = before[before.length - 1].id;
      useMazeStore.getState().moveFloor(lastId, "down");
      expect(useMazeStore.getState().floors).toEqual(before);
    });

    it("is a no-op for an unknown id", () => {
      const before = useMazeStore.getState().floors;
      useMazeStore.getState().moveFloor("not_a_real_id", "down");
      expect(useMazeStore.getState().floors).toEqual(before);
    });

    it("remaps preset levels to keep pointing at the same floor after a swap", () => {
      // floor 0 = f1, floor 1 = f2, floor 2 = f3 — a preset on f2 (level 1) and one on f3 (level 2).
      const [f1, f2, f3] = useMazeStore.getState().floors;
      const epF2 = presetEndpoint([0, 0], undefined, 1);
      const epF3 = presetEndpoint([1, 1], undefined, 2);
      useMazeStore.setState({
        presetStart: epF2,
        presetFinish: epF3,
        lockedNodes: new Map([["0,0@1", "both"]]),
        presetSplitPoints: { "1,1@2": [0] },
      });

      useMazeStore.getState().moveFloor(f2.id, "down"); // f2 <-> f3: f2 now at index 2, f3 now at index 1

      const floors = useMazeStore.getState().floors;
      expect(floors[1].id).toBe(f3.id);
      expect(floors[2].id).toBe(f2.id);
      // presetStart was on f2, which is now at level 2.
      expect(useMazeStore.getState().presetStart).toEqual(presetEndpoint([0, 0], undefined, 2));
      // presetFinish was on f3, which is now at level 1.
      expect(useMazeStore.getState().presetFinish).toEqual(presetEndpoint([1, 1], undefined, 1));
      expect(useMazeStore.getState().lockedNodes.has("0,0@2")).toBe(true);
      expect(useMazeStore.getState().presetSplitPoints).toEqual({ "1,1@1": [0] });
      expect(f1).toBeDefined(); // f1 (level 0) untouched by the swap, sanity check on fixture setup
    });

    it("leaves floor-0 presets untouched when swapping two floors above it", () => {
      const [, f2, f3] = useMazeStore.getState().floors;
      const epFloor0 = presetEndpoint([2, 2]);
      useMazeStore.setState({ presetStart: epFloor0 });
      useMazeStore.getState().moveFloor(f2.id, "down");
      expect(useMazeStore.getState().presetStart).toEqual(epFloor0);
      expect(f3).toBeDefined();
    });

    it("remaps preset connection entries and rebuilds their map key", () => {
      const [, f2, f3] = useMazeStore.getState().floors;
      const from = presetEndpoint([0, 0], undefined, 1);
      const to = presetEndpoint([1, 0], undefined, 1);
      const oldKey = presetEdgeKey(from, to);
      useMazeStore.setState({
        presetConnections: new Map([[oldKey, { from, to, state: "passage", source: "user" }]]),
      });

      useMazeStore.getState().moveFloor(f2.id, "down");

      const newFrom = presetEndpoint([0, 0], undefined, 2);
      const newTo = presetEndpoint([1, 0], undefined, 2);
      const newKey = presetEdgeKey(newFrom, newTo);
      expect(useMazeStore.getState().presetConnections.has(oldKey)).toBe(false);
      expect(useMazeStore.getState().presetConnections.get(newKey)).toMatchObject({ state: "passage" });
      expect(f3).toBeDefined();
    });
  });

  describe("activeFloorId", () => {
    it("starts pointed at the initial floor", () => {
      const id = useMazeStore.getState().floors[0].id;
      expect(useMazeStore.getState().activeFloorId).toBe(id);
    });

    describe("setActiveFloorId", () => {
      it("sets activeFloorId to a known floor id", () => {
        useMazeStore.getState().addFloor();
        const secondId = useMazeStore.getState().floors[1].id;
        useMazeStore.getState().setActiveFloorId(secondId);
        expect(useMazeStore.getState().activeFloorId).toBe(secondId);
      });

      it("is a no-op for an unknown id", () => {
        const before = useMazeStore.getState().activeFloorId;
        useMazeStore.getState().setActiveFloorId("not_a_real_id");
        expect(useMazeStore.getState().activeFloorId).toBe(before);
      });
    });

    describe("removeFloor", () => {
      it("falls back to the bottom floor when the active floor is removed", () => {
        useMazeStore.getState().addFloor();
        const [first, second] = useMazeStore.getState().floors;
        useMazeStore.getState().setActiveFloorId(second.id);
        useMazeStore.getState().removeFloor(second.id);
        expect(useMazeStore.getState().activeFloorId).toBe(first.id);
      });

      it("leaves activeFloorId untouched when a different floor is removed", () => {
        useMazeStore.getState().addFloor();
        const [first, second] = useMazeStore.getState().floors;
        useMazeStore.getState().setActiveFloorId(first.id);
        useMazeStore.getState().removeFloor(second.id);
        expect(useMazeStore.getState().activeFloorId).toBe(first.id);
      });
    });
  });
});
