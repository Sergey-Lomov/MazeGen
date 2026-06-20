import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { encodePoint } from "../pixi/tessellationProjection";

vi.mock("../wasm/mazeService", () => ({
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
}));

vi.mock("../wasm/wasmLoader", () => ({
  initWasm: vi.fn(() => Promise.resolve()),
}));

import { generateMaze, computeAnalytics, getAvailableChecks, getAvailableStrategies } from "../wasm/mazeService";
import { initWasm } from "../wasm/wasmLoader";

const mockSnapshot = {
  nodes: [{ id: 0, x: 0, y: 0 }, { id: 1, x: 1, y: 0 }],
  edges: [{ from: 0, to: 1 }],
  start: 0,
  finish: 1,
  warnings: [],
  nav_nodes: [],
  nav_edges: [],
  graph_analytics: { node_count: 0, edge_count: 0, component_count: 0, cycle_count: 0, cycle_region_count: 0, node_component: {}, pure_cycle_node_ids: [], pure_cycle_edge_pairs: [] },
  node_stats: { dead_ends: 2, straight: 0, turns: 0, junctions: [] },
  edge_stats: { bidirectional: 0, one_way: 1, walls: 0 },
  route_info: null,
  debug_steps: [],
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
    showFieldOverlay: true,
    selectedNode: null,
    error: null,
    initialConfig: { method: "custom_vertex_based", depth_first: 0.9, corridor_chance: 0.7, branching: 0.5, directionality: 0.0 },
    elementsConfig: { one_way_chance: 0.04 },
    selectedChecks: [],
    selectedStrategies: {},
    strategyParams: {},
    checkParams: {},
    registryLoaded: false,
    availableChecks: [],
    availableStrategies: [],
  });
  vi.mocked(generateMaze).mockReset();
  vi.mocked(computeAnalytics).mockReset();
  vi.mocked(computeAnalytics).mockReturnValue(mockSnapshot);
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
      check_params: {},
      initial: expect.objectContaining({ method: "custom_vertex_based" }),
      elements: { one_way_chance: 0.04 },
      preset_connections: [],
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
      check_params: {},
      initial: expect.objectContaining({ method: "custom_vertex_based" }),
      elements: { one_way_chance: 0.04 },
      preset_connections: [],
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
      check_params: {},
      initial: expect.objectContaining({ method: "custom_vertex_based" }),
      elements: { one_way_chance: 0.04 },
      preset_connections: [],
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
    expect(call[1].tessellation.tessellation_type).toBe("square");
    expect(call[1].tessellation.points).toHaveLength(3);
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
      check_params: {},
      initial: expect.objectContaining({ method: "custom_vertex_based" }),
      elements: { one_way_chance: 0.04 },
      preset_connections: [],
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

  it("sets showMaze", () => {
    useMazeStore.getState().setDebugFlag("showMaze", false);
    expect(useMazeStore.getState().showMaze).toBe(false);
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
    const checks = [{ id: "missing_endpoints", label: "Missing endpoints", description: "", issue_kinds: ["missing_endpoints"], params: [] }];
    const strategies = [{ id: "farthest_endpoints", handles: "missing_endpoints", params: [] }];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue(strategies);
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().availableChecks).toEqual(checks);
    expect(useMazeStore.getState().availableStrategies).toEqual(strategies);
  });

  it("auto-selects checks without params", async () => {
    const checks = [
      { id: "check_a", label: "Check A", description: "", issue_kinds: ["kind_a"], params: [] },
      { id: "check_b", label: "Check B", description: "", issue_kinds: ["kind_b"], params: [] },
    ];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue([]);
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().selectedChecks).toEqual(["check_a", "check_b"]);
  });

  it("does not auto-select checks with params", async () => {
    const paramKind = { type: "integer" as const, default: 1, min: 1, max: 100 };
    const checks = [
      { id: "check_no_params", label: "No params", description: "", issue_kinds: ["kind_a"], params: [] },
      { id: "check_with_params", label: "Has params", description: "", issue_kinds: ["kind_b"], params: [{ id: "p", label: "P", kind: paramKind }] },
    ];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue([]);
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().selectedChecks).toEqual(["check_no_params"]);
  });

  it("preserves selectedChecks on repeated call", async () => {
    const checks = [
      { id: "check_a", label: "Check A", description: "", issue_kinds: ["kind_a"], params: [] },
      { id: "check_b", label: "Check B", description: "", issue_kinds: ["kind_b"], params: [] },
    ];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue([]);
    await useMazeStore.getState().loadRegistry();
    useMazeStore.setState({ selectedChecks: ["check_b"] });
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().selectedChecks).toEqual(["check_b"]);
  });

  it("auto-selects first matching strategy per issue kind", async () => {
    const checks = [{ id: "check_a", label: "Check A", description: "", issue_kinds: ["kind_a"], params: [] }];
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
    const checks = [{ id: "check_a", label: "Check A", description: "", issue_kinds: ["kind_a", "kind_b"], params: [] }];
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

describe("mazeStore.addCheck", () => {
  const paramKind = { type: "integer" as const, default: 3, min: 1, max: 100 };
  const descriptor = { id: "min_loops", label: "Min loops", description: "", issue_kinds: ["min_loops_count"], params: [{ id: "min_loops", label: "Min loops", kind: paramKind }] };

  it("adds check id to selectedChecks", () => {
    useMazeStore.setState({ availableChecks: [descriptor], selectedChecks: [] });
    useMazeStore.getState().addCheck("min_loops");
    expect(useMazeStore.getState().selectedChecks).toContain("min_loops");
  });

  it("is idempotent — does not add duplicate", () => {
    useMazeStore.setState({ availableChecks: [descriptor], selectedChecks: ["min_loops"] });
    useMazeStore.getState().addCheck("min_loops");
    expect(useMazeStore.getState().selectedChecks.filter((id) => id === "min_loops")).toHaveLength(1);
  });

  it("initializes checkParams from descriptor defaults when no prior entry", () => {
    useMazeStore.setState({ availableChecks: [descriptor], selectedChecks: [], checkParams: {} });
    useMazeStore.getState().addCheck("min_loops");
    expect(useMazeStore.getState().checkParams["min_loops"]["min_loops"]).toBe("3");
  });

  it("preserves existing checkParams when re-adding", () => {
    useMazeStore.setState({ availableChecks: [descriptor], selectedChecks: [], checkParams: { min_loops: { min_loops: "7" } } });
    useMazeStore.getState().addCheck("min_loops");
    expect(useMazeStore.getState().checkParams["min_loops"]["min_loops"]).toBe("7");
  });

  it("is no-op for unknown check id", () => {
    useMazeStore.setState({ availableChecks: [], selectedChecks: [] });
    useMazeStore.getState().addCheck("nonexistent");
    expect(useMazeStore.getState().selectedChecks).toEqual([]);
  });
});

describe("mazeStore.removeCheck", () => {
  it("removes check id from selectedChecks", () => {
    useMazeStore.setState({ selectedChecks: ["check_a", "check_b"] });
    useMazeStore.getState().removeCheck("check_a");
    expect(useMazeStore.getState().selectedChecks).toEqual(["check_b"]);
  });

  it("preserves checkParams after removal", () => {
    useMazeStore.setState({ selectedChecks: ["check_a"], checkParams: { check_a: { p: "5" } } });
    useMazeStore.getState().removeCheck("check_a");
    expect(useMazeStore.getState().checkParams["check_a"]).toEqual({ p: "5" });
  });

  it("is no-op for non-selected id", () => {
    useMazeStore.setState({ selectedChecks: ["check_b"] });
    useMazeStore.getState().removeCheck("check_a");
    expect(useMazeStore.getState().selectedChecks).toEqual(["check_b"]);
  });
});

describe("mazeStore.setCheckParam", () => {
  it("stores param value keyed by checkId", () => {
    useMazeStore.setState({ checkParams: {} });
    useMazeStore.getState().setCheckParam("min_loops", "min_loops", "5");
    expect(useMazeStore.getState().checkParams["min_loops"]["min_loops"]).toBe("5");
  });

  it("merges params for same checkId", () => {
    useMazeStore.setState({ checkParams: {} });
    useMazeStore.getState().setCheckParam("min_loops", "param_a", "1");
    useMazeStore.getState().setCheckParam("min_loops", "param_b", "2");
    expect(useMazeStore.getState().checkParams["min_loops"]["param_a"]).toBe("1");
    expect(useMazeStore.getState().checkParams["min_loops"]["param_b"]).toBe("2");
  });

  it("overrides existing param value", () => {
    useMazeStore.setState({ checkParams: { min_loops: { min_loops: "1" } } });
    useMazeStore.getState().setCheckParam("min_loops", "min_loops", "9");
    expect(useMazeStore.getState().checkParams["min_loops"]["min_loops"]).toBe("9");
  });

  it("keeps params for different checkIds independent", () => {
    useMazeStore.setState({ checkParams: {} });
    useMazeStore.getState().setCheckParam("check_a", "p", "1");
    useMazeStore.getState().setCheckParam("check_b", "p", "2");
    expect(useMazeStore.getState().checkParams["check_a"]["p"]).toBe("1");
    expect(useMazeStore.getState().checkParams["check_b"]["p"]).toBe("2");
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

describe("mazeStore preview/confirm flow", () => {
  it("setPreviewKind does not reset orientation", () => {
    useMazeStore.setState({ previewHexOrientation: "pointy_top", previewTriOrientation: "r90" });
    useMazeStore.getState().setPreviewKind("hex");
    const s = useMazeStore.getState();
    expect(s.previewKind).toBe("hex");
    expect(s.previewHexOrientation).toBe("pointy_top");
    expect(s.previewTriOrientation).toBe("r90");
  });

  it("setPreviewKind updates previewTessellationConfig", () => {
    useMazeStore.getState().setPreviewKind("triangle");
    expect(useMazeStore.getState().previewTessellationConfig.type).toBe("triangle_rect");
  });

  it("syncPreviewToConfirmed copies all confirmed values atomically", () => {
    useMazeStore.setState({
      tessellationKind: "hex",
      hexOrientation: "pointy_top",
      triOrientation: "r180",
      previewKind: "triangle",
      previewHexOrientation: "flat_top",
      previewTriOrientation: "r0",
    });
    useMazeStore.getState().syncPreviewToConfirmed();
    const s = useMazeStore.getState();
    expect(s.previewKind).toBe("hex");
    expect(s.previewHexOrientation).toBe("pointy_top");
    expect(s.previewTriOrientation).toBe("r180");
    expect(s.previewTessellationConfig.type).toBe("hex_parallelogram");
    if (s.previewTessellationConfig.type === "hex_parallelogram") {
      expect(s.previewTessellationConfig.orientation).toBe("pointy_top");
    }
  });

  it("confirmTessellation copies preview into confirmed", () => {
    useMazeStore.setState({
      previewKind: "hex",
      previewHexOrientation: "pointy_top",
      previewTriOrientation: "r0",
      tessellationKind: "square",
    });
    useMazeStore.getState().confirmTessellation();
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("hex");
    expect(s.hexOrientation).toBe("pointy_top");
    expect(s.tessellationConfirmed).toBe(true);
  });

  it("confirmTessellation syncs preview fields to confirmed", () => {
    useMazeStore.setState({
      previewKind: "triangle",
      previewHexOrientation: "flat_top",
      previewTriOrientation: "r90",
      tessellationKind: "square",
    });
    useMazeStore.getState().confirmTessellation();
    const s = useMazeStore.getState();
    expect(s.previewKind).toBe("triangle");
    expect(s.previewTriOrientation).toBe("r90");
    expect(s.previewTessellationConfig.type).toBe("triangle_rect");
  });

  it("confirmTessellation with same kind does not clear maze", () => {
    useMazeStore.setState({
      tessellationKind: "square",
      previewKind: "square",
      previewHexOrientation: "flat_top",
      previewTriOrientation: "r0",
      nodes: [{ id: 0, x: 0, y: 0 }],
      edges: [],
    });
    useMazeStore.getState().confirmTessellation();
    expect(useMazeStore.getState().nodes.length).toBe(1);
  });

  it("confirmTessellation with different kind clears maze", () => {
    useMazeStore.setState({
      tessellationKind: "square",
      previewKind: "hex",
      previewHexOrientation: "flat_top",
      previewTriOrientation: "r0",
      nodes: [{ id: 0, x: 0, y: 0 }],
      edges: [{ from: 0, to: 0 }],
      start: 0,
      finish: 0,
    });
    useMazeStore.getState().confirmTessellation();
    const s = useMazeStore.getState();
    expect(s.nodes).toHaveLength(0);
    expect(s.edges).toHaveLength(0);
    expect(s.start).toBeNull();
    expect(s.finish).toBeNull();
  });
});

describe("mazeStore tessellation misc actions", () => {
  it("setPreviewHexOrientation updates preview config", () => {
    useMazeStore.setState({ previewKind: "hex" });
    useMazeStore.getState().setPreviewHexOrientation("pointy_top");
    const s = useMazeStore.getState();
    expect(s.previewHexOrientation).toBe("pointy_top");
    expect(s.previewTessellationConfig.type).toBe("hex_parallelogram");
    if (s.previewTessellationConfig.type === "hex_parallelogram") {
      expect(s.previewTessellationConfig.orientation).toBe("pointy_top");
    }
  });

  it("setPreviewTriOrientation updates preview config", () => {
    useMazeStore.setState({ previewKind: "triangle" });
    useMazeStore.getState().setPreviewTriOrientation("r270");
    const s = useMazeStore.getState();
    expect(s.previewTriOrientation).toBe("r270");
    expect(s.previewTessellationConfig.type).toBe("triangle_rect");
    if (s.previewTessellationConfig.type === "triangle_rect") {
      expect(s.previewTessellationConfig.orientation).toBe("r270");
    }
  });

  it("addFieldPoints adds multiple cells and marks fieldDirty", () => {
    useMazeStore.setState({ tessellationKind: "square", fieldPoints: new Set<number>(), freeFieldPoints: emptyFreePoints() });
    useMazeStore.getState().addFieldPoints([[0, 0], [1, 0], [0, 1]]);
    const s = useMazeStore.getState();
    expect(s.fieldPoints.size).toBe(3);
    expect(s.fieldDirty).toBe(true);
  });

  it("addFieldPoints is no-op when all cells already present", () => {
    const pts = new Set([encodePoint(0, 0)]);
    useMazeStore.setState({ tessellationKind: "square", fieldPoints: pts, freeFieldPoints: { ...emptyFreePoints(), square: pts }, fieldDirty: false });
    useMazeStore.getState().addFieldPoints([[0, 0]]);
    expect(useMazeStore.getState().fieldDirty).toBe(false);
  });

  it("removeFieldPoints removes multiple cells", () => {
    const pts = new Set([encodePoint(0, 0), encodePoint(1, 0), encodePoint(0, 1)]);
    useMazeStore.setState({ tessellationKind: "square", fieldPoints: pts, freeFieldPoints: { ...emptyFreePoints(), square: pts } });
    useMazeStore.getState().removeFieldPoints([[0, 0], [1, 0]]);
    expect(useMazeStore.getState().fieldPoints.size).toBe(1);
  });

  it("clearFieldPoints empties the set", () => {
    const pts = new Set([encodePoint(0, 0), encodePoint(1, 0)]);
    useMazeStore.setState({ tessellationKind: "square", fieldPoints: pts, freeFieldPoints: { ...emptyFreePoints(), square: pts } });
    useMazeStore.getState().clearFieldPoints();
    expect(useMazeStore.getState().fieldPoints.size).toBe(0);
  });

  it("clearFieldPoints is no-op on already-empty set", () => {
    useMazeStore.setState({ fieldPoints: new Set<number>(), fieldDirty: false });
    useMazeStore.getState().clearFieldPoints();
    expect(useMazeStore.getState().fieldDirty).toBe(false);
  });

  it("setShowFieldOverlay toggles flag", () => {
    useMazeStore.getState().setShowFieldOverlay(false);
    expect(useMazeStore.getState().showFieldOverlay).toBe(false);
  });

  it("setShowFieldOrigin toggles flag", () => {
    useMazeStore.getState().setShowFieldOrigin(false);
    expect(useMazeStore.getState().showFieldOrigin).toBe(false);
  });

  it("setFieldPrimitive updates primitive", () => {
    useMazeStore.getState().setFieldPrimitive("hex_hexagon");
    expect(useMazeStore.getState().fieldPrimitive).toBe("hex_hexagon");
  });

  it("setFieldEditMode('custom') derives fieldPoints from predefined config cells", () => {
    useMazeStore.setState({
      tessellationKind: "square",
      tessellationConfig: { type: "square", width: 3, height: 3 },
      freeFieldPoints: emptyFreePoints(),
    });
    useMazeStore.getState().setFieldEditMode("custom");
    const s = useMazeStore.getState();
    expect(s.fieldEditMode).toBe("custom");
    expect(s.isEditingField).toBe(true);
    expect(s.fieldPoints.size).toBe(9);
    expect(s.tessellationConfig.type).toBe("square_custom");
  });

  it("setFieldEditMode('default') rebuilds predefined config", () => {
    useMazeStore.setState({
      tessellationKind: "square",
      squareShape: "rect",
      hexShape: "parallelogram",
      triangleShape: "rect",
      fieldEditMode: "custom",
      savedConfigs: {},
    });
    useMazeStore.getState().setFieldEditMode("default");
    const s = useMazeStore.getState();
    expect(s.fieldEditMode).toBe("default");
    expect(s.isEditingField).toBe(false);
    expect(s.tessellationConfig.type).toBe("square");
  });
});

describe("mazeStore preset connections", () => {
  beforeEach(() => {
    useMazeStore.setState({
      tessellationKind: "square",
      tessellationConfig: { type: "square", width: 3, height: 3 },
      isEditingField: false,
      fieldPoints: new Set<number>(),
      presetConnections: new Map(),
      lockedNodes: new Map(),
      autoLockedNodes: new Set(),
      autoLock: true,
    });
  });

  it("setPresetConnectionsTool updates tool", () => {
    useMazeStore.getState().setPresetConnectionsTool("passage");
    expect(useMazeStore.getState().presetConnectionsTool).toBe("passage");
  });

  it("applyPresetConnectionsTool('wall') sets a wall entry and marks presetsDirty", () => {
    useMazeStore.setState({ presetConnectionsTool: "wall" });
    useMazeStore.getState().applyPresetConnectionsTool("0,0-1,0", [0, 0], [1, 0]);
    const s = useMazeStore.getState();
    expect(s.presetConnections.get("0,0-1,0")?.state).toBe("wall");
    expect(s.presetsDirty).toBe(true);
  });

  it("applyPresetConnectionsTool('passage') sets a passage entry", () => {
    useMazeStore.setState({ presetConnectionsTool: "passage" });
    useMazeStore.getState().applyPresetConnectionsTool("0,0-1,0", [0, 0], [1, 0]);
    expect(useMazeStore.getState().presetConnections.get("0,0-1,0")?.state).toBe("passage");
  });

  it("applyPresetConnectionsTool recomputes autoLockedNodes when fully surrounding a cell", () => {
    // width=2 centers cells at x=-1 and x=0 (see configAllCells offset math)
    useMazeStore.setState({
      tessellationConfig: { type: "square", width: 2, height: 1 },
      presetConnectionsTool: "wall",
    });
    useMazeStore.getState().applyPresetConnectionsTool("-1,0-0,0", [-1, 0], [0, 0]);
    const s = useMazeStore.getState();
    expect(s.autoLockedNodes.has("-1,0")).toBe(true);
    expect(s.autoLockedNodes.has("0,0")).toBe(true);
  });

  it("applyPresetConnectionsReset resets an existing entry to undefined", () => {
    useMazeStore.setState({
      presetConnections: new Map([["0,0-1,0", { from: [0, 0], to: [1, 0], state: "wall", source: "user" }]]),
    });
    useMazeStore.getState().applyPresetConnectionsReset("0,0-1,0");
    expect(useMazeStore.getState().presetConnections.get("0,0-1,0")?.state).toBe("undefined");
  });

  it("applyPresetConnectionsReset is no-op for missing key", () => {
    useMazeStore.getState().applyPresetConnectionsReset("9,9-9,8");
    expect(useMazeStore.getState().presetConnections.size).toBe(0);
  });

  it("clearInvalidPresetConnections removes entries outside the field", () => {
    useMazeStore.setState({
      tessellationConfig: { type: "square", width: 1, height: 1 },
      presetConnections: new Map([["5,5-6,5", { from: [5, 5], to: [6, 5], state: "wall", source: "user" }]]),
    });
    useMazeStore.getState().clearInvalidPresetConnections();
    expect(useMazeStore.getState().presetConnections.size).toBe(0);
  });

  it("resetPresetConnections clears all preset state", () => {
    useMazeStore.setState({
      presetConnections: new Map([["0,0-1,0", { from: [0, 0], to: [1, 0], state: "wall", source: "user" }]]),
      defaultEdgeState: "wall",
      presetStart: [0, 0],
      presetFinish: [1, 1],
      presetGenSource: [2, 2],
      lockedNodes: new Map([["0,0", "both"]]),
      autoLockedNodes: new Set(["0,0"]),
    });
    useMazeStore.getState().resetPresetConnections();
    const s = useMazeStore.getState();
    expect(s.presetConnections.size).toBe(0);
    expect(s.defaultEdgeState).toBe("undefined");
    expect(s.presetStart).toBeNull();
    expect(s.presetFinish).toBeNull();
    expect(s.presetGenSource).toBeNull();
    expect(s.lockedNodes.size).toBe(0);
    expect(s.autoLockedNodes.size).toBe(0);
  });

  it("setPresetStart/Finish/GenSource update respective cells", () => {
    useMazeStore.getState().setPresetStart([1, 1]);
    useMazeStore.getState().setPresetFinish([2, 2]);
    useMazeStore.getState().setPresetGenSource([3, 3]);
    const s = useMazeStore.getState();
    expect(s.presetStart).toEqual([1, 1]);
    expect(s.presetFinish).toEqual([2, 2]);
    expect(s.presetGenSource).toEqual([3, 3]);
  });

  it("setDefaultEdgeState('wall') fills all interior edges as walls", () => {
    // width=2 centers cells at x=-1 and x=0 (see configAllCells offset math)
    useMazeStore.setState({ tessellationConfig: { type: "square", width: 2, height: 1 } });
    useMazeStore.getState().setDefaultEdgeState("wall");
    const s = useMazeStore.getState();
    expect(s.defaultEdgeState).toBe("wall");
    expect(s.presetConnections.get("-1,0-0,0")?.state).toBe("wall");
    expect(s.presetConnections.get("-1,0-0,0")?.source).toBe("default");
  });

  it("setDefaultEdgeState('undefined') removes default-sourced entries", () => {
    useMazeStore.setState({
      tessellationConfig: { type: "square", width: 2, height: 1 },
      presetConnections: new Map([["-1,0-0,0", { from: [-1, 0], to: [0, 0], state: "wall", source: "default" }]]),
    });
    useMazeStore.getState().setDefaultEdgeState("undefined");
    expect(useMazeStore.getState().presetConnections.size).toBe(0);
  });

  it("setHighlightInvalidPresets / setHighlightIsolatedNodes toggle flags", () => {
    useMazeStore.getState().setHighlightInvalidPresets(true);
    useMazeStore.getState().setHighlightIsolatedNodes(true);
    const s = useMazeStore.getState();
    expect(s.highlightInvalidPresets).toBe(true);
    expect(s.highlightIsolatedNodes).toBe(true);
  });

  it("setShowPresetOrigin toggles flag", () => {
    useMazeStore.getState().setShowPresetOrigin(true);
    expect(useMazeStore.getState().showPresetOrigin).toBe(true);
  });

  it("setLockedNode adds a lock entry", () => {
    useMazeStore.getState().setLockedNode(2, 3, "both");
    expect(useMazeStore.getState().lockedNodes.get("2,3")).toBe("both");
  });

  it("removeLockedNode removes an existing entry", () => {
    useMazeStore.setState({ lockedNodes: new Map([["2,3", "both"]]) });
    useMazeStore.getState().removeLockedNode(2, 3);
    expect(useMazeStore.getState().lockedNodes.has("2,3")).toBe(false);
  });

  it("removeLockedNode is no-op for missing key", () => {
    useMazeStore.getState().removeLockedNode(9, 9);
    expect(useMazeStore.getState().lockedNodes.size).toBe(0);
  });

  it("clearLockedNodes empties locks and autoLocks", () => {
    useMazeStore.setState({ lockedNodes: new Map([["0,0", "both"]]), autoLockedNodes: new Set(["0,0"]) });
    useMazeStore.getState().clearLockedNodes();
    const s = useMazeStore.getState();
    expect(s.lockedNodes.size).toBe(0);
    expect(s.autoLockedNodes.size).toBe(0);
  });

  it("setAutoLock(false) clears autoLockedNodes", () => {
    useMazeStore.setState({ autoLock: true, autoLockedNodes: new Set(["0,0"]) });
    useMazeStore.getState().setAutoLock(false);
    const s = useMazeStore.getState();
    expect(s.autoLock).toBe(false);
    expect(s.autoLockedNodes.size).toBe(0);
  });

  it("setAutoLock(true) recomputes autoLockedNodes", () => {
    // width=2 centers cells at x=-1 and x=0 (see configAllCells offset math)
    useMazeStore.setState({
      tessellationConfig: { type: "square", width: 2, height: 1 },
      presetConnections: new Map([["-1,0-0,0", { from: [-1, 0], to: [0, 0], state: "wall", source: "user" }]]),
      autoLock: false,
      autoLockedNodes: new Set(),
    });
    useMazeStore.getState().setAutoLock(true);
    const s = useMazeStore.getState();
    expect(s.autoLock).toBe(true);
    expect(s.autoLockedNodes.has("-1,0")).toBe(true);
  });
});

describe("mazeStore analytics overlays", () => {
  it("each overlay setter toggles its own flag independently", () => {
    const s0 = useMazeStore.getState();
    s0.setShowMazeOverlay(false);
    s0.setShowComponentsOverlay(true);
    s0.setShowGraphOverlay(true);
    s0.setShowNavGraphOverlay(true);
    s0.setShowPureCyclesOverlay(true);
    s0.setShowRouteOverlay(true);
    const s = useMazeStore.getState();
    expect(s.showMazeOverlay).toBe(false);
    expect(s.showComponentsOverlay).toBe(true);
    expect(s.showGraphOverlay).toBe(true);
    expect(s.showNavGraphOverlay).toBe(true);
    expect(s.showPureCyclesOverlay).toBe(true);
    expect(s.showRouteOverlay).toBe(true);
  });
});

describe("mazeStore generation misc actions", () => {
  it("setStrategy sets a strategy for an issue kind", () => {
    useMazeStore.getState().setStrategy("missing_endpoints", "scored_endpoints");
    expect(useMazeStore.getState().selectedStrategies.missing_endpoints).toBe("scored_endpoints");
  });

  it("clearStrategy removes a strategy for an issue kind", () => {
    useMazeStore.setState({ selectedStrategies: { missing_endpoints: "scored_endpoints" } });
    useMazeStore.getState().clearStrategy("missing_endpoints");
    expect(useMazeStore.getState().selectedStrategies).not.toHaveProperty("missing_endpoints");
  });

  it("setEdgeBasedParam updates param when method is custom_edge_based", () => {
    useMazeStore.setState({ initialConfig: { method: "custom_edge_based", corridor_length: 0.5, branching: 0.5, depth_first: 0.5, directionality: 0, cyclicity: 0 } });
    useMazeStore.getState().setEdgeBasedParam("corridor_length", 0.9);
    const cfg = useMazeStore.getState().initialConfig;
    expect(cfg.method).toBe("custom_edge_based");
    if (cfg.method === "custom_edge_based") expect(cfg.corridor_length).toBe(0.9);
  });

  it("setEdgeBasedParam is no-op when method is not custom_edge_based", () => {
    useMazeStore.setState({ initialConfig: { method: "recursive_backtracker" } });
    useMazeStore.getState().setEdgeBasedParam("corridor_length", 0.9);
    expect(useMazeStore.getState().initialConfig.method).toBe("recursive_backtracker");
  });

  it("setRandomSeed toggles flag", () => {
    useMazeStore.getState().setRandomSeed(true);
    expect(useMazeStore.getState().randomSeed).toBe(true);
  });

  it("setOpenCard switches card and clears preset highlights when leaving preset_connections", () => {
    useMazeStore.setState({ openCard: "preset_connections", highlightInvalidPresets: true, highlightIsolatedNodes: true });
    useMazeStore.getState().setOpenCard("generation");
    const s = useMazeStore.getState();
    expect(s.openCard).toBe("generation");
    expect(s.highlightInvalidPresets).toBe(false);
    expect(s.highlightIsolatedNodes).toBe(false);
  });

  it("setOpenCard keeps highlights when not leaving preset_connections", () => {
    useMazeStore.setState({ openCard: "generation", highlightInvalidPresets: true });
    useMazeStore.getState().setOpenCard("quality");
    expect(useMazeStore.getState().highlightInvalidPresets).toBe(true);
  });

  it("setDebugMode(false) clears debugStale", () => {
    useMazeStore.setState({ debugMode: true, debugStale: true });
    useMazeStore.getState().setDebugMode(false);
    const s = useMazeStore.getState();
    expect(s.debugMode).toBe(false);
    expect(s.debugStale).toBe(false);
  });

  it("setDebugMode(true) does not touch debugStale", () => {
    useMazeStore.setState({ debugMode: false, debugStale: true });
    useMazeStore.getState().setDebugMode(true);
    expect(useMazeStore.getState().debugStale).toBe(true);
  });

  it("setDebugStep / setDebugAutoPlayDelay / setShowDebugFrontier update their fields", () => {
    useMazeStore.getState().setDebugStep(3);
    useMazeStore.getState().setDebugAutoPlayDelay(500);
    useMazeStore.getState().setShowDebugFrontier(false);
    const s = useMazeStore.getState();
    expect(s.debugStep).toBe(3);
    expect(s.debugAutoPlayDelay).toBe(500);
    expect(s.showDebugFrontier).toBe(false);
  });

  it("regenerate is a no-op when lastUsedSeed is null", () => {
    useMazeStore.setState({ lastUsedSeed: null });
    useMazeStore.getState().regenerate();
    expect(generateMaze).not.toHaveBeenCalled();
  });

  it("regenerate calls generateMaze with the last used seed", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({ lastUsedSeed: 123, selectedChecks: [], selectedStrategies: {} });
    useMazeStore.getState().regenerate();
    expect(generateMaze).toHaveBeenCalledWith(123, expect.anything());
  });

  it("setError sets and clears the error message", () => {
    useMazeStore.getState().setError("boom");
    expect(useMazeStore.getState().error).toBe("boom");
    useMazeStore.getState().setError(null);
    expect(useMazeStore.getState().error).toBeNull();
  });
});

describe("mazeStore post-edit actions", () => {
  beforeEach(() => {
    useMazeStore.setState({
      edges: [{ from: 0, to: 1 }],
      nodes: [{ id: 0, x: 0, y: 0 }, { id: 1, x: 1, y: 0 }],
      start: 0,
      finish: 1,
      activeTessellationConfig: { type: "square", width: 2, height: 1 },
      selectedChecks: [],
      checkParams: {},
      postEditDraftEdges: { "0-1": { from: 0, to: 1, kind: "basic" } },
      postEditDraftMeta: { start: 0, finish: 1 },
      postEditEdges: null,
      postEditMeta: null,
      postEditAnalytics: null,
      postEditDirty: false,
      postEditAutoConfirm: false,
      _generatedStart: 0,
      _generatedFinish: 1,
    });
  });

  it("setPostEditAutoConfirm / setPostEditTool update their fields", () => {
    useMazeStore.getState().setPostEditAutoConfirm(true);
    useMazeStore.getState().setPostEditTool("passage");
    const s = useMazeStore.getState();
    expect(s.postEditAutoConfirm).toBe(true);
    expect(s.postEditTool).toBe("passage");
  });

  it("applyPostEditTool('wall') deletes the draft edge entry and marks postEditDirty", () => {
    useMazeStore.setState({ postEditTool: "wall" });
    useMazeStore.getState().applyPostEditTool("0-1", 0, 1);
    const s = useMazeStore.getState();
    expect(s.postEditDraftEdges?.["0-1"]).toBeUndefined();
    expect(s.postEditDirty).toBe(true);
  });

  it("applyPostEditTool('passage') sets a basic edge entry", () => {
    useMazeStore.setState({ postEditTool: "passage", postEditDraftEdges: {} });
    useMazeStore.getState().applyPostEditTool("0-1", 0, 1);
    expect(useMazeStore.getState().postEditDraftEdges?.["0-1"]?.kind).toBe("basic");
  });

  it("applyPostEditTool is no-op when there is no draft yet", () => {
    useMazeStore.setState({ postEditDraftEdges: null, postEditDirty: false });
    useMazeStore.getState().applyPostEditTool("0-1", 0, 1);
    expect(useMazeStore.getState().postEditDirty).toBe(false);
  });

  it("confirmPostEdit computes analytics from the current draft and stores a snapshot", async () => {
    await useMazeStore.getState().confirmPostEdit();
    const s = useMazeStore.getState();
    expect(computeAnalytics).toHaveBeenCalled();
    expect(s.postEditAnalytics).not.toBeNull();
    expect(s.postEditEdges).toEqual({ "0-1": { from: 0, to: 1, kind: "basic" } });
    expect(s.postEditMeta).toEqual({ start: 0, finish: 1 });
  });

  it("confirmPostEdit passes non-wall edges and excludes wall edges to computeAnalytics", async () => {
    useMazeStore.setState({
      postEditDraftEdges: {
        "0-1": { from: 0, to: 1, kind: "basic" },
        "1-2": { from: 1, to: 2, kind: "wall" },
      },
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.edges).toEqual([{ from: 0, to: 1, kind: "basic" }]);
  });

  it("confirmPostEdit is no-op when there is no draft", async () => {
    useMazeStore.setState({ postEditDraftEdges: null });
    await useMazeStore.getState().confirmPostEdit();
    expect(computeAnalytics).not.toHaveBeenCalled();
  });

  it("confirmPostEdit stores error message when computeAnalytics throws", async () => {
    vi.mocked(computeAnalytics).mockImplementation(() => { throw new Error("analytics failed"); });
    await useMazeStore.getState().confirmPostEdit();
    expect(useMazeStore.getState().error).toBe("analytics failed");
  });

  it("confirmPostEdit increments the request id on every call", async () => {
    vi.mocked(computeAnalytics).mockReturnValue(mockSnapshot);
    const before = useMazeStore.getState()._postEditRequestId;
    await useMazeStore.getState().confirmPostEdit();
    await useMazeStore.getState().confirmPostEdit();
    expect(useMazeStore.getState()._postEditRequestId).toBe(before + 2);
  });

  it("resetPostEdit rebuilds draft from generated edges and restores generated endpoints", () => {
    useMazeStore.setState({
      postEditDraftEdges: { "0-1": { from: 0, to: 1, kind: "wall" } },
      postEditDirty: true,
    });
    useMazeStore.getState().resetPostEdit();
    const s = useMazeStore.getState();
    expect(s.postEditDraftMeta).toEqual({ start: 0, finish: 1 });
    expect(s.postEditDirty).toBe(false);
  });

  it("setPostEditEndpoint updates draft meta and marks dirty", () => {
    useMazeStore.setState({ postEditAutoConfirm: false });
    useMazeStore.getState().setPostEditEndpoint("start", 5);
    const s = useMazeStore.getState();
    expect(s.postEditDraftMeta?.start).toBe(5);
    expect(s.postEditDirty).toBe(true);
  });

  it("setPostEditEndpoint triggers confirmPostEdit when postEditAutoConfirm is true", () => {
    useMazeStore.setState({ postEditAutoConfirm: true });
    useMazeStore.getState().setPostEditEndpoint("finish", 7);
    expect(computeAnalytics).toHaveBeenCalled();
  });

  it("clearPostEditEndpoint sets the endpoint to null and marks dirty", () => {
    useMazeStore.setState({ postEditAutoConfirm: false });
    useMazeStore.getState().clearPostEditEndpoint("finish");
    const s = useMazeStore.getState();
    expect(s.postEditDraftMeta?.finish).toBeNull();
    expect(s.postEditDirty).toBe(true);
  });
});
