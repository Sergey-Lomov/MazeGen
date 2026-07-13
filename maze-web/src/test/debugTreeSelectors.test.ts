import { describe, it, expect } from "vitest";
import { parseTape, TAG_SCOPE, NO_NODE, RB_TAG, type ParsedTape } from "../debug/eventTape";
import {
  buildStepIndex, stepForNode, nodeIndexForStep, flattenVisibleRows, resolveHighlightTarget,
  buildNodeCoordIndex,
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

describe("buildStepIndex — exact sequence", () => {
  it("produces the exact stepToNodeIndex/nearestStepByNodeIndex for the two-step fixture", () => {
    const tape = buildTwoStepTape();
    const { stepToNodeIndex, nearestStepByNodeIndex } = buildStepIndex(tape);

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
    const stepIndex = buildStepIndex(tape);
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
    const stepIndex = buildStepIndex(tape);
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
    const stepIndex = buildStepIndex(tape);
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
    const stepIndex = buildStepIndex(tape);
    const rows = flattenVisibleRows(tape, new Set([1]));
    const rowIndexByNodeIndex = new Map(rows.map((r, i) => [r.nodeIndex, i]));

    const target = resolveHighlightTarget(tape, stepIndex, 0, rowIndexByNodeIndex); // step 0 -> nodeIndex 2 (EdgeAdded)
    expect(target).toBe(2);
  });

  it("walks up to the nearest visible ancestor when the target's scope is collapsed", () => {
    const tape = buildTwoStepTape();
    const stepIndex = buildStepIndex(tape);
    const rows = flattenVisibleRows(tape, new Set()); // fully collapsed
    const rowIndexByNodeIndex = new Map(rows.map((r, i) => [r.nodeIndex, i]));

    const target = resolveHighlightTarget(tape, stepIndex, 0, rowIndexByNodeIndex); // nodeIndex 2, invisible
    expect(target).toBe(1); // its top-level step scope, which is visible
    expect(rowIndexByNodeIndex.has(target)).toBe(true);
  });

  it("throws instead of returning null when no visible ancestor exists at all", () => {
    const tape = buildTwoStepTape();
    const stepIndex = buildStepIndex(tape);
    // Deliberately broken map — contract violation (should always contain every top-level scope,
    // see flattenVisibleRows), exercised here to pin down the fail-loud behavior fixed after review.
    const emptyMap = new Map<number, number>();

    expect(() => resolveHighlightTarget(tape, stepIndex, 0, emptyMap)).toThrow(/no visible ancestor/);
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
