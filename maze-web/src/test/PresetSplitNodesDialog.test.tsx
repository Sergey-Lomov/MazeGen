import { describe, expect, it, vi, beforeEach } from "vitest";


import { render, screen } from "@testing-library/react";
import { PresetSplitNodesDialog } from "../components/features/PresetSplitNodesDialog";
import { useMazeStore } from "../store/mazeStore";
import { presetEndpoint } from "../pixi/presetEndpoint";
import { baseStoreState } from "./storeTestHelpers";

beforeEach(() => {
  useMazeStore.setState({
    ...baseStoreState(),
    presetSplitPoints: { "2,2": [0] },
    presetConnections: new Map(),
    presetTeleports: [],
    presetVerticalPassages: [],
    presetElevators: [],
    presetStart: null,
    presetFinish: null,
    presetGenSource: presetEndpoint([2, 2], 0),
    lockedNodes: new Map(),
    autoLockedNodes: new Set(),
    presetActiveSplitNode: {},
  });
});

describe("PresetSplitNodesDialog", () => {
  it("shows a preset generation source in the node's elements", () => {
    render(<PresetSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);

    expect(screen.getByText("Gen source")).toBeInTheDocument();
  });

  it.each(["wall", "undefined"] as const)("shows a %s edge as a two-way link whichever way the entry is stored", (state) => {
    const ends = [
      { from: presetEndpoint([2, 2], 0), to: presetEndpoint([3, 2]) },
      { from: presetEndpoint([3, 2]), to: presetEndpoint([2, 2], 0) },
    ];
    for (const entry of ends) {
      useMazeStore.setState({ presetConnections: new Map([["k", { ...entry, state, source: "user" }]]) });
      const { unmount } = render(<PresetSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);

      const links = screen.getAllByText(/^2:2 \(N\d\) (<->|->|<-) \d:\d$/);
      for (const link of links) expect(link.textContent).toContain("<->");
      unmount();
    }
  });
});
