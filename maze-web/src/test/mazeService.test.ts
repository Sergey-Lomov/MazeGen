import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateMaze, generateMazeAsync, computeAnalyticsAsync, disposeWorkers } from "../wasm/mazeService";

vi.mock("../wasm/wasmLoader", async (importActual) => ({
  ...(await importActual<typeof import("../wasm/wasmLoader")>()),
  getWasm: vi.fn(),
  initWasm: vi.fn(() => Promise.resolve()),
  compileWasmModule: vi.fn(() => Promise.resolve({} as WebAssembly.Module)),
}));

import { getWasm, initWasm } from "../wasm/wasmLoader";

const mockGenerate = vi.fn();

const defaultInitial = { method: "custom_vertex_based" as const };
const defaultElements = { one_way_chance: 0.04 };
const defaultConfig = { tessellation: { kind: "square" as const, params: {} }, level_fields: [[[0, 0]]] as [number, number][][], stages: [], initial: defaultInitial, elements: defaultElements };

/** Wraps a raw snapshot value in a fake `GenerateResult` (see `maze-wasm/src/result.rs`) — no
 *  debug tape, matching the non-`debug_events` path. */
function fakeGenerateResult(snapshot: unknown) {
  return {
    snapshot: () => snapshot,
    debugTapeNodeTable: () => undefined,
    debugTapePayload: () => undefined,
    debugValueNames: () => [],
    debugValueKinds: () => [],
    debugAllNodes: () => [],
    free: () => {},
  };
}

beforeEach(() => {
  vi.mocked(getWasm).mockReturnValue({ generate: mockGenerate } as never);
  mockGenerate.mockReset();
});

interface Sent { id: number; payload: unknown }

/** Fake pooled worker: answers each request through `reply`, or stays silent when it returns undefined. */
function stubWorkers(reply: (sent: Sent) => unknown) {
  const workers: FakeWorker[] = [];
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    sent: Sent[] = [];
    terminate = vi.fn();

    constructor() {
      workers.push(this);
    }

    postMessage(value: Sent) {
      this.sent.push(value);
      const data = reply(value);
      if (data !== undefined) this.onmessage?.({ data } as MessageEvent);
    }
  }
  vi.stubGlobal("Worker", FakeWorker);
  return workers;
}

describe("generateMazeAsync", () => {
  beforeEach(() => disposeWorkers());

  it("routes the request to a worker and resolves its result", async () => {
    const workers = stubWorkers(({ id }) => ({ id, result: { snapshot: validSnapshot, debugTape: undefined } }));

    const result = await generateMazeAsync(42, defaultConfig);

    expect(workers[0].sent[0].payload).toEqual({ seed: 42, config: defaultConfig });
    expect(result.snapshot).toEqual(validSnapshot);
  });

  it("reuses one worker across runs", async () => {
    const workers = stubWorkers(({ id }) => ({ id, result: { snapshot: validSnapshot, debugTape: undefined } }));

    await generateMazeAsync(1, defaultConfig);
    await generateMazeAsync(2, defaultConfig);

    expect(workers).toHaveLength(1);
    expect(workers[0].sent).toHaveLength(2);
    expect(workers[0].terminate).not.toHaveBeenCalled();
  });

  it("rejects an error response and replaces the worker", async () => {
    let fail = true;
    const workers = stubWorkers(({ id }) => fail ? { id, error: "boom" } : { id, result: { snapshot: validSnapshot } });

    await expect(generateMazeAsync(1, defaultConfig)).rejects.toThrow("boom");
    fail = false;
    await generateMazeAsync(2, defaultConfig);

    expect(workers).toHaveLength(2);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });
});

describe("computeAnalyticsAsync", () => {
  const config = { nodes: [], edges: [], rule_groups: [] } as never;
  beforeEach(() => disposeWorkers());

  it("routes the request and resolves the validated snapshot", async () => {
    const workers = stubWorkers(({ id }) => ({ id, result: validSnapshot }));

    const result = await computeAnalyticsAsync(config);

    expect(workers[0].sent[0].payload).toEqual({ config });
    expect(result).toEqual(validSnapshot);
    expect(workers[0].terminate).not.toHaveBeenCalled();
  });

  it("rejects an invalid snapshot", async () => {
    stubWorkers(({ id }) => ({ id, result: { nodes: 1 } }));
    await expect(computeAnalyticsAsync(config)).rejects.toThrow("invalid nodes");
  });

  it("terminates and rejects a superseded worker", async () => {
    const workers = stubWorkers(() => undefined);

    const first = computeAnalyticsAsync(config);
    const second = computeAnalyticsAsync(config);

    await expect(first).rejects.toThrow("Analytics request superseded");
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    workers[1].onmessage?.({ data: { id: workers[1].sent[0].id, result: validSnapshot } } as MessageEvent);
    await expect(second).resolves.toEqual(validSnapshot);
    expect(workers[1].terminate).not.toHaveBeenCalled();
  });

  it("cleans up when posting to the worker fails", async () => {
    const workers = stubWorkers(() => { throw new Error("cannot clone analytics config"); });
    await expect(computeAnalyticsAsync(config)).rejects.toThrow("cannot clone analytics config");
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects a worker runtime error", async () => {
    const workers = stubWorkers(() => undefined);
    const pending = computeAnalyticsAsync(config);
    workers[0].onerror?.({ message: "worker crashed" } as ErrorEvent);
    await expect(pending).rejects.toThrow("worker crashed");
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it("terminates every worker on dispose", async () => {
    const workers = stubWorkers(({ id }) => ({ id, result: validSnapshot }));
    await computeAnalyticsAsync(config);
    disposeWorkers();
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });
});

describe("serveWorker", () => {
  it("initializes WASM and answers by request id, reporting errors as responses", async () => {
    const workerScope = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: vi.fn(),
    };
    vi.stubGlobal("self", workerScope);
    const compute = vi.fn(() => validSnapshot);
    vi.mocked(getWasm).mockReturnValue({ compute_analytics: compute } as never);

    await import("../wasm/analyticsWorker");
    const config = { nodes: [], edges: [], rule_groups: [] } as never;
    await workerScope.onmessage?.({ data: { id: 7, payload: { config } } } as MessageEvent);

    expect(compute).toHaveBeenCalledWith(config);
    expect(workerScope.postMessage).toHaveBeenCalledWith({ id: 7, result: validSnapshot }, []);

    const wasmModule = {} as WebAssembly.Module;
    await workerScope.onmessage?.({ data: { id: 9, payload: { config }, wasmModule } } as MessageEvent);
    expect(initWasm).toHaveBeenLastCalledWith(wasmModule);

    compute.mockImplementation(() => { throw new Error("analytics failed in worker"); });
    await workerScope.onmessage?.({ data: { id: 8, payload: { config } } } as MessageEvent);
    expect(workerScope.postMessage).toHaveBeenLastCalledWith({ id: 8, error: "analytics failed in worker" });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const validSnapshot = {
  nodes: [
    { id: 0, x: 0, y: 0, i: 0 },
    { id: 1, x: 1, y: 0, i: 0 },
  ],
  edges: [
    { from: 0, to: 1 },
  ],
  start: 0,
  finish: 1,
  issues: [],
  nav_nodes: [{ node_id: 0 }, { node_id: 1 }],
  nav_edges: [{ from: 0, to: 1, path: [0, 1] }],
  graph_analytics: { node_count: 2, edge_count: 1, component_count: 1, cycle_count: 0, cycle_region_count: 0, simple_cycle_count: 0, node_component: {}, pure_cycle_node_ids: [], pure_cycle_edge_pairs: [], cycle_analysis_overflowed: false, region_classes: {} },
};

describe("generateMaze / validateSnapshot", () => {
  it("returns valid snapshot", () => {
    mockGenerate.mockReturnValue(fakeGenerateResult(validSnapshot));
    const cfg = { tessellation: { kind: "square" as const, params: {} }, level_fields: [[[0, 0], [1, 0]]] as [number, number][][], stages: [], initial: defaultInitial, elements: defaultElements };
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

  // GitHub issue #236: NodeDto gained a required `i` field (stable per-point index) — a WASM
  // snapshot missing it must fail validation the same way a missing `id`/`x`/`y` already does,
  // not silently pass through with `i` as `undefined`.
  it("throws when node missing i", () => {
    mockGenerate.mockReturnValue(fakeGenerateResult({ nodes: [{ id: 0, x: 0, y: 0 }], edges: [] }));
    expect(() => generateMaze(1, defaultConfig)).toThrow("invalid nodes");
  });

  it("throws when edges missing", () => {
    mockGenerate.mockReturnValue(fakeGenerateResult({ nodes: [{ id: 0, x: 0, y: 0, i: 0 }] }));
    expect(() => generateMaze(1, defaultConfig)).toThrow("invalid edges");
  });

  it("throws when edge missing from", () => {
    mockGenerate.mockReturnValue(fakeGenerateResult({ nodes: [{ id: 0, x: 0, y: 0, i: 0 }], edges: [{ to: 0 }] }));
    expect(() => generateMaze(1, defaultConfig)).toThrow("invalid edges");
  });

  it("throws when edge.from not in nodes", () => {
    mockGenerate.mockReturnValue(fakeGenerateResult({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }],
      edges: [{ from: 99, to: 0 }],
      issues: [],
      nav_nodes: [],
      nav_edges: [],
    }));
    expect(() => generateMaze(1, defaultConfig)).toThrow("edge.from 99 not in nodes");
  });

  it("throws when edge.to not in nodes", () => {
    mockGenerate.mockReturnValue(fakeGenerateResult({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }],
      edges: [{ from: 0, to: 99 }],
      issues: [],
      nav_nodes: [],
      nav_edges: [],
    }));
    expect(() => generateMaze(1, defaultConfig)).toThrow("edge.to 99 not in nodes");
  });

  it("accepts empty nodes and edges", () => {
    mockGenerate.mockReturnValue(fakeGenerateResult({ nodes: [], edges: [], start: null, finish: null, issues: [], nav_nodes: [], nav_edges: [] }));
    const result = generateMaze(0, defaultConfig);
    expect(result.snapshot.nodes).toHaveLength(0);
    expect(result.snapshot.edges).toHaveLength(0);
  });

  it("accepts null start/finish", () => {
    mockGenerate.mockReturnValue(fakeGenerateResult({ nodes: [{ id: 0, x: 0, y: 0, i: 0 }], edges: [], start: null, finish: null, issues: [], nav_nodes: [], nav_edges: [] }));
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
      sourceScopeNames: () => ["generation"],
      sourceEventKinds: () => ["recursive_backtracker"],
      debugValueNames: () => [],
      debugValueKinds: () => [],
      debugAllNodes: () => [],
      free: () => {},
    });
    const result = generateMaze(1, defaultConfig);
    expect(result.debugTape).toEqual({
      nodeTable: nodeTableBytes, payload: payloadBytes,
      sourceScopeNames: ["generation"], sourceEventKinds: ["recursive_backtracker"],
      debugValueNames: [],
      allNodes: [],
    });
    // Must be independent copies, not the same views handed back by WASM.
    expect(result.debugTape?.nodeTable).not.toBe(nodeTableBytes);
    expect(result.debugTape?.payload).not.toBe(payloadBytes);
  });

  it("copies a Kruskal debug tape and tags it with eventKind (GitHub issue #146)", () => {
    const nodeTableBytes = new Uint8Array([1, 2, 3]);
    const payloadBytes = new Uint8Array([4, 5, 6]);
    mockGenerate.mockReturnValue({
      snapshot: () => validSnapshot,
      debugTapeNodeTable: () => nodeTableBytes,
      debugTapePayload: () => payloadBytes,
      sourceScopeNames: () => ["generation"],
      sourceEventKinds: () => ["kruskal"],
      debugValueNames: () => [],
      debugValueKinds: () => [],
      debugAllNodes: () => [],
      free: () => {},
    });
    const result = generateMaze(1, defaultConfig);
    expect(result.debugTape?.sourceEventKinds).toEqual(["kruskal"]);
  });

  it("copies a Wilson debug tape and tags it with eventKind (GitHub issue #145)", () => {
    const nodeTableBytes = new Uint8Array([1, 2, 3]);
    const payloadBytes = new Uint8Array([4, 5, 6]);
    mockGenerate.mockReturnValue({
      snapshot: () => validSnapshot,
      debugTapeNodeTable: () => nodeTableBytes,
      debugTapePayload: () => payloadBytes,
      sourceScopeNames: () => ["generation"],
      sourceEventKinds: () => ["wilson"],
      debugValueNames: () => [],
      debugValueKinds: () => [],
      debugAllNodes: () => [],
      free: () => {},
    });
    const result = generateMaze(1, defaultConfig);
    expect(result.debugTape?.sourceEventKinds).toEqual(["wilson"]);
  });

  it("copies a CustomVertexBased debug tape and tags it with eventKind (GitHub issue #143)", () => {
    const nodeTableBytes = new Uint8Array([1, 2, 3]);
    const payloadBytes = new Uint8Array([4, 5, 6]);
    mockGenerate.mockReturnValue({
      snapshot: () => validSnapshot,
      debugTapeNodeTable: () => nodeTableBytes,
      debugTapePayload: () => payloadBytes,
      sourceScopeNames: () => ["generation"],
      sourceEventKinds: () => ["vertex_based"],
      debugValueNames: () => [],
      debugValueKinds: () => [],
      debugAllNodes: () => [],
      free: () => {},
    });
    const result = generateMaze(1, defaultConfig);
    expect(result.debugTape?.sourceEventKinds).toEqual(["vertex_based"]);
  });

  it("throws when a debug tape is present but sourceScopeNames/sourceEventKinds is empty", () => {
    mockGenerate.mockReturnValue({
      snapshot: () => validSnapshot,
      debugTapeNodeTable: () => new Uint8Array([1, 2, 3]),
      debugTapePayload: () => new Uint8Array([4, 5, 6]),
      sourceScopeNames: () => [],
      sourceEventKinds: () => [],
      debugValueNames: () => [],
      debugValueKinds: () => [],
      debugAllNodes: () => [],
      free: () => {},
    });
    expect(() => generateMaze(1, defaultConfig)).toThrow(/sourceScopeNames\/sourceEventKinds is empty/);
  });

  it("throws when sourceScopeNames and sourceEventKinds have different lengths", () => {
    mockGenerate.mockReturnValue({
      snapshot: () => validSnapshot,
      debugTapeNodeTable: () => new Uint8Array([1, 2, 3]),
      debugTapePayload: () => new Uint8Array([4, 5, 6]),
      sourceScopeNames: () => ["generation", "quality_control"],
      sourceEventKinds: () => ["recursive_backtracker"],
      debugValueNames: () => [],
      debugValueKinds: () => [],
      debugAllNodes: () => [],
      free: () => {},
    });
    expect(() => generateMaze(1, defaultConfig)).toThrow(/length mismatch/);
  });

  it("throws on an unrecognized eventKind", () => {
    mockGenerate.mockReturnValue({
      snapshot: () => validSnapshot,
      debugTapeNodeTable: () => new Uint8Array([1, 2, 3]),
      debugTapePayload: () => new Uint8Array([4, 5, 6]),
      sourceScopeNames: () => ["generation"],
      sourceEventKinds: () => ["not_a_real_kind"],
      debugValueNames: () => [],
      debugValueKinds: () => [],
      debugAllNodes: () => [],
      free: () => {},
    });
    expect(() => generateMaze(1, defaultConfig)).toThrow(/unknown event kind/);
  });

  it("throws when debugValueNames and debugValueKinds have different lengths", () => {
    mockGenerate.mockReturnValue({
      snapshot: () => validSnapshot,
      debugTapeNodeTable: () => new Uint8Array([1, 2, 3]),
      debugTapePayload: () => new Uint8Array([4, 5, 6]),
      sourceScopeNames: () => ["generation"],
      sourceEventKinds: () => ["recursive_backtracker"],
      debugValueNames: () => ["recursion_stack", "visited"],
      debugValueKinds: () => ["sequence"],
      debugAllNodes: () => [],
      free: () => {},
    });
    expect(() => generateMaze(1, defaultConfig)).toThrow(/length mismatch/);
  });

  it("throws on an unrecognized debug value kind", () => {
    mockGenerate.mockReturnValue({
      snapshot: () => validSnapshot,
      debugTapeNodeTable: () => new Uint8Array([1, 2, 3]),
      debugTapePayload: () => new Uint8Array([4, 5, 6]),
      sourceScopeNames: () => ["generation"],
      sourceEventKinds: () => ["recursive_backtracker"],
      debugValueNames: () => ["recursion_stack"],
      debugValueKinds: () => ["not_a_real_kind"],
      debugAllNodes: () => [],
      free: () => {},
    });
    expect(() => generateMaze(1, defaultConfig)).toThrow(/unknown debug value kind/);
  });

});
