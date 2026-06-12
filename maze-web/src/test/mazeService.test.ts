import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateMaze } from "../wasm/mazeService";

vi.mock("../wasm/wasmLoader", () => ({
  getWasm: vi.fn(),
}));

import { getWasm } from "../wasm/wasmLoader";

const mockGenerate = vi.fn();

const defaultInitial = { method: "custom_vertex_based" as const };
const defaultElements = { one_way_chance: 0.04 };
const defaultConfig = { tessellation: { tessellation_type: "square" as const, points: [[0, 0]] as [number, number][] }, checks: [], strategies: {}, initial: defaultInitial, elements: defaultElements };

beforeEach(() => {
  vi.mocked(getWasm).mockReturnValue({ generate: mockGenerate } as never);
  mockGenerate.mockReset();
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
    const cfg = { tessellation: { tessellation_type: "square" as const, points: [[0, 0], [1, 0]] as [number, number][] }, checks: [], strategies: {}, initial: defaultInitial, elements: defaultElements };
    const result = generateMaze(42, cfg);
    expect(result).toEqual(validSnapshot);
    expect(mockGenerate).toHaveBeenCalledWith(BigInt(42), cfg);
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

