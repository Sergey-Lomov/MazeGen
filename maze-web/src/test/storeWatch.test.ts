import { describe, it, expect, vi } from "vitest";
import { watchStoreInputs } from "../pixi/storeWatch";

const { useMazeStore } = await import("../store/mazeStore");

// `watchStoreInputs`: a redraw runs once now and then only after an update that changes one of its inputs.

describe("watchStoreInputs", () => {
  it("redraws on a change of an input, once per burst, and ignores unrelated updates", async () => {
    const redraw = vi.fn();
    const unwatch = watchStoreInputs((st) => [st.activeFloorId], redraw);
    expect(redraw).toHaveBeenCalledTimes(1);

    useMazeStore.setState({ openCard: "generation" } as never);
    useMazeStore.setState({ openCard: "analytics" } as never);
    await Promise.resolve();
    expect(redraw).toHaveBeenCalledTimes(1);

    const floor = useMazeStore.getState().activeFloorId;
    useMazeStore.setState({ activeFloorId: floor + 1 } as never);
    useMazeStore.setState({ activeFloorId: floor + 2 } as never);
    await Promise.resolve();
    expect(redraw).toHaveBeenCalledTimes(2);

    unwatch();
    useMazeStore.setState({ activeFloorId: floor } as never);
    await Promise.resolve();
    expect(redraw).toHaveBeenCalledTimes(2);
  });
});
