import { describe, it, expect, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";

beforeEach(() => {
  useMazeStore.setState({
    floors: [{ id: "floor_1", title: "Floor 1" }],
    nextFloorNumber: 2,
  });
});

describe("floorsSlice", () => {
  it("starts with a single default floor", () => {
    // Fresh module state (before beforeEach's explicit reset) is asserted separately in
    // storeTypes-level defaults; here we only check the slice's own actions against a known base.
    expect(useMazeStore.getState().floors).toEqual([{ id: "floor_1", title: "Floor 1" }]);
  });

  describe("addFloor", () => {
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
  });

  describe("renameFloor", () => {
    it("updates the floor's title", () => {
      const id = useMazeStore.getState().floors[0].id;
      useMazeStore.getState().renameFloor(id, "Ground Floor");
      expect(useMazeStore.getState().floors[0].title).toBe("Ground Floor");
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
  });
});
