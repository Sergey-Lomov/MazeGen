import { describe, it, expect } from "vitest";
import { parseTape, TAG_SCOPE, NO_NODE, RB_TAG, KRUSKAL_TAG, WILSON_TAG, EDGE_BASED_TAG, VERTEX_BASED_TAG, type ParsedTape } from "../debug/eventTape";
import {
  buildStepIndex, stepForNode, nodeIndexForStep, flattenVisibleRows, resolveHighlightTarget,
  buildNodeCoordIndex, displayStepForRow,
} from "../debug/debugTreeSelectors";
import type { NodeDto } from "../wasm/types";

// --- Hand-built fixture encoder, mirroring `eventTape.test.ts`'s own (kept local per that file's
// "wynieś to shared test-util if duplication gets annoying" fallback — small enough not to yet).

interface FixtureNode {
  parent: number | null;
  firstChild: number | null;
  nextSibling: number | null;
  tag: number;
  payloadBytes: Uint8Array;
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

function scopePayload(name: string): Uint8Array {
  return new TextEncoder().encode(name);
}

function edgeAddedPayload(from: bigint, to: bigint): Uint8Array {
  // bidirectional=true (GitHub issue #135) — payload shape unused by this file's selectors
  // (they classify by tag only), kept accurate anyway so this stays a correct wire-format mirror.
  return concatBytes([u64le(from), u64le(to), new Uint8Array([1])]);
}

function vertexPayload(id: bigint): Uint8Array {
  return u64le(id);
}

function buildFixture(nodes: FixtureNode[]): ParsedTape {
  const payloadChunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let cursor = 0;
  for (const n of nodes) {
    offsets.push(cursor);
    payloadChunks.push(n.payloadBytes);
    cursor += n.payloadBytes.byteLength;
  }
  const payload = concatBytes(payloadChunks);

  const nodeTable = new Uint8Array(nodes.length * 22);
  const dv = new DataView(nodeTable.buffer);
  nodes.forEach((n, i) => {
    const base = i * 22;
    dv.setUint32(base + 0, n.parent ?? NO_NODE, true);
    dv.setUint32(base + 4, n.firstChild ?? NO_NODE, true);
    dv.setUint32(base + 8, n.nextSibling ?? NO_NODE, true);
    dv.setUint16(base + 12, n.tag, true);
    dv.setUint32(base + 14, offsets[i], true);
    dv.setUint32(base + 18, n.payloadBytes.byteLength, true);
  });

  return parseTape(nodeTable, payload);
}

// Same shape as `eventTape.test.ts`'s `buildTwoStepTape`:
//   root (0)
//     -> "step" scope (1) -> EdgeAdded(1,2) (2) -> VertexVisited(2) (3) -> VertexPushed(2) (4)
//     -> "step" scope (5) -> DeadEnd (6) -> VertexPopped(2) (7)
// One connecting step (3 mutating events: EdgeAdded, VertexVisited, VertexPushed) followed by
// one dead-end step (1 mutating event: VertexPopped) — forces both branches without RNG.
function buildTwoStepTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: 5, tag: TAG_SCOPE, payloadBytes: scopePayload("step") },
    { parent: 1, firstChild: null, nextSibling: 3, tag: RB_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 2n) },
    { parent: 1, firstChild: null, nextSibling: 4, tag: RB_TAG.VERTEX_VISITED, payloadBytes: vertexPayload(2n) },
    { parent: 1, firstChild: null, nextSibling: null, tag: RB_TAG.VERTEX_PUSHED, payloadBytes: vertexPayload(2n) },
    { parent: 0, firstChild: 6, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step") },
    { parent: 5, firstChild: null, nextSibling: 7, tag: RB_TAG.DEAD_END, payloadBytes: new Uint8Array(0) },
    { parent: 5, firstChild: null, nextSibling: null, tag: RB_TAG.VERTEX_POPPED, payloadBytes: vertexPayload(2n) },
  ]);
}

// Kruskal fixture, mirroring eventTape.test.ts's buildKruskalTape shape:
//   root (0)
//     -> "edge 1" scope (1) -> EdgeSelected (2) -> EdgeAdded(1,3) (3) -> SetsMerged (4)
//     -> "edge 2" scope (5) -> EdgeSelected (6) -> EdgeRejected (7)
// One connecting edge (2 mutating events: EdgeAdded, SetsMerged) followed by one rejected edge
// (0 mutating events) — exercises buildStepIndex's "kruskal" branch (GitHub issue #146).
function buildTwoEdgeKruskalTape(): ParsedTape {
  const rootsPayload = concatBytes([u64le(1n), u64le(3n)]);
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: 5, tag: TAG_SCOPE, payloadBytes: scopePayload("edge 1") },
    { parent: 1, firstChild: null, nextSibling: 3, tag: KRUSKAL_TAG.EDGE_SELECTED, payloadBytes: rootsPayload },
    { parent: 1, firstChild: null, nextSibling: 4, tag: KRUSKAL_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 3n) },
    { parent: 1, firstChild: null, nextSibling: null, tag: KRUSKAL_TAG.SETS_MERGED, payloadBytes: rootsPayload },
    { parent: 0, firstChild: 6, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("edge 2") },
    { parent: 5, firstChild: null, nextSibling: 7, tag: KRUSKAL_TAG.EDGE_SELECTED, payloadBytes: rootsPayload },
    { parent: 5, firstChild: null, nextSibling: null, tag: KRUSKAL_TAG.EDGE_REJECTED, payloadBytes: new Uint8Array(0) },
  ]);
}

// Wilson fixture, mirroring eventTape.test.ts's buildWilsonTape shape (two-level "walk N" >
// "step M" nesting):
//   root (0)
//     -> "walk 1" scope (1)
//          -> WalkStartPicked(5) (2)
//          -> "step 1" scope (3) -> StepTaken(5,3) (4)
//          -> EdgeAdded(5,3) (5) -> NodeVisited(5) (6)
// 4 mutating events (WalkStartPicked, StepTaken, EdgeAdded, NodeVisited) nested two scope-levels
// deep — exercises buildStepIndex's "wilson" branch (GitHub issue #145) and confirms it isn't
// thrown off by the extra nesting level Kruskal/RB don't have.
function buildOneWalkWilsonTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("walk 1") },
    { parent: 1, firstChild: null, nextSibling: 3, tag: WILSON_TAG.WALK_START_PICKED, payloadBytes: vertexPayload(5n) },
    { parent: 1, firstChild: 4, nextSibling: 5, tag: TAG_SCOPE, payloadBytes: scopePayload("step 1") },
    { parent: 3, firstChild: null, nextSibling: null, tag: WILSON_TAG.STEP_TAKEN, payloadBytes: concatBytes([u64le(5n), u64le(3n)]) },
    { parent: 1, firstChild: null, nextSibling: 6, tag: WILSON_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(5n, 3n) },
    { parent: 1, firstChild: null, nextSibling: null, tag: WILSON_TAG.NODE_VISITED, payloadBytes: vertexPayload(5n) },
  ]);
}

describe("buildStepIndex — wilson dispatch (GitHub issue #145)", () => {
  it("dispatches to the Wilson mutating-event scan, distinct from the recursive_backtracker/kruskal ones", () => {
    const tape = buildOneWalkWilsonTape();
    const { stepToNodeIndex, nearestStepByNodeIndex } = buildStepIndex(tape, [{ kind: "wilson", nodeIndex: 0 }]);

    // 4 mutating events in emission order: WalkStartPicked(2), StepTaken(4), EdgeAdded(5),
    // NodeVisited(6) — WalkStartPicked/StepTaken are mutating too (they change the walk's `next`
    // map — see WilsonEvent::is_mutating's doc comment), only WalkDeadEnd would be trace-only.
    expect(stepToNodeIndex).toEqual([2, 4, 5, 6]);
    expect(nearestStepByNodeIndex).toEqual([0, 0, 0, 0, 1, 2, 3]);
  });
});

// CustomEdgeBased fixture (GitHub issue #144) — one flat "step 1" scope, mirroring Kruskal's
// flat shape but with a trace event (CorridorRollSkipped) preceding the two mutating ones:
//   root (0)
//     -> "step 1" scope (1)
//          -> CorridorRollSkipped (2, trace-only)
//          -> EdgeAdded(1,3) (3)
//          -> NodeActivated(3, parent=1) (4)
function edgeBasedEdgeAddedPayload(src: bigint, dst: bigint, teleport = false, bidirectional = true): Uint8Array {
  return concatBytes([u64le(src), u64le(dst), new Uint8Array([teleport ? 1 : 0]), new Uint8Array([bidirectional ? 1 : 0])]);
}

function buildOneStepEdgeBasedTape(): ParsedTape {
  const nodeActivatedPayload = concatBytes([u64le(3n), new Uint8Array([1]), u64le(1n), new Uint8Array([0, 0, 0, 0])]);
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step 1") },
    { parent: 1, firstChild: null, nextSibling: 3, tag: EDGE_BASED_TAG.CORRIDOR_ROLL_SKIPPED, payloadBytes: new Uint8Array(0) },
    { parent: 1, firstChild: null, nextSibling: 4, tag: EDGE_BASED_TAG.EDGE_ADDED, payloadBytes: edgeBasedEdgeAddedPayload(1n, 3n) },
    { parent: 1, firstChild: null, nextSibling: null, tag: EDGE_BASED_TAG.NODE_ACTIVATED, payloadBytes: nodeActivatedPayload },
  ]);
}

describe("buildStepIndex — edge_based dispatch (GitHub issue #144)", () => {
  it("dispatches to the CustomEdgeBased mutating-event scan, skipping the trace-only CorridorRollSkipped", () => {
    const tape = buildOneStepEdgeBasedTape();
    const { stepToNodeIndex, nearestStepByNodeIndex } = buildStepIndex(tape, [{ kind: "edge_based", nodeIndex: 0 }]);

    expect(stepToNodeIndex).toEqual([3, 4]);
    expect(nearestStepByNodeIndex).toEqual([0, 0, 0, 0, 1]);
  });
});

// CustomVertexBased fixture (GitHub issue #143) — one flat "step 1" scope, mirroring EdgeBased's
// flat shape but with a trace event (TeleportRolled) preceding the two mutating ones:
//   root (0)
//     -> "step 1" scope (1)
//          -> TeleportRolled (2, trace-only)
//          -> EdgeAdded(1,3) (3)
//          -> NodeVisited(3, parent=1) (4)
function vertexBasedEdgeAddedPayload(src: bigint, dst: bigint, bidirectional = true): Uint8Array {
  return concatBytes([u64le(src), u64le(dst), new Uint8Array([bidirectional ? 1 : 0])]);
}

function buildOneStepVertexBasedTape(): ParsedTape {
  const teleportRolledPayload = concatBytes([u64le(1n), new Uint8Array(8), new Uint8Array(8), new Uint8Array([0])]);
  const nodeVisitedPayload = concatBytes([u64le(3n), u64le(1n)]);
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step 1") },
    { parent: 1, firstChild: null, nextSibling: 3, tag: VERTEX_BASED_TAG.TELEPORT_ROLLED, payloadBytes: teleportRolledPayload },
    { parent: 1, firstChild: null, nextSibling: 4, tag: VERTEX_BASED_TAG.EDGE_ADDED, payloadBytes: vertexBasedEdgeAddedPayload(1n, 3n) },
    { parent: 1, firstChild: null, nextSibling: null, tag: VERTEX_BASED_TAG.NODE_VISITED, payloadBytes: nodeVisitedPayload },
  ]);
}

describe("buildStepIndex — vertex_based dispatch (GitHub issue #143)", () => {
  it("dispatches to the CustomVertexBased mutating-event scan, skipping the trace-only TeleportRolled", () => {
    const tape = buildOneStepVertexBasedTape();
    const { stepToNodeIndex, nearestStepByNodeIndex } = buildStepIndex(tape, [{ kind: "vertex_based", nodeIndex: 0 }]);

    expect(stepToNodeIndex).toEqual([3, 4]);
    expect(nearestStepByNodeIndex).toEqual([0, 0, 0, 0, 1]);
  });
});

describe("buildStepIndex — kruskal dispatch (GitHub issue #146)", () => {
  it("dispatches to the Kruskal mutating-event scan, distinct from the recursive_backtracker one", () => {
    const tape = buildTwoEdgeKruskalTape();
    const { stepToNodeIndex, nearestStepByNodeIndex } = buildStepIndex(tape, [{ kind: "kruskal", nodeIndex: 0 }]);

    // 2 mutating events in emission order: EdgeAdded(3), SetsMerged(4). EdgeRejected (node 7) is
    // trace-only and must not appear.
    expect(stepToNodeIndex).toEqual([3, 4]);
    expect(nearestStepByNodeIndex).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });

  it("does not throw for a Kruskal tape with zero mutating events (every edge rejected)", () => {
    const tape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("edge 1") },
      { parent: 1, firstChild: null, nextSibling: 2, tag: KRUSKAL_TAG.EDGE_SELECTED, payloadBytes: concatBytes([u64le(1n), u64le(2n)]) },
      { parent: 1, firstChild: null, nextSibling: null, tag: KRUSKAL_TAG.EDGE_REJECTED, payloadBytes: new Uint8Array(0) },
    ]);
    const stepIndex = buildStepIndex(tape, [{ kind: "kruskal", nodeIndex: 0 }]);
    expect(stepIndex.stepToNodeIndex).toEqual([]);
    expect(() => stepForNode(stepIndex, 2)).not.toThrow();
  });
});

describe("buildStepIndex — exact sequence", () => {
  it("produces the exact stepToNodeIndex/nearestStepByNodeIndex for the two-step fixture", () => {
    const tape = buildTwoStepTape();
    const { stepToNodeIndex, nearestStepByNodeIndex } = buildStepIndex(tape, [{ kind: "recursive_backtracker", nodeIndex: 0 }]);

    // 4 mutating events in emission order: EdgeAdded(2), VertexVisited(3), VertexPushed(4), VertexPopped(7)
    expect(stepToNodeIndex).toEqual([2, 3, 4, 7]);

    // Per arena index: 0=root(pre-mutating,clamp0) 1=step-scope(clamp0) 2=EdgeAdded(step0)
    // 3=VertexVisited(step1) 4=VertexPushed(step2) 5=step-scope(still step2) 6=DeadEnd(still step2)
    // 7=VertexPopped(step3)
    expect(nearestStepByNodeIndex).toEqual([0, 0, 0, 1, 2, 2, 2, 3]);
  });
});

describe("buildStepIndex / stepForNode / nodeIndexForStep invariants", () => {
  it("stepForNode is monotonic non-decreasing over arena order and never throws", () => {
    const tape = buildTwoStepTape();
    const stepIndex = buildStepIndex(tape, [{ kind: "recursive_backtracker", nodeIndex: 0 }]);
    let prev = 0;
    for (let i = 0; i < tape.nodeCount; i++) {
      const step = stepForNode(stepIndex, i);
      expect(step).toBeGreaterThanOrEqual(0);
      if (i > 0) expect(step).toBeGreaterThanOrEqual(prev);
      prev = step;
    }
  });

  it("nodeIndexForStep round-trips through buildStepIndex for every valid step", () => {
    const tape = buildTwoStepTape();
    const stepIndex = buildStepIndex(tape, [{ kind: "recursive_backtracker", nodeIndex: 0 }]);
    const totalSteps = stepIndex.stepToNodeIndex.length;
    for (let step = 0; step < totalSteps; step++) {
      const nodeIndex = nodeIndexForStep(stepIndex, step);
      expect(stepForNode(stepIndex, nodeIndex)).toBe(step);
    }
  });

  it("does not throw building the index for a tape with zero mutating events", () => {
    const tape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step") },
      { parent: 1, firstChild: null, nextSibling: 3, tag: RB_TAG.VERTEX_SELECTED, payloadBytes: vertexPayload(1n) },
      { parent: 1, firstChild: null, nextSibling: null, tag: RB_TAG.DEAD_END, payloadBytes: new Uint8Array(0) },
    ]);
    const stepIndex = buildStepIndex(tape, [{ kind: "recursive_backtracker", nodeIndex: 0 }]);
    expect(stepIndex.stepToNodeIndex).toEqual([]);
    expect(() => stepForNode(stepIndex, 2)).not.toThrow();
    expect(stepForNode(stepIndex, 2)).toBe(0);
  });
});

describe("flattenVisibleRows", () => {
  it("with empty expanded returns exactly the top-level step scopes, root excluded", () => {
    const tape = buildTwoStepTape();
    const rows = flattenVisibleRows(tape, new Set());
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.nodeIndex)).toEqual([1, 5]);
    expect(rows.every((r) => r.depth === 1)).toBe(true);
    expect(rows.every((r) => r.payload.kind === "scope")).toBe(true);
  });

  it("expanding one scope adds exactly its direct children, not grandchildren", () => {
    const tape = buildTwoStepTape();
    const rows = flattenVisibleRows(tape, new Set([1]));
    expect(rows.map((r) => r.nodeIndex)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.find((r) => r.nodeIndex === 2)?.depth).toBe(2);
  });

  it("collapsing a previously expanded scope removes its children again", () => {
    const tape = buildTwoStepTape();
    const expandedRows = flattenVisibleRows(tape, new Set([1]));
    expect(expandedRows).toHaveLength(5);
    const collapsedRows = flattenVisibleRows(tape, new Set());
    expect(collapsedRows.map((r) => r.nodeIndex)).toEqual([1, 5]);
  });

  it("expands a nested scope (depth 3+) only when its own ancestor chain is expanded", () => {
    // root (0) -> "step" scope (1) -> "roll" scope (2) -> VertexSelected (3)
    const tape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step") },
      { parent: 1, firstChild: 3, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("roll") },
      { parent: 2, firstChild: null, nextSibling: null, tag: RB_TAG.VERTEX_SELECTED, payloadBytes: vertexPayload(1n) },
    ]);

    // Only top-level expanded: nested "roll" scope's child stays hidden.
    const oneLevel = flattenVisibleRows(tape, new Set([1]));
    expect(oneLevel.map((r) => r.nodeIndex)).toEqual([1, 2]);

    // Both ancestors expanded: the depth-3 leaf becomes visible.
    const twoLevels = flattenVisibleRows(tape, new Set([1, 2]));
    expect(twoLevels.map((r) => r.nodeIndex)).toEqual([1, 2, 3]);
    expect(twoLevels.find((r) => r.nodeIndex === 3)?.depth).toBe(3);
  });
});

describe("resolveHighlightTarget", () => {
  it("returns the exact node when its row is visible", () => {
    const tape = buildTwoStepTape();
    const stepIndex = buildStepIndex(tape, [{ kind: "recursive_backtracker", nodeIndex: 0 }]);
    const rows = flattenVisibleRows(tape, new Set([1]));
    const rowIndexByNodeIndex = new Map(rows.map((r, i) => [r.nodeIndex, i]));

    const target = resolveHighlightTarget(tape, stepIndex, 0, rowIndexByNodeIndex, 0); // step 0 -> nodeIndex 2 (EdgeAdded)
    expect(target).toBe(2);
  });

  it("walks up to the nearest visible ancestor when the target's scope is collapsed", () => {
    const tape = buildTwoStepTape();
    const stepIndex = buildStepIndex(tape, [{ kind: "recursive_backtracker", nodeIndex: 0 }]);
    const rows = flattenVisibleRows(tape, new Set()); // fully collapsed
    const rowIndexByNodeIndex = new Map(rows.map((r, i) => [r.nodeIndex, i]));

    const target = resolveHighlightTarget(tape, stepIndex, 0, rowIndexByNodeIndex, 0); // nodeIndex 2, invisible
    expect(target).toBe(1); // its top-level step scope, which is visible
    expect(rowIndexByNodeIndex.has(target)).toBe(true);
  });

  it("throws instead of returning null when no visible ancestor exists at all", () => {
    const tape = buildTwoStepTape();
    const stepIndex = buildStepIndex(tape, [{ kind: "recursive_backtracker", nodeIndex: 0 }]);
    // Deliberately broken map — contract violation (should always contain every top-level scope,
    // see flattenVisibleRows), exercised here to pin down the fail-loud behavior fixed after review.
    const emptyMap = new Map<number, number>();

    expect(() => resolveHighlightTarget(tape, stepIndex, 0, emptyMap, 0)).toThrow(/no visible ancestor/);
  });

  it("falls back to fallbackNodeIndex when stepToNodeIndex is empty (GitHub issue #173 — zero mutating events)", () => {
    // root (0) -> "quality_control" scope (1) -> IterationStarted (2, trace-only, not mutating)
    const tape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("quality_control") },
      { parent: 1, firstChild: null, nextSibling: null, tag: 1 /* trace-only tag, not RB's EDGE_ADDED */, payloadBytes: new Uint8Array(4) },
    ]);
    const stepIndex = buildStepIndex(tape, [{ kind: "quality_control", nodeIndex: 1 }]);
    expect(stepIndex.stepToNodeIndex).toHaveLength(0);

    const rows = flattenVisibleRows(tape, new Set([1]));
    const rowIndexByNodeIndex = new Map(rows.map((r, i) => [r.nodeIndex, i]));
    expect(rowIndexByNodeIndex.has(1)).toBe(true);

    const target = resolveHighlightTarget(tape, stepIndex, 0, rowIndexByNodeIndex, 1);
    expect(target).toBe(1);
  });
});

describe("displayStepForRow (GitHub issue #166)", () => {
  it("shows the nearest preceding mutating step for a trace-only leaf, not a dash", () => {
    const tape = buildOneStepEdgeBasedTape();
    const stepIndex = buildStepIndex(tape, [{ kind: "edge_based", nodeIndex: 0 }]);
    const rows = flattenVisibleRows(tape, new Set([1]));

    // node 2 = CorridorRollSkipped, trace-only, precedes both mutating events -> nearest step 0
    const traceRow = rows.find((r) => r.nodeIndex === 2)!;
    expect(displayStepForRow(tape, stepIndex, traceRow)).toBe(0);

    // node 3 = EdgeAdded itself, mutating -> its own step 0
    const mutatingRow = rows.find((r) => r.nodeIndex === 3)!;
    expect(displayStepForRow(tape, stepIndex, mutatingRow)).toBe(0);

    // node 4 = NodeActivated, mutating -> its own step 1
    const secondMutatingRow = rows.find((r) => r.nodeIndex === 4)!;
    expect(displayStepForRow(tape, stepIndex, secondMutatingRow)).toBe(1);
  });
});

describe("buildNodeCoordIndex", () => {
  it("joins bigint node ids to (x, y) without narrowing to number", () => {
    const nodes: NodeDto[] = [
      { id: 1, x: 0, y: 0 },
      { id: 2, x: 3, y: 4 },
    ];
    const index = buildNodeCoordIndex(nodes);
    expect(index.get(2n)).toEqual({ x: 3, y: 4 });
    expect(index.get(99n)).toBeNull();
  });
});
