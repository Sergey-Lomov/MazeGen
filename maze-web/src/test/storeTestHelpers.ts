import { emptyFreePoints } from "../store/storeHelpers";
import { RECURSIVE_BACKTRACKER_EVENT_TAG, NO_NODE } from "../debug/eventTape";
import type { DebugValueDescriptor } from "../debug/eventTape";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { QcRuleState, CheckInstance, FloorFieldConfig, MazeStore } from "../store/storeTypes";
import type { PostEditCommand } from "../store/postEditCommandTypes";
import { replayPostEditCommands } from "../pixi/postEditReplay";
import { buildPostEditBaseline, derivedStateToLegacyFields, nextSplitSlotIdCounters } from "../store/slices/postEditSliceHelpers";
import { parsePostEditIdNumber } from "../pixi/postEditIdFormat";

export { emptyFreePoints };

/** Floor id used by every test's base state (GitHub issue #338 per-floor field-shape split) —
 *  matches the `"floor_1"` convention already used by floorsSlice.test.ts/generationSlice.config.test.ts. */
export const TEST_FLOOR_ID = "floor_1";

/** A fresh default `FloorFieldConfig` matching `baseStoreState()`'s tessellation defaults
 *  (square/rect, 10x10) — used as the base entry for `floorFields[TEST_FLOOR_ID]`. */
export function baseFloorFieldConfig(overrides: Partial<FloorFieldConfig> = {}): FloorFieldConfig {
  return {
    squareShape: "rect",
    hexShape: "parallelogram",
    triangleShape: "rect",
    savedConfigs: {},
    tessellationConfig: { type: "square", width: 10, height: 10 },
    freeFieldPoints: emptyFreePoints(),
    isEditingField: false,
    fieldPoints: new Set<number>(),
    fieldEditMode: "default",
    fieldPrimitive: "point",
    fieldDirty: false,
    ...overrides,
  };
}

/** Builds a `QcRuleState` with sensible defaults, overridable per-field — replaces the
 *  repeated full-shape rule object literal inlined across generationSlice tests. */
export function makeRule(overrides: Partial<QcRuleState> = {}): QcRuleState {
  return {
    id: "g1", name: "Rule 1", kind: "k1",
    checks: [], nextLocalCheckId: 0,
    strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [], params: {},
    collapsed: false,
    ...overrides,
  };
}

/** Builds a `CheckInstance` with sensible defaults, overridable per-field. */
export function makeCheck(overrides: Partial<CheckInstance> = {}): CheckInstance {
  return { localId: 0, typeId: "check_a", params: {}, disabled: false, ...overrides };
}

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
export function encodeEdgeAddedTape(edges: [bigint, bigint][]): { nodeTable: Uint8Array; payload: Uint8Array; sourceScopeNames: string[]; sourceEventKinds: ["recursive_backtracker"]; debugValueNames: DebugValueDescriptor[]; allNodes: NodeDto[] } {
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
    writeRecord(index, 2, NO_NODE, nextSibling, RECURSIVE_BACKTRACKER_EVENT_TAG.EDGE_ADDED, edgeOffsets[i], edgePayloadChunks[i].byteLength);
  });
  // debugValueNames (GitHub issue #131) is a plain array in the real WASM response, not derived
  // from these edges — fixtures using this helper aren't exercising RB's recursion_stack declaration,
  // so an empty default is correct here; a test that specifically needs a non-empty list should
  // override the field on the returned object.
  return { nodeTable, payload, sourceScopeNames: ["generation"], sourceEventKinds: ["recursive_backtracker"], debugValueNames: [], allNodes: [] };
}

export const mockSnapshot = {
  nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }],
  edges: [{ from: 0, to: 1, kind: "basic" as const }],
  start: 0,
  finish: 1,
  issues: [],
  nav_nodes: [],
  nav_edges: [],
  statistics: {
    graph_stats: { floor_count: 1, node_count: 0, edge_count: 0, component_count: 0, average_degree: 0, cycle_count: 0, cycle_region_count: 0, simple_cycle_count: 0, node_component: {}, pure_cycle_node_ids: [], pure_cycle_edge_pairs: [], cycle_analysis_overflowed: false, region_classes: {} },
    cell_count: { total: 2, by_floor: { 0: 2 } },
    cell_stats: { total: { dead_ends: 2, straight: 0, turns: 0, junctions: [] }, by_floor: { 0: { dead_ends: 2, straight: 0, turns: 0, junctions: [] } } },
    passage_stats: { total: { bidirectional: 0, walls: 0, total_pairs: 0 }, by_floor: { 0: { bidirectional: 0, walls: 0, total_pairs: 0 } } },
    elements_stats: { total: { one_way_passages: 1, two_way_teleports: 0, one_way_teleports: 0, split_tile_count: 0, split_node_count: 0, split_groups: [] }, by_floor: { 0: { one_way_passages: 1, two_way_teleports: 0, one_way_teleports: 0, split_tile_count: 0, split_node_count: 0, split_groups: [] } } },
    vertical_stats: { bidirectional_passages: 0, one_way_passages_up: 0, one_way_passages_down: 0, elevator_groups: 0, elevator_stop_count: 0, average_elevator_stops: 0, cross_floor_teleports: 0 },
    elevator_stop_count: { total: 0, by_floor: { 0: 0 } },
  },
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
    hexOrientation: "flat_top" as const,
    triOrientation: "r0" as const,
    floors: [{ id: TEST_FLOOR_ID, title: "Floor 1" }],
    nextFloorNumber: 2,
    activeFloorId: TEST_FLOOR_ID,
    floorFields: { [TEST_FLOOR_ID]: baseFloorFieldConfig() },
    activeTessellationConfig: { type: "square" as const, width: 10, height: 10 },
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
    elementsConfig: { one_way_chance: 0.0, teleport_chance: 0.0, teleport_one_way_chance: 0.0, split_chance: 0.0 },
    splitPatternMode: false,
    splitMaxNodes: 2,
    splitPatterns: [],
    rules: [],
    stages: [{ id: "stage_1", name: "Stage 1", ruleIds: [], disabled: false, collapsed: false }],
    strategyParams: {},
    registryLoaded: false,
    availableChecks: [],
    availableStrategies: [],
  };
}

/** Free-field-editing state for a given kind, used by free field point mutation tests. Field-shape
 *  fields land in `floorFields[TEST_FLOOR_ID]` (GitHub issue #338) — merge on top of `extra` when
 *  a test also needs to override other floorFields entries. */
export function freeFieldEditState(kind: "square" | "hex" | "triangle", pts: Set<number>) {
  const squareShape: "free" | "rect" = kind === "square" ? "free" : "rect";
  const hexShape: "free" | "parallelogram" = kind === "hex" ? "free" : "parallelogram";
  const triangleShape: "free" | "rect" = kind === "triangle" ? "free" : "rect";
  return {
    tessellationKind: kind,
    hexOrientation: "flat_top" as const,
    triOrientation: "r0" as const,
    activeFloorId: TEST_FLOOR_ID,
    floorFields: {
      [TEST_FLOOR_ID]: baseFloorFieldConfig({
        squareShape,
        hexShape,
        triangleShape,
        isEditingField: true,
        fieldPoints: pts,
        freeFieldPoints: { ...emptyFreePoints(), [kind]: pts },
      }),
    },
  };
}

/** State for hex-predefined-mode orientation tests: hexShape=parallelogram, other shapes=rect.
 *  `extra` may contain top-level MazeState fields (e.g. `nodes`) and/or a `floorFieldOverrides`
 *  patch merged into `floorFields[TEST_FLOOR_ID]` (e.g. `tessellationConfig`). */
export function hexPredefinedState(extra?: Record<string, unknown> & { floorFieldOverrides?: Partial<FloorFieldConfig> }) {
  const { floorFieldOverrides, ...rest } = extra ?? {};
  return {
    tessellationKind: "hex" as const,
    hexOrientation: "flat_top" as const,
    activeFloorId: TEST_FLOOR_ID,
    floorFields: {
      [TEST_FLOOR_ID]: baseFloorFieldConfig({
        hexShape: "parallelogram",
        squareShape: "rect",
        triangleShape: "rect",
        ...floorFieldOverrides,
      }),
    },
    ...rest,
  };
}

/** State for triangle-predefined-mode orientation tests: triangleShape=rect, other shapes=rect/parallelogram.
 *  Same `floorFieldOverrides` convention as `hexPredefinedState`. */
export function trianglePredefinedState(extra?: Record<string, unknown> & { floorFieldOverrides?: Partial<FloorFieldConfig> }) {
  const { floorFieldOverrides, ...rest } = extra ?? {};
  return {
    tessellationKind: "triangle" as const,
    triOrientation: "r0" as const,
    activeFloorId: TEST_FLOOR_ID,
    floorFields: {
      [TEST_FLOOR_ID]: baseFloorFieldConfig({
        triangleShape: "rect",
        hexShape: "parallelogram",
        squareShape: "rect",
        ...floorFieldOverrides,
      }),
    },
    ...rest,
  };
}

/** Seed for `postEditStatePatch` — a generation snapshot plus the command log applied on top of it.
 *  `nodes`/`edges` default to the snapshot's own (the state right after a generation, before any
 *  confirm has overwritten them); pass `liveNodes`/`liveEdges` explicitly to simulate a later
 *  confirm having replaced `state.nodes`/`state.edges` with a different (edited) graph. */
export interface PostEditSeed {
  /** The generation snapshot the baseline (and thus every command's identity resolution) is built
   *  from — lands in `_generatedNodes`/`_generatedEdges`. */
  nodes: NodeDto[];
  edges: EdgeDto[];
  start?: number | null;
  finish?: number | null;
  commands?: PostEditCommand[];
  /** Live confirmed graph, when it must differ from the generation snapshot. */
  liveNodes?: NodeDto[];
  liveEdges?: EdgeDto[];
  /** Per-point high-water marks for split slot ids (`"x,y"`/`"x,y@level"` keys) — normally left
   *  alone (a fresh point mints slot 0); set explicitly by tests that need a specific next id. */
  nextSplitSlotId?: Record<string, number>;
  revision?: number;
}

/** Builds the full post-edit store patch for a scenario (GitHub issue #543): a real
 *  `postEditBaseline` built from the generation snapshot, the given command log replayed on top of
 *  it, and the legacy `postEditDraft*`/`postEditSuppressed*` mirror fields derived from the result.
 *
 *  Post-edit actions read `postEditBaseline.derived` as their source of truth, never the legacy
 *  mirror fields — seeding a scenario by `setState`-ing `postEditDraftEdges` & co. alone silently
 *  desyncs the two, so every test scenario must go through this. */
export function postEditStatePatch(seed: PostEditSeed): Partial<MazeStore> {
  const start = seed.start ?? null;
  const finish = seed.finish ?? null;
  const baseline = buildPostEditBaseline(seed.nodes, seed.edges, seed.revision ?? 0, start, finish);
  const commands = seed.commands ?? [];
  const derived = replayPostEditCommands(baseline, commands);
  // High-water marks for ids minted post-baseline (GitHub issue #564) — mirrors what the real
  // `generate()` store action seeds after building a baseline, so a scenario's own counters start
  // clean instead of inheriting whatever a previous test/seed left in the (shared, singleton) store.
  const splitPointIdValues = Object.values(baseline.derived.splitPointIds).map((id) => parsePostEditIdNumber("splitPoint", id));
  return {
    _generatedNodes: seed.nodes,
    _generatedEdges: seed.edges,
    _generatedStart: start,
    _generatedFinish: finish,
    nodes: seed.liveNodes ?? seed.nodes,
    edges: seed.liveEdges ?? seed.edges,
    start,
    finish,
    postEditBaseline: baseline,
    postEditDerived: derived,
    postEditCommands: commands,
    ...derivedStateToLegacyFields(derived),
    // Defaults to the baseline's own per-point high-water marks (GitHub issue #569) — same
    // "generation-baked slots already occupy ids" seeding `generate()`/`resetPostEdit` do, so a
    // scenario built from a split-bearing snapshot doesn't silently collide `addSplitNode`'s next
    // slotId with an existing generation-baked slot unless a test explicitly overrides it.
    _nextSplitSlotId: seed.nextSplitSlotId ?? nextSplitSlotIdCounters(baseline.derived.splitPoints),
    _nextPostEditSplitPointId: splitPointIdValues.length > 0 ? Math.max(...splitPointIdValues) + 1 : 1,
  } as Partial<MazeStore>;
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
