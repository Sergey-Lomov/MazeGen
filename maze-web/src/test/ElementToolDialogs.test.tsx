import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConnectionSettingsDialog } from "../components/dialogs/ConnectionSettingsDialog";
import { PresetConnectionSettingsDialog } from "../components/dialogs/PresetConnectionSettingsDialog";
import { PostEditConnectionSettingsDialog } from "../components/dialogs/PostEditConnectionSettingsDialog";
import { PresetEntityPickDialog } from "../components/dialogs/PresetEntityPickDialog";
import { PostEditEntityPickDialog } from "../components/dialogs/PostEditEntityPickDialog";
import { PresetLockSettingsDialog } from "../components/dialogs/PresetLockSettingsDialog";
import { useMazeStore } from "../store/mazeStore";
import { presetEndpoint } from "../pixi/presetEndpoint";
import { nodeEndpoint } from "../pixi/postEditEndpoint";
import { baseStoreState, baseFloorFieldConfig, postEditStatePatch, TEST_FLOOR_ID } from "./storeTestHelpers";
import * as m from "~/paraglide/messages";

vi.mock("../wasm/mazeService", () => ({
  generateMaze: vi.fn(),
  computeAnalyticsAsync: vi.fn(),
  getCartesianCoords: vi.fn((cfg: { points: [number, number][] }) => cfg.points.map(([x, y]) => [x, y])),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
}));
vi.mock("../wasm/wasmLoader", () => ({
  initWasm: vi.fn(() => Promise.resolve()),
}));

const n = nodeEndpoint;

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
});

describe("ConnectionSettingsDialog (GitHub issue #748)", () => {
  it("lists the from bubble first in every row and shows the direction only by the arrow", () => {
    render(<ConnectionSettingsDialog title="T" fromLabel="A" toLabel="B" direction="forward" onSelect={vi.fn()} onClose={vi.fn()} />);
    const rows = screen.getAllByRole("button").filter((button) => button.textContent?.includes("A"));
    expect(rows.map((row) => Array.from(row.querySelectorAll("span")).slice(1).map((span) => span.textContent))).toEqual([
      ["A", "<->", "B"],
      ["A", "->", "B"],
      ["A", "<-", "B"],
    ]);
  });

  it("applies the picked option and closes", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<ConnectionSettingsDialog title="T" fromLabel="A" toLabel="B" direction="two_way" onSelect={onSelect} onClose={onClose} />);
    fireEvent.click(screen.getByText("<-").closest("button")!);
    expect(onSelect).toHaveBeenCalledWith("backward");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("PresetConnectionSettingsDialog (GitHub issue #748)", () => {
  it("shows only floors for a vertical passage", () => {
    useMazeStore.setState({
      floors: [{ id: "f1", title: "Floor 1" }, { id: "f2", title: "Floor 2" }],
      presetVerticalPassages: [{ id: 4, from: presetEndpoint([3, 5], undefined, 0), to: presetEndpoint([3, 5], undefined, 1), direction: "two_way" }],
      presetConnectionSettingsPrompt: { kind: "vertical_passage", id: 4 },
    });
    render(<PresetConnectionSettingsDialog onClose={vi.fn()} />);
    expect(screen.getAllByText("L1")).toHaveLength(3);
    expect(screen.getAllByText("L2")).toHaveLength(3);
    expect(screen.queryByText(/3:5/)).toBeNull();
  });
});

describe("PostEditConnectionSettingsDialog (GitHub issue #748)", () => {
  it("shows only floors for a vertical passage and applies the pick as an absolute command", () => {
    useMazeStore.setState({
      floors: [{ id: TEST_FLOOR_ID, title: "Floor 1" }, { id: "floor_2", title: "Floor 2" }],
      floorFields: { [TEST_FLOOR_ID]: baseFloorFieldConfig(), floor_2: baseFloorFieldConfig() },
      postEditAutoConfirm: false,
      ...postEditStatePatch({
        nodes: [{ id: 0, x: 3, y: 5, i: 0, level: 0 }, { id: 1, x: 3, y: 5, i: 0, level: 1 }],
        edges: [],
        start: null,
        finish: null,
        commands: [{ kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" }],
      }),
      postEditConnectionSettingsPrompt: { kind: "vertical_passage", id: "v1" },
    });
    const onClose = vi.fn();
    render(<PostEditConnectionSettingsDialog onClose={onClose} />);
    expect(screen.getAllByText("L1")).toHaveLength(3);
    expect(screen.queryByText(/3:5/)).toBeNull();

    fireEvent.click(screen.getByText("<->").closest("button")!);
    expect(useMazeStore.getState().postEditDraftVerticalPassages[0].direction).toBe("two_way");
    expect(useMazeStore.getState().postEditCommands.at(-1)).toMatchObject({ kind: "setVerticalPassageDirection", absolute: true });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("element pick dialogs (GitHub issue #748)", () => {
  it("the preset picker lists the cell's movable elements and hands the chosen one to the move tool", () => {
    useMazeStore.setState({
      presetStart: presetEndpoint([0, 0]),
      presetTeleports: [{ id: 4, from: presetEndpoint([0, 0]), to: presetEndpoint([2, 0]), direction: "forward" }],
      presetEntityPickPrompt: { point: [0, 0], purpose: "move" },
      presetMoveRequest: null,
    });
    render(<PresetEntityPickDialog onClose={vi.fn()} />);
    expect(screen.getByText(m["tools.pick_move_hint"]())).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Teleport/ }));
    expect(useMazeStore.getState().presetMoveRequest).toMatchObject({ kind: "teleport", id: "4" });
    expect(useMazeStore.getState().presetEntityPickPrompt).toBeNull();
  });

  it("the post-edit picker opens the chosen element's settings", () => {
    useMazeStore.setState({
      postEditAutoConfirm: false,
      ...postEditStatePatch({
        nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }, { id: 2, x: 2, y: 0, i: 0 }],
        edges: [],
        start: null,
        finish: null,
        commands: [
          { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
          { kind: "addTeleport", id: "t2", from: n(2), to: n(0), direction: "two_way" },
        ],
      }),
      postEditEntityPickPrompt: { point: [0, 0], purpose: "settings" },
      postEditConnectionSettingsPrompt: null,
    });
    render(<PostEditEntityPickDialog onClose={vi.fn()} />);
    expect(screen.getByText(m["tools.pick_settings_hint"]())).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /Teleport/ })[1]);
    expect(useMazeStore.getState().postEditConnectionSettingsPrompt).toEqual({ kind: "teleport", id: "t2" });
  });
});

describe("PresetLockSettingsDialog (GitHub issue #748)", () => {
  it("switches the lock's kind and closes", () => {
    useMazeStore.setState({
      lockedNodes: new Map([["1,0", "in"]]),
      presetLockSettingsPrompt: { endpoint: presetEndpoint([1, 0]) },
    });
    const onClose = vi.fn();
    render(<PresetLockSettingsDialog onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: m["preset.lock_out"]() }));
    expect(useMazeStore.getState().lockedNodes.get("1,0")).toBe("out");
    expect(onClose).toHaveBeenCalled();
  });
});
