import { describe, it, expect, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";

describe.each([
  ["walls", "patchVectorByWallsTeleportGroupOverrides", "vectorByWallsSettings"],
  ["corridors", "patchVectorByCorridorsTeleportGroupOverrides", "vectorByCorridorsSettings"],
] as const)("patch%sTeleportGroupOverrides (GitHub issue #728)", (_mode, action, settingsKey) => {
  beforeEach(() => useMazeStore.setState(baseStoreState()));

  it("merges each group's patch into its override in one store update", () => {
    useMazeStore.setState({
      [settingsKey]: { ...useMazeStore.getState()[settingsKey], teleportGroupOverrides: { a: { shape: "circle", fillColor: 1 } } },
    });
    let updates = 0;
    const unsub = useMazeStore.subscribe(() => { updates++; });
    useMazeStore.getState()[action]({ a: { fillColor: 2 }, b: { fillColor: 3 } });
    unsub();

    expect(updates).toBe(1);
    expect(useMazeStore.getState()[settingsKey].teleportGroupOverrides).toEqual({
      a: { shape: "circle", fillColor: 2, linkBroken: { fillColor: true } },
      b: { fillColor: 3, linkBroken: { fillColor: true } },
    });
  });
});
