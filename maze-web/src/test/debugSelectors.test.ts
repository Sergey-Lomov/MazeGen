import { describe, it, expect } from "vitest";
import { parseTape, RECURSIVE_BACKTRACKER_EVENT_TAG, WILSON_EVENT_TAG, KRUSKAL_EVENT_TAG, EDGE_BASED_EVENT_TAG, VERTEX_BASED_EVENT_TAG, PRESET_SETUP_EVENT_TAG, QC_EVENT_TAG, TAG_SCOPE, NO_NODE, type ParsedTape } from "../debug/eventTape";
import { selectDebugMazeView } from "../store/debugSelectors";
import type { DebugArenaHandle } from "../store/storeTypes";
import type { NodeDto } from "../wasm/types";

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

function edgeAddedPayload(from: bigint, to: bigint): Uint8Array {
  // bidirectional=true — mirrors RB's real behavior (GitHub issue #135).
  return concatBytes([u64le(from), u64le(to), new Uint8Array([1])]);
}

interface FixtureNode {
  nextSibling: number | null;
  tag: number;
  payloadBytes: Uint8Array;
}

/** Same flat-under-root shape as eventTape.test.ts's buildThreeEdgeTape — three top-level
 *  EdgeAdded nodes, no nested scopes (parent/firstChild are irrelevant to the flat layer this
 *  selector uses). */
function buildTapeWithEdges(edges: [bigint, bigint][]): ParsedTape {
  const nodes: FixtureNode[] = edges.map(([from, to], i) => ({
    nextSibling: i < edges.length - 1 ? i + 1 : null,
    tag: RECURSIVE_BACKTRACKER_EVENT_TAG.EDGE_ADDED,
    payloadBytes: edgeAddedPayload(from, to),
  }));
  const payloadChunks = nodes.map((n) => n.payloadBytes);
  const offsets: number[] = [];
  let cursor = 0;
  for (const chunk of payloadChunks) {
    offsets.push(cursor);
    cursor += chunk.byteLength;
  }
  const payload = concatBytes(payloadChunks);
  const nodeTable = new Uint8Array(nodes.length * 22);
  const dv = new DataView(nodeTable.buffer);
  nodes.forEach((n, i) => {
    const base = i * 22;
    dv.setUint32(base + 0, NO_NODE, true); // parent
    dv.setUint32(base + 4, NO_NODE, true); // firstChild
    dv.setUint32(base + 8, n.nextSibling ?? NO_NODE, true);
    dv.setUint16(base + 12, n.tag, true);
    dv.setUint32(base + 14, offsets[i], true);
    dv.setUint32(base + 18, n.payloadBytes.byteLength, true);
  });
  return parseTape(nodeTable, payload);
}

const nodes: NodeDto[] = [
  { id: 1, x: 0, y: 0, i: 0 },
  { id: 2, x: 1, y: 0, i: 0 },
  { id: 3, x: 2, y: 0, i: 0 },
  { id: 4, x: 3, y: 0, i: 0 },
];

/** Flat, no nested scopes (mirrors buildTapeWithEdges — Kruskal's applyKruskal only uses the flat
 *  layer): one EdgeAdded(1,2) then one SetsMerged(1,2), directly under root. Covers
 *  selectDebugMazeView's "kruskal" branch, which had zero coverage — the only Kruskal fixture
 *  elsewhere in this repo lives in eventTape.test.ts/debugTreeSelectors.test.ts, neither of which
 *  exercises this selector. */
function buildKruskalArenaTape(): ParsedTape {
  const records: { nextSibling: number | null; tag: number; bytes: Uint8Array }[] = [
    { nextSibling: 1, tag: KRUSKAL_EVENT_TAG.EDGE_ADDED, bytes: edgeAddedPayload(1n, 2n) },
    { nextSibling: null, tag: KRUSKAL_EVENT_TAG.SETS_MERGED, bytes: concatBytes([u64le(1n), u64le(2n)]) },
  ];
  const payloadChunks = records.map((r) => r.bytes);
  const offsets: number[] = [];
  let cursor = 0;
  for (const chunk of payloadChunks) {
    offsets.push(cursor);
    cursor += chunk.byteLength;
  }
  const payload = concatBytes(payloadChunks);
  const nodeTable = new Uint8Array(records.length * 22);
  const dv = new DataView(nodeTable.buffer);
  records.forEach((r, i) => {
    const base = i * 22;
    dv.setUint32(base + 0, NO_NODE, true);
    dv.setUint32(base + 4, NO_NODE, true);
    dv.setUint32(base + 8, r.nextSibling ?? NO_NODE, true);
    dv.setUint16(base + 12, r.tag, true);
    dv.setUint32(base + 14, offsets[i], true);
    dv.setUint32(base + 18, r.bytes.byteLength, true);
  });
  return parseTape(nodeTable, payload);
}

/** preset_setup fixture, flat under root, same shape as buildKruskalArenaTape — one
 *  PassageEstablished(1,2) then one OneWayEstablished(3,4). Covers selectDebugMazeView's
 *  "preset_setup" branch (presetSetupContribution), which had zero coverage. */
function buildPresetSetupArenaTape(): ParsedTape {
  function passagePayload(from: bigint, to: bigint): Uint8Array {
    return concatBytes([u64le(from), u64le(to)]);
  }
  const records: { nextSibling: number | null; tag: number; bytes: Uint8Array }[] = [
    { nextSibling: 1, tag: PRESET_SETUP_EVENT_TAG.PASSAGE_ESTABLISHED, bytes: passagePayload(1n, 2n) },
    { nextSibling: null, tag: PRESET_SETUP_EVENT_TAG.ONE_WAY_ESTABLISHED, bytes: passagePayload(3n, 4n) },
  ];
  const payloadChunks = records.map((r) => r.bytes);
  const offsets: number[] = [];
  let cursor = 0;
  for (const chunk of payloadChunks) {
    offsets.push(cursor);
    cursor += chunk.byteLength;
  }
  const payload = concatBytes(payloadChunks);
  const nodeTable = new Uint8Array(records.length * 22);
  const dv = new DataView(nodeTable.buffer);
  records.forEach((r, i) => {
    const base = i * 22;
    dv.setUint32(base + 0, NO_NODE, true);
    dv.setUint32(base + 4, NO_NODE, true);
    dv.setUint32(base + 8, r.nextSibling ?? NO_NODE, true);
    dv.setUint16(base + 12, r.tag, true);
    dv.setUint32(base + 14, offsets[i], true);
    dv.setUint32(base + 18, r.bytes.byteLength, true);
  });
  return parseTape(nodeTable, payload);
}

function arenaWithEdges(edges: [bigint, bigint][]): DebugArenaHandle {
  return {
    tape: buildTapeWithEdges(edges), algorithmKind: "recursive_backtracker",
    sources: [{ scopeName: "generation", kind: "recursive_backtracker", nodeIndex: 0, startStep: 0, endStep: edges.length, checkpointFroms: [] }],
    nodes, allNodes: nodes, totalSteps: edges.length, debugValueNames: [],
  };
}

// Wilson fixture, mirroring eventTape.test.ts's buildWilsonTape shape:
//   root (0)
//     -> "walk 1" scope (1)
//          -> WalkStartPicked(1) (2)
//          -> "step 1" scope (3) -> StepTaken(1,2) (4)
//          -> EdgeAdded(1,2) (5) -> NodeVisited(1) (6)
function buildWilsonArenaTape(): ParsedTape {
  const nodeTable = new Uint8Array(7 * 22);
  const payloadChunks: Uint8Array[] = [];
  const records: { parent: number; firstChild: number; nextSibling: number; tag: number; bytes: Uint8Array }[] = [
    { parent: NO_NODE, firstChild: 1, nextSibling: NO_NODE, tag: 0, bytes: new TextEncoder().encode("root") },
    { parent: 0, firstChild: 2, nextSibling: NO_NODE, tag: 0, bytes: new TextEncoder().encode("walk 1") },
    { parent: 1, firstChild: NO_NODE, nextSibling: 3, tag: WILSON_EVENT_TAG.WALK_START_PICKED, bytes: u64le(1n) },
    { parent: 1, firstChild: 4, nextSibling: 5, tag: 0, bytes: new TextEncoder().encode("step 1") },
    { parent: 3, firstChild: NO_NODE, nextSibling: NO_NODE, tag: WILSON_EVENT_TAG.STEP_TAKEN, bytes: concatBytes([u64le(1n), u64le(2n)]) },
    { parent: 1, firstChild: NO_NODE, nextSibling: 6, tag: WILSON_EVENT_TAG.EDGE_ADDED, bytes: edgeAddedPayload(1n, 2n) },
    { parent: 1, firstChild: NO_NODE, nextSibling: NO_NODE, tag: WILSON_EVENT_TAG.NODE_VISITED, bytes: u64le(1n) },
  ];
  const offsets: number[] = [];
  let cursor = 0;
  for (const r of records) {
    offsets.push(cursor);
    payloadChunks.push(r.bytes);
    cursor += r.bytes.byteLength;
  }
  const payload = concatBytes(payloadChunks);
  const dv = new DataView(nodeTable.buffer);
  records.forEach((r, i) => {
    const base = i * 22;
    dv.setUint32(base + 0, r.parent, true);
    dv.setUint32(base + 4, r.firstChild, true);
    dv.setUint32(base + 8, r.nextSibling, true);
    dv.setUint16(base + 12, r.tag, true);
    dv.setUint32(base + 14, offsets[i], true);
    dv.setUint32(base + 18, r.bytes.byteLength, true);
  });
  return parseTape(nodeTable, payload);
}

// CustomEdgeBased fixture (GitHub issue #144), one flat "step 1" scope:
//   root (0)
//     -> "step 1" scope (1)
//          -> EdgeAdded(1,2) (2)
//          -> NodeActivated(2, parent=1) (3)
//          -> SrcExhausted(1) (4)
function buildEdgeBasedArenaTape(): ParsedTape {
  const nodeTable = new Uint8Array(5 * 22);
  const edgeAddedPayload = concatBytes([u64le(1n), u64le(2n), new Uint8Array([0]), new Uint8Array([0])]);
  const nodeActivatedPayload = concatBytes([u64le(2n), new Uint8Array([1]), u64le(1n), new Uint8Array([0, 0, 0, 0])]);
  const srcExhaustedPayload = u64le(1n);
  const records: { parent: number; firstChild: number; nextSibling: number; tag: number; bytes: Uint8Array }[] = [
    { parent: NO_NODE, firstChild: 1, nextSibling: NO_NODE, tag: 0, bytes: new TextEncoder().encode("root") },
    { parent: 0, firstChild: 2, nextSibling: NO_NODE, tag: 0, bytes: new TextEncoder().encode("step 1") },
    { parent: 1, firstChild: NO_NODE, nextSibling: 3, tag: EDGE_BASED_EVENT_TAG.EDGE_ADDED, bytes: edgeAddedPayload },
    { parent: 1, firstChild: NO_NODE, nextSibling: 4, tag: EDGE_BASED_EVENT_TAG.NODE_ACTIVATED, bytes: nodeActivatedPayload },
    { parent: 1, firstChild: NO_NODE, nextSibling: NO_NODE, tag: EDGE_BASED_EVENT_TAG.SRC_EXHAUSTED, bytes: srcExhaustedPayload },
  ];
  const offsets: number[] = [];
  let cursor = 0;
  for (const r of records) {
    offsets.push(cursor);
    cursor += r.bytes.byteLength;
  }
  const payload = concatBytes(records.map((r) => r.bytes));
  const dv = new DataView(nodeTable.buffer);
  records.forEach((r, i) => {
    const base = i * 22;
    dv.setUint32(base + 0, r.parent, true);
    dv.setUint32(base + 4, r.firstChild, true);
    dv.setUint32(base + 8, r.nextSibling, true);
    dv.setUint16(base + 12, r.tag, true);
    dv.setUint32(base + 14, offsets[i], true);
    dv.setUint32(base + 18, r.bytes.byteLength, true);
  });
  return parseTape(nodeTable, payload);
}

// CustomVertexBased fixture (GitHub issue #143), one flat "step 1" scope:
//   root (0)
//     -> "step 1" scope (1)
//          -> EdgeAdded(1,2) (2)
//          -> NodeVisited(2, parent=1) (3)
function buildVertexBasedArenaTape(): ParsedTape {
  const nodeTable = new Uint8Array(4 * 22);
  const edgeAddedPayload = concatBytes([u64le(1n), u64le(2n), new Uint8Array([0])]);
  const nodeVisitedPayload = concatBytes([u64le(2n), u64le(1n)]);
  const records: { parent: number; firstChild: number; nextSibling: number; tag: number; bytes: Uint8Array }[] = [
    { parent: NO_NODE, firstChild: 1, nextSibling: NO_NODE, tag: 0, bytes: new TextEncoder().encode("root") },
    { parent: 0, firstChild: 2, nextSibling: NO_NODE, tag: 0, bytes: new TextEncoder().encode("step 1") },
    { parent: 1, firstChild: NO_NODE, nextSibling: 3, tag: VERTEX_BASED_EVENT_TAG.EDGE_ADDED, bytes: edgeAddedPayload },
    { parent: 1, firstChild: NO_NODE, nextSibling: NO_NODE, tag: VERTEX_BASED_EVENT_TAG.NODE_VISITED, bytes: nodeVisitedPayload },
  ];
  const offsets: number[] = [];
  let cursor = 0;
  for (const r of records) {
    offsets.push(cursor);
    cursor += r.bytes.byteLength;
  }
  const payload = concatBytes(records.map((r) => r.bytes));
  const dv = new DataView(nodeTable.buffer);
  records.forEach((r, i) => {
    const base = i * 22;
    dv.setUint32(base + 0, r.parent, true);
    dv.setUint32(base + 4, r.firstChild, true);
    dv.setUint32(base + 8, r.nextSibling, true);
    dv.setUint16(base + 12, r.tag, true);
    dv.setUint32(base + 14, offsets[i], true);
    dv.setUint32(base + 18, r.bytes.byteLength, true);
  });
  return parseTape(nodeTable, payload);
}

function u32le(v: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, v, true);
  return bytes;
}

// CustomVertexBased fixture with a split (GitHub issue #222):
//   root (0)
//     -> "step 1" scope (1)
//          -> EdgeAdded(1,2) (2)
//          -> NodeVisited(2, parent=1) (3)
//          -> SplitNodesCreated(src=2, nodes=[2,3], pattern=null) (4) -- mints node 3
//          -> EdgeAdded(2,3) (5) -- the new sibling's own connection
// Node 3 (id=5 in the fixture's NodeDto list) doesn't exist yet at step 2 (before
// SplitNodesCreated) — only from step 3 onward should it appear in `view.nodes`.
function buildVertexBasedSplitArenaTape(): ParsedTape {
  const nodeTable = new Uint8Array(6 * 22);
  const edgeAddedPayload = (from: bigint, to: bigint) => concatBytes([u64le(from), u64le(to), new Uint8Array([0])]);
  const nodeVisitedPayload = concatBytes([u64le(2n), u64le(1n)]);
  const splitNodesCreatedPayload = concatBytes([
    u64le(2n), // src
    u32le(2), u64le(2n), u64le(5n), // nodes = [src, new sibling id=5]
    new Uint8Array([0]), // hasPattern = false
  ]);
  const records: { parent: number; firstChild: number; nextSibling: number; tag: number; bytes: Uint8Array }[] = [
    { parent: NO_NODE, firstChild: 1, nextSibling: NO_NODE, tag: 0, bytes: new TextEncoder().encode("root") },
    { parent: 0, firstChild: 2, nextSibling: NO_NODE, tag: 0, bytes: new TextEncoder().encode("step 1") },
    { parent: 1, firstChild: NO_NODE, nextSibling: 3, tag: VERTEX_BASED_EVENT_TAG.EDGE_ADDED, bytes: edgeAddedPayload(1n, 2n) },
    { parent: 1, firstChild: NO_NODE, nextSibling: 4, tag: VERTEX_BASED_EVENT_TAG.NODE_VISITED, bytes: nodeVisitedPayload },
    { parent: 1, firstChild: NO_NODE, nextSibling: 5, tag: VERTEX_BASED_EVENT_TAG.SPLIT_NODES_CREATED, bytes: splitNodesCreatedPayload },
    { parent: 1, firstChild: NO_NODE, nextSibling: NO_NODE, tag: VERTEX_BASED_EVENT_TAG.EDGE_ADDED, bytes: edgeAddedPayload(2n, 5n) },
  ];
  const offsets: number[] = [];
  let cursor = 0;
  for (const r of records) {
    offsets.push(cursor);
    cursor += r.bytes.byteLength;
  }
  const payload = concatBytes(records.map((r) => r.bytes));
  const dv = new DataView(nodeTable.buffer);
  records.forEach((r, i) => {
    const base = i * 22;
    dv.setUint32(base + 0, r.parent, true);
    dv.setUint32(base + 4, r.firstChild, true);
    dv.setUint32(base + 8, r.nextSibling, true);
    dv.setUint16(base + 12, r.tag, true);
    dv.setUint32(base + 14, offsets[i], true);
    dv.setUint32(base + 18, r.bytes.byteLength, true);
  });
  return parseTape(nodeTable, payload);
}

describe("selectDebugMazeView", () => {
  it("returns null when there is no debug arena", () => {
    expect(selectDebugMazeView(null, 0)).toBeNull();
  });

  it("a source with zero mutating events (startStep === endStep, GitHub issue #173) yields an empty view instead of a negative-localStep crash", () => {
    const arena = arenaWithEdges([]);
    expect(arena.totalSteps).toBe(0);
    const view = selectDebugMazeView(arena, 0);
    expect(view).toEqual({
      nodes,
      edges: [],
      start: null,
      finish: null,
      debugValues: new Map(),
      dsuGroups: null,
      debugMaps: new Map(),
      debugVertices: new Map(),
    });
  });

  it("returns the arena's static node list and the exact edges reconstructed at debugStep, both directions per bidirectional EdgeAdded (GitHub issue #135)", () => {
    const arena = arenaWithEdges([[1n, 2n], [2n, 3n], [3n, 4n]]);
    const view = selectDebugMazeView(arena, 1);
    expect(view).toEqual({
      nodes,
      edges: [
        { from: 1, to: 2, kind: "basic" },
        { from: 2, to: 1, kind: "basic" },
        { from: 2, to: 3, kind: "basic" },
        { from: 3, to: 2, kind: "basic" },
      ],
      start: null,
      finish: null,
      debugValues: new Map(),
      dsuGroups: null,
      debugMaps: new Map(),
      debugVertices: new Map(),
    });
  });

  it("step 0 reconstructs exactly one bidirectional edge (both directions)", () => {
    const arena = arenaWithEdges([[1n, 2n], [2n, 3n]]);
    const view = selectDebugMazeView(arena, 0);
    expect(view?.edges).toEqual([
      { from: 1, to: 2, kind: "basic" },
      { from: 2, to: 1, kind: "basic" },
    ]);
  });

  it("the last valid step (totalSteps - 1) reconstructs every edge in the tape, both directions each", () => {
    const edgePairs: [bigint, bigint][] = [[1n, 2n], [2n, 3n], [3n, 4n]];
    const arena = arenaWithEdges(edgePairs);
    const view = selectDebugMazeView(arena, arena.totalSteps - 1);
    expect(view?.edges).toHaveLength(edgePairs.length * 2);
  });

  it("converts bigint node ids to number and always tags edges as basic", () => {
    const arena = arenaWithEdges([[1n, 2n]]);
    const view = selectDebugMazeView(arena, 0);
    expect(view?.edges[0]).toEqual({ from: 1, to: 2, kind: "basic" });
    expect(typeof view?.edges[0].from).toBe("number");
  });

  it("resumes from a checkpoint (GitHub issue #128) and reconstructs the same edges as a full replay", () => {
    const edgePairs: [bigint, bigint][] = [[1n, 2n], [2n, 3n], [3n, 4n]];
    const tape = buildTapeWithEdges(edgePairs);
    // A checkpoint at arena node 0 (step 0) reflecting state after the first EdgeAdded.
    const checkpointFroms = [{ step: 0, result: { edges: [{ from: 1n, to: 2n }, { from: 2n, to: 1n }], debugValues: new Map(), step: 0, nodeIndex: 0 } }];
    const sourcesWithCheckpoint: DebugArenaHandle["sources"] = [{ scopeName: "generation", kind: "recursive_backtracker", nodeIndex: 0, startStep: 0, endStep: edgePairs.length, checkpointFroms }];
    const sourcesWithoutCheckpoint: DebugArenaHandle["sources"] = [{ scopeName: "generation", kind: "recursive_backtracker", nodeIndex: 0, startStep: 0, endStep: edgePairs.length, checkpointFroms: [] }];
    const arenaWithCheckpoint: DebugArenaHandle = { tape, algorithmKind: "recursive_backtracker", sources: sourcesWithCheckpoint, nodes, allNodes: nodes, totalSteps: edgePairs.length, debugValueNames: [] };
    const arenaWithoutCheckpoint: DebugArenaHandle = { tape, algorithmKind: "recursive_backtracker", sources: sourcesWithoutCheckpoint, nodes, allNodes: nodes, totalSteps: edgePairs.length, debugValueNames: [] };

    const withCheckpoint = selectDebugMazeView(arenaWithCheckpoint, 2);
    const withoutCheckpoint = selectDebugMazeView(arenaWithoutCheckpoint, 2);
    expect(withCheckpoint).toEqual(withoutCheckpoint);
  });

  it("returns the same object reference for repeated calls with the same (arena, debugStep) pair (GitHub issue #139)", () => {
    const arena = arenaWithEdges([[1n, 2n], [2n, 3n], [3n, 4n]]);
    const first = selectDebugMazeView(arena, 1);
    const second = selectDebugMazeView(arena, 1);
    expect(second).toBe(first);
  });

  it("recomputes when debugStep changes, then again when it changes back", () => {
    const arena = arenaWithEdges([[1n, 2n], [2n, 3n], [3n, 4n]]);
    const atStep1 = selectDebugMazeView(arena, 1);
    const atStep2 = selectDebugMazeView(arena, 2);
    expect(atStep2).not.toBe(atStep1);
    const backToStep1 = selectDebugMazeView(arena, 1);
    expect(backToStep1).toEqual(atStep1);
  });

  it("recomputes when the arena changes even for the same debugStep", () => {
    const arenaA = arenaWithEdges([[1n, 2n]]);
    const arenaB = arenaWithEdges([[1n, 2n]]);
    const viewA = selectDebugMazeView(arenaA, 0);
    const viewB = selectDebugMazeView(arenaB, 0);
    expect(viewB).not.toBe(viewA);
    expect(viewB).toEqual(viewA);
  });

  // --- Wilson dispatch (GitHub issue #145) ---

  it("dispatches Wilson arenas to applyWilson, populating debugValues and debugMaps", () => {
    const tape = buildWilsonArenaTape();
    const arena: DebugArenaHandle = {
      tape, algorithmKind: "wilson",
      sources: [{ scopeName: "generation", kind: "wilson", nodeIndex: 0, startStep: 0, endStep: 4, checkpointFroms: [] }],
      nodes, allNodes: nodes, totalSteps: 4,
      debugValueNames: [{ name: "visited", kind: "region" }, { name: "current_walk", kind: "map" }],
    };

    // targetStep 3 = WalkStartPicked, StepTaken, EdgeAdded, NodeVisited all applied.
    const view = selectDebugMazeView(arena, 3);
    expect(view?.edges).toEqual([
      { from: 1, to: 2, kind: "basic" },
      { from: 2, to: 1, kind: "basic" },
    ]);
    expect(view?.debugValues.get("visited")).toEqual([1]);
    expect(view?.debugMaps.get("current_walk")).toEqual(new Map([[1, 2]]));
    expect(view?.debugVertices.get("walk_start")).toBe(1);
    expect(view?.debugVertices.get("walk_head")).toBe(2);
    expect(view?.dsuGroups).toBeNull();
  });

  // --- CustomEdgeBased dispatch (GitHub issue #144) ---

  it("dispatches edge_based arenas to applyEdgeBased, populating edges and active/visited debugValues, with no dsuGroups/debugMaps/debugVertices", () => {
    const tape = buildEdgeBasedArenaTape();
    const arena: DebugArenaHandle = {
      tape, algorithmKind: "edge_based",
      sources: [{ scopeName: "generation", kind: "edge_based", nodeIndex: 0, startStep: 0, endStep: 3, checkpointFroms: [] }],
      nodes, allNodes: nodes, totalSteps: 3,
      debugValueNames: [{ name: "active", kind: "region" }, { name: "visited", kind: "region" }],
    };

    // targetStep 2 = EdgeAdded(1,2), NodeActivated(2, parent=1), SrcExhausted(1) all applied.
    const view = selectDebugMazeView(arena, 2);
    expect(view?.edges).toEqual([{ from: 1, to: 2, kind: "basic" }]);
    expect(view?.debugValues.get("active")).toEqual([2]);
    expect(view?.debugValues.get("visited")).toEqual([1]);
    expect(view?.dsuGroups).toBeNull();
    expect(view?.debugMaps.size).toBe(0);
    expect(view?.debugVertices.size).toBe(0);
  });

  // --- CustomVertexBased dispatch (GitHub issue #143) ---

  it("dispatches vertex_based arenas to applyVertexBased, populating edges and visited/frontier debugValues, with no dsuGroups/debugMaps/debugVertices", () => {
    const tape = buildVertexBasedArenaTape();
    const arena: DebugArenaHandle = {
      tape, algorithmKind: "vertex_based",
      sources: [{ scopeName: "generation", kind: "vertex_based", nodeIndex: 0, startStep: 0, endStep: 2, checkpointFroms: [] }],
      nodes, allNodes: nodes, totalSteps: 2,
      debugValueNames: [{ name: "visited", kind: "region" }, { name: "frontier", kind: "region" }, { name: "reserve", kind: "region" }],
    };

    // targetStep 1 = EdgeAdded(1,2), NodeVisited(2, parent=1) both applied.
    const view = selectDebugMazeView(arena, 1);
    expect(view?.edges).toEqual([{ from: 1, to: 2, kind: "basic" }]);
    expect(view?.debugValues.get("visited")).toEqual([2]);
    expect(view?.debugValues.get("frontier")).toEqual([2]);
    expect(view?.dsuGroups).toBeNull();
    expect(view?.debugMaps.size).toBe(0);
    expect(view?.debugVertices.size).toBe(0);
  });

  // --- Split-node visibility (GitHub issue #222) ---
  // Regression: `arena.nodes` is the run's final, static node list, so a split-minted node id
  // (here 5, sibling of src=2) is present in it from the start regardless of `debugStep`. Before
  // this fix, `view.nodes` was just `arena.nodes` unfiltered — a point with more than one node
  // read as "split" (excluded from ordinary wall rendering, see `buildSplitPointKeys` in
  // `mazeSelectors.ts`) many steps before the split actually happened, and with no edges yet for
  // the not-yet-created sibling, the whole point rendered fully closed instead of as ordinary
  // walls.

  it("excludes a split-minted node from view.nodes before its SplitNodesCreated step, and includes it from that step onward", () => {
    const tape = buildVertexBasedSplitArenaTape();
    const splitNodes: NodeDto[] = [...nodes, { id: 5, x: 1, y: 0, i: 1 }]; // sibling shares node 2's cell
    const arena: DebugArenaHandle = {
      tape, algorithmKind: "vertex_based",
      sources: [{ scopeName: "generation", kind: "vertex_based", nodeIndex: 0, startStep: 0, endStep: 4, checkpointFroms: [] }],
      nodes: splitNodes, allNodes: splitNodes, totalSteps: 4,
      debugValueNames: [{ name: "visited", kind: "region" }, { name: "frontier", kind: "region" }, { name: "reserve", kind: "region" }],
    };

    // step 1 = EdgeAdded(1,2), NodeVisited(2) applied — SplitNodesCreated hasn't fired yet.
    const beforeSplit = selectDebugMazeView(arena, 1);
    expect(beforeSplit?.nodes.map((n) => n.id)).toEqual([1, 2, 3, 4]);

    // step 2 = SplitNodesCreated(src=2, nodes=[2,5]) applied — node 5 now exists.
    const atSplit = selectDebugMazeView(arena, 2);
    expect(atSplit?.nodes.map((n) => n.id)).toEqual([1, 2, 3, 4, 5]);

    // step 3 = EdgeAdded(2,5) applied — node 5 still present, now with its own edge.
    const afterSplit = selectDebugMazeView(arena, 3);
    expect(afterSplit?.nodes.map((n) => n.id)).toEqual([1, 2, 3, 4, 5]);
    expect(afterSplit?.edges).toContainEqual({ from: 2, to: 5, kind: "basic" });
  });

  // --- QC node removal (GitHub issue #248's remove_split strategy) ---

  // root (0) -> BidirectionalEdgeAdded(2,3) (1) -> NodeRemoved(3) (2)
  function buildQcNodeRemovedArenaTape(): ParsedTape {
    const records: { parent: number; firstChild: number; nextSibling: number; tag: number; bytes: Uint8Array }[] = [
      { parent: NO_NODE, firstChild: 1, nextSibling: NO_NODE, tag: TAG_SCOPE, bytes: new TextEncoder().encode("root") },
      { parent: 0, firstChild: NO_NODE, nextSibling: 2, tag: QC_EVENT_TAG.BIDIRECTIONAL_EDGE_ADDED, bytes: concatBytes([u64le(2n), u64le(3n)]) },
      { parent: 0, firstChild: NO_NODE, nextSibling: NO_NODE, tag: QC_EVENT_TAG.NODE_REMOVED, bytes: u64le(3n) },
    ];
    const offsets: number[] = [];
    let cursor = 0;
    for (const r of records) {
      offsets.push(cursor);
      cursor += r.bytes.byteLength;
    }
    const payload = concatBytes(records.map((r) => r.bytes));
    const nodeTable = new Uint8Array(records.length * 22);
    const dv = new DataView(nodeTable.buffer);
    records.forEach((r, i) => {
      const base = i * 22;
      dv.setUint32(base + 0, r.parent, true);
      dv.setUint32(base + 4, r.firstChild, true);
      dv.setUint32(base + 8, r.nextSibling, true);
      dv.setUint16(base + 12, r.tag, true);
      dv.setUint32(base + 14, offsets[i], true);
      dv.setUint32(base + 18, r.bytes.byteLength, true);
    });
    return parseTape(nodeTable, payload);
  }

  it("a node removed by QC's remove_split strategy (RemoveNode/NodeRemoved) disappears from view.nodes from that step onward", () => {
    const tape = buildQcNodeRemovedArenaTape();
    const arena: DebugArenaHandle = {
      tape, algorithmKind: "quality_control",
      sources: [{ scopeName: "quality_control", kind: "quality_control", nodeIndex: 0, startStep: 0, endStep: 2, checkpointFroms: [] }],
      nodes: [{ id: 2, x: 0, y: 0, i: 0 }, { id: 3, x: 1, y: 0, i: 0 }],
      allNodes: [{ id: 2, x: 0, y: 0, i: 0 }, { id: 3, x: 1, y: 0, i: 0 }],
      totalSteps: 2,
      debugValueNames: [],
    };

    // step 0 = BidirectionalEdgeAdded(2,3) applied — node 3 still present, connected.
    const beforeRemoval = selectDebugMazeView(arena, 0);
    expect(beforeRemoval?.nodes.map((n) => n.id)).toEqual([2, 3]);
    expect(beforeRemoval?.edges).toContainEqual({ from: 2, to: 3, kind: "basic" });

    // step 1 = NodeRemoved(3) applied — node 3 must be gone from view.nodes entirely, not just
    // edgeless (its RemoveNode command already cleared its edges too, on the Rust side).
    const afterRemoval = selectDebugMazeView(arena, 1);
    expect(afterRemoval?.nodes.map((n) => n.id)).toEqual([2]);
  });

  // --- QC point-nodes replacement (GitHub issue #247's AddSplitStrategy, generalized by #271) ---

  // root (0) -> BidirectionalEdgeAdded(2,3) (1) -> PointNodesReplaced(at=3, old=[3], new=[20], edges=[(20->2, Forward)]) (2)
  function buildQcPointNodesReplacedArenaTape(): ParsedTape {
    const splitNodesPayload = concatBytes([
      new Uint8Array([1, 0, 0, 0]), // node count = 1 (little-endian u32)
      new Uint8Array([1, 0, 0, 0]), // edge count = 1
      new Uint8Array([0]), // direction = Forward
      new Uint8Array([0]), // kind = Basic (issue #281)
      u64le(2n), // target = node 2
    ]);
    const pointNodesReplacedPayload = concatBytes([
      u64le(3n), // at
      new Uint8Array([1, 0, 0, 0]), u64le(3n), // old_nodes = [3]
      new Uint8Array([1, 0, 0, 0]), u64le(20n), // new_nodes = [20]
      splitNodesPayload,
    ]);
    const records: { parent: number; firstChild: number; nextSibling: number; tag: number; bytes: Uint8Array }[] = [
      { parent: NO_NODE, firstChild: 1, nextSibling: NO_NODE, tag: TAG_SCOPE, bytes: new TextEncoder().encode("root") },
      { parent: 0, firstChild: NO_NODE, nextSibling: 2, tag: QC_EVENT_TAG.BIDIRECTIONAL_EDGE_ADDED, bytes: concatBytes([u64le(2n), u64le(3n)]) },
      { parent: 0, firstChild: NO_NODE, nextSibling: NO_NODE, tag: QC_EVENT_TAG.POINT_NODES_REPLACED, bytes: pointNodesReplacedPayload },
    ];
    const offsets: number[] = [];
    let cursor = 0;
    for (const r of records) {
      offsets.push(cursor);
      cursor += r.bytes.byteLength;
    }
    const payload = concatBytes(records.map((r) => r.bytes));
    const nodeTable = new Uint8Array(records.length * 22);
    const dv = new DataView(nodeTable.buffer);
    records.forEach((r, i) => {
      const base = i * 22;
      dv.setUint32(base + 0, r.parent, true);
      dv.setUint32(base + 4, r.firstChild, true);
      dv.setUint32(base + 8, r.nextSibling, true);
      dv.setUint16(base + 12, r.tag, true);
      dv.setUint32(base + 14, offsets[i], true);
      dv.setUint32(base + 18, r.bytes.byteLength, true);
    });
    return parseTape(nodeTable, payload);
  }

  it("a node replaced by QC's ReplacePointNodes (AddSplitStrategy) keeps its earlier edges until the replacement step, then the new node takes over (GitHub issue #271)", () => {
    const tape = buildQcPointNodesReplacedArenaTape();
    const arena: DebugArenaHandle = {
      tape, algorithmKind: "quality_control",
      sources: [{ scopeName: "quality_control", kind: "quality_control", nodeIndex: 0, startStep: 0, endStep: 2, checkpointFroms: [] }],
      // Node 3 is gone from the run's final node list — it was replaced by node 20 before the run
      // ended — mirrors the real WASM boundary shape (`snapshot.nodes` = final survivors only).
      nodes: [{ id: 2, x: 0, y: 0, i: 0 }, { id: 20, x: 1, y: 0, i: 0 }],
      // `allNodes` (GitHub issue #271) is the only place node 3's coordinates survive.
      allNodes: [{ id: 3, x: 1, y: 0, i: 0 }, { id: 20, x: 1, y: 0, i: 0 }],
      totalSteps: 2,
      debugValueNames: [],
    };

    // step 0 = BidirectionalEdgeAdded(2,3) applied — node 3 must render with its real edge, not as
    // a stray isolated dot and not simply absent because it's missing from the final `nodes` list.
    const beforeReplace = selectDebugMazeView(arena, 0);
    expect(beforeReplace?.nodes.map((n) => n.id).sort()).toEqual([2, 3]);
    expect(beforeReplace?.edges).toContainEqual({ from: 2, to: 3, kind: "basic" });
    expect(beforeReplace?.edges).toContainEqual({ from: 3, to: 2, kind: "basic" });

    // step 1 = PointNodesReplaced applied — node 3 is gone, node 20 takes over with its own edge.
    const afterReplace = selectDebugMazeView(arena, 1);
    expect(afterReplace?.nodes.map((n) => n.id)).toEqual([2, 20]);
    expect(afterReplace?.edges).toContainEqual({ from: 20, to: 2, kind: "basic" });
    expect(afterReplace?.edges.some((e) => e.from === 3 || e.to === 3)).toBe(false);
  });

  // --- Kruskal dispatch (GitHub issue #146) ---

  it("dispatches Kruskal arenas to applyKruskal, populating edges and dsuGroups", () => {
    const tape = buildKruskalArenaTape();
    const arena: DebugArenaHandle = {
      tape, algorithmKind: "kruskal",
      sources: [{ scopeName: "generation", kind: "kruskal", nodeIndex: 0, startStep: 0, endStep: 2, checkpointFroms: [] }],
      nodes, allNodes: nodes, totalSteps: 2, debugValueNames: [],
    };

    // targetStep 1 = EdgeAdded(1,2), SetsMerged(1,2) both applied.
    const view = selectDebugMazeView(arena, 1);
    expect(view?.edges).toEqual([
      { from: 1, to: 2, kind: "basic" },
      { from: 2, to: 1, kind: "basic" },
    ]);
    expect(view?.dsuGroups).toEqual(new Map([[1, 1], [2, 1]]));
    expect(view?.debugValues.size).toBe(0);
    expect(view?.debugMaps.size).toBe(0);
    expect(view?.debugVertices.size).toBe(0);
  });

  // --- Preset setup dispatch (GitHub issue #225) ---

  it("dispatches preset_setup arenas to applyPresetSetup, populating only edges (no debug values/dsuGroups/start/finish)", () => {
    const tape = buildPresetSetupArenaTape();
    const arena: DebugArenaHandle = {
      tape, algorithmKind: "preset_setup",
      sources: [{ scopeName: "preset_setup", kind: "preset_setup", nodeIndex: 0, startStep: 0, endStep: 2, checkpointFroms: [] }],
      nodes, allNodes: nodes, totalSteps: 2, debugValueNames: [],
    };

    // targetStep 1 = PassageEstablished(1,2) (bidirectional), then OneWayEstablished(3,4) (one direction only).
    const view = selectDebugMazeView(arena, 1);
    expect(view?.edges).toEqual([
      { from: 1, to: 2, kind: "basic" },
      { from: 2, to: 1, kind: "basic" },
      { from: 3, to: 4, kind: "basic" },
    ]);
    expect(view?.start).toBeNull();
    expect(view?.finish).toBeNull();
    expect(view?.debugValues.size).toBe(0);
    expect(view?.dsuGroups).toBeNull();
    expect(view?.debugMaps.size).toBe(0);
    expect(view?.debugVertices.size).toBe(0);
  });
});
