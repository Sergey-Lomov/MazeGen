import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState, baseFloorFieldConfig, postEditStatePatch, TEST_FLOOR_ID } from "./storeTestHelpers";
import { PostEditRenderer } from "../pixi/PostEditRenderer";
import { VerticalConnectionRenderer } from "../pixi/renderers/VerticalConnectionRenderer";
import type { VerticalConnectionMarker } from "../pixi/renderers/types";
import type { EdgeDto, NodeDto } from "../wasm/types";
import { fieldOf } from "./fieldConfigFixtures";

vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  getGeometrySnapshot: (await importActual<typeof import("../wasm/mazeService")>()).getGeometrySnapshot,
  getCellAt: (await importActual<typeof import("../wasm/mazeService")>()).getCellAt,
  getCellsInRegion: (await importActual<typeof import("../wasm/mazeService")>()).getCellsInRegion,
  generateMaze: vi.fn(),
  computeAnalyticsAsync: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
}));
vi.mock("../wasm/wasmLoader", async (importActual) => ({
  ...(await importActual<typeof import("../wasm/wasmLoader")>()),
  initWasm: vi.fn(() => Promise.resolve()),
}));
const SECOND_FLOOR_ID = "floor_2";
const TESS = fieldOf("square", { shape: "rect", cols: 2, rows: 1 });
// Two floors of a 2x1 grid: (0,0) is node 0 / node 1, (1,0) is node 2 / node 3.
const NODES: NodeDto[] = [
  { id: 0, x: 0, y: 0, i: 0, level: 0 },
  { id: 1, x: 0, y: 0, i: 0, level: 1 },
  { id: 2, x: 1, y: 0, i: 0, level: 0 },
  { id: 3, x: 1, y: 0, i: 0, level: 1 },
];
const GENERATED_EDGES: EdgeDto[] = [
  { from: 0, to: 1, kind: "vertical_passage" },
  { from: 1, to: 0, kind: "vertical_passage" },
];

describe("PostEditRenderer vertical markers (GitHub issue #564)", () => {
  let renderer: PostEditRenderer | null = null;

  beforeEach(() => {
    useMazeStore.setState({
      ...baseStoreState(),
      floors: [{ id: TEST_FLOOR_ID, title: "Floor 1" }, { id: SECOND_FLOOR_ID, title: "Floor 2" }],
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({ fieldConfig: TESS }),
        [SECOND_FLOOR_ID]: baseFloorFieldConfig({ fieldConfig: TESS }),
      },
      activeFieldConfig: TESS,
      postEditActiveSplitNode: {},
      postEditDragOverride: null,
      postEditAutoConfirm: false,
      postEditTool: "wall",
      openCard: "generation",
    } as Partial<ReturnType<typeof useMazeStore.getState>>);
  });

  afterEach(() => {
    renderer?.destroy();
    renderer = null;
    vi.restoreAllMocks();
  });

  it("draws markers only from draft entries, ignoring stale vertical edges in the confirmed graph", () => {
    // The confirmed graph also holds a vertical passage at (1,0) that no draft entry backs — the kind
    // of stale mirror a previous confirm leaves behind after the entry was removed or moved.
    useMazeStore.setState(postEditStatePatch({
      nodes: NODES,
      edges: GENERATED_EDGES,
      liveEdges: [
        ...GENERATED_EDGES,
        { from: 2, to: 3, kind: "vertical_passage" },
        { from: 3, to: 2, kind: "vertical_passage" },
      ],
    }));
    expect(useMazeStore.getState().postEditDraftVerticalPassages).toHaveLength(1);

    const render = vi.spyOn(VerticalConnectionRenderer.prototype, "render");
    renderer = new PostEditRenderer(new Container());
    useMazeStore.setState({ openCard: "post_edit" });

    const markers: VerticalConnectionMarker[] = render.mock.calls.at(-1)![0].markers;
    expect(markers.map((m) => m.fromNode)).toEqual([0]);
  });
});
