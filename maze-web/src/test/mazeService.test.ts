import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateMaze, generateMazeSteps } from "../wasm/mazeService";

vi.mock("../wasm/wasmLoader", () => ({
  getWasm: vi.fn(),
}));

import { getWasm } from "../wasm/wasmLoader";

const mockGenerate = vi.fn();
const mockGenerateSteps = vi.fn();

const defaultInitial = { method: "custom_vertex_based" as const };
const defaultElements = { one_way_chance: 0.04 };
const defaultConfig = { tessellation: { type: "square" as const, width: 1, height: 1 }, checks: [], strategies: {}, initial: defaultInitial, elements: defaultElements };

beforeEach(() => {
  vi.mocked(getWasm).mockReturnValue({ generate: mockGenerate, generate_steps: mockGenerateSteps } as never);
  mockGenerate.mockReset();
  mockGenerateSteps.mockReset();
});

const validSnapshot = {
  nodes: [
    { id: 0, x: 0, y: 0 },
    { id: 1, x: 1, y: 0 },
  ],
  edges: [
    { from: 0, to: 1 },
  ],
  start: 0,
  finish: 1,
  warnings: [],
  nav_nodes: [{ node_id: 0 }, { node_id: 1 }],
  nav_edges: [{ from: 0, to: 1, path: [0, 1] }],
  components: [[0], [1]],
};

describe("generateMaze / validateSnapshot", () => {
  it("returns valid snapshot", () => {
    mockGenerate.mockReturnValue(validSnapshot);
    const result = generateMaze(42, { tessellation: { type: "square", width: 2, height: 1 }, checks: [], strategies: {}, initial: defaultInitial, elements: defaultElements });
    expect(result).toEqual(validSnapshot);
    expect(mockGenerate).toHaveBeenCalledWith(BigInt(42), { tessellation: { type: "square", width: 2, height: 1 }, checks: [], strategies: {}, initial: defaultInitial, elements: defaultElements });
  });

  it("throws when raw is null", () => {
    mockGenerate.mockReturnValue(null);
    expect(() => generateMaze(1, defaultConfig)).toThrow("WASM returned invalid snapshot");
  });

  it("throws when raw is not object", () => {
    mockGenerate.mockReturnValue("bad");
    expect(() => generateMaze(1, defaultConfig)).toThrow("WASM returned invalid snapshot");
  });

  it("throws when nodes missing", () => {
    mockGenerate.mockReturnValue({ edges: [] });
    expect(() => generateMaze(1, defaultConfig)).toThrow("invalid nodes");
  });

  it("throws when node missing id", () => {
    mockGenerate.mockReturnValue({ nodes: [{ x: 0, y: 0 }], edges: [] });
    expect(() => generateMaze(1, defaultConfig)).toThrow("invalid nodes");
  });

  it("throws when node has non-number x", () => {
    mockGenerate.mockReturnValue({ nodes: [{ id: 0, x: "0", y: 0 }], edges: [] });
    expect(() => generateMaze(1, defaultConfig)).toThrow("invalid nodes");
  });

  it("throws when edges missing", () => {
    mockGenerate.mockReturnValue({ nodes: [{ id: 0, x: 0, y: 0 }] });
    expect(() => generateMaze(1, defaultConfig)).toThrow("invalid edges");
  });

  it("throws when edge missing from", () => {
    mockGenerate.mockReturnValue({ nodes: [{ id: 0, x: 0, y: 0 }], edges: [{ to: 0 }] });
    expect(() => generateMaze(1, defaultConfig)).toThrow("invalid edges");
  });

  it("throws when edge.from not in nodes", () => {
    mockGenerate.mockReturnValue({
      nodes: [{ id: 0, x: 0, y: 0 }],
      edges: [{ from: 99, to: 0 }],
      warnings: [],
      nav_nodes: [],
      nav_edges: [],
      components: [],
    });
    expect(() => generateMaze(1, defaultConfig)).toThrow("edge.from 99 not in nodes");
  });

  it("throws when edge.to not in nodes", () => {
    mockGenerate.mockReturnValue({
      nodes: [{ id: 0, x: 0, y: 0 }],
      edges: [{ from: 0, to: 99 }],
      warnings: [],
      nav_nodes: [],
      nav_edges: [],
      components: [],
    });
    expect(() => generateMaze(1, defaultConfig)).toThrow("edge.to 99 not in nodes");
  });

  it("accepts empty nodes and edges", () => {
    mockGenerate.mockReturnValue({ nodes: [], edges: [], start: null, finish: null, warnings: [], nav_nodes: [], nav_edges: [], components: [] });
    const result = generateMaze(0, defaultConfig);
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it("accepts null start/finish", () => {
    mockGenerate.mockReturnValue({ nodes: [{ id: 0, x: 0, y: 0 }], edges: [], start: null, finish: null, warnings: [], nav_nodes: [], nav_edges: [], components: [] });
    const result = generateMaze(1, defaultConfig);
    expect(result.start).toBeNull();
    expect(result.finish).toBeNull();
  });
});

describe("generateMazeSteps", () => {
  const validStepsSnapshot = {
    nodes: [{ id: 0, x: 0, y: 0 }, { id: 1, x: 1, y: 0 }],
    steps: [
      { edges: [] },
      { edges: [{ from: 0, to: 1 }, { from: 1, to: 0 }] },
    ],
  };

  it("calls generate_steps with BigInt seed and config", () => {
    mockGenerateSteps.mockReturnValue(validStepsSnapshot);
    generateMazeSteps(7, defaultConfig);
    expect(mockGenerateSteps).toHaveBeenCalledWith(BigInt(7), defaultConfig);
  });

  it("returns nodes and steps from valid snapshot", () => {
    mockGenerateSteps.mockReturnValue(validStepsSnapshot);
    const result = generateMazeSteps(1, defaultConfig);
    expect(result.nodes).toEqual(validStepsSnapshot.nodes);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1].edges).toHaveLength(2);
  });

  it("throws when raw is null", () => {
    mockGenerateSteps.mockReturnValue(null);
    expect(() => generateMazeSteps(1, defaultConfig)).toThrow("generate_steps returned invalid data");
  });

  it("throws when nodes missing", () => {
    mockGenerateSteps.mockReturnValue({ steps: [] });
    expect(() => generateMazeSteps(1, defaultConfig)).toThrow("generate_steps: invalid nodes");
  });

  it("throws when steps missing", () => {
    mockGenerateSteps.mockReturnValue({ nodes: [] });
    expect(() => generateMazeSteps(1, defaultConfig)).toThrow("generate_steps: invalid steps");
  });

  it("throws when step has non-array edges", () => {
    mockGenerateSteps.mockReturnValue({ nodes: [], steps: [{ edges: "bad" }] });
    expect(() => generateMazeSteps(1, defaultConfig)).toThrow("generate_steps: invalid steps");
  });

  it("throws when step edge missing from", () => {
    mockGenerateSteps.mockReturnValue({ nodes: [{ id: 0, x: 0, y: 0 }], steps: [{ edges: [{ to: 0 }] }] });
    expect(() => generateMazeSteps(1, defaultConfig)).toThrow("generate_steps: invalid steps");
  });

  it("accepts empty nodes and steps", () => {
    mockGenerateSteps.mockReturnValue({ nodes: [], steps: [] });
    const result = generateMazeSteps(0, defaultConfig);
    expect(result.nodes).toHaveLength(0);
    expect(result.steps).toHaveLength(0);
  });
});
