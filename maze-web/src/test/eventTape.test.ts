import { describe, it, expect } from "vitest";
import {
  parseTape, nodeAt, nodeView, mutatingRbEvents, applyRecursiveBacktracker,
  decodeRecursiveBacktrackerEvent, isMutatingRbEvent,
  TAG_SCOPE, NO_NODE, RB_TAG,
  type ParsedTape,
} from "../debug/eventTape";

// --- Hand-built fixture encoder, mirroring `DebugTape::encode()` (maze-core/src/event_log/mod.rs)
// and RecursiveBacktrackerEvent::encode_payload (maze-core/src/generation/recursive_backtracker.rs).
// Uses the module's own exported constants (never raw numbers), per the plan's "no bare numbers
// scattered across tests" requirement.

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

function u32le(v: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, v, true);
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
  return concatBytes([u64le(from), u64le(to)]);
}

function vertexPayload(id: bigint): Uint8Array {
  return u64le(id);
}

function candidatesComputedPayload(ids: bigint[]): Uint8Array {
  return concatBytes([u32le(ids.length), ...ids.map(u64le)]);
}

/** Builds a `ParsedTape` from a flat list of nodes (already in arena/insertion order — index 0
 *  must be the root scope). Encodes exactly like `DebugTape::encode()`: node_table records +
 *  a payload byte arena (no scope-name dedup here, unlike the Rust encoder — not needed for
 *  these tests, and dedup is an implementation detail per `event_log.md`). */
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

// Tree shape used by the exact-sequence test and several invariant tests:
//   root (0)
//     -> "step" scope (1) -> EdgeAdded(1,2) (2) -> VertexVisited(2) (3) -> VertexPushed(2) (4)
//     -> "step" scope (5) -> DeadEnd (6) -> VertexPopped(2) (7)
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

describe("mutatingRbEvents / applyRecursiveBacktracker — exact sequence", () => {
  it("decodes and applies the exact event sequence for a small deterministic tree", () => {
    const tape = buildTwoStepTape();
    const events = mutatingRbEvents(tape);
    expect(events).toEqual([
      { kind: "EdgeAdded", from: 1n, to: 2n },
      { kind: "VertexVisited", id: 2n },
      { kind: "VertexPushed", id: 2n },
      { kind: "VertexPopped", id: 2n },
    ]);

    const result = applyRecursiveBacktracker(tape, 0);
    expect(result).toEqual({ edges: [{ from: 1n, to: 2n }], step: 0, nodeIndex: 2 });

    const full = applyRecursiveBacktracker(tape, 3);
    expect(full).toEqual({ edges: [{ from: 1n, to: 2n }], step: 3, nodeIndex: 7 });
  });
});

describe("mutatingRbEvents invariants", () => {
  it("skips scope nodes entirely", () => {
    const tape = buildTwoStepTape();
    const events = mutatingRbEvents(tape);
    expect(events.every((e) => e.kind !== undefined)).toBe(true);
    expect(events).toHaveLength(4);
  });

  it("is_mutating split agrees with the Rust-side variant list", () => {
    expect(isMutatingRbEvent({ kind: "EdgeAdded", from: 1n, to: 2n })).toBe(true);
    expect(isMutatingRbEvent({ kind: "VertexVisited", id: 1n })).toBe(true);
    expect(isMutatingRbEvent({ kind: "VertexPopped", id: 1n })).toBe(true);
    expect(isMutatingRbEvent({ kind: "VertexPushed", id: 1n })).toBe(true);
    expect(isMutatingRbEvent({ kind: "VertexSelected", id: 1n })).toBe(false);
    expect(isMutatingRbEvent({ kind: "CandidatesComputed", ids: [] })).toBe(false);
    expect(isMutatingRbEvent({ kind: "DeadEnd" })).toBe(false);
    expect(isMutatingRbEvent({ kind: "CandidateChosen", id: 1n })).toBe(false);
  });
});

describe("nodeView tree layer", () => {
  it("exposes scope names and children in emission order, independent of the flat layer", () => {
    const tape = buildTwoStepTape();
    const root = nodeView(tape, 0);
    expect(root.payload()).toEqual({ kind: "scope", name: "root" });
    expect(root.parent()).toBeNull();

    const children = root.children();
    expect(children).toHaveLength(2);
    expect(children[0].payload()).toEqual({ kind: "scope", name: "step" });
    expect(children[1].payload()).toEqual({ kind: "scope", name: "step" });

    const firstStepChildren = children[0].children();
    expect(firstStepChildren).toHaveLength(3);
    expect(firstStepChildren[0].payload()).toEqual({ kind: "event", tag: RB_TAG.EDGE_ADDED, bytes: edgeAddedPayload(1n, 2n) });

    expect(children[0].parent()?.payload()).toEqual({ kind: "scope", name: "root" });
  });

  it("returns an empty array for a leaf event node with no children", () => {
    const tape = buildTwoStepTape();
    const root = nodeView(tape, 0);
    const firstStepChildren = root.children()[0].children();
    const edgeAddedLeaf = firstStepChildren[0]; // node index 2, firstChild = NO_NODE
    expect(edgeAddedLeaf.children()).toEqual([]);
  });
});

describe("applyRecursiveBacktracker — resume via `from`", () => {
  function buildThreeEdgeTape(): ParsedTape {
    // root -> EdgeAdded(1,2), EdgeAdded(2,3), EdgeAdded(3,4) — flat, no scopes needed for this test.
    return buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: null, nextSibling: 2, tag: RB_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 2n) },
      { parent: 0, firstChild: null, nextSibling: 3, tag: RB_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(2n, 3n) },
      { parent: 0, firstChild: null, nextSibling: null, tag: RB_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(3n, 4n) },
    ]);
  }

  it("resuming from an intermediate step matches a full replay to the same target", () => {
    const tape = buildThreeEdgeTape();
    const full = applyRecursiveBacktracker(tape, 2);
    const partial = applyRecursiveBacktracker(tape, 0);
    // Passing a previous result straight back in as `from`, unmodified — the documented contract.
    const resumed = applyRecursiveBacktracker(tape, 2, partial);
    expect(resumed.edges).toEqual(full.edges);
    expect(resumed.step).toBe(2);
  });

  it("resume only decodes events after from.nodeIndex, not the whole tape again", () => {
    const tape = buildThreeEdgeTape();
    const partial = applyRecursiveBacktracker(tape, 0); // nodeIndex 1 (first EdgeAdded)
    expect(partial.nodeIndex).toBe(1);
    const resumed = applyRecursiveBacktracker(tape, 2, partial);
    expect(resumed.nodeIndex).toBe(3); // last EdgeAdded's node-table index
  });

  it("result.step always equals targetStep", () => {
    const tape = buildThreeEdgeTape();
    expect(applyRecursiveBacktracker(tape, 1).step).toBe(1);
    expect(applyRecursiveBacktracker(tape, 1, { edges: [], step: 0, nodeIndex: 1 }).step).toBe(1);
  });

  it("does not mutate the edges array passed via `from`", () => {
    const tape = buildThreeEdgeTape();
    const partial = applyRecursiveBacktracker(tape, 0);
    const originalEdges = partial.edges;
    const originalCopy = [...originalEdges];
    applyRecursiveBacktracker(tape, 2, partial);
    expect(originalEdges).toEqual(originalCopy);
  });

  it("throws when from.step is ahead of targetStep", () => {
    const tape = buildThreeEdgeTape();
    expect(() => applyRecursiveBacktracker(tape, 0, { edges: [], step: 1, nodeIndex: 2 })).toThrow();
  });

  it("throws when from.step is out of range", () => {
    const tape = buildThreeEdgeTape();
    expect(() => applyRecursiveBacktracker(tape, 2, { edges: [], step: -1, nodeIndex: 0 })).toThrow();
    expect(() => applyRecursiveBacktracker(tape, 2, { edges: [], step: 1.5, nodeIndex: 1 })).toThrow();
  });

  it("throws when targetStep is out of range or non-integer", () => {
    const tape = buildThreeEdgeTape();
    expect(() => applyRecursiveBacktracker(tape, -1)).toThrow();
    expect(() => applyRecursiveBacktracker(tape, 3)).toThrow(); // only 3 mutating events (indices 0..2)
    expect(() => applyRecursiveBacktracker(tape, 1.5)).toThrow();
    expect(() => applyRecursiveBacktracker(tape, NaN)).toThrow();
    expect(() => applyRecursiveBacktracker(tape, Infinity)).toThrow();
  });
});

describe("decodeRecursiveBacktrackerEvent — trace-only variants", () => {
  it("decodes VertexSelected", () => {
    expect(decodeRecursiveBacktrackerEvent(RB_TAG.VERTEX_SELECTED, vertexPayload(7n))).toEqual({ kind: "VertexSelected", id: 7n });
  });

  it("decodes CandidateChosen", () => {
    expect(decodeRecursiveBacktrackerEvent(RB_TAG.CANDIDATE_CHOSEN, vertexPayload(7n))).toEqual({ kind: "CandidateChosen", id: 7n });
  });
});

describe("decodeRecursiveBacktrackerEvent — malformed payload handling", () => {
  it("throws on an unknown tag", () => {
    expect(() => decodeRecursiveBacktrackerEvent(99, new Uint8Array(0))).toThrow();
  });

  it("throws when a fixed-size event's payload_len doesn't match, for every fixed-size variant", () => {
    expect(() => decodeRecursiveBacktrackerEvent(RB_TAG.VERTEX_SELECTED, new Uint8Array(7))).toThrow();
    expect(() => decodeRecursiveBacktrackerEvent(RB_TAG.CANDIDATE_CHOSEN, new Uint8Array(7))).toThrow();
    expect(() => decodeRecursiveBacktrackerEvent(RB_TAG.VERTEX_VISITED, new Uint8Array(7))).toThrow();
    expect(() => decodeRecursiveBacktrackerEvent(RB_TAG.VERTEX_POPPED, new Uint8Array(7))).toThrow();
    expect(() => decodeRecursiveBacktrackerEvent(RB_TAG.VERTEX_PUSHED, new Uint8Array(7))).toThrow();
    expect(() => decodeRecursiveBacktrackerEvent(RB_TAG.EDGE_ADDED, new Uint8Array(15))).toThrow();
    expect(() => decodeRecursiveBacktrackerEvent(RB_TAG.DEAD_END, new Uint8Array(1))).toThrow();
  });

  it("throws when CandidatesComputed's payload is shorter than the 4-byte length prefix", () => {
    expect(() => decodeRecursiveBacktrackerEvent(RB_TAG.CANDIDATES_COMPUTED, new Uint8Array(2))).toThrow();
  });

  it("throws when CandidatesComputed's payload_len doesn't match 4 + count*8", () => {
    const malformed = concatBytes([u32le(2), u64le(1n)]); // claims 2 ids, only provides 1
    expect(() => decodeRecursiveBacktrackerEvent(RB_TAG.CANDIDATES_COMPUTED, malformed)).toThrow();
  });

  it("decodes a well-formed CandidatesComputed payload", () => {
    const payload = candidatesComputedPayload([10n, 20n, 30n]);
    const event = decodeRecursiveBacktrackerEvent(RB_TAG.CANDIDATES_COMPUTED, payload);
    expect(event).toEqual({ kind: "CandidatesComputed", ids: [10n, 20n, 30n] });
  });

  it("decodes an empty CandidatesComputed payload (count=0)", () => {
    const event = decodeRecursiveBacktrackerEvent(RB_TAG.CANDIDATES_COMPUTED, candidatesComputedPayload([]));
    expect(event).toEqual({ kind: "CandidatesComputed", ids: [] });
  });
});

describe("mutatingRbEvents — bounded scan", () => {
  it("limit stops the scan early without decoding the rest of the tape", () => {
    const tape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: null, nextSibling: 2, tag: RB_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 2n) },
      { parent: 0, firstChild: null, nextSibling: 3, tag: RB_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(2n, 3n) },
      // Malformed trailing event — would throw if decoded, proving the scan never reaches it.
      { parent: 0, firstChild: null, nextSibling: null, tag: 99, payloadBytes: new Uint8Array(0) },
    ]);
    const limited = mutatingRbEvents(tape, 2);
    expect(limited).toEqual([
      { kind: "EdgeAdded", from: 1n, to: 2n },
      { kind: "EdgeAdded", from: 2n, to: 3n },
    ]);
  });
});

describe("nodeAt", () => {
  it("decodes NO_NODE sentinels as null", () => {
    const tape = buildTwoStepTape();
    const root = nodeAt(tape, 0);
    expect(root.parent).toBeNull();
    expect(root.nextSibling).toBeNull();
    expect(root.firstChild).toBe(1);
  });
});
