import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState, baseFloorFieldConfig, postEditStatePatch, TEST_FLOOR_ID } from "./storeTestHelpers";
import { nodeEndpoint, edgeKey } from "../pixi/postEditEndpoint";
import { PostEditRenderer } from "../pixi/PostEditRenderer";
import { WallRenderer } from "../pixi/renderers/WallRenderer";
import { SplitJunctionRenderer } from "../pixi/renderers/SplitJunctionRenderer";
import { TeleportRenderer } from "../pixi/renderers/TeleportRenderer";
import { WaypointsRenderer } from "../pixi/renderers/WaypointsRenderer";
import { CellFillRenderer } from "../pixi/renderers/CellFillRenderer";
import { EdgeHighlightRenderer } from "../pixi/renderers/EdgeHighlightRenderer";
import { IssueHighlightOverlay } from "../pixi/IssueHighlightOverlay";
import { canvas } from "../pixi/colorTokens";

vi.mock("../wasm/mazeService", () => ({
  generateMaze: vi.fn(),
  computeAnalyticsAsync: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
}));
vi.mock("../wasm/wasmLoader", () => ({
  initWasm: vi.fn(() => Promise.resolve()),
}));
// Cartesian coords come from wasm, unavailable here — same square-grid stand-in as other renderer tests.
vi.mock("../pixi/cartesianCache", () => ({
  getCartesian: (x: number, y: number): [number, number] => [x, y],
}));

const n = nodeEndpoint;
// Point (2,0) is split into nodes 2 and 3; (3,0) is an ordinary cell.
const NODES = [
  { id: 0, x: 0, y: 0, i: 0 },
  { id: 1, x: 1, y: 0, i: 0 },
  { id: 2, x: 2, y: 0, i: 0 },
  { id: 3, x: 2, y: 0, i: 1 },
  { id: 4, x: 3, y: 0, i: 0 },
];
const EDGES = [
  { from: 0, to: 1, kind: "basic" as const },
  { from: 1, to: 0, kind: "basic" as const },
];

describe("PostEditRenderer layer skipping (GitHub issue #739)", () => {
  let renderer: PostEditRenderer;

  beforeEach(() => {
    useMazeStore.setState({
      ...baseStoreState(),
      floorFields: { [TEST_FLOOR_ID]: baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 4, height: 1 } }) },
      activeTessellationConfig: { type: "square", width: 4, height: 1 },
      ...postEditStatePatch({ nodes: NODES, edges: EDGES, start: 0, finish: 1 }),
      postEditActiveSplitNode: {},
      postEditDragOverride: null,
      postEditAutoConfirm: false,
      postEditTool: "wall",
      openCard: "generation",
    } as Partial<ReturnType<typeof useMazeStore.getState>>);
    renderer = new PostEditRenderer(new Container());
    useMazeStore.setState({ openCard: "post_edit" });
  });

  afterEach(() => {
    renderer.destroy();
    vi.restoreAllMocks();
  });

  it("redraws only drag-dependent layers while a marker drag preview moves", () => {
    const walls = vi.spyOn(WallRenderer.prototype, "render");
    const junctions = vi.spyOn(SplitJunctionRenderer.prototype, "render");
    const teleports = vi.spyOn(TeleportRenderer.prototype, "render");
    const markers = vi.spyOn(WaypointsRenderer.prototype, "render");

    useMazeStore.getState().setPostEditDragOverride({ kind: "marker", marker: "finish", endpoint: n(4) });
    useMazeStore.getState().setPostEditDragOverride({ kind: "marker", marker: "finish", endpoint: n(0) });
    useMazeStore.getState().setPostEditDragOverride(null);

    expect(markers).toHaveBeenCalledTimes(3);
    expect(teleports).toHaveBeenCalledTimes(3);
    expect(walls).not.toHaveBeenCalled();
    expect(junctions).not.toHaveBeenCalled();
  });

  it("rebuilds split junctions only when a dragged marker enters or leaves a split node", () => {
    const junctions = vi.spyOn(SplitJunctionRenderer.prototype, "render");
    const walls = vi.spyOn(WallRenderer.prototype, "render");
    const drag = (id: number) =>
      useMazeStore.getState().setPostEditDragOverride({ kind: "marker", marker: "finish", endpoint: n(id) });

    drag(4);
    expect(junctions).not.toHaveBeenCalled();
    drag(3);
    expect(junctions).toHaveBeenCalledTimes(1);
    expect(walls).toHaveBeenCalledTimes(1);
    drag(4);
    expect(junctions).toHaveBeenCalledTimes(2);
    drag(0);
    expect(junctions).toHaveBeenCalledTimes(2);
  });

  it("redraws walls once the draft edges change", () => {
    useMazeStore.setState({ postEditTool: "passage" });
    const walls = vi.spyOn(WallRenderer.prototype, "render");
    useMazeStore.getState().applyPostEditTool(edgeKey(n(1), n(2)), n(1), n(2));
    expect(walls).toHaveBeenCalledTimes(1);
  });

  it("redraws every layer after the card is closed and reopened", () => {
    useMazeStore.setState({ openCard: "generation" });
    const walls = vi.spyOn(WallRenderer.prototype, "render");
    const junctions = vi.spyOn(SplitJunctionRenderer.prototype, "render");
    useMazeStore.setState({ openCard: "post_edit" });
    expect(walls).toHaveBeenCalledTimes(1);
    expect(junctions).toHaveBeenCalledTimes(1);
  });

  it("redraws a hover highlight only when its target changes, and again after the card reopens", () => {
    const fills = vi.spyOn(CellFillRenderer.prototype, "render");
    const edges = vi.spyOn(EdgeHighlightRenderer.prototype, "render");
    const edge = { key: "0,0|1,0", from: [0, 0] as [number, number], to: [1, 0] as [number, number] };

    renderer.updateCellHover([1, 0]);
    renderer.updateCellHover([1, 0]);
    renderer.updateCellHover([1, 0], true);
    renderer.updateHover(edge);
    renderer.updateHover({ ...edge, from: [0, 0], to: [1, 0] });
    expect(fills).toHaveBeenCalledTimes(2);
    expect(edges).toHaveBeenCalledTimes(1);

    useMazeStore.setState({ openCard: "generation" });
    useMazeStore.setState({ openCard: "post_edit" });
    fills.mockClear();
    renderer.updateCellHover([1, 0], true);
    expect(fills).toHaveBeenCalledTimes(1);
  });

  it("redraws walls and closed cells when the tessellation config object changes", () => {
    const walls = vi.spyOn(WallRenderer.prototype, "render");
    const fills = vi.spyOn(CellFillRenderer.prototype, "render");
    useMazeStore.setState({
      floorFields: { [TEST_FLOOR_ID]: baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 4, height: 1 } }) },
    });
    expect(walls).toHaveBeenCalledTimes(1);
    const closedCellDraws = fills.mock.calls.filter(([data]) => !Array.isArray(data) && data.color === canvas.wall.default);
    expect(closedCellDraws).toHaveLength(1);
  });

  it("draws the issue highlight once per graph change and again when the hovered issue changes", () => {
    const issue = vi.spyOn(IssueHighlightOverlay.prototype, "render");
    useMazeStore.setState({ nodes: [...useMazeStore.getState().nodes] });
    expect(issue).toHaveBeenCalledTimes(1);
    useMazeStore.setState({ hoveredIssueLoopEdges: [] });
    expect(issue).toHaveBeenCalledTimes(2);
  });
});
