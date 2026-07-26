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

/** Node-table offset (GitHub issue #169) every real merged tape's actual content starts at:
 *  node 0 is the merge's own root, node 1 is the single "generation" top-level source scope,
 *  node 2 is the algorithm's own former root (the actual `EventLog::new()` root the algorithm
 *  built, always named "root", relinked as node 1's child by `merge_tapes`) — every source's own
 *  content starts at node 3. Fixtures built with `encodeEdgeAddedTape` mirror this exact
 *  three-level shape (matching `DebugEventTree.test.tsx`'s own merged fixtures) so they match
 *  what `mazeService.generateMaze()` actually returns post-merge, not the pre-#169 flat shape. */
export const MERGED_TAPE_NODE_OFFSET = 3;

/** Encodes a list of top-level `EdgeAdded` nodes into the raw `{ nodeTable, payload }` buffer
 *  pair `generateMaze()` returns as `debugTape` — mirrors `DebugTape::encode()`'s wire format
 *  (see `Specs/event_log.md`) as merged by `event_log::merge_tapes` (GitHub issue #169): node 0
 *  is the merged root, node 1 is a "generation" scope, node 2 is the algorithm's own former root
 *  (also named "root", per `merge_tapes`'s relinking — see `MERGED_TAPE_NODE_OFFSET`), wrapping
 *  the edges, which start at node `MERGED_TAPE_NODE_OFFSET`. Returns raw buffers (not a parsed
 *  `ParsedTape`) since that's the shape `generateWithSeed` receives from
 *  `mazeService.generateMaze` before it calls `parseTape` itself. */
export function encodeEdgeAddedTape(edges: [bigint, bigint][]): { nodeTable: Uint8Array; payload: Uint8Array; sourceScopeNames: string[]; sourceEventKinds: ["recursive_backtracker"]; debugValueNames: DebugValueDescriptor[] } {
  const textEncoder = new TextEncoder();
  const rootBytes = textEncoder.encode("root");
  const generationBytes = textEncoder.encode("generation");
  const formerRootBytes = textEncoder.encode("root");

  // `bidirectional` always encoded `true` — mirrors RB's real behavior (GitHub issue #135).
  const edgePayloadChunks = edges.map(([from, to]) => concatBytes([u64le(from), u64le(to), new Uint8Array([1])]));
  const payload = concatBytes([rootBytes, generationBytes, formerRootBytes, ...edgePayloadChunks]);
  const edgeOffsets: number[] = [];
  {
    let cursor = rootBytes.byteLength + generationBytes.byteLength + formerRootBytes.byteLength;
    for (const chunk of edgePayloadChunks) {
      edgeOffsets.push(cursor);
      cursor += chunk.byteLength;
    }
  }

  const nodeCount = MERGED_TAPE_NODE_OFFSET + edges.length;
  const nodeTable = new Uint8Array(nodeCount * 22);
  const dv = new DataView(nodeTable.buffer);
  const writeRecord = (index: number, parent: number, firstChild: number, nextSibling: number, tag: number, payloadOffset: number, payloadLen: number) => {
    const base = index * 22;
    dv.setUint32(base + 0, parent, true);
    dv.setUint32(base + 4, firstChild, true);
    dv.setUint32(base + 8, nextSibling, true);
    dv.setUint16(base + 12, tag, true);
    dv.setUint32(base + 14, payloadOffset, true);
    dv.setUint32(base + 18, payloadLen, true);
  };
  // Node 0: merged root -> first_child is node 1 ("generation" scope).
  writeRecord(0, NO_NODE, 1, NO_NODE, 0 /* TAG_SCOPE */, 0, rootBytes.byteLength);
  // Node 1: "generation" scope -> first_child is node 2 (the former root).
  writeRecord(1, 0, 2, NO_NODE, 0 /* TAG_SCOPE */, rootBytes.byteLength, generationBytes.byteLength);
  // Node 2: former root -> first_child is node MERGED_TAPE_NODE_OFFSET (first edge), or NO_NODE
  // when there are no edges at all.
  writeRecord(2, 1, edges.length > 0 ? MERGED_TAPE_NODE_OFFSET : NO_NODE, NO_NODE, 0 /* TAG_SCOPE */, rootBytes.byteLength + generationBytes.byteLength, formerRootBytes.byteLength);
  edges.forEach((_, i) => {
    const index = MERGED_TAPE_NODE_OFFSET + i;
    const nextSibling = i < edges.length - 1 ? index + 1 : NO_NODE;
    writeRecord(index, 2, NO_NODE, nextSibling, RB_TAG.EDGE_ADDED, edgeOffsets[i], edgePayloadChunks[i].byteLength);
  });
  // debugValueNames (GitHub issue #131) is a plain array in the real WASM response, not derived
  // from these edges — fixtures using this helper aren't exercising RB's recursion_stack declaration,
  // so an empty default is correct here; a test that specifically needs a non-empty list should
  // override the field on the returned object.
  return { nodeTable, payload, sourceScopeNames: ["generation"], sourceEventKinds: ["recursive_backtracker"], debugValueNames: [] };
}

export const mockSnapshot = {
  nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }],
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
    randomSeed: false,
    lastUsedSeed: null,
    seedHistory: [],
    seedHistoryIndex: 0,
    seedAttachedToHistory: false,
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
    elementsConfig: { one_way_chance: 0.04, teleport_chance: 0.0, teleport_one_way_chance: 0.0, split_chance: 0.0 },
    splitPatternMode: false,
    splitMaxNodes: 2,
    splitPatterns: [],
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
