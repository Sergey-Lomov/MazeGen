import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { encodePoint } from "../pixi/tessellationProjection";

vi.mock("../wasm/mazeService", () => ({
  generateMaze: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
}));

vi.mock("../wasm/wasmLoader", () => ({
  initWasm: vi.fn(() => Promise.resolve()),
}));

import { generateMaze, getAvailableChecks, getAvailableStrategies } from "../wasm/mazeService";
import { initWasm } from "../wasm/wasmLoader";

const mockSnapshot = {
  nodes: [{ id: 0, x: 0, y: 0 }, { id: 1, x: 1, y: 0 }],
  edges: [{ from: 0, to: 1 }],
  start: 0,
  finish: 1,
  warnings: [],
  nav_nodes: [],
  nav_edges: [],
  components: [],
  node_stats: { dead_ends: 2, straight: 0, turns: 0, junctions: [] },
  edge_stats: { bidirectional: 0, one_way: 1, walls: 0 },
  route_info: null,
};

const emptyFreePoints = () => ({
  square: new Set<number>(),
  hex: new Set<number>(),
  triangle: new Set<number>(),
});

beforeEach(() => {
  useMazeStore.setState({
    seed: 42,
    tessellationKind: "square",
    squareShape: "rect",
    hexShape: "parallelogram",
    triangleShape: "rect",
    hexOrientation: "flat_top",
    triOrientation: "r0",
    tessellationConfig: { type: "square", width: 10, height: 10 },
    activeTessellationConfig: { type: "square", width: 10, height: 10 },
    freeFieldPoints: emptyFreePoints(),
    isEditingField: false,
    fieldPoints: new Set<number>(),
    nodes: [],
    edges: [],
    start: null,
    finish: null,
    showNodeIds: false,
    showCoords: false,
    showGraphOverlay: true,
    showFieldOverlay: true,
    selectedNode: null,
    error: null,
    initialConfig: { method: "custom_vertex_based", depth_first: 0.9, corridor_chance: 0.7, branching: 0.5, directionality: 0.0 },
    elementsConfig: { one_way_chance: 0.04 },
    selectedChecks: [],
    selectedStrategies: {},
    strategyParams: {},
    availableStrategies: [],
  });
  vi.mocked(generateMaze).mockReset();
  vi.mocked(initWasm).mockResolvedValue(undefined);
});

describe("mazeStore setters", () => {
  it("setSeed updates seed and clears error", () => {
    useMazeStore.setState({ error: "old error" });
    useMazeStore.getState().setSeed(99);
    expect(useMazeStore.getState().seed).toBe(99);
    expect(useMazeStore.getState().error).toBeNull();
  });

  it("setTessellationConfig updates config and clears error", () => {
    useMazeStore.setState({ error: "old error" });
    useMazeStore.getState().setTessellationConfig({ type: "hex_parallelogram", cols: 5, rows: 7, orientation: "pointy_top" });
    const cfg = useMazeStore.getState().tessellationConfig;
    expect(cfg.type).toBe("hex_parallelogram");
    if (cfg.type === "hex_parallelogram") {
      expect(cfg.cols).toBe(5);
      expect(cfg.rows).toBe(7);
      expect(cfg.orientation).toBe("pointy_top");
    }
    expect(useMazeStore.getState().error).toBeNull();
  });

  it("setTessellationConfig syncs tessellationKind and hexShape", () => {
    useMazeStore.getState().setTessellationConfig({ type: "hex_hexagon", radius: 3, orientation: "flat_top" });
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("hex");
    expect(s.hexShape).toBe("hexagon");
  });

  it("setTessellationConfig syncs tessellationKind and triangleShape", () => {
    useMazeStore.getState().setTessellationConfig({ type: "triangle_triangle", side: 5, orientation: "r90" });
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("triangle");
    expect(s.triangleShape).toBe("triangle");
  });

  it("setTessellationConfig with square_custom sets isEditingField and syncs freeFieldPoints", () => {
    useMazeStore.getState().setTessellationConfig({ type: "square_custom", points: [[1, 2], [3, 4]] });
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("square");
    expect(s.squareShape).toBe("free");
    expect(s.isEditingField).toBe(true);
    expect(s.fieldPoints.size).toBe(2);
    expect(s.freeFieldPoints.square.size).toBe(2);
  });

  it("setTessellationConfig with hex_custom syncs freeFieldPoints.hex", () => {
    useMazeStore.getState().setTessellationConfig({ type: "hex_custom", points: [[0, 0], [1, 0], [0, 1]], orientation: "pointy_top" });
    const s = useMazeStore.getState();
    expect(s.freeFieldPoints.hex.size).toBe(3);
    expect(s.freeFieldPoints.square.size).toBe(0);
    expect(s.hexOrientation).toBe("pointy_top");
  });
});

describe("mazeStore tessellation kind/shape actions", () => {
  it("setTessellationKind to hex sets tessellationKind and hex config type", () => {
    useMazeStore.getState().setTessellationKind("hex");
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("hex");
    expect(s.tessellationConfig.type).toBe("hex_parallelogram");
  });

  it("setTessellationKind to triangle sets tessellationKind and triangle config type", () => {
    useMazeStore.getState().setTessellationKind("triangle");
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("triangle");
    expect(s.tessellationConfig.type).toBe("triangle_rect");
  });

  it("setTessellationKind to square sets tessellationKind and square config type", () => {
    useMazeStore.setState({ tessellationKind: "hex" });
    useMazeStore.getState().setTessellationKind("square");
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("square");
    expect(s.tessellationConfig.type).toBe("square");
  });

  it("setTessellationKind resets freeFieldPoints for target kind", () => {
    useMazeStore.setState({
      tessellationKind: "hex",
      freeFieldPoints: { square: new Set([1, 2]), hex: new Set([3]), triangle: new Set() },
    });
    useMazeStore.getState().setTessellationKind("square");
    const s = useMazeStore.getState();
    expect(s.freeFieldPoints.square.size).toBe(0);
    expect(s.freeFieldPoints.hex.size).toBe(1);
  });

  it("setTessellationKind resets isEditingField", () => {
    useMazeStore.setState({ tessellationKind: "hex", squareShape: "free", isEditingField: true });
    useMazeStore.getState().setTessellationKind("square");
    expect(useMazeStore.getState().isEditingField).toBe(false);
  });

  it("setHexShape to hexagon sets hexShape and hex_hexagon config type", () => {
    useMazeStore.setState({
      tessellationKind: "hex",
      hexShape: "parallelogram",
      tessellationConfig: { type: "hex_parallelogram", cols: 8, rows: 6, orientation: "pointy_top" },
    });
    useMazeStore.getState().setHexShape("hexagon");
    const s = useMazeStore.getState();
    expect(s.hexShape).toBe("hexagon");
    expect(s.tessellationConfig.type).toBe("hex_hexagon");
  });

  it("setHexShape preserves hex orientation", () => {
    useMazeStore.setState({
      tessellationKind: "hex",
      hexShape: "parallelogram",
      hexOrientation: "pointy_top",
      tessellationConfig: { type: "hex_parallelogram", cols: 8, rows: 6, orientation: "pointy_top" },
    });
    useMazeStore.getState().setHexShape("hexagon");
    const cfg = useMazeStore.getState().tessellationConfig;
    if (cfg.type === "hex_hexagon") {
      expect(cfg.orientation).toBe("pointy_top");
    } else {
      throw new Error("unexpected config type");
    }
  });

  it("setHexShape to free sets isEditingField and empty fieldPoints (first time)", () => {
    useMazeStore.setState({
      tessellationKind: "hex",
      hexShape: "parallelogram",
      freeFieldPoints: emptyFreePoints(),
    });
    useMazeStore.getState().setHexShape("free");
    const s = useMazeStore.getState();
    expect(s.hexShape).toBe("free");
    expect(s.isEditingField).toBe(true);
    expect(s.fieldPoints.size).toBe(0);
    expect(s.tessellationConfig.type).toBe("hex_custom");
  });

  it("setHexShape to free restores previously saved points", () => {
    const pts = new Set([encodePoint(1, 0), encodePoint(0, 1)]);
    useMazeStore.setState({
      tessellationKind: "hex",
      hexShape: "parallelogram",
      freeFieldPoints: { ...emptyFreePoints(), hex: pts },
    });
    useMazeStore.getState().setHexShape("free");
    const s = useMazeStore.getState();
    expect(s.fieldPoints.size).toBe(2);
    expect(s.fieldPoints).toBe(pts);
  });

  it("setHexShape from free to parallelogram clears isEditingField", () => {
    useMazeStore.setState({
      tessellationKind: "hex",
      hexShape: "free",
      isEditingField: true,
      fieldPoints: new Set([1]),
    });
    useMazeStore.getState().setHexShape("parallelogram");
    const s = useMazeStore.getState();
    expect(s.isEditingField).toBe(false);
    expect(s.tessellationConfig.type).toBe("hex_parallelogram");
  });

  it("setSquareShape to free sets isEditingField", () => {
    useMazeStore.setState({ tessellationKind: "square", squareShape: "rect", freeFieldPoints: emptyFreePoints() });
    useMazeStore.getState().setSquareShape("free");
    const s = useMazeStore.getState();
    expect(s.squareShape).toBe("free");
    expect(s.isEditingField).toBe(true);
    expect(s.tessellationConfig.type).toBe("square_custom");
  });

  it("setTriangleShape to free sets isEditingField", () => {
    useMazeStore.setState({ tessellationKind: "triangle", triangleShape: "rect", freeFieldPoints: emptyFreePoints() });
    useMazeStore.getState().setTriangleShape("free");
    const s = useMazeStore.getState();
    expect(s.triangleShape).toBe("free");
    expect(s.isEditingField).toBe(true);
    expect(s.tessellationConfig.type).toBe("tri_custom");
  });

  it("setTriangleShape to triangle sets triangleShape and triangle_triangle config type", () => {
    useMazeStore.setState({
      tessellationKind: "triangle",
      triangleShape: "rect",
      tessellationConfig: { type: "triangle_rect", cols: 10, rows: 10, orientation: "r90" },
    });
    useMazeStore.getState().setTriangleShape("triangle");
    const s = useMazeStore.getState();
    expect(s.triangleShape).toBe("triangle");
    expect(s.tessellationConfig.type).toBe("triangle_triangle");
  });

  it("setTriangleShape preserves triangle orientation", () => {
    useMazeStore.setState({
      tessellationKind: "triangle",
      triangleShape: "rect",
      triOrientation: "r180",
      tessellationConfig: { type: "triangle_rect", cols: 10, rows: 10, orientation: "r180" },
    });
    useMazeStore.getState().setTriangleShape("hexagon");
    const cfg = useMazeStore.getState().tessellationConfig;
    if (cfg.type === "triangle_hexagon") {
      expect(cfg.orientation).toBe("r180");
    } else {
      throw new Error("unexpected config type");
    }
  });

  it("setTessellationKind hex→triangle preserves triangle orientation default when coming from non-triangle", () => {
    useMazeStore.setState({
      tessellationKind: "hex",
      tessellationConfig: { type: "hex_parallelogram", cols: 8, rows: 6, orientation: "flat_top" },
    });
    useMazeStore.getState().setTessellationKind("triangle");
    const cfg = useMazeStore.getState().tessellationConfig;
    if (cfg.type === "triangle_rect") {
      expect(cfg.orientation).toBe("r0");
    } else {
      throw new Error("unexpected config type");
    }
  });
});

describe("mazeStore free field actions", () => {
  it("addFieldPoint adds encoded point and updates tessellationConfig", () => {
    useMazeStore.setState({
      tessellationKind: "square",
      squareShape: "free",
      hexShape: "parallelogram",
      triangleShape: "rect",
      isEditingField: true,
      fieldPoints: new Set<number>(),
      freeFieldPoints: emptyFreePoints(),
      hexOrientation: "flat_top",
      triOrientation: "r0",
    });
    useMazeStore.getState().addFieldPoint(3, 5);
    const s = useMazeStore.getState();
    expect(s.fieldPoints.size).toBe(1);
    expect(s.freeFieldPoints.square.size).toBe(1);
    expect(s.tessellationConfig.type).toBe("square_custom");
  });

  it("addFieldPoint is idempotent for same coord", () => {
    useMazeStore.setState({
      tessellationKind: "square",
      squareShape: "free",
      hexShape: "parallelogram",
      triangleShape: "rect",
      isEditingField: true,
      fieldPoints: new Set<number>(),
      freeFieldPoints: emptyFreePoints(),
      hexOrientation: "flat_top",
      triOrientation: "r0",
    });
    useMazeStore.getState().addFieldPoint(1, 1);
    useMazeStore.getState().addFieldPoint(1, 1);
    expect(useMazeStore.getState().fieldPoints.size).toBe(1);
  });

  it("removeFieldPoint removes point and updates tessellationConfig", () => {
    const pts = new Set([encodePoint(0, 0), encodePoint(1, 0)]);
    useMazeStore.setState({
      tessellationKind: "square",
      squareShape: "free",
      hexShape: "parallelogram",
      triangleShape: "rect",
      isEditingField: true,
      fieldPoints: pts,
      freeFieldPoints: { ...emptyFreePoints(), square: pts },
      hexOrientation: "flat_top",
      triOrientation: "r0",
    });
    useMazeStore.getState().removeFieldPoint(0, 0);
    const s = useMazeStore.getState();
    expect(s.fieldPoints.size).toBe(1);
    expect(s.freeFieldPoints.square.size).toBe(1);
  });

  it("removeFieldPoint is no-op for absent coord", () => {
    const pts = new Set([encodePoint(0, 0)]);
    useMazeStore.setState({
      tessellationKind: "square",
      squareShape: "free",
      hexShape: "parallelogram",
      triangleShape: "rect",
      isEditingField: true,
      fieldPoints: pts,
      freeFieldPoints: { ...emptyFreePoints(), square: pts },
      hexOrientation: "flat_top",
      triOrientation: "r0",
    });
    useMazeStore.getState().removeFieldPoint(99, 99);
    expect(useMazeStore.getState().fieldPoints.size).toBe(1);
  });

  it("freeFieldPoints persists per-kind when switching shapes", () => {
    const hexPts = new Set([encodePoint(1, 0), encodePoint(0, 1)]);
    useMazeStore.setState({
      tessellationKind: "hex",
      hexShape: "free",
      squareShape: "rect",
      triangleShape: "rect",
      isEditingField: true,
      fieldPoints: hexPts,
      freeFieldPoints: { ...emptyFreePoints(), hex: hexPts },
    });
    useMazeStore.getState().setHexShape("parallelogram");
    const s1 = useMazeStore.getState();
    expect(s1.isEditingField).toBe(false);
    expect(s1.freeFieldPoints.hex.size).toBe(2);

    useMazeStore.getState().setHexShape("free");
    const s2 = useMazeStore.getState();
    expect(s2.isEditingField).toBe(true);
    expect(s2.fieldPoints.size).toBe(2);
    expect(s2.fieldPoints).toBe(hexPts);
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

  it("calls generateMaze with current seed and tessellationConfig", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({
      seed: 7,
      tessellationConfig: { type: "square", width: 3, height: 4 },
      selectedChecks: [],
      selectedStrategies: {},
    });
    useMazeStore.getState().generate();
    expect(generateMaze).toHaveBeenCalledWith(7, {
      tessellation: { type: "square", width: 3, height: 4 },
      checks: [],
      strategies: {},
      initial: expect.objectContaining({ method: "custom_vertex_based" }),
      elements: { one_way_chance: 0.04 },
    });
  });

  it("calls generateMaze with hex_parallelogram tessellationConfig", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({
      seed: 7,
      tessellationConfig: { type: "hex_parallelogram", cols: 5, rows: 6, orientation: "flat_top" },
      selectedChecks: [],
      selectedStrategies: {},
    });
    useMazeStore.getState().generate();
    expect(generateMaze).toHaveBeenCalledWith(7, {
      tessellation: { type: "hex_parallelogram", cols: 5, rows: 6, orientation: "flat_top" },
      checks: [],
      strategies: {},
      initial: expect.objectContaining({ method: "custom_vertex_based" }),
      elements: { one_way_chance: 0.04 },
    });
  });

  it("calls generateMaze with hex_hexagon tessellationConfig", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({
      seed: 7,
      tessellationConfig: { type: "hex_hexagon", radius: 3, orientation: "pointy_top" },
      selectedChecks: [],
      selectedStrategies: {},
    });
    useMazeStore.getState().generate();
    expect(generateMaze).toHaveBeenCalledWith(7, {
      tessellation: { type: "hex_hexagon", radius: 3, orientation: "pointy_top" },
      checks: [],
      strategies: {},
      initial: expect.objectContaining({ method: "custom_vertex_based" }),
      elements: { one_way_chance: 0.04 },
    });
  });

  it("uses buildFreeConfig when isEditingField", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    const pts = new Set([encodePoint(0, 0), encodePoint(1, 0), encodePoint(0, 1)]);
    useMazeStore.setState({
      seed: 5,
      tessellationKind: "square",
      squareShape: "free",
      hexShape: "parallelogram",
      triangleShape: "rect",
      isEditingField: true,
      fieldPoints: pts,
      freeFieldPoints: { ...emptyFreePoints(), square: pts },
      hexOrientation: "flat_top",
      triOrientation: "r0",
      selectedChecks: [],
      selectedStrategies: {},
    });
    useMazeStore.getState().generate();
    const call = vi.mocked(generateMaze).mock.calls[0];
    expect(call[1].tessellation.type).toBe("square_custom");
    if (call[1].tessellation.type === "square_custom") {
      expect(call[1].tessellation.points).toHaveLength(3);
    }
  });

  it("sets error when isEditingField and fieldPoints.size < 2", () => {
    useMazeStore.setState({
      tessellationKind: "square",
      squareShape: "free",
      hexShape: "parallelogram",
      triangleShape: "rect",
      isEditingField: true,
      fieldPoints: new Set([encodePoint(0, 0)]),
      freeFieldPoints: { ...emptyFreePoints(), square: new Set([encodePoint(0, 0)]) },
    });
    useMazeStore.getState().generate();
    expect(useMazeStore.getState().error).toBeTruthy();
    expect(generateMaze).not.toHaveBeenCalled();
  });

  it("sets error when isEditingField and fieldPoints.size === 0", () => {
    useMazeStore.setState({
      tessellationKind: "square",
      squareShape: "free",
      hexShape: "parallelogram",
      triangleShape: "rect",
      isEditingField: true,
      fieldPoints: new Set<number>(),
      freeFieldPoints: emptyFreePoints(),
    });
    useMazeStore.getState().generate();
    expect(useMazeStore.getState().error).toBeTruthy();
    expect(generateMaze).not.toHaveBeenCalled();
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

  it("passes strategyParams overrides to generateMaze", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({
      tessellationConfig: { type: "square", width: 10, height: 10 },
      selectedChecks: ["missing_endpoints"],
      selectedStrategies: { missing_endpoints: "scored_endpoints" },
      strategyParams: { scored_endpoints: { path_weight: "2", junction_weight: "6" } },
      availableStrategies: [{
        id: "scored_endpoints",
        handles: "missing_endpoints",
        params: [
          { id: "path_weight", label: "Path length weight", kind: { type: "float", default: 1, min: 0, max: 100 } },
          { id: "junction_weight", label: "Junction weight", kind: { type: "float", default: 3, min: 0, max: 100 } },
        ],
      }],
    });
    useMazeStore.getState().generate();
    expect(generateMaze).toHaveBeenCalledWith(42, {
      tessellation: { type: "square", width: 10, height: 10 },
      checks: ["missing_endpoints"],
      strategies: {
        missing_endpoints: {
          id: "scored_endpoints",
          params: { path_weight: "2", junction_weight: "6" },
        },
      },
      initial: expect.objectContaining({ method: "custom_vertex_based" }),
      elements: { one_way_chance: 0.04 },
    });
  });

  it("omits strategyParams not in descriptor from generateMaze call", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({
      selectedChecks: [],
      selectedStrategies: { missing_endpoints: "scored_endpoints" },
      strategyParams: { scored_endpoints: { unknown_param: "99" } },
      availableStrategies: [{
        id: "scored_endpoints",
        handles: "missing_endpoints",
        params: [
          { id: "path_weight", label: "Path length weight", kind: { type: "float", default: 1, min: 0, max: 100 } },
        ],
      }],
    });
    useMazeStore.getState().generate();
    const call = vi.mocked(generateMaze).mock.calls[0];
    const strategies = call[1].strategies;
    expect(strategies["missing_endpoints"].params).not.toHaveProperty("unknown_param");
    expect(strategies["missing_endpoints"].params).not.toHaveProperty("path_weight");
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

describe("mazeStore.loadRegistry", () => {
  it("stores available checks and strategies", async () => {
    const checks = [{ id: "missing_endpoints", issue_kinds: ["missing_endpoints"] }];
    const strategies = [{ id: "farthest_endpoints", handles: "missing_endpoints", params: [] }];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue(strategies);
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().availableChecks).toEqual(checks);
    expect(useMazeStore.getState().availableStrategies).toEqual(strategies);
  });

  it("auto-selects all checks", async () => {
    const checks = [
      { id: "check_a", issue_kinds: ["kind_a"] },
      { id: "check_b", issue_kinds: ["kind_b"] },
    ];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue([]);
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().selectedChecks).toEqual(["check_a", "check_b"]);
  });

  it("auto-selects first matching strategy per issue kind", async () => {
    const checks = [{ id: "check_a", issue_kinds: ["kind_a"] }];
    const strategies = [
      { id: "strategy_first", handles: "kind_a", params: [] },
      { id: "strategy_second", handles: "kind_a", params: [] },
    ];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue(strategies);
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().selectedStrategies["kind_a"]).toBe("strategy_first");
  });

  it("leaves issue kind without strategy unselected", async () => {
    const checks = [{ id: "check_a", issue_kinds: ["kind_a", "kind_b"] }];
    const strategies = [{ id: "strategy_a", handles: "kind_a", params: [] }];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue(strategies);
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().selectedStrategies["kind_a"]).toBe("strategy_a");
    expect(useMazeStore.getState().selectedStrategies["kind_b"]).toBeUndefined();
  });

  it("sets error when initWasm rejects", async () => {
    vi.mocked(initWasm).mockRejectedValueOnce(new Error("wasm load failed"));
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().error).toBe("wasm load failed");
  });

  it("sets error string when initWasm rejects with non-Error", async () => {
    vi.mocked(initWasm).mockRejectedValueOnce("fatal");
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().error).toBe("fatal");
  });
});

describe("mazeStore.setStrategyParam", () => {
  it("stores param value keyed by strategyId", () => {
    useMazeStore.setState({ strategyParams: {} });
    useMazeStore.getState().setStrategyParam("scored_endpoints", "path_weight", "2.5");
    expect(useMazeStore.getState().strategyParams["scored_endpoints"]["path_weight"]).toBe("2.5");
  });

  it("merges params for same strategyId", () => {
    useMazeStore.setState({ strategyParams: {} });
    useMazeStore.getState().setStrategyParam("scored_endpoints", "path_weight", "2");
    useMazeStore.getState().setStrategyParam("scored_endpoints", "junction_weight", "6");
    const params = useMazeStore.getState().strategyParams["scored_endpoints"];
    expect(params["path_weight"]).toBe("2");
    expect(params["junction_weight"]).toBe("6");
  });

  it("keeps params for different strategyIds independent", () => {
    useMazeStore.setState({ strategyParams: {} });
    useMazeStore.getState().setStrategyParam("scored_endpoints", "path_weight", "2");
    useMazeStore.getState().setStrategyParam("farthest_endpoints", "path_weight", "9");
    expect(useMazeStore.getState().strategyParams["scored_endpoints"]["path_weight"]).toBe("2");
    expect(useMazeStore.getState().strategyParams["farthest_endpoints"]["path_weight"]).toBe("9");
  });

  it("overrides existing param value", () => {
    useMazeStore.setState({ strategyParams: { scored_endpoints: { path_weight: "1" } } });
    useMazeStore.getState().setStrategyParam("scored_endpoints", "path_weight", "5");
    expect(useMazeStore.getState().strategyParams["scored_endpoints"]["path_weight"]).toBe("5");
  });
});

describe("mazeStore.setGenerationParam", () => {
  it("updates single param in initialConfig", () => {
    useMazeStore.setState({ initialConfig: { method: "custom_vertex_based", depth_first: 0.9, corridor_chance: 0.7, branching: 0.5, directionality: 0.0 } });
    useMazeStore.getState().setGenerationParam("depth_first", 0.3);
    const cfg = useMazeStore.getState().initialConfig;
    expect(cfg.method).toBe("custom_vertex_based");
    if (cfg.method === "custom_vertex_based") {
      expect(cfg.depth_first).toBe(0.3);
    }
  });

  it("preserves other params when updating one", () => {
    useMazeStore.setState({ initialConfig: { method: "custom_vertex_based", depth_first: 0.9, corridor_chance: 0.7, branching: 0.5, directionality: 0.0 } });
    useMazeStore.getState().setGenerationParam("branching", 0.1);
    const cfg = useMazeStore.getState().initialConfig;
    if (cfg.method === "custom_vertex_based") {
      expect(cfg.depth_first).toBe(0.9);
      expect(cfg.corridor_chance).toBe(0.7);
      expect(cfg.branching).toBe(0.1);
      expect(cfg.directionality).toBe(0.0);
    }
  });

  it("preserves method after param update", () => {
    useMazeStore.getState().setGenerationParam("directionality", 0.5);
    expect(useMazeStore.getState().initialConfig.method).toBe("custom_vertex_based");
  });

  it("is no-op when method is recursive_backtracker", () => {
    useMazeStore.setState({ initialConfig: { method: "recursive_backtracker" } });
    useMazeStore.getState().setGenerationParam("depth_first", 0.5);
    expect(useMazeStore.getState().initialConfig).toEqual({ method: "recursive_backtracker" });
  });
});

describe("mazeStore.setGenerationMethod", () => {
  it("switches initialConfig to defaults for new method", () => {
    useMazeStore.setState({ initialConfig: { method: "custom_vertex_based", depth_first: 0.1, corridor_chance: 0.1, branching: 0.1, directionality: 0.1 } });
    useMazeStore.getState().setGenerationMethod("custom_vertex_based");
    const cfg = useMazeStore.getState().initialConfig;
    expect(cfg.method).toBe("custom_vertex_based");
    if (cfg.method === "custom_vertex_based") {
      expect(cfg.depth_first).toBe(0.9);
    }
  });

  it("does not update store for unknown method", () => {
    const before = useMazeStore.getState().initialConfig;
    useMazeStore.getState().setGenerationMethod("nonexistent_method");
    expect(useMazeStore.getState().initialConfig).toBe(before);
  });

  it("switches to recursive_backtracker", () => {
    useMazeStore.getState().setGenerationMethod("recursive_backtracker");
    expect(useMazeStore.getState().initialConfig.method).toBe("recursive_backtracker");
  });

  it("switches to wilson_algorithm", () => {
    useMazeStore.getState().setGenerationMethod("wilson_algorithm");
    expect(useMazeStore.getState().initialConfig.method).toBe("wilson_algorithm");
  });

  it("switches to kruskal_algorithm", () => {
    useMazeStore.getState().setGenerationMethod("kruskal_algorithm");
    expect(useMazeStore.getState().initialConfig.method).toBe("kruskal_algorithm");
  });
});

describe("mazeStore.setElementsParam", () => {
  it("updates one_way_chance in elementsConfig", () => {
    useMazeStore.setState({ elementsConfig: { one_way_chance: 0.04 } });
    useMazeStore.getState().setElementsParam("one_way_chance", 0.2);
    expect(useMazeStore.getState().elementsConfig.one_way_chance).toBe(0.2);
  });

  it("last call wins when called twice for same key", () => {
    useMazeStore.setState({ elementsConfig: { one_way_chance: 0.1 } });
    useMazeStore.getState().setElementsParam("one_way_chance", 0.3);
    useMazeStore.getState().setElementsParam("one_way_chance", 0.7);
    expect(useMazeStore.getState().elementsConfig.one_way_chance).toBe(0.7);
  });
});

describe("mazeStore.setHexOrientation", () => {
  it("updates hexOrientation only when tessellationKind is not hex", () => {
    useMazeStore.setState({
      tessellationKind: "square",
      tessellationConfig: { type: "square", width: 10, height: 10 },
      hexOrientation: "flat_top",
    });
    useMazeStore.getState().setHexOrientation("pointy_top");
    const s = useMazeStore.getState();
    expect(s.hexOrientation).toBe("pointy_top");
    expect(s.tessellationConfig.type).toBe("square");
  });

  it("is no-op when orientation unchanged", () => {
    useMazeStore.setState({ tessellationKind: "hex", hexOrientation: "flat_top" });
    const before = useMazeStore.getState().tessellationConfig;
    useMazeStore.getState().setHexOrientation("flat_top");
    expect(useMazeStore.getState().tessellationConfig).toBe(before);
  });

  it("updates tessellationConfig orientation in predefined mode", () => {
    useMazeStore.setState({
      tessellationKind: "hex",
      hexShape: "parallelogram",
      squareShape: "rect",
      triangleShape: "rect",
      hexOrientation: "flat_top",
      tessellationConfig: { type: "hex_parallelogram", cols: 8, rows: 6, orientation: "flat_top" },
      freeFieldPoints: emptyFreePoints(),
    });
    useMazeStore.getState().setHexOrientation("pointy_top");
    const s = useMazeStore.getState();
    expect(s.hexOrientation).toBe("pointy_top");
    const cfg = s.tessellationConfig;
    if (cfg.type === "hex_parallelogram") {
      expect(cfg.orientation).toBe("pointy_top");
      expect(cfg.cols).toBe(8);
      expect(cfg.rows).toBe(6);
    } else {
      throw new Error("unexpected config type");
    }
  });

  it("rebuilds tessellationConfig via buildFreeConfig in free mode", () => {
    const pts = new Set([encodePoint(0, 0), encodePoint(1, 0)]);
    useMazeStore.setState({
      tessellationKind: "hex",
      hexShape: "free",
      squareShape: "rect",
      triangleShape: "rect",
      hexOrientation: "flat_top",
      isEditingField: true,
      fieldPoints: pts,
      freeFieldPoints: { ...emptyFreePoints(), hex: pts },
      tessellationConfig: { type: "hex_custom", points: [[0, 0], [1, 0]], orientation: "flat_top" },
    });
    useMazeStore.getState().setHexOrientation("pointy_top");
    const s = useMazeStore.getState();
    expect(s.hexOrientation).toBe("pointy_top");
    const cfg = s.tessellationConfig;
    expect(cfg.type).toBe("hex_custom");
    if (cfg.type === "hex_custom") {
      expect(cfg.orientation).toBe("pointy_top");
    }
  });

  it("updates activeTessellationConfig orientation when nodes exist", () => {
    useMazeStore.setState({
      tessellationKind: "hex",
      hexShape: "parallelogram",
      squareShape: "rect",
      triangleShape: "rect",
      hexOrientation: "flat_top",
      tessellationConfig: { type: "hex_parallelogram", cols: 8, rows: 6, orientation: "flat_top" },
      activeTessellationConfig: { type: "hex_parallelogram", cols: 8, rows: 6, orientation: "flat_top" },
      nodes: [{ id: 0, x: 0, y: 0 }],
      freeFieldPoints: emptyFreePoints(),
    });
    useMazeStore.getState().setHexOrientation("pointy_top");
    const s = useMazeStore.getState();
    const active = s.activeTessellationConfig;
    if (active.type === "hex_parallelogram") {
      expect(active.orientation).toBe("pointy_top");
      expect(active.cols).toBe(8);
    } else {
      throw new Error("unexpected active config type");
    }
  });

  it("does not update activeTessellationConfig when no nodes", () => {
    useMazeStore.setState({
      tessellationKind: "hex",
      hexShape: "parallelogram",
      squareShape: "rect",
      triangleShape: "rect",
      hexOrientation: "flat_top",
      tessellationConfig: { type: "hex_parallelogram", cols: 5, rows: 5, orientation: "flat_top" },
      activeTessellationConfig: { type: "hex_parallelogram", cols: 5, rows: 5, orientation: "flat_top" },
      nodes: [],
      freeFieldPoints: emptyFreePoints(),
    });
    const activeBefore = useMazeStore.getState().activeTessellationConfig;
    useMazeStore.getState().setHexOrientation("pointy_top");
    expect(useMazeStore.getState().activeTessellationConfig).toBe(activeBefore);
  });
});

describe("mazeStore.setTriOrientation", () => {
  it("updates triOrientation only when tessellationKind is not triangle", () => {
    useMazeStore.setState({
      tessellationKind: "square",
      tessellationConfig: { type: "square", width: 10, height: 10 },
      triOrientation: "r0",
    });
    useMazeStore.getState().setTriOrientation("r90");
    const s = useMazeStore.getState();
    expect(s.triOrientation).toBe("r90");
    expect(s.tessellationConfig.type).toBe("square");
  });

  it("is no-op when orientation unchanged", () => {
    useMazeStore.setState({ tessellationKind: "triangle", triOrientation: "r0" });
    const before = useMazeStore.getState().tessellationConfig;
    useMazeStore.getState().setTriOrientation("r0");
    expect(useMazeStore.getState().tessellationConfig).toBe(before);
  });

  it("updates tessellationConfig orientation in predefined mode", () => {
    useMazeStore.setState({
      tessellationKind: "triangle",
      triangleShape: "rect",
      hexShape: "parallelogram",
      squareShape: "rect",
      triOrientation: "r0",
      tessellationConfig: { type: "triangle_rect", cols: 10, rows: 10, orientation: "r0" },
      freeFieldPoints: emptyFreePoints(),
    });
    useMazeStore.getState().setTriOrientation("r180");
    const s = useMazeStore.getState();
    expect(s.triOrientation).toBe("r180");
    const cfg = s.tessellationConfig;
    if (cfg.type === "triangle_rect") {
      expect(cfg.orientation).toBe("r180");
      expect(cfg.cols).toBe(10);
    } else {
      throw new Error("unexpected config type");
    }
  });

  it("rebuilds tessellationConfig via buildFreeConfig in free mode", () => {
    const pts = new Set([encodePoint(0, 0), encodePoint(1, 0)]);
    useMazeStore.setState({
      tessellationKind: "triangle",
      triangleShape: "free",
      hexShape: "parallelogram",
      squareShape: "rect",
      triOrientation: "r0",
      hexOrientation: "flat_top",
      isEditingField: true,
      fieldPoints: pts,
      freeFieldPoints: { ...emptyFreePoints(), triangle: pts },
      tessellationConfig: { type: "tri_custom", points: [[0, 0], [1, 0]], orientation: "r0" },
    });
    useMazeStore.getState().setTriOrientation("r270");
    const s = useMazeStore.getState();
    expect(s.triOrientation).toBe("r270");
    const cfg = s.tessellationConfig;
    expect(cfg.type).toBe("tri_custom");
    if (cfg.type === "tri_custom") {
      expect(cfg.orientation).toBe("r270");
    }
  });

  it("updates activeTessellationConfig orientation when nodes exist", () => {
    useMazeStore.setState({
      tessellationKind: "triangle",
      triangleShape: "rect",
      hexShape: "parallelogram",
      squareShape: "rect",
      triOrientation: "r0",
      tessellationConfig: { type: "triangle_rect", cols: 6, rows: 4, orientation: "r0" },
      activeTessellationConfig: { type: "triangle_rect", cols: 6, rows: 4, orientation: "r0" },
      nodes: [{ id: 0, x: 0, y: 0 }],
      freeFieldPoints: emptyFreePoints(),
    });
    useMazeStore.getState().setTriOrientation("r90");
    const s = useMazeStore.getState();
    const active = s.activeTessellationConfig;
    if (active.type === "triangle_rect") {
      expect(active.orientation).toBe("r90");
      expect(active.cols).toBe(6);
    } else {
      throw new Error("unexpected active config type");
    }
  });
});
