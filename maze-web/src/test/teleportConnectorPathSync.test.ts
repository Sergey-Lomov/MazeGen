import { describe, expect, it } from "vitest";

const { useMazeStore } = await import("../store/mazeStore");
const { baseStoreState } = await import("./storeTestHelpers");

// Stale manual connector paths are dropped when edges change (GitHub issue #950).

const path = { nodes: [[0, 0], [1, 1]] as [number, number][] };
const tp = (from: number, to: number) => ({ from, to, kind: "teleport" as const });

function setup(edges: unknown[]) {
  const { vectorByWallsSettings, vectorByCorridorsSettings } = useMazeStore.getState();
  const manualTeleportConnectorPaths = { "1:2": path, "3:4": path };
  useMazeStore.setState({
    ...baseStoreState(),
    edges: edges as never,
    vectorByWallsSettings: { ...vectorByWallsSettings, manualTeleportConnectorPaths },
    vectorByCorridorsSettings: { ...vectorByCorridorsSettings, manualTeleportConnectorPaths },
  } as never);
}

describe("installTeleportConnectorPathSync", () => {
  it("drops the path of a deleted teleport in both export modes", () => {
    setup([tp(1, 2), tp(3, 4)]);
    useMazeStore.setState({ edges: [tp(2, 1)] as never });
    expect(Object.keys(useMazeStore.getState().vectorByWallsSettings.manualTeleportConnectorPaths!)).toEqual(["1:2"]);
    expect(Object.keys(useMazeStore.getState().vectorByCorridorsSettings.manualTeleportConnectorPaths!)).toEqual(["1:2"]);
  });

  it("does not count a non-teleport edge between the same nodes as a live teleport", () => {
    setup([tp(1, 2), tp(3, 4)]);
    useMazeStore.setState({ edges: [tp(1, 2), { from: 3, to: 4, kind: "basic" }] as never });
    expect(Object.keys(useMazeStore.getState().vectorByWallsSettings.manualTeleportConnectorPaths!)).toEqual(["1:2"]);
  });

  it("leaves the settings untouched when no path is stale or none exist", () => {
    setup([tp(1, 2), tp(3, 4)]);
    const before = useMazeStore.getState().vectorByWallsSettings;
    useMazeStore.setState({ edges: [tp(3, 4), tp(1, 2)] as never });
    expect(useMazeStore.getState().vectorByWallsSettings).toBe(before);

    useMazeStore.setState({ vectorByWallsSettings: { ...before, manualTeleportConnectorPaths: {} } });
    const empty = useMazeStore.getState().vectorByWallsSettings;
    useMazeStore.setState({ edges: [] });
    useMazeStore.setState({ edges: [tp(9, 10)] as never });
    expect(useMazeStore.getState().vectorByWallsSettings).toBe(empty);
  });

  it("keeps both floor segments of a live cross-floor pair and drops its legacy plain-key path (GitHub issue #989)", () => {
    const set = (paths: Record<string, typeof path>, edges: unknown[]) => {
      const { vectorByWallsSettings, vectorByCorridorsSettings } = useMazeStore.getState();
      useMazeStore.setState({
        ...baseStoreState(),
        nodes: [{ id: 1, x: 0, y: 0, level: 0 }, { id: 2, x: 0, y: 0, level: 1 }, { id: 3, x: 1, y: 1, level: 0 }, { id: 4, x: 1, y: 1, level: 0 }] as never,
        edges: edges as never,
        vectorByWallsSettings: { ...vectorByWallsSettings, manualTeleportConnectorPaths: paths },
        vectorByCorridorsSettings: { ...vectorByCorridorsSettings, manualTeleportConnectorPaths: paths },
      } as never);
    };
    set({ "1:2": path, "1:2@1": path, "1:2@2": path, "3:4": path }, [tp(1, 2), tp(3, 4)]);
    useMazeStore.setState({ edges: [tp(2, 1), tp(3, 4)] as never });
    expect(Object.keys(useMazeStore.getState().vectorByWallsSettings.manualTeleportConnectorPaths!)).toEqual(["1:2@1", "1:2@2", "3:4"]);
  });

  it("drops cross-floor segments when the pair is removed or no longer crosses floors", () => {
    const { vectorByWallsSettings } = useMazeStore.getState();
    useMazeStore.setState({
      ...baseStoreState(),
      nodes: [{ id: 1, x: 0, y: 0, level: 0 }, { id: 2, x: 0, y: 0, level: 0 }] as never,
      edges: [tp(5, 6)] as never,
      vectorByWallsSettings: { ...vectorByWallsSettings, manualTeleportConnectorPaths: { "1:2@1": path, "1:2@2": path } },
    } as never);
    useMazeStore.setState({ edges: [tp(1, 2)] as never });
    expect(useMazeStore.getState().vectorByWallsSettings.manualTeleportConnectorPaths).toEqual({});
  });

  it("keeps everything while edges are empty", () => {
    setup([tp(1, 2), tp(3, 4)]);
    useMazeStore.setState({ edges: [] });
    expect(Object.keys(useMazeStore.getState().vectorByWallsSettings.manualTeleportConnectorPaths!)).toEqual(["1:2", "3:4"]);
  });
});
