import { describe, it, expect } from "vitest";
import {
  TAG_SCOPE, NO_NODE, RECURSIVE_BACKTRACKER_EVENT_TAG, KRUSKAL_EVENT_TAG, WILSON_EVENT_TAG, VERTEX_BASED_EVENT_TAG, PRESET_SETUP_EVENT_TAG,
  mutatingRbEventsWithIndex, mutatingKruskalEventsWithIndex, mutatingWilsonEventsWithIndex, mutatingVertexBasedEventsWithIndex, mutatingPresetSetupEventsWithIndex,
  applyRecursiveBacktracker, applyKruskal, applyWilson, applyVertexBased, applyPresetSetup,
  decodeRecursiveBacktrackerEvent, decodeKruskalEvent, decodeWilsonEvent, decodeVertexBasedEvent, decodePresetSetupEvent,
  isMutatingRecursiveBacktrackerEvent, isMutatingKruskalEvent, isMutatingWilsonEvent, isMutatingVertexBasedEvent, isMutatingPresetSetupEvent,
  mutatingRbEvents, mutatingKruskalEvents, mutatingWilsonEvents, mutatingVertexBasedEvents, mutatingPresetSetupEvents,
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
    { parent: 1, firstChild: null, nextSibling: 3, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 2n) },
    { parent: 1, firstChild: null, nextSibling: 4, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.VERTEX_VISITED, payloadBytes: vertexPayload(2n) },
    { parent: 1, firstChild: null, nextSibling: null, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.VERTEX_PUSHED, payloadBytes: vertexPayload(2n) },
  ]);
}

function buildKruskalTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("edge 1") },
    { parent: 1, firstChild: null, nextSibling: 3, tag: KRUSKAL_EVENT_TAG.EDGE_SELECTED, payloadBytes: rootsComparedPayload(1n, 3n) },
    { parent: 1, firstChild: null, nextSibling: 4, tag: KRUSKAL_EVENT_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 3n) },
    { parent: 1, firstChild: null, nextSibling: null, tag: KRUSKAL_EVENT_TAG.SETS_MERGED, payloadBytes: rootsComparedPayload(1n, 3n) },
  ]);
}

function buildWilsonTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("walk 1") },
    { parent: 1, firstChild: null, nextSibling: 3, tag: WILSON_EVENT_TAG.WALK_START_PICKED, payloadBytes: vertexPayload(5n) },
    { parent: 1, firstChild: null, nextSibling: 4, tag: WILSON_EVENT_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(5n, 3n) },
    { parent: 1, firstChild: null, nextSibling: null, tag: WILSON_EVENT_TAG.NODE_VISITED, payloadBytes: vertexPayload(5n) },
  ]);
}

function passagePayload(from: bigint, to: bigint): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes.set(u64le(from), 0);
  bytes.set(u64le(to), 8);
  return bytes;
}

function buildPresetSetupTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("preset_setup") },
    { parent: 1, firstChild: null, nextSibling: 3, tag: PRESET_SETUP_EVENT_TAG.PASSAGE_ESTABLISHED, payloadBytes: passagePayload(1n, 2n) },
    { parent: 1, firstChild: null, nextSibling: null, tag: PRESET_SETUP_EVENT_TAG.ONE_WAY_ESTABLISHED, payloadBytes: passagePayload(3n, 4n) },
  ]);
}

describe("adapterFor(\"preset_setup\")", () => {
  const tape = buildPresetSetupTape();
  const adapter = adapterFor("preset_setup");

  it("mutatingNodeIndices matches mutatingPresetSetupEventsWithIndex", () => {
    expect(adapter.mutatingNodeIndices(tape)).toEqual(mutatingPresetSetupEventsWithIndex(tape).map((e) => e.nodeIndex));
  });

  it("apply matches applyPresetSetup", () => {
    expect(adapter.apply(tape, 1, undefined, 0)).toEqual(applyPresetSetup(tape, 1, undefined, 0));
  });

  it("resolveMetadata's totalSteps matches mutatingPresetSetupEvents(tape).length", () => {
    expect(adapter.resolveMetadata(tape).totalSteps).toBe(mutatingPresetSetupEvents(tape).length);
    expect(adapter.resolveMetadata(tape).checkpointFroms).toEqual([]);
  });

  it("decodeEvent/isMutatingEvent match the direct functions", () => {
    const decoded = adapter.decodeEvent(PRESET_SETUP_EVENT_TAG.PASSAGE_ESTABLISHED, passagePayload(1n, 2n));
    expect(decoded).toEqual(decodePresetSetupEvent(PRESET_SETUP_EVENT_TAG.PASSAGE_ESTABLISHED, passagePayload(1n, 2n)));
    expect(adapter.isMutatingEvent(decoded)).toBe(isMutatingPresetSetupEvent(decoded));
  });

  it("scopeLabel is the identity function (this source never opens a nested scope)", () => {
    expect(adapter.scopeLabel("preset_setup", [])).toBe("preset_setup");
  });

  it("narrationTokensFor renders an edge token per event kind, with the right bidirectional flag", () => {
    const passage = adapter.narrationTokensFor({ kind: "PassageEstablished", from: 1n, to: 2n });
    expect(passage).toEqual([
      { kind: "text", text: expect.any(String) },
      { kind: "edge", from: 1n, to: 2n, bidirectional: true },
    ]);

    const oneWay = adapter.narrationTokensFor({ kind: "OneWayEstablished", from: 3n, to: 4n });
    expect(oneWay).toEqual([
      { kind: "text", text: expect.any(String) },
      { kind: "edge", from: 3n, to: 4n, bidirectional: false },
    ]);

    const teleportOneWay = adapter.narrationTokensFor({ kind: "TeleportEstablished", from: 5n, to: 6n, twoWay: false });
    expect(teleportOneWay).toEqual([
      { kind: "text", text: expect.any(String) },
      { kind: "edge", from: 5n, to: 6n, bidirectional: false },
    ]);

    const teleportTwoWay = adapter.narrationTokensFor({ kind: "TeleportEstablished", from: 5n, to: 6n, twoWay: true });
    expect(teleportTwoWay).toEqual([
      { kind: "text", text: expect.any(String) },
      { kind: "edge", from: 5n, to: 6n, bidirectional: true },
    ]);

    // Every event kind gets distinct narration text (guards against a copy-paste that reuses one
    // message key for two different connection kinds).
    const texts = [passage[0], oneWay[0], teleportOneWay[0]].map((t) => (t.kind === "text" ? t.text : ""));
    expect(new Set(texts).size).toBe(texts.length);
  });
});

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
    const decoded = adapter.decodeEvent(RECURSIVE_BACKTRACKER_EVENT_TAG.VERTEX_VISITED, vertexPayload(2n));
    expect(decoded).toEqual(decodeRecursiveBacktrackerEvent(RECURSIVE_BACKTRACKER_EVENT_TAG.VERTEX_VISITED, vertexPayload(2n)));
    expect(adapter.isMutatingEvent(decoded)).toBe(isMutatingRecursiveBacktrackerEvent(decoded));
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
    const decoded = adapter.decodeEvent(KRUSKAL_EVENT_TAG.EDGE_ADDED, edgeAddedPayload(1n, 3n));
    expect(decoded).toEqual(decodeKruskalEvent(KRUSKAL_EVENT_TAG.EDGE_ADDED, edgeAddedPayload(1n, 3n)));
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
    const decoded = adapter.decodeEvent(WILSON_EVENT_TAG.NODE_VISITED, vertexPayload(5n));
    expect(decoded).toEqual(decodeWilsonEvent(WILSON_EVENT_TAG.NODE_VISITED, vertexPayload(5n)));
    expect(adapter.isMutatingEvent(decoded)).toBe(isMutatingWilsonEvent(decoded));
  });

  it("scopeLabel formats Wilson's fixed search/commit scope names distinctly from numbered walk scopes", () => {
    expect(adapter.scopeLabel("search", [])).not.toBe(adapter.scopeLabel("walk 1", []));
    expect(adapter.scopeLabel("commit", [])).not.toBe(adapter.scopeLabel("walk 1", []));
    expect(adapter.scopeLabel("search", [])).not.toBe(adapter.scopeLabel("commit", []));
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
    { parent: 1, firstChild: null, nextSibling: 3, tag: VERTEX_BASED_EVENT_TAG.EDGE_ADDED, payloadBytes: vertexBasedEdgeAddedPayload(1n, 3n) },
    { parent: 1, firstChild: null, nextSibling: null, tag: VERTEX_BASED_EVENT_TAG.NODE_VISITED, payloadBytes: vertexBasedNodeVisitedPayload(3n, 1n) },
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
    const decoded = adapter.decodeEvent(VERTEX_BASED_EVENT_TAG.EDGE_ADDED, vertexBasedEdgeAddedPayload(1n, 3n));
    expect(decoded).toEqual(decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.EDGE_ADDED, vertexBasedEdgeAddedPayload(1n, 3n)));
    expect(adapter.isMutatingEvent(decoded)).toBe(isMutatingVertexBasedEvent(decoded));
  });

  it("scopeLabel formats a numbered step scope distinctly from the fixed reserve_search scope", () => {
    expect(adapter.scopeLabel("step 1", [])).not.toBe("");
    expect(adapter.scopeLabel("reserve_search", [])).not.toBe(adapter.scopeLabel("step 1", []));
  });

  it("narrates skipped element rolls with quoted, localized lowercase names", () => {
    expect(adapter.narrationTokensFor({ kind: "ElementRollSkipped", src: 7n, element: "teleport", cellType: "square" })).toEqual([
      { kind: "text", text: "\"teleport\" chance roll skipped: cell type \"square\" forbids this element: " },
      { kind: "node", id: 7n },
    ]);
  });
});

describe("adapterFor — one adapter instance per kind, stable identity", () => {
  it("returns the same adapter instance across repeated calls for each kind", () => {
    expect(adapterFor("preset_setup")).toBe(adapterFor("preset_setup"));
    expect(adapterFor("recursive_backtracker")).toBe(adapterFor("recursive_backtracker"));
    expect(adapterFor("kruskal")).toBe(adapterFor("kruskal"));
    expect(adapterFor("wilson")).toBe(adapterFor("wilson"));
    expect(adapterFor("vertex_based")).toBe(adapterFor("vertex_based"));
  });
});
