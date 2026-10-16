import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState, baseFloorFieldConfig, postEditStatePatch, TEST_FLOOR_ID } from "./storeTestHelpers";
import type { PostEditSeed } from "./storeTestHelpers";
import { encodePoint } from "../pixi/tessellationProjection";
import { edgeKey, nodeEndpoint } from "../pixi/postEditEndpoint";
import { PostEditController } from "../pixi/PostEditController";
import type { PostEditRenderer } from "../pixi/PostEditRenderer";
import { fieldOf } from "./fieldConfigFixtures";
import { fakeCellCenters } from "./cellCentersFake";

vi.mock("../wasm/mazeService", () => ({
  generateMaze: vi.fn(),
  computeAnalyticsAsync: vi.fn(),
  getCellCenters: vi.fn((config: Parameters<typeof fakeCellCenters>[0]) => fakeCellCenters(config)),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
}));
vi.mock("../wasm/wasmLoader", () => ({
  initWasm: vi.fn(() => Promise.resolve()),
}));

const n = nodeEndpoint;
const cells = new Set([encodePoint(0, 0), encodePoint(1, 0), encodePoint(2, 0)]);
const activeControllers: PostEditController[] = [];

function makeController(): PostEditController {
  const renderer = {
    getCachedCellSet: () => cells,
    getCachedCells: () => [[0, 0], [1, 0], [2, 0]],
    updateCellHover: vi.fn(),
    updateHover: vi.fn(),
    updateTeleportPreview: vi.fn(),
  } as unknown as PostEditRenderer;
  const controller = new PostEditController(
    () => ({ x: 0, y: 0, scale: { x: 1, y: 1 } }) as unknown as Container,
    renderer,
    vi.fn(),
  );
  activeControllers.push(controller);
  return controller;
}

/** Square cell centers: (20, -20), (60, -20), (100, -20). */
function cellCenter(x: number): [number, number] {
  return [20 + x * 40, -20];
}

/** Clicks a cell: press and release without moving. */
function click(controller: PostEditController, x: number): void {
  controller.onPointerDown(...cellCenter(x), 0);
  controller.onPointerUp(0);
}

/** Three floor-0 nodes in a row; generation produced a single one-way edge 0 -> 1. */
function seed(overrides: Partial<PostEditSeed> = {}, extra: Partial<ReturnType<typeof useMazeStore.getState>> = {}): void {
  useMazeStore.setState({
    ...postEditStatePatch({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }, { id: 2, x: 2, y: 0, i: 0 }],
      edges: [{ from: 0, to: 1, kind: "basic" }],
      start: 0,
      finish: null,
      ...overrides,
    }),
    ...extra,
  } as Partial<ReturnType<typeof useMazeStore.getState>>);
}

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
  useMazeStore.setState({
    openCard: "post_edit",
    activeFieldConfig: fieldOf("square", { shape: "rect", cols: 3, rows: 1 }),
    floorFields: { [TEST_FLOOR_ID]: baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 3, rows: 1 }), fieldPoints: cells }) },
    postEditAutoConfirm: false,
    postEditAutoCompact: false,
    postEditActiveSplitNode: {},
    postEditDragOverride: null,
    postEditSplitTargetPrompt: null,
    postEditEntityPickPrompt: null,
    postEditMoveRequest: null,
    postEditConnectionSettingsPrompt: null,
    postEditTeleportPendingFrom: null,
  });
  seed();
});

afterEach(() => {
  for (const controller of activeControllers.splice(0)) controller.destroy();
});

describe("PostEditController element tools (GitHub issue #748)", () => {
  it("a placement click on an occupied node adds the tool's element; a press that leaves the cell drags instead", () => {
    useMazeStore.setState({ postEditTool: "set_finish" });
    const controller = makeController();

    click(controller, 0);
    expect(useMazeStore.getState().postEditDraftMeta?.finish).toEqual(n(0));
    expect(useMazeStore.getState().postEditDraftMeta?.start).toEqual(n(0));

    // The start marker is first in hit-test priority: dragging it moves start, finish stays.
    controller.onPointerDown(...cellCenter(0), 0);
    controller.onPointerMove(...cellCenter(2));
    controller.onPointerUp(0);
    expect(useMazeStore.getState().postEditDraftMeta?.start).toEqual(n(2));
    expect(useMazeStore.getState().postEditDraftMeta?.finish).toEqual(n(0));
  });

  it("the move tool carries a marker until the next click, and Escape or a right click cancel the carry", () => {
    useMazeStore.setState({ postEditTool: "move" });
    const controller = makeController();

    click(controller, 0);
    controller.onPointerMove(...cellCenter(1));
    expect(useMazeStore.getState().postEditDragOverride).toMatchObject({ kind: "marker" });
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));
    expect(useMazeStore.getState().postEditDragOverride).toBeNull();
    click(controller, 1);
    expect(useMazeStore.getState().postEditDraftMeta?.start).toEqual(n(0));

    click(controller, 0);
    controller.onPointerMove(...cellCenter(2));
    controller.onPointerDown(...cellCenter(2), 2);
    expect(useMazeStore.getState().postEditDraftMeta?.start).toEqual(n(0));

    click(controller, 0);
    controller.onPointerMove(...cellCenter(2));
    click(controller, 2);
    expect(useMazeStore.getState().postEditDraftMeta?.start).toEqual(n(2));
    expect(useMazeStore.getState().postEditDragOverride).toBeNull();
  });

  it("switching floors cancels a carried element", () => {
    useMazeStore.setState({
      postEditTool: "move",
      floors: [{ id: TEST_FLOOR_ID, title: "Floor 1" }, { id: "floor_2", title: "Floor 2" }],
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 3, rows: 1 }), fieldPoints: cells }),
        floor_2: baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 3, rows: 1 }), fieldPoints: cells }),
      },
    });
    const controller = makeController();

    click(controller, 0);
    controller.onPointerMove(...cellCenter(1));
    expect(useMazeStore.getState().postEditDragOverride).not.toBeNull();
    useMazeStore.setState({ activeFloorId: "floor_2" });
    expect(useMazeStore.getState().postEditDragOverride).toBeNull();
    useMazeStore.setState({ activeFloorId: TEST_FLOOR_ID });
    click(controller, 1);
    expect(useMazeStore.getState().postEditDraftMeta?.start).toEqual(n(0));
  });

  it("the settings tool reverses a one-way edge and never touches another edge", () => {
    seed({ start: null });
    useMazeStore.setState({ postEditTool: "settings" });
    const controller = makeController();
    const key01 = edgeKey(n(0), n(1));
    const key10 = edgeKey(n(1), n(0));
    expect(useMazeStore.getState().postEditDraftEdges?.[key01]?.kind).toBe("one_way_forward");

    controller.onPointerDown(40, -20, 0);
    expect(useMazeStore.getState().postEditDraftEdges?.[key10]?.kind).toBe("one_way_forward");
    expect(useMazeStore.getState().postEditCommands).toHaveLength(1);

    // The 1|2 face is a wall: the settings tool has nothing to configure there.
    controller.onPointerDown(80, -20, 0);
    expect(useMazeStore.getState().postEditCommands).toHaveLength(1);
  });

  it("moving a teleport endpoint onto its other endpoint's split tile takes the free node", () => {
    seed({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 3, x: 0, y: 0, i: 1 }, { id: 1, x: 1, y: 0, i: 0 }, { id: 2, x: 2, y: 0, i: 0 }],
      edges: [],
      start: null,
      commands: [{ kind: "addTeleport", id: "t1", from: n(0), to: n(2), direction: "forward" }],
    }, { postEditTool: "move" });
    const controller = makeController();

    controller.onPointerDown(...cellCenter(2), 0);
    controller.onPointerMove(...cellCenter(0));
    controller.onPointerUp(0);
    const state = useMazeStore.getState();
    expect(state.postEditSplitTargetPrompt).toBeNull();
    const teleport = state.postEditDraftTeleports.find((t) => t.id === "t1");
    expect(teleport?.from).toEqual(n(0));
    expect(teleport?.to).toMatchObject({ kind: "split", point: [0, 0] });
  });
});
