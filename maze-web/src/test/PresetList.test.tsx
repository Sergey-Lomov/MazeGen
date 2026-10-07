import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PresetList } from "../components/features/PresetList";
import { presetEndpoint } from "../pixi/presetEndpoint";
import { useMazeStore } from "../store/mazeStore";
import { baseFloorFieldConfig, baseStoreState, TEST_FLOOR_ID } from "./storeTestHelpers";
import * as m from "~/paraglide/messages";

vi.mock("../components/features/ToolGlyph", () => ({
  ToolGlyph: () => null,
}));

beforeEach(() => {
  useMazeStore.setState({
    ...baseStoreState(),
    presetConnections: new Map(),
    presetStart: null,
    presetFinish: null,
    presetGenSource: null,
    presetTeleports: [],
    presetVerticalPassages: [],
    presetElevators: [],
    lockedNodes: new Map(),
    presetSplitPoints: {},
    presetActiveSplitNode: null,
  });
});

describe("PresetList filters", () => {
  it("toggles one filter independently and supports bulk enable/disable", () => {
    render(<PresetList onClose={() => {}} />);

    expect(screen.getByText(m["preset.list_filters"]({ active: 9, total: 12 }))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: m["preset.wall"]() }));
    expect(screen.getByText(m["preset.list_filters"]({ active: 10, total: 12 }))).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: m["preset.list_filter_disable_all"]() }));
    expect(screen.getByText(m["preset.list_filters"]({ active: 0, total: 12 }))).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: m["preset.list_filter_enable_all"]() }));
    expect(screen.getByText(m["preset.list_filters"]({ active: 12, total: 12 }))).toBeInTheDocument();
  });

  it("hides floor controls in a single-floor maze and exposes them for multiple floors", () => {
    const floor2 = { id: "floor_2", title: "Floor 2" };
    useMazeStore.setState({
      floors: [
        { id: TEST_FLOOR_ID, title: "Floor 1" },
        floor2,
      ],
      floorFields: {
        [TEST_FLOOR_ID]: baseStoreState().floorFields[TEST_FLOOR_ID],
        [floor2.id]: baseFloorFieldConfig(),
      },
    });

    const { unmount } = render(<PresetList onClose={() => {}} />);
    expect(screen.getByText(m["preset.list_filters"]({ active: 12, total: 15 }))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: m["preset.elevator"]() })).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();

    unmount();
    useMazeStore.setState({
      floors: [{ id: TEST_FLOOR_ID, title: "Floor 1" }],
      floorFields: { [TEST_FLOOR_ID]: baseFloorFieldConfig() },
    });
    render(<PresetList onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: m["preset.elevator"]() })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("collapses the filter section without losing the preset-list divider", () => {
    render(<PresetList onClose={() => {}} />);
    fireEvent.click(screen.getByText(m["preset.list_filters"]({ active: 9, total: 12 })));

    expect(screen.queryByRole("button", { name: m["preset.wall"]() })).not.toBeInTheDocument();
    expect(document.querySelector('[style*="border-top"]')).toBeInTheDocument();
  });

  it("clears the wall hover when its delete icon is pressed", () => {
    const from = presetEndpoint([0, 0]);
    const to = presetEndpoint([1, 0]);
    useMazeStore.setState({
      presetConnections: new Map([
        ["0,0-1,0", { from, to, state: "wall" as const, source: "user" as const }],
      ]),
    });
    render(<PresetList onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: m["preset.wall"]() }));
    const cell = screen.getByTestId("preset-cell");
    fireEvent.mouseEnter(cell);
    expect(useMazeStore.getState().presetHoveredLink).not.toBeNull();

    fireEvent.pointerDown(screen.getByTestId("preset-action-delete"));

    expect(useMazeStore.getState().presetHoveredLink).toBeNull();
    expect(useMazeStore.getState().presetHoveredEntity).toBeNull();
    expect(screen.queryByTestId("preset-cell")).not.toBeInTheDocument();
  });
});
