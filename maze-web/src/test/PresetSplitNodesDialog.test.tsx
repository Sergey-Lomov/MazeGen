import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../wasm/wasmLoader", () => ({
  getWasm: () => ({
    cartesian_coords: (config: { points: [number, number][] }) => config.points,
  }),
}));

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
});
