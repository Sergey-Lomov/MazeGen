import { emptyFreePoints } from "../store/storeHelpers";
import { RB_TAG, NO_NODE } from "../debug/eventTape";
import type { DebugValueDescriptor } from "../debug/eventTape";

export { emptyFreePoints };

function u64le(v: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, v, true);
  return bytes;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Encodes a flat, un-nested list of top-level `EdgeAdded` nodes into the raw
 *  `{ nodeTable, payload }` buffer pair `generateMaze()` returns as `debugTape` — mirrors
 *  `DebugTape::encode()`'s wire format (see `Specs/event_log.md`), same shape as
 *  `eventTape.test.ts`'s fixtures, but returning raw buffers (not a parsed `ParsedTape`) since
 *  that's the shape `generateWithSeed` receives from `mazeService.generateMaze` before it calls
 *  `parseTape` itself. */
export function encodeEdgeAddedTape(edges: [bigint, bigint][]): { nodeTable: Uint8Array; payload: Uint8Array; eventKind: "recursive_backtracker"; debugValueNames: DebugValueDescriptor[] } {
  // `bidirectional` always encoded `true` — mirrors RB's real behavior (GitHub issue #135).
  const payloadChunks = edges.map(([from, to]) => concatBytes([u64le(from), u64le(to), new Uint8Array([1])]));
  const offsets: number[] = [];
  let cursor = 0;
  for (const chunk of payloadChunks) {
    offsets.push(cursor);
    cursor += chunk.byteLength;
  }
  const payload = concatBytes(payloadChunks);
  const nodeTable = new Uint8Array(edges.length * 22);
  const dv = new DataView(nodeTable.buffer);
  edges.forEach((_, i) => {
    const base = i * 22;
    dv.setUint32(base + 0, NO_NODE, true); // parent
    dv.setUint32(base + 4, NO_NODE, true); // firstChild
    dv.setUint32(base + 8, i < edges.length - 1 ? i + 1 : NO_NODE, true); // nextSibling
    dv.setUint16(base + 12, RB_TAG.EDGE_ADDED, true);
    dv.setUint32(base + 14, offsets[i], true);
    dv.setUint32(base + 18, payloadChunks[i].byteLength, true);
  });
  // debugValueNames (GitHub issue #131) is a plain array in the real WASM response, not derived
  // from these edges — fixtures using this helper aren't exercising RB's recursion_stack declaration,
  // so an empty default is correct here; a test that specifically needs a non-empty list should
  // override the field on the returned object.
  return { nodeTable, payload, eventKind: "recursive_backtracker", debugValueNames: [] };
}

function u32le(v: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, v, true);
  return bytes;
}

/** Encodes intermediate snapshot checkpoints (GitHub issue #128) into the raw
 *  `{ snapshotTable, snapshotPayload }` buffer pair `generateMaze()` returns as
 *  `debugTape.snapshotTable`/`snapshotPayload` — mirrors `CheckpointTracker::record`'s wire
 *  format in `maze-core/src/generation/recursive_backtracker.rs` (see `Specs/event_log.md`):
 *  edges (`u32` count + `(u64, u64)` pairs), then named debug-value sets (GitHub issue #131,
 *  `u32` count of sets, each `u32` name length + UTF-8 name + `u32` id count + `u64` ids).
 *  `checkpoints` must be given in ascending `nodeIndex` order, same invariant `CheckpointLog::push`
 *  enforces on the Rust side. `debugValues` defaults to no sets — fixtures that don't specifically
 *  exercise debug-value checkpointing don't need to pass it. */
export function encodeCheckpoints(checkpoints: Array<{ nodeIndex: number; edges: [bigint, bigint][]; debugValues?: [string, bigint[]][] }>): { snapshotTable: Uint8Array; snapshotPayload: Uint8Array } {
  const textEncoder = new TextEncoder();
  const payloadChunks: Uint8Array[] = [];
  const tableChunks: Uint8Array[] = [];
  let payloadOffset = 0;
  for (const { nodeIndex, edges, debugValues = [] } of checkpoints) {
    const nameBytes = debugValues.map(([name]) => textEncoder.encode(name));
    const bytes = concatBytes([
      u32le(edges.length),
      ...edges.flatMap(([from, to]) => [u64le(from), u64le(to)]),
      u32le(debugValues.length),
      ...debugValues.flatMap(([, ids], i) => [
        u32le(nameBytes[i].byteLength),
        nameBytes[i],
        u32le(ids.length),
        ...ids.map(u64le),
      ]),
    ]);
    tableChunks.push(u32le(nodeIndex), u32le(payloadOffset), u32le(bytes.byteLength));
    payloadChunks.push(bytes);
    payloadOffset += bytes.byteLength;
  }
  return { snapshotTable: concatBytes(tableChunks), snapshotPayload: concatBytes(payloadChunks) };
}

export const mockSnapshot = {
  nodes: [{ id: 0, x: 0, y: 0 }, { id: 1, x: 1, y: 0 }],
  edges: [{ from: 0, to: 1, kind: "basic" as const }],
  start: 0,
  finish: 1,
  issues: [],
  nav_nodes: [],
  nav_edges: [],
  graph_analytics: { node_count: 0, edge_count: 0, component_count: 0, cycle_count: 0, cycle_region_count: 0, node_component: {}, pure_cycle_node_ids: [], pure_cycle_edge_pairs: [], cycle_analysis_overflowed: false, region_classes: {} },
  node_stats: { dead_ends: 2, straight: 0, turns: 0, junctions: [], teleport_entries: 0 },
  edge_stats: { bidirectional: 0, one_way_passages: 1, walls: 0 },
  teleport_edge_stats: { two_way: 0, one_way: 0 },
  route_info: null,
  timing: null,
};

/** `generateMaze`'s return shape (see `GenerateMazeResult` in `wasm/mazeService.ts`) wrapping
 *  `mockSnapshot`, with no debug tape — the default shape for tests that don't exercise
 *  `debug_events`. */
export const mockGenerateMazeResult = { snapshot: mockSnapshot, debugTape: undefined };

export function baseStoreState() {
  return {
    seed: 42,
    tessellationKind: "square" as const,
    squareShape: "rect" as const,
    hexShape: "parallelogram" as const,
    triangleShape: "rect" as const,
    hexOrientation: "flat_top" as const,
    triOrientation: "r0" as const,
    tessellationConfig: { type: "square" as const, width: 10, height: 10 },
    activeTessellationConfig: { type: "square" as const, width: 10, height: 10 },
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
    initialConfig: { method: "custom_vertex_based" as const, depth_first: 0.9, corridor_chance: 0.7, branching: 0.5, directionality: 0.0 },
    elementsConfig: { one_way_chance: 0.04, teleport_chance: 0.0, teleport_one_way_chance: 0.0 },
    rules: [],
    stages: [{ id: "stage_1", name: "Stage 1", ruleIds: [], disabled: false }],
    strategyParams: {},
    registryLoaded: false,
    availableChecks: [],
    availableStrategies: [],
  };
}

/** Free-field-editing state for a given kind, used by free field point mutation tests. */
export function freeFieldEditState(kind: "square" | "hex" | "triangle", pts: Set<number>) {
  const squareShape: "free" | "rect" = kind === "square" ? "free" : "rect";
  const hexShape: "free" | "parallelogram" = kind === "hex" ? "free" : "parallelogram";
  const triangleShape: "free" | "rect" = kind === "triangle" ? "free" : "rect";
  return {
    tessellationKind: kind,
    squareShape,
    hexShape,
    triangleShape,
    isEditingField: true,
    fieldPoints: pts,
    freeFieldPoints: { ...emptyFreePoints(), [kind]: pts },
    hexOrientation: "flat_top" as const,
    triOrientation: "r0" as const,
  };
}

/** State for hex-predefined-mode orientation tests: hexShape=parallelogram, other shapes=rect. */
export function hexPredefinedState(extra?: Record<string, unknown>) {
  return {
    tessellationKind: "hex" as const,
    hexShape: "parallelogram" as const,
    squareShape: "rect" as const,
    triangleShape: "rect" as const,
    hexOrientation: "flat_top" as const,
    freeFieldPoints: emptyFreePoints(),
    ...extra,
  };
}

/** State for triangle-predefined-mode orientation tests: triangleShape=rect, other shapes=rect/parallelogram. */
export function trianglePredefinedState(extra?: Record<string, unknown>) {
  return {
    tessellationKind: "triangle" as const,
    triangleShape: "rect" as const,
    hexShape: "parallelogram" as const,
    squareShape: "rect" as const,
    triOrientation: "r0" as const,
    freeFieldPoints: emptyFreePoints(),
    ...extra,
  };
}

/** Resets generateMaze/computeAnalytics/initWasm mocks to their default working state. Call in beforeEach. */
export function resetGenerationMocks<TGenerate extends { mockReset: () => void }, TAnalytics extends { mockReset: () => void; mockReturnValue: (v: typeof mockSnapshot) => unknown }, TWasm extends { mockResolvedValue: (v: undefined) => unknown }>(
  generateMaze: TGenerate,
  computeAnalytics: TAnalytics,
  initWasm: TWasm,
) {
  generateMaze.mockReset();
  computeAnalytics.mockReset();
  computeAnalytics.mockReturnValue(mockSnapshot);
  initWasm.mockResolvedValue(undefined);
}
