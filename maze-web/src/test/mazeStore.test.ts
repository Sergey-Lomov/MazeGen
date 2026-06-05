import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";

vi.mock("../wasm/mazeService", () => ({
  generateMaze: vi.fn(),
}));

import { generateMaze } from "../wasm/mazeService";

const mockSnapshot = {
  nodes: [{ id: 0, x: 0, y: 0 }, { id: 1, x: 1, y: 0 }],
  edges: [{ from: 0, to: 1 }],
  start: 0,
  finish: 1,
  warnings: [],
  nav_nodes: [],
  nav_edges: [],
  components: [],
};

beforeEach(() => {
  useMazeStore.setState({
    seed: 42,
    width: 10,
    height: 10,
    nodes: [],
    edges: [],
    start: null,
    finish: null,
    showNodeIds: false,
    showCoords: false,
    showGraphOverlay: true,
    selectedNode: null,
    error: null,
  });
  vi.mocked(generateMaze).mockReset();
});

describe("mazeStore setters", () => {
  it("setSeed updates seed and clears error", () => {
    useMazeStore.setState({ error: "old error" });
    useMazeStore.getState().setSeed(99);
    expect(useMazeStore.getState().seed).toBe(99);
    expect(useMazeStore.getState().error).toBeNull();
  });

  it("setWidth updates width and clears error", () => {
    useMazeStore.setState({ error: "old error" });
    useMazeStore.getState().setWidth(5);
    expect(useMazeStore.getState().width).toBe(5);
    expect(useMazeStore.getState().error).toBeNull();
  });

  it("setHeight updates height and clears error", () => {
    useMazeStore.setState({ error: "old error" });
    useMazeStore.getState().setHeight(7);
    expect(useMazeStore.getState().height).toBe(7);
    expect(useMazeStore.getState().error).toBeNull();
  });
});

describe("mazeStore.generate", () => {
  it("stores snapshot on success", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.getState().generate();
    const s = useMazeStore.getState();
    expect(s.nodes).toEqual(mockSnapshot.nodes);
    expect(s.edges).toEqual(mockSnapshot.edges);
    expect(s.start).toBe(0);
    expect(s.finish).toBe(1);
    expect(s.error).toBeNull();
    expect(s.selectedNode).toBeNull();
  });

  it("calls generateMaze with current seed/width/height", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({ seed: 7, width: 3, height: 4 });
    useMazeStore.getState().generate();
    expect(generateMaze).toHaveBeenCalledWith(7, 3, 4);
  });

  it("stores error string on Error throw", () => {
    vi.mocked(generateMaze).mockImplementation(() => { throw new Error("bad wasm"); });
    useMazeStore.getState().generate();
    expect(useMazeStore.getState().error).toBe("bad wasm");
  });

  it("stores string error when non-Error thrown", () => {
    vi.mocked(generateMaze).mockImplementation(() => { throw "raw error"; });
    useMazeStore.getState().generate();
    expect(useMazeStore.getState().error).toBe("raw error");
  });

  it("clears selectedNode on generate", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({ selectedNode: 5 });
    useMazeStore.getState().generate();
    expect(useMazeStore.getState().selectedNode).toBeNull();
  });
});

describe("mazeStore.reset", () => {
  it("clears nodes, edges, start, finish, selectedNode, error", () => {
    useMazeStore.setState({
      nodes: mockSnapshot.nodes,
      edges: mockSnapshot.edges,
      start: 0,
      finish: 1,
      selectedNode: 0,
      error: "something",
    });
    useMazeStore.getState().reset();
    const s = useMazeStore.getState();
    expect(s.nodes).toEqual([]);
    expect(s.edges).toEqual([]);
    expect(s.start).toBeNull();
    expect(s.finish).toBeNull();
    expect(s.selectedNode).toBeNull();
    expect(s.error).toBeNull();
  });
});

describe("mazeStore.setDebugFlag", () => {
  it("sets showNodeIds", () => {
    useMazeStore.getState().setDebugFlag("showNodeIds", true);
    expect(useMazeStore.getState().showNodeIds).toBe(true);
  });

  it("sets showCoords", () => {
    useMazeStore.getState().setDebugFlag("showCoords", true);
    expect(useMazeStore.getState().showCoords).toBe(true);
  });

  it("sets showGraphOverlay", () => {
    useMazeStore.getState().setDebugFlag("showGraphOverlay", false);
    expect(useMazeStore.getState().showGraphOverlay).toBe(false);
  });
});

describe("mazeStore.selectNode", () => {
  it("sets selectedNode", () => {
    useMazeStore.getState().selectNode(3);
    expect(useMazeStore.getState().selectedNode).toBe(3);
  });

  it("clears selectedNode with null", () => {
    useMazeStore.setState({ selectedNode: 3 });
    useMazeStore.getState().selectNode(null);
    expect(useMazeStore.getState().selectedNode).toBeNull();
  });
});
