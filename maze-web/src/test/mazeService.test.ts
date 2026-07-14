import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateMaze } from "../wasm/mazeService";

vi.mock("../wasm/wasmLoader", () => ({
  getWasm: vi.fn(),
}));

import { getWasm } from "../wasm/wasmLoader";

const mockGenerate = vi.fn();

const defaultInitial = { method: "custom_vertex_based" as const };
const defaultElements = { one_way_chance: 0.04 };
const defaultConfig = { tessellation: { tessellation_type: "square" as const, points: [[0, 0]] as [number, number][] }, stages: [], initial: defaultInitial, elements: defaultElements };

/** Wraps a raw snapshot value in a fake `GenerateResult` (see `maze-wasm/src/result.rs`) — no
 *  debug tape, matching the non-`debug_events` path. */
function fakeGenerateResult(snapshot: unknown) {
  return {
    snapshot: () => snapshot,
    debugTapeNodeTable: () => undefined,
    debugTapePayload: () => undefined,
    debugSnapshotTable: () => undefined,
    debugSnapshotPayload: () => undefined,
    free: () => {},
  };
}

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
  issues: [],
  nav_nodes: [{ node_id: 0 }, { node_id: 1 }],
  nav_edges: [{ from: 0, to: 1, path: [0, 1] }],
  graph_analytics: { node_count: 2, edge_count: 1, component_count: 1, cycle_count: 0, cycle_region_count: 0, node_component: {}, pure_cycle_node_ids: [], pure_cycle_edge_pairs: [], cycle_analysis_overflowed: false, region_classes: {} },
  debug_steps: [],
};

describe("generateMaze / validateSnapshot", () => {
  it("returns valid snapshot", () => {
    mockGenerate.mockReturnValue(fakeGenerateResult(validSnapshot));
    const cfg = { tessellation: { tessellation_type: "square" as const, points: [[0, 0], [1, 0]] as [number, number][] }, stages: [], initial: defaultInitial, elements: defaultElements };
    const result = generateMaze(42, cfg);
    expect(result.snapshot).toEqual(validSnapshot);
    expect(result.debugTape).toBeUndefined();
    expect(mockGenerate).toHaveBeenCalledWith(BigInt(42), cfg);
  });

  it("throws when raw is null", () => {
    mockGenerate.mockReturnValue(fakeGenerateResult(null));
    expect(() => generateMaze(1, defaultConfig)).toThrow("WASM returned invalid snapshot");
  });

  it("throws when raw is not object", () => {
    mockGenerate.mockReturnValue(fakeGenerateResult("bad"));
    expect(() => generateMaze(1, defaultConfig)).toThrow("WASM returned invalid snapshot");
  });

  it("throws when nodes missing", () => {
    mockGenerate.mockReturnValue(fakeGenerateResult({ edges: [] }));
    expect(() => generateMaze(1, defaultConfig)).toThrow("invalid nodes");
  });

  it("throws when node missing id", () => {
    mockGenerate.mockReturnValue(fakeGenerateResult({ nodes: [{ x: 0, y: 0 }], edges: [] }));
    expect(() => generateMaze(1, defaultConfig)).toThrow("invalid nodes");
  });

  it("throws when node has non-number x", () => {
    mockGenerate.mockReturnValue(fakeGenerateResult({ nodes: [{ id: 0, x: "0", y: 0 }], edges: [] }));
    expect(() => generateMaze(1, defaultConfig)).toThrow("invalid nodes");
  });

  it("throws when edges missing", () => {
    mockGenerate.mockReturnValue(fakeGenerateResult({ nodes: [{ id: 0, x: 0, y: 0 }] }));
    expect(() => generateMaze(1, defaultConfig)).toThrow("invalid edges");
  });

  it("throws when edge missing from", () => {
    mockGenerate.mockReturnValue(fakeGenerateResult({ nodes: [{ id: 0, x: 0, y: 0 }], edges: [{ to: 0 }] }));
    expect(() => generateMaze(1, defaultConfig)).toThrow("invalid edges");
  });

  it("throws when edge.from not in nodes", () => {
    mockGenerate.mockReturnValue(fakeGenerateResult({
      nodes: [{ id: 0, x: 0, y: 0 }],
      edges: [{ from: 99, to: 0 }],
      issues: [],
      nav_nodes: [],
      nav_edges: [],
    }));
    expect(() => generateMaze(1, defaultConfig)).toThrow("edge.from 99 not in nodes");
  });

  it("throws when edge.to not in nodes", () => {
    mockGenerate.mockReturnValue(fakeGenerateResult({
      nodes: [{ id: 0, x: 0, y: 0 }],
      edges: [{ from: 0, to: 99 }],
      issues: [],
      nav_nodes: [],
      nav_edges: [],
    }));
    expect(() => generateMaze(1, defaultConfig)).toThrow("edge.to 99 not in nodes");
  });

  it("accepts empty nodes and edges", () => {
    mockGenerate.mockReturnValue(fakeGenerateResult({ nodes: [], edges: [], start: null, finish: null, issues: [], nav_nodes: [], nav_edges: [], debug_steps: [] }));
    const result = generateMaze(0, defaultConfig);
    expect(result.snapshot.nodes).toHaveLength(0);
    expect(result.snapshot.edges).toHaveLength(0);
  });

  it("accepts null start/finish", () => {
    mockGenerate.mockReturnValue(fakeGenerateResult({ nodes: [{ id: 0, x: 0, y: 0 }], edges: [], start: null, finish: null, issues: [], nav_nodes: [], nav_edges: [], debug_steps: [] }));
    const result = generateMaze(1, defaultConfig);
    expect(result.snapshot.start).toBeNull();
    expect(result.snapshot.finish).toBeNull();
  });

  it("copies debug tape buffers out of WASM memory when present", () => {
    const nodeTableBytes = new Uint8Array([1, 2, 3]);
    const payloadBytes = new Uint8Array([4, 5, 6]);
    mockGenerate.mockReturnValue({
      snapshot: () => validSnapshot,
      debugTapeNodeTable: () => nodeTableBytes,
      debugTapePayload: () => payloadBytes,
      debugSnapshotTable: () => undefined,
      debugSnapshotPayload: () => undefined,
      free: () => {},
    });
    const result = generateMaze(1, defaultConfig);
    expect(result.debugTape).toEqual({ nodeTable: nodeTableBytes, payload: payloadBytes });
    // Must be independent copies, not the same views handed back by WASM.
    expect(result.debugTape?.nodeTable).not.toBe(nodeTableBytes);
    expect(result.debugTape?.payload).not.toBe(payloadBytes);
  });

  it("copies checkpoint buffers out of WASM memory when present (GitHub issue #128)", () => {
    const nodeTableBytes = new Uint8Array([1, 2, 3]);
    const payloadBytes = new Uint8Array([4, 5, 6]);
    const snapshotTableBytes = new Uint8Array([7, 8]);
    const snapshotPayloadBytes = new Uint8Array([9, 10, 11]);
    mockGenerate.mockReturnValue({
      snapshot: () => validSnapshot,
      debugTapeNodeTable: () => nodeTableBytes,
      debugTapePayload: () => payloadBytes,
      debugSnapshotTable: () => snapshotTableBytes,
      debugSnapshotPayload: () => snapshotPayloadBytes,
      free: () => {},
    });
    const result = generateMaze(1, defaultConfig);
    expect(result.debugTape).toEqual({
      nodeTable: nodeTableBytes,
      payload: payloadBytes,
      snapshotTable: snapshotTableBytes,
      snapshotPayload: snapshotPayloadBytes,
    });
    expect(result.debugTape?.snapshotTable).not.toBe(snapshotTableBytes);
    expect(result.debugTape?.snapshotPayload).not.toBe(snapshotPayloadBytes);
  });

  it("omits checkpoint fields entirely when no checkpoints were recorded", () => {
    const nodeTableBytes = new Uint8Array([1, 2, 3]);
    const payloadBytes = new Uint8Array([4, 5, 6]);
    mockGenerate.mockReturnValue({
      snapshot: () => validSnapshot,
      debugTapeNodeTable: () => nodeTableBytes,
      debugTapePayload: () => payloadBytes,
      debugSnapshotTable: () => undefined,
      debugSnapshotPayload: () => undefined,
      free: () => {},
    });
    const result = generateMaze(1, defaultConfig);
    expect(result.debugTape?.snapshotTable).toBeUndefined();
    expect(result.debugTape?.snapshotPayload).toBeUndefined();
    expect(result.debugTape).not.toHaveProperty("snapshotTable");
    expect(result.debugTape).not.toHaveProperty("snapshotPayload");
  });
});

