import { describe, it, expect, vi } from "vitest";

let currentState: { floors: { id: string }[]; setActiveFloorId: ReturnType<typeof vi.fn> };

vi.mock("../store/mazeStore", () => ({
  useMazeStore: { getState: () => currentState },
}));

const { navigateToFloor } = await import("../pixi/renderers/floorNavigation");

describe("navigateToFloor", () => {
  it("sets activeFloorId to floors[floorIndex].id", () => {
    const setActiveFloorId = vi.fn();
    currentState = { floors: [{ id: "a" }, { id: "b" }, { id: "c" }], setActiveFloorId };

    navigateToFloor(1);

    expect(setActiveFloorId).toHaveBeenCalledWith("b");
  });

  it("no-ops for an out-of-range floorIndex", () => {
    const setActiveFloorId = vi.fn();
    currentState = { floors: [{ id: "a" }], setActiveFloorId };

    navigateToFloor(5);

    expect(setActiveFloorId).not.toHaveBeenCalled();
  });

  it("no-ops for a negative floorIndex", () => {
    const setActiveFloorId = vi.fn();
    currentState = { floors: [{ id: "a" }], setActiveFloorId };

    navigateToFloor(-1);

    expect(setActiveFloorId).not.toHaveBeenCalled();
  });
});
