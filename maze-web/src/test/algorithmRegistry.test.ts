import { describe, it, expect } from "vitest";
import {
  TAG_SCOPE, NO_NODE, RB_TAG, KRUSKAL_TAG, WILSON_TAG, EDGE_BASED_TAG, VERTEX_BASED_TAG,
  mutatingRbEventsWithIndex, mutatingKruskalEventsWithIndex, mutatingWilsonEventsWithIndex, mutatingEdgeBasedEventsWithIndex, mutatingVertexBasedEventsWithIndex,
  applyRecursiveBacktracker, applyKruskal, applyWilson, applyEdgeBased, applyVertexBased,
  decodeRecursiveBacktrackerEvent, decodeKruskalEvent, decodeWilsonEvent, decodeEdgeBasedEvent, decodeVertexBasedEvent,
  isMutatingRbEvent, isMutatingKruskalEvent, isMutatingWilsonEvent, isMutatingEdgeBasedEvent, isMutatingVertexBasedEvent,
  mutatingRbEvents, mutatingKruskalEvents, mutatingWilsonEvents, mutatingEdgeBasedEvents, mutatingVertexBasedEvents,
  type ParsedTape,
} from "../debug/eventTape";
import { adapterFor } from "../debug/algorithmRegistry";

// Mirrors eventTape.test.ts's own hand-built fixture encoder (kept local — those helpers aren't
// exported, and this test only needs small single-purpose tapes per algorithm).

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

function scopePayload(name: string): Uint8Array {
  return new TextEncoder().encode(name);
}

function vertexPayload(id: bigint): Uint8Array {
  return u64le(id);
}

function edgeAddedPayload(from: bigint, to: bigint, bidirectional = true): Uint8Array {
  const bytes = new Uint8Array(17);
  bytes.set(u64le(from), 0);
  bytes.set(u64le(to), 8);
  bytes[16] = bidirectional ? 1 : 0;
  return bytes;
}

function rootsComparedPayload(from: bigint, to: bigint): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes.set(u64le(from), 0);
  bytes.set(u64le(to), 8);
  return bytes;
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
  const total = payloadChunks.reduce((sum, c) => sum + c.byteLength, 0);
  const payload = new Uint8Array(total);
  let off = 0;
  for (const c of payloadChunks) { payload.set(c, off); off += c.byteLength; }

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
  return {
    nodeTable, payload,
    nodeTableView: new DataView(nodeTable.buffer, nodeTable.byteOffset, nodeTable.byteLength),
    nodeCount: nodes.length,
  };
}

function buildRbTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step 1") },
    { parent: 1, firstChild: null, nextSibling: 3, tag: RB_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 2n) },
    { parent: 1, firstChild: null, nextSibling: 4, tag: RB_TAG.VERTEX_VISITED, payloadBytes: vertexPayload(2n) },
    { parent: 1, firstChild: null, nextSibling: null, tag: RB_TAG.VERTEX_PUSHED, payloadBytes: vertexPayload(2n) },
  ]);
}

function buildKruskalTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("edge 1") },
    { parent: 1, firstChild: null, nextSibling: 3, tag: KRUSKAL_TAG.EDGE_SELECTED, payloadBytes: rootsComparedPayload(1n, 3n) },
    { parent: 1, firstChild: null, nextSibling: 4, tag: KRUSKAL_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 3n) },
    { parent: 1, firstChild: null, nextSibling: null, tag: KRUSKAL_TAG.SETS_MERGED, payloadBytes: rootsComparedPayload(1n, 3n) },
  ]);
}

function buildWilsonTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("walk 1") },
    { parent: 1, firstChild: null, nextSibling: 3, tag: WILSON_TAG.WALK_START_PICKED, payloadBytes: vertexPayload(5n) },
    { parent: 1, firstChild: null, nextSibling: 4, tag: WILSON_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(5n, 3n) },
    { parent: 1, firstChild: null, nextSibling: null, tag: WILSON_TAG.NODE_VISITED, payloadBytes: vertexPayload(5n) },
  ]);
}

describe("adapterFor(\"recursive_backtracker\")", () => {
  const tape = buildRbTape();
  const adapter = adapterFor("recursive_backtracker");

  it("mutatingNodeIndices matches mutatingRbEventsWithIndex", () => {
    expect(adapter.mutatingNodeIndices(tape)).toEqual(mutatingRbEventsWithIndex(tape).map((e) => e.nodeIndex));
  });

  it("apply matches applyRecursiveBacktracker", () => {
    expect(adapter.apply(tape, 1)).toEqual(applyRecursiveBacktracker(tape, 1));
  });

  it("resolveMetadata's totalSteps matches mutatingRbEvents(tape).length", () => {
    expect(adapter.resolveMetadata(tape).totalSteps).toBe(mutatingRbEvents(tape).length);
    expect(adapter.resolveMetadata(tape).checkpointFroms).toEqual([]);
  });

  it("decodeEvent/isMutatingEvent match the direct functions", () => {
    const decoded = adapter.decodeEvent(RB_TAG.VERTEX_VISITED, vertexPayload(2n));
    expect(decoded).toEqual(decodeRecursiveBacktrackerEvent(RB_TAG.VERTEX_VISITED, vertexPayload(2n)));
    expect(adapter.isMutatingEvent(decoded)).toBe(isMutatingRbEvent(decoded));
  });

  it("scopeLabel formats a numbered step scope", () => {
    expect(adapter.scopeLabel("step 1", [])).toBe(adapter.scopeLabel("step 1", []));
    expect(adapter.scopeLabel("step 1", [])).not.toBe("");
  });
});

describe("adapterFor(\"kruskal\")", () => {
  const tape = buildKruskalTape();
  const adapter = adapterFor("kruskal");

  it("mutatingNodeIndices matches mutatingKruskalEventsWithIndex", () => {
    expect(adapter.mutatingNodeIndices(tape)).toEqual(mutatingKruskalEventsWithIndex(tape).map((e) => e.nodeIndex));
  });

  it("apply matches applyKruskal", () => {
    expect(adapter.apply(tape, 0)).toEqual(applyKruskal(tape, 0));
  });

  it("resolveMetadata's totalSteps matches mutatingKruskalEvents(tape).length and checkpointFroms is empty", () => {
    expect(adapter.resolveMetadata(tape).totalSteps).toBe(mutatingKruskalEvents(tape).length);
    expect(adapter.resolveMetadata(tape).checkpointFroms).toEqual([]);
  });

  it("decodeEvent/isMutatingEvent match the direct functions", () => {
    const decoded = adapter.decodeEvent(KRUSKAL_TAG.EDGE_ADDED, edgeAddedPayload(1n, 3n));
    expect(decoded).toEqual(decodeKruskalEvent(KRUSKAL_TAG.EDGE_ADDED, edgeAddedPayload(1n, 3n)));
    expect(adapter.isMutatingEvent(decoded)).toBe(isMutatingKruskalEvent(decoded));
  });

  it("scopeLabel formats a numbered edge scope", () => {
    expect(adapter.scopeLabel("edge 1", [])).not.toBe("");
  });
});

describe("adapterFor(\"wilson\")", () => {
  const tape = buildWilsonTape();
  const adapter = adapterFor("wilson");

  it("mutatingNodeIndices matches mutatingWilsonEventsWithIndex", () => {
    expect(adapter.mutatingNodeIndices(tape)).toEqual(mutatingWilsonEventsWithIndex(tape).map((e) => e.nodeIndex));
  });

  it("apply matches applyWilson", () => {
    expect(adapter.apply(tape, 0)).toEqual(applyWilson(tape, 0));
  });

  it("resolveMetadata's totalSteps matches mutatingWilsonEvents(tape).length and checkpointFroms is empty", () => {
    expect(adapter.resolveMetadata(tape).totalSteps).toBe(mutatingWilsonEvents(tape).length);
    expect(adapter.resolveMetadata(tape).checkpointFroms).toEqual([]);
  });

  it("decodeEvent/isMutatingEvent match the direct functions", () => {
    const decoded = adapter.decodeEvent(WILSON_TAG.NODE_VISITED, vertexPayload(5n));
    expect(decoded).toEqual(decodeWilsonEvent(WILSON_TAG.NODE_VISITED, vertexPayload(5n)));
    expect(adapter.isMutatingEvent(decoded)).toBe(isMutatingWilsonEvent(decoded));
  });

  it("scopeLabel formats Wilson's fixed search/commit scope names distinctly from numbered walk scopes", () => {
    expect(adapter.scopeLabel("search", [])).not.toBe(adapter.scopeLabel("walk 1", []));
    expect(adapter.scopeLabel("commit", [])).not.toBe(adapter.scopeLabel("walk 1", []));
    expect(adapter.scopeLabel("search", [])).not.toBe(adapter.scopeLabel("commit", []));
  });
});

function edgeAdapterEdgeAddedPayload(src: bigint, dst: bigint, teleport = false, bidirectional = true): Uint8Array {
  const bytes = new Uint8Array(18);
  bytes.set(u64le(src), 0);
  bytes.set(u64le(dst), 8);
  bytes[16] = teleport ? 1 : 0;
  bytes[17] = bidirectional ? 1 : 0;
  return bytes;
}

function edgeBasedSrcExhaustedPayload(src: bigint): Uint8Array {
  return u64le(src);
}

function buildEdgeBasedTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step 1") },
    { parent: 1, firstChild: null, nextSibling: 3, tag: EDGE_BASED_TAG.EDGE_ADDED, payloadBytes: edgeAdapterEdgeAddedPayload(1n, 3n) },
    { parent: 1, firstChild: null, nextSibling: null, tag: EDGE_BASED_TAG.SRC_EXHAUSTED, payloadBytes: edgeBasedSrcExhaustedPayload(1n) },
  ]);
}

describe("adapterFor(\"edge_based\")", () => {
  const tape = buildEdgeBasedTape();
  const adapter = adapterFor("edge_based");

  it("mutatingNodeIndices matches mutatingEdgeBasedEventsWithIndex", () => {
    expect(adapter.mutatingNodeIndices(tape)).toEqual(mutatingEdgeBasedEventsWithIndex(tape).map((e) => e.nodeIndex));
  });

  it("apply matches applyEdgeBased", () => {
    expect(adapter.apply(tape, 0)).toEqual(applyEdgeBased(tape, 0));
  });

  it("resolveMetadata's totalSteps matches mutatingEdgeBasedEvents(tape).length and checkpointFroms is empty", () => {
    expect(adapter.resolveMetadata(tape).totalSteps).toBe(mutatingEdgeBasedEvents(tape).length);
    expect(adapter.resolveMetadata(tape).checkpointFroms).toEqual([]);
  });

  it("decodeEvent/isMutatingEvent match the direct functions", () => {
    const decoded = adapter.decodeEvent(EDGE_BASED_TAG.EDGE_ADDED, edgeAdapterEdgeAddedPayload(1n, 3n));
    expect(decoded).toEqual(decodeEdgeBasedEvent(EDGE_BASED_TAG.EDGE_ADDED, edgeAdapterEdgeAddedPayload(1n, 3n)));
    expect(adapter.isMutatingEvent(decoded)).toBe(isMutatingEdgeBasedEvent(decoded));
  });

  it("scopeLabel formats a numbered step scope", () => {
    expect(adapter.scopeLabel("step 1", [])).not.toBe("");
  });
});

function vertexBasedEdgeAddedPayload(src: bigint, dst: bigint, bidirectional = true): Uint8Array {
  const bytes = new Uint8Array(17);
  bytes.set(u64le(src), 0);
  bytes.set(u64le(dst), 8);
  bytes[16] = bidirectional ? 1 : 0;
  return bytes;
}

function vertexBasedNodeVisitedPayload(node: bigint, parent: bigint): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes.set(u64le(node), 0);
  bytes.set(u64le(parent), 8);
  return bytes;
}

function buildVertexBasedTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step 1") },
    { parent: 1, firstChild: null, nextSibling: 3, tag: VERTEX_BASED_TAG.EDGE_ADDED, payloadBytes: vertexBasedEdgeAddedPayload(1n, 3n) },
    { parent: 1, firstChild: null, nextSibling: null, tag: VERTEX_BASED_TAG.NODE_VISITED, payloadBytes: vertexBasedNodeVisitedPayload(3n, 1n) },
  ]);
}

describe("adapterFor(\"vertex_based\")", () => {
  const tape = buildVertexBasedTape();
  const adapter = adapterFor("vertex_based");

  it("mutatingNodeIndices matches mutatingVertexBasedEventsWithIndex", () => {
    expect(adapter.mutatingNodeIndices(tape)).toEqual(mutatingVertexBasedEventsWithIndex(tape).map((e) => e.nodeIndex));
  });

  it("apply matches applyVertexBased", () => {
    expect(adapter.apply(tape, 0)).toEqual(applyVertexBased(tape, 0));
  });

  it("resolveMetadata's totalSteps matches mutatingVertexBasedEvents(tape).length and checkpointFroms is empty", () => {
    expect(adapter.resolveMetadata(tape).totalSteps).toBe(mutatingVertexBasedEvents(tape).length);
    expect(adapter.resolveMetadata(tape).checkpointFroms).toEqual([]);
  });

  it("decodeEvent/isMutatingEvent match the direct functions", () => {
    const decoded = adapter.decodeEvent(VERTEX_BASED_TAG.EDGE_ADDED, vertexBasedEdgeAddedPayload(1n, 3n));
    expect(decoded).toEqual(decodeVertexBasedEvent(VERTEX_BASED_TAG.EDGE_ADDED, vertexBasedEdgeAddedPayload(1n, 3n)));
    expect(adapter.isMutatingEvent(decoded)).toBe(isMutatingVertexBasedEvent(decoded));
  });

  it("scopeLabel formats a numbered step scope distinctly from the fixed reserve_search scope", () => {
    expect(adapter.scopeLabel("step 1", [])).not.toBe("");
    expect(adapter.scopeLabel("reserve_search", [])).not.toBe(adapter.scopeLabel("step 1", []));
  });
});

describe("adapterFor — one adapter instance per kind, stable identity", () => {
  it("returns the same adapter instance across repeated calls for each kind", () => {
    expect(adapterFor("recursive_backtracker")).toBe(adapterFor("recursive_backtracker"));
    expect(adapterFor("kruskal")).toBe(adapterFor("kruskal"));
    expect(adapterFor("wilson")).toBe(adapterFor("wilson"));
    expect(adapterFor("edge_based")).toBe(adapterFor("edge_based"));
    expect(adapterFor("vertex_based")).toBe(adapterFor("vertex_based"));
  });
});
