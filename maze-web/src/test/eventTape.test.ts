import { describe, it, expect } from "vitest";
import {
  parseTape, nodeAt, nodeView, mutatingRbEvents, applyRecursiveBacktracker,
  decodeRecursiveBacktrackerEvent, isMutatingRbEvent,
  parseCheckpoints, checkpointAt,
  resolveCheckpointFroms, nearestCheckpointFromAtOrBefore, resolveDebugArenaMetadata,
  decodeKruskalEvent, isMutatingKruskalEvent, applyKruskal, kruskalMergedRoot,
  decodeWilsonEvent, isMutatingWilsonEvent, mutatingWilsonEvents, applyWilson,
  decodeEdgeBasedEvent, isMutatingEdgeBasedEvent, mutatingEdgeBasedEvents, applyEdgeBased,
  TAG_SCOPE, NO_NODE, RB_TAG, KRUSKAL_TAG, WILSON_TAG, EDGE_BASED_TAG, CHECKPOINT_RECORD_SIZE,
  type ParsedTape, type ParsedCheckpoints,
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

function edgeAddedPayload(from: bigint, to: bigint, bidirectional = true): Uint8Array {
  return concatBytes([u64le(from), u64le(to), new Uint8Array([bidirectional ? 1 : 0])]);
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
      { kind: "EdgeAdded", from: 1n, to: 2n, bidirectional: true },
      { kind: "VertexVisited", id: 2n },
      { kind: "VertexPushed", id: 2n },
      { kind: "VertexPopped", id: 2n },
    ]);

    const result = applyRecursiveBacktracker(tape, 0);
    expect(result).toEqual({ edges: [{ from: 1n, to: 2n }, { from: 2n, to: 1n }], debugValues: new Map(), step: 0, nodeIndex: 2 });

    const full = applyRecursiveBacktracker(tape, 3);
    expect(full).toEqual({
      edges: [{ from: 1n, to: 2n }, { from: 2n, to: 1n }],
      debugValues: new Map([["visited", [2n]], ["recursion_stack", []]]),
      step: 3,
      nodeIndex: 7,
    });
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
    expect(isMutatingRbEvent({ kind: "EdgeAdded", from: 1n, to: 2n, bidirectional: true })).toBe(true);
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
    expect(applyRecursiveBacktracker(tape, 1, { edges: [], debugValues: new Map(), step: 0, nodeIndex: 1 }).step).toBe(1);
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
    expect(() => applyRecursiveBacktracker(tape, 0, { edges: [], debugValues: new Map(), step: 1, nodeIndex: 2 })).toThrow();
  });

  it("throws when from.step is out of range", () => {
    const tape = buildThreeEdgeTape();
    expect(() => applyRecursiveBacktracker(tape, 2, { edges: [], debugValues: new Map(), step: -1, nodeIndex: 0 })).toThrow();
    expect(() => applyRecursiveBacktracker(tape, 2, { edges: [], debugValues: new Map(), step: 1.5, nodeIndex: 1 })).toThrow();
  });

  it("throws when targetStep is out of range or non-integer", () => {
    const tape = buildThreeEdgeTape();
    expect(() => applyRecursiveBacktracker(tape, -1)).toThrow();
    expect(() => applyRecursiveBacktracker(tape, 3)).toThrow(); // only 3 mutating events (indices 0..2)
    expect(() => applyRecursiveBacktracker(tape, 1.5)).toThrow();
    expect(() => applyRecursiveBacktracker(tape, NaN)).toThrow();
    expect(() => applyRecursiveBacktracker(tape, Infinity)).toThrow();
  });

  it("from.step === targetStep returns from as-is without scanning (regression: used to crash)", () => {
    // A checkpoint landing exactly on the requested step needs zero new events — the bounded
    // scan below would ask mutatingRbEventsWithIndex for 0 events and then index into an empty
    // array (`newEvents[-1].nodeIndex`), throwing. This is exactly what
    // nearestCheckpointFromAtOrBefore can produce in practice (GitHub issue #128 wiring).
    const tape = buildThreeEdgeTape();
    const from = { edges: [{ from: 1n, to: 2n }], debugValues: new Map(), step: 0, nodeIndex: 1 };
    const result = applyRecursiveBacktracker(tape, 0, from);
    expect(result).toEqual({ edges: [{ from: 1n, to: 2n }], debugValues: new Map(), step: 0, nodeIndex: 1 });
  });

  it("from.step === targetStep returns a new edges array, not the same reference as from.edges", () => {
    const tape = buildThreeEdgeTape();
    const from = { edges: [{ from: 1n, to: 2n }], debugValues: new Map(), step: 0, nodeIndex: 1 };
    const result = applyRecursiveBacktracker(tape, 0, from);
    expect(result.edges).not.toBe(from.edges);
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
      { kind: "EdgeAdded", from: 1n, to: 2n, bidirectional: true },
      { kind: "EdgeAdded", from: 2n, to: 3n, bidirectional: true },
    ]);
  });

  it("EdgeAdded with bidirectional=false decodes without a reverse pair", () => {
    const tape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: null, nextSibling: null, tag: RB_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 2n, false) },
    ]);
    expect(mutatingRbEvents(tape)).toEqual([{ kind: "EdgeAdded", from: 1n, to: 2n, bidirectional: false }]);
    expect(applyRecursiveBacktracker(tape, 0).edges).toEqual([{ from: 1n, to: 2n }]);
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

// --- Checkpoint buffer (GitHub issue #128) ---
// Hand-built fixture mirroring `CheckpointLog::encode()` (maze-core/src/event_log/checkpoint.rs)
// and the edges-payload encoding written by `CheckpointTracker::record`
// (maze-core/src/generation/recursive_backtracker.rs).

interface FixtureCheckpoint {
  nodeIndex: number;
  edges: Array<[bigint, bigint]>;
  /** Named debug-value sets (GitHub issue #131) — defaults to none for fixtures that don't
   *  specifically exercise debug-value checkpointing. */
  debugValues?: Array<[string, bigint[]]>;
}

/** Encodes one checkpoint's payload: edges, then named debug-value sets — mirrors
 *  `CheckpointTracker::record`'s wire format in `recursive_backtracker.rs`. */
function checkpointPayload(edges: Array<[bigint, bigint]>, debugValues: Array<[string, bigint[]]>): Uint8Array {
  const textEncoder = new TextEncoder();
  const chunks: Uint8Array[] = [u32le(edges.length)];
  for (const [from, to] of edges) {
    chunks.push(u64le(from), u64le(to));
  }
  chunks.push(u32le(debugValues.length));
  for (const [name, ids] of debugValues) {
    const nameBytes = textEncoder.encode(name);
    chunks.push(u32le(nameBytes.byteLength), nameBytes, u32le(ids.length), ...ids.map(u64le));
  }
  return concatBytes(chunks);
}

function buildCheckpointFixture(checkpoints: FixtureCheckpoint[]): ParsedCheckpoints {
  const tableChunks: Uint8Array[] = [];
  const payloadChunks: Uint8Array[] = [];
  let payloadOffset = 0;
  for (const cp of checkpoints) {
    const bytes = checkpointPayload(cp.edges, cp.debugValues ?? []);
    tableChunks.push(u32le(cp.nodeIndex), u32le(payloadOffset), u32le(bytes.byteLength));
    payloadChunks.push(bytes);
    payloadOffset += bytes.byteLength;
  }
  return parseCheckpoints(concatBytes(tableChunks), concatBytes(payloadChunks));
}

describe("parseCheckpoints / checkpointAt", () => {
  it("round-trips a single checkpoint's node index and edges", () => {
    const tape = buildCheckpointFixture([{ nodeIndex: 42, edges: [[1n, 2n], [2n, 1n]] }]);
    expect(tape.checkpointCount).toBe(1);
    expect(tape.table.byteLength).toBe(CHECKPOINT_RECORD_SIZE);
    expect(checkpointAt(tape, 0)).toEqual({ nodeIndex: 42, edges: [{ from: 1n, to: 2n }, { from: 2n, to: 1n }], debugValues: new Map() });
  });

  it("round-trips multiple checkpoints with distinct payload slices", () => {
    const tape = buildCheckpointFixture([
      { nodeIndex: 10, edges: [[1n, 2n]] },
      { nodeIndex: 520, edges: [[1n, 2n], [3n, 4n], [4n, 3n]] },
    ]);
    expect(tape.checkpointCount).toBe(2);
    expect(checkpointAt(tape, 0)).toEqual({ nodeIndex: 10, edges: [{ from: 1n, to: 2n }], debugValues: new Map() });
    expect(checkpointAt(tape, 1)).toEqual({
      nodeIndex: 520,
      edges: [{ from: 1n, to: 2n }, { from: 3n, to: 4n }, { from: 4n, to: 3n }],
      debugValues: new Map(),
    });
  });

  it("round-trips a checkpoint with zero edges", () => {
    const tape = buildCheckpointFixture([{ nodeIndex: 5, edges: [] }]);
    expect(checkpointAt(tape, 0)).toEqual({ nodeIndex: 5, edges: [], debugValues: new Map() });
  });

  it("round-trips a checkpoint with a named debug-value set (GitHub issue #131)", () => {
    const tape = buildCheckpointFixture([{ nodeIndex: 7, edges: [[1n, 2n]], debugValues: [["recursion_stack", [3n, 5n, 8n]]] }]);
    expect(checkpointAt(tape, 0)).toEqual({
      nodeIndex: 7,
      edges: [{ from: 1n, to: 2n }],
      debugValues: new Map([["recursion_stack", [3n, 5n, 8n]]]),
    });
  });

  it("an empty buffer has zero checkpoints", () => {
    const tape = parseCheckpoints(new Uint8Array(0), new Uint8Array(0));
    expect(tape.checkpointCount).toBe(0);
  });
});


describe("resolveCheckpointFroms / nearestCheckpointFromAtOrBefore", () => {
  // buildTwoStepTape()'s mutating events, in step order: EdgeAdded (node 2, step 0),
  // VertexVisited (node 3, step 1), VertexPushed (node 4, step 2), VertexPopped (node 7, step 3).

  it("resolves an empty checkpoint table to an empty array", () => {
    const tape = buildTwoStepTape();
    const checkpoints = parseCheckpoints(new Uint8Array(0), new Uint8Array(0));
    expect(resolveCheckpointFroms(tape, checkpoints)).toEqual([]);
  });

  it("translates a checkpoint's arena nodeIndex into its mutating-event step", () => {
    const tape = buildTwoStepTape();
    // Checkpoint recorded at arena node 4 (the VertexPushed event) — step 2.
    const checkpoints = buildCheckpointFixture([{ nodeIndex: 4, edges: [[1n, 2n], [2n, 1n]] }]);
    const froms = resolveCheckpointFroms(tape, checkpoints);
    expect(froms).toEqual([{ edges: [{ from: 1n, to: 2n }, { from: 2n, to: 1n }], debugValues: new Map(), step: 2, nodeIndex: 4 }]);
  });

  it("resolves multiple checkpoints in ascending step order", () => {
    const tape = buildTwoStepTape();
    const checkpoints = buildCheckpointFixture([
      { nodeIndex: 2, edges: [[1n, 2n], [2n, 1n]] }, // EdgeAdded, step 0
      { nodeIndex: 7, edges: [[1n, 2n], [2n, 1n]] }, // VertexPopped, step 3
    ]);
    const froms = resolveCheckpointFroms(tape, checkpoints);
    expect(froms.map((f) => f.step)).toEqual([0, 3]);
    expect(froms.map((f) => f.nodeIndex)).toEqual([2, 7]);
  });

  it("a resolved checkpoint plugged into applyRecursiveBacktracker as `from` matches a full replay", () => {
    const tape = buildTwoStepTape();
    const checkpoints = buildCheckpointFixture([{ nodeIndex: 4, edges: [[1n, 2n], [2n, 1n]] }]);
    const [from] = resolveCheckpointFroms(tape, checkpoints);

    const viaCheckpoint = applyRecursiveBacktracker(tape, 3, from);
    const fromScratch = applyRecursiveBacktracker(tape, 3);
    expect(viaCheckpoint.edges).toEqual(fromScratch.edges);
  });

  it("nearestCheckpointFromAtOrBefore finds the greatest step <= target, or null", () => {
    const tape = buildTwoStepTape();
    const checkpoints = buildCheckpointFixture([
      { nodeIndex: 2, edges: [[1n, 2n], [2n, 1n]] }, // step 0
      { nodeIndex: 7, edges: [[1n, 2n], [2n, 1n]] }, // step 3
    ]);
    const froms = resolveCheckpointFroms(tape, checkpoints);

    expect(nearestCheckpointFromAtOrBefore(froms, 0)?.step).toBe(0);
    expect(nearestCheckpointFromAtOrBefore(froms, 2)?.step).toBe(0);
    expect(nearestCheckpointFromAtOrBefore(froms, 3)?.step).toBe(3);
    expect(nearestCheckpointFromAtOrBefore(froms, 100)?.step).toBe(3);
  });

  it("nearestCheckpointFromAtOrBefore returns null when no checkpoint precedes the target step", () => {
    const froms = resolveCheckpointFroms(buildTwoStepTape(), buildCheckpointFixture([{ nodeIndex: 4, edges: [] }]));
    expect(nearestCheckpointFromAtOrBefore(froms, 1)).toBeNull();
  });

  it("nearestCheckpointFromAtOrBefore returns null on an empty array", () => {
    expect(nearestCheckpointFromAtOrBefore([], 5)).toBeNull();
  });
});

describe("resolveDebugArenaMetadata", () => {
  // buildTwoStepTape()'s mutating events, in step order: EdgeAdded (node 2, step 0),
  // VertexVisited (node 3, step 1), VertexPushed (node 4, step 2), VertexPopped (node 7, step 3).

  it("totalSteps matches mutatingRbEvents(tape).length when there are no checkpoints", () => {
    const tape = buildTwoStepTape();
    const emptyCheckpoints = parseCheckpoints(new Uint8Array(0), new Uint8Array(0));
    const { totalSteps, checkpointFroms } = resolveDebugArenaMetadata(tape, emptyCheckpoints);
    expect(totalSteps).toBe(mutatingRbEvents(tape).length);
    expect(checkpointFroms).toEqual([]);
  });

  it("produces the same checkpointFroms as resolveCheckpointFroms for the same inputs", () => {
    const tape = buildTwoStepTape();
    const checkpoints = buildCheckpointFixture([
      { nodeIndex: 2, edges: [[1n, 2n], [2n, 1n]] },
      { nodeIndex: 7, edges: [[1n, 2n], [2n, 1n]] },
    ]);
    const combined = resolveDebugArenaMetadata(tape, checkpoints);
    const separate = resolveCheckpointFroms(tape, checkpoints);
    expect(combined.checkpointFroms).toEqual(separate);
    expect(combined.totalSteps).toBe(mutatingRbEvents(tape).length);
  });

  it("totalSteps is 0 and checkpointFroms is empty for a tape with no mutating events", () => {
    const tape = buildFixture([
      { parent: null, firstChild: null, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    ]);
    const emptyCheckpoints = parseCheckpoints(new Uint8Array(0), new Uint8Array(0));
    const { totalSteps, checkpointFroms } = resolveDebugArenaMetadata(tape, emptyCheckpoints);
    expect(totalSteps).toBe(0);
    expect(checkpointFroms).toEqual([]);
  });

  it("still resolves checkpointFroms correctly even when a checkpoint sits at the very last mutating event", () => {
    const tape = buildTwoStepTape();
    const checkpoints = buildCheckpointFixture([{ nodeIndex: 7, edges: [[1n, 2n]] }]); // last mutating event (VertexPopped)
    const { totalSteps, checkpointFroms } = resolveDebugArenaMetadata(tape, checkpoints);
    expect(totalSteps).toBe(4);
    expect(checkpointFroms).toEqual([{ edges: [{ from: 1n, to: 2n }], debugValues: new Map(), step: 3, nodeIndex: 7 }]);
  });
});

// --- Kruskal (GitHub issue #146) ---

function rootsComparedPayload(rootA: bigint, rootB: bigint): Uint8Array {
  return concatBytes([u64le(rootA), u64le(rootB)]);
}

function rootsComparedFullPayload(from: bigint, to: bigint, rootOfFrom: bigint, rootOfTo: bigint): Uint8Array {
  return concatBytes([u64le(from), u64le(to), u64le(rootOfFrom), u64le(rootOfTo)]);
}

function presetUnionsAppliedPayload(pairs: [bigint, bigint][]): Uint8Array {
  return concatBytes([u32le(pairs.length), ...pairs.flatMap(([a, b]) => [u64le(a), u64le(b)])]);
}

// Tree shape used by several tests below:
//   root (0)
//     -> PresetUnionsApplied([(1,2)]) (1)
//     -> "edge 1" scope (2) -> EdgeSelected(1,3) (3) -> RootsCompared(1,3) (4) -> EdgeAdded(1,3) (5) -> SetsMerged(1,3) (6)
//     -> "edge 2" scope (7) -> EdgeSelected(3,1) (8) -> RootsCompared(1,1) (9) -> EdgeRejected (10)
function buildKruskalTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: null, nextSibling: 2, tag: KRUSKAL_TAG.PRESET_UNIONS_APPLIED, payloadBytes: presetUnionsAppliedPayload([[1n, 2n]]) },
    { parent: 0, firstChild: 3, nextSibling: 7, tag: TAG_SCOPE, payloadBytes: scopePayload("edge 1") },
    { parent: 2, firstChild: null, nextSibling: 4, tag: KRUSKAL_TAG.EDGE_SELECTED, payloadBytes: rootsComparedPayload(1n, 3n) },
    { parent: 2, firstChild: null, nextSibling: 5, tag: KRUSKAL_TAG.ROOTS_COMPARED, payloadBytes: rootsComparedFullPayload(1n, 3n, 1n, 3n) },
    { parent: 2, firstChild: null, nextSibling: 6, tag: KRUSKAL_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 3n) },
    { parent: 2, firstChild: null, nextSibling: null, tag: KRUSKAL_TAG.SETS_MERGED, payloadBytes: rootsComparedPayload(1n, 3n) },
    { parent: 0, firstChild: 8, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("edge 2") },
    { parent: 7, firstChild: null, nextSibling: 9, tag: KRUSKAL_TAG.EDGE_SELECTED, payloadBytes: rootsComparedPayload(3n, 1n) },
    { parent: 7, firstChild: null, nextSibling: 10, tag: KRUSKAL_TAG.ROOTS_COMPARED, payloadBytes: rootsComparedFullPayload(3n, 1n, 1n, 1n) },
    { parent: 7, firstChild: null, nextSibling: null, tag: KRUSKAL_TAG.EDGE_REJECTED, payloadBytes: new Uint8Array(0) },
  ]);
}

describe("decodeKruskalEvent", () => {
  it("decodes EdgesShuffled (variable-length)", () => {
    const bytes = concatBytes([u32le(2), u64le(5n), u64le(9n), u64le(1n), u64le(2n)]);
    expect(decodeKruskalEvent(KRUSKAL_TAG.EDGES_SHUFFLED, bytes)).toEqual({
      kind: "EdgesShuffled", edges: [[5n, 9n], [1n, 2n]],
    });
  });

  it("decodes EdgeSelected (16 bytes)", () => {
    expect(decodeKruskalEvent(KRUSKAL_TAG.EDGE_SELECTED, rootsComparedPayload(1n, 3n))).toEqual({
      kind: "EdgeSelected", from: 1n, to: 3n,
    });
  });

  it("decodes RootsCompared (32 bytes)", () => {
    expect(decodeKruskalEvent(KRUSKAL_TAG.ROOTS_COMPARED, rootsComparedFullPayload(1n, 3n, 1n, 3n))).toEqual({
      kind: "RootsCompared", from: 1n, to: 3n, rootOfFrom: 1n, rootOfTo: 3n,
    });
  });

  it("decodes SetsMerged (16 bytes)", () => {
    expect(decodeKruskalEvent(KRUSKAL_TAG.SETS_MERGED, rootsComparedPayload(1n, 3n))).toEqual({
      kind: "SetsMerged", rootA: 1n, rootB: 3n,
    });
  });

  it("decodes EdgeRejected (0 bytes)", () => {
    expect(decodeKruskalEvent(KRUSKAL_TAG.EDGE_REJECTED, new Uint8Array(0))).toEqual({
      kind: "EdgeRejected",
    });
  });

  it("decodes EdgeAdded (17 bytes)", () => {
    expect(decodeKruskalEvent(KRUSKAL_TAG.EDGE_ADDED, edgeAddedPayload(1n, 3n))).toEqual({
      kind: "EdgeAdded", from: 1n, to: 3n, bidirectional: true,
    });
  });

  it("decodes PresetUnionsApplied (variable-length)", () => {
    expect(decodeKruskalEvent(KRUSKAL_TAG.PRESET_UNIONS_APPLIED, presetUnionsAppliedPayload([[1n, 2n], [4n, 5n]]))).toEqual({
      kind: "PresetUnionsApplied", pairs: [[1n, 2n], [4n, 5n]],
    });
  });

  it("throws on an unknown wire tag", () => {
    expect(() => decodeKruskalEvent(99, new Uint8Array(0))).toThrow(/unknown wire tag/);
  });

  it("throws on a payload_len mismatch", () => {
    expect(() => decodeKruskalEvent(KRUSKAL_TAG.EDGE_ADDED, new Uint8Array(5))).toThrow(/payload_len/);
  });
});

describe("kruskalMergedRoot", () => {
  it("returns the smaller of the two roots, mirroring core's union_by_min", () => {
    expect(kruskalMergedRoot(5n, 2n)).toBe(2n);
    expect(kruskalMergedRoot(2n, 5n)).toBe(2n);
    expect(kruskalMergedRoot(7n, 7n)).toBe(7n);
  });
});

describe("isMutatingKruskalEvent", () => {
  it("EdgeAdded and SetsMerged are mutating; everything else is trace-only", () => {
    expect(isMutatingKruskalEvent({ kind: "EdgeAdded", from: 1n, to: 2n, bidirectional: true })).toBe(true);
    expect(isMutatingKruskalEvent({ kind: "SetsMerged", rootA: 1n, rootB: 2n })).toBe(true);
    expect(isMutatingKruskalEvent({ kind: "RootsCompared", from: 1n, to: 2n, rootOfFrom: 1n, rootOfTo: 2n })).toBe(false);
    expect(isMutatingKruskalEvent({ kind: "EdgeSelected", from: 1n, to: 2n })).toBe(false);
    expect(isMutatingKruskalEvent({ kind: "EdgeRejected" })).toBe(false);
    expect(isMutatingKruskalEvent({ kind: "EdgesShuffled", edges: [] })).toBe(false);
    expect(isMutatingKruskalEvent({ kind: "PresetUnionsApplied", pairs: [] })).toBe(false);
  });
});

describe("applyKruskal", () => {
  it("reconstructs edges (both directions) and dsuGroups at each step", () => {
    const tape = buildKruskalTape();

    const step0 = applyKruskal(tape, 0); // EdgeAdded(1,3)
    expect(step0.edges).toEqual([{ from: 1n, to: 3n }, { from: 3n, to: 1n }]);
    // dsuGroups starts from PresetUnionsApplied([(1,2)]) then EdgeAdded's own find(1)/find(3)
    // calls register both endpoints (no union yet from EdgeAdded alone).
    expect(step0.dsuGroups.get(1n)).toBe(1n);
    expect(step0.dsuGroups.get(2n)).toBe(1n);
    expect(step0.dsuGroups.get(3n)).toBe(3n);
    expect(step0.step).toBe(0);
    expect(step0.nodeIndex).toBe(5);

    const step1 = applyKruskal(tape, 1); // + SetsMerged(1,3) -> union(1,3), root = min(1,3) = 1
    expect(step1.dsuGroups.get(1n)).toBe(1n);
    expect(step1.dsuGroups.get(2n)).toBe(1n);
    expect(step1.dsuGroups.get(3n)).toBe(1n);
    expect(step1.step).toBe(1);
    expect(step1.nodeIndex).toBe(6);
  });

  it("throws when targetStep is out of range", () => {
    const tape = buildKruskalTape();
    expect(() => applyKruskal(tape, 2)).toThrow(/out of range/);
  });

  it("without any PresetUnionsApplied event, dsuGroups starts from singleton sets", () => {
    const tape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("edge 1") },
      { parent: 1, firstChild: null, nextSibling: 3, tag: KRUSKAL_TAG.ROOTS_COMPARED, payloadBytes: rootsComparedFullPayload(1n, 2n, 1n, 2n) },
      { parent: 1, firstChild: null, nextSibling: 4, tag: KRUSKAL_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 2n) },
      { parent: 1, firstChild: null, nextSibling: null, tag: KRUSKAL_TAG.SETS_MERGED, payloadBytes: rootsComparedPayload(1n, 2n) },
    ]);
    const result = applyKruskal(tape, 1);
    expect(result.dsuGroups.get(1n)).toBe(1n);
    expect(result.dsuGroups.get(2n)).toBe(1n);
  });
});

// --- Wilson (GitHub issue #145) ---

function stepTakenPayload(from: bigint, to: bigint): Uint8Array {
  return concatBytes([u64le(from), u64le(to)]);
}

// Tree shape used by several tests below — Wilson's two-level scope nesting ("walk N" containing
// "step M" sub-scopes, per Specs/event_log.md):
//   root (0)
//     -> "walk 1" scope (1)
//          -> WalkStartPicked(5) (2)
//          -> "step 1" scope (3) -> StepTaken(5,3) (4) -> LoopErased(3) (5)
//          -> "step 2" scope (6) -> StepTaken(3,1) (7)
//          -> EdgeAdded(5,3) (8) -> NodeVisited(5) (9) -> EdgeAdded(3,1) (10) -> NodeVisited(3) (11)
function buildWilsonTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("walk 1") },
    { parent: 1, firstChild: null, nextSibling: 3, tag: WILSON_TAG.WALK_START_PICKED, payloadBytes: vertexPayload(5n) },
    { parent: 1, firstChild: 4, nextSibling: 6, tag: TAG_SCOPE, payloadBytes: scopePayload("step 1") },
    { parent: 3, firstChild: null, nextSibling: 5, tag: WILSON_TAG.STEP_TAKEN, payloadBytes: stepTakenPayload(5n, 3n) },
    { parent: 3, firstChild: null, nextSibling: null, tag: WILSON_TAG.LOOP_ERASED, payloadBytes: vertexPayload(3n) },
    { parent: 1, firstChild: 7, nextSibling: 8, tag: TAG_SCOPE, payloadBytes: scopePayload("step 2") },
    { parent: 6, firstChild: null, nextSibling: null, tag: WILSON_TAG.STEP_TAKEN, payloadBytes: stepTakenPayload(3n, 1n) },
    { parent: 1, firstChild: null, nextSibling: 9, tag: WILSON_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(5n, 3n) },
    { parent: 1, firstChild: null, nextSibling: 10, tag: WILSON_TAG.NODE_VISITED, payloadBytes: vertexPayload(5n) },
    { parent: 1, firstChild: null, nextSibling: 11, tag: WILSON_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(3n, 1n) },
    { parent: 1, firstChild: null, nextSibling: null, tag: WILSON_TAG.NODE_VISITED, payloadBytes: vertexPayload(3n) },
  ]);
}

describe("decodeWilsonEvent", () => {
  it("decodes StartVisited (8 bytes)", () => {
    expect(decodeWilsonEvent(WILSON_TAG.START_VISITED, vertexPayload(5n))).toEqual({
      kind: "StartVisited", id: 5n,
    });
  });

  it("decodes WalkStartPicked (8 bytes)", () => {
    expect(decodeWilsonEvent(WILSON_TAG.WALK_START_PICKED, vertexPayload(5n))).toEqual({
      kind: "WalkStartPicked", id: 5n,
    });
  });

  it("decodes StepTaken (16 bytes)", () => {
    expect(decodeWilsonEvent(WILSON_TAG.STEP_TAKEN, stepTakenPayload(5n, 3n))).toEqual({
      kind: "StepTaken", from: 5n, to: 3n,
    });
  });

  it("decodes LoopErased (8 bytes)", () => {
    expect(decodeWilsonEvent(WILSON_TAG.LOOP_ERASED, vertexPayload(3n))).toEqual({
      kind: "LoopErased", node: 3n,
    });
  });

  it("decodes WalkDeadEnd (0 bytes)", () => {
    expect(decodeWilsonEvent(WILSON_TAG.WALK_DEAD_END, new Uint8Array(0))).toEqual({
      kind: "WalkDeadEnd",
    });
  });

  it("decodes EdgeAdded (17 bytes)", () => {
    expect(decodeWilsonEvent(WILSON_TAG.EDGE_ADDED, edgeAddedPayload(5n, 3n))).toEqual({
      kind: "EdgeAdded", from: 5n, to: 3n, bidirectional: true,
    });
  });

  it("decodes NodeVisited (8 bytes)", () => {
    expect(decodeWilsonEvent(WILSON_TAG.NODE_VISITED, vertexPayload(5n))).toEqual({
      kind: "NodeVisited", id: 5n,
    });
  });

  it("throws on an unknown wire tag", () => {
    expect(() => decodeWilsonEvent(99, new Uint8Array(0))).toThrow(/unknown wire tag/);
  });

  it("throws on a payload_len mismatch", () => {
    expect(() => decodeWilsonEvent(WILSON_TAG.EDGE_ADDED, new Uint8Array(5))).toThrow(/payload_len/);
  });
});

describe("isMutatingWilsonEvent", () => {
  it("StartVisited/WalkStartPicked/StepTaken/LoopErased/EdgeAdded/NodeVisited are mutating; only WalkDeadEnd is trace-only", () => {
    // WalkStartPicked/StepTaken/LoopErased are mutating despite not touching the graph — they
    // change the walk's `next` map, the state `applyWilson`'s `"current_walk"` map debug value
    // reconstructs (mirrors `WilsonEvent::is_mutating`'s doc comment in maze-core/src/generation/wilson.rs).
    expect(isMutatingWilsonEvent({ kind: "StartVisited", id: 1n })).toBe(true);
    expect(isMutatingWilsonEvent({ kind: "WalkStartPicked", id: 1n })).toBe(true);
    expect(isMutatingWilsonEvent({ kind: "StepTaken", from: 1n, to: 2n })).toBe(true);
    expect(isMutatingWilsonEvent({ kind: "LoopErased", node: 1n })).toBe(true);
    expect(isMutatingWilsonEvent({ kind: "EdgeAdded", from: 1n, to: 2n, bidirectional: true })).toBe(true);
    expect(isMutatingWilsonEvent({ kind: "NodeVisited", id: 1n })).toBe(true);
    expect(isMutatingWilsonEvent({ kind: "WalkDeadEnd" })).toBe(false);
  });
});

describe("mutatingWilsonEvents / applyWilson", () => {
  it("skips scope nodes and WalkDeadEnd, keeping everything else in emission order", () => {
    const tape = buildWilsonTape();
    const events = mutatingWilsonEvents(tape);
    expect(events).toEqual([
      { kind: "WalkStartPicked", id: 5n },
      { kind: "StepTaken", from: 5n, to: 3n },
      { kind: "LoopErased", node: 3n },
      { kind: "StepTaken", from: 3n, to: 1n },
      { kind: "EdgeAdded", from: 5n, to: 3n, bidirectional: true },
      { kind: "NodeVisited", id: 5n },
      { kind: "EdgeAdded", from: 3n, to: 1n, bidirectional: true },
      { kind: "NodeVisited", id: 3n },
    ]);
  });

  it("reconstructs edges (both directions) and the current_walk map debug value up to targetStep, replaying from the start every call", () => {
    const tape = buildWilsonTape();

    const step1 = applyWilson(tape, 1); // WalkStartPicked(5), StepTaken(5,3) -> next: {5:3}
    expect(step1.edges).toEqual([]);
    expect(step1.debugMaps.get("current_walk")).toEqual(new Map([[5n, 3n]]));
    expect(step1.step).toBe(1);
    expect(step1.nodeIndex).toBe(4);

    const step4 = applyWilson(tape, 4); // + LoopErased, StepTaken(3,1), EdgeAdded(5,3)
    expect(step4.edges).toEqual([{ from: 5n, to: 3n }, { from: 3n, to: 5n }]);
    expect(step4.debugMaps.get("current_walk")).toEqual(new Map([[5n, 3n], [3n, 1n]]));
    expect(step4.step).toBe(4);
    expect(step4.nodeIndex).toBe(8);
  });

  it("reconstructs the visited debug value from NodeVisited events only", () => {
    const tape = buildWilsonTape();
    const step5 = applyWilson(tape, 5); // + NodeVisited(5)
    expect(step5.debugValues.get("visited")).toEqual([5n]);

    const step7 = applyWilson(tape, 7); // + EdgeAdded(3,1), NodeVisited(3)
    expect(step7.debugValues.get("visited")).toEqual([5n, 3n]);
  });

  it("throws when targetStep is out of range", () => {
    const tape = buildWilsonTape();
    expect(() => applyWilson(tape, 8)).toThrow(/out of range/);
  });
});

// --- CustomEdgeBased (GitHub issue #144) ---

function f64le(v: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, v, true);
  return bytes;
}

function boolByte(v: boolean): Uint8Array {
  return new Uint8Array([v ? 1 : 0]);
}

function nodeIdListPayload(ids: bigint[]): Uint8Array {
  return concatBytes([u32le(ids.length), ...ids.map(u64le)]);
}

function f64ListPayload(values: number[]): Uint8Array {
  return concatBytes([u32le(values.length), ...values.map(f64le)]);
}

function optionalNodeIdPayload(id: bigint | null): Uint8Array {
  return id === null
    ? concatBytes([new Uint8Array([0]), u64le(0n)])
    : concatBytes([new Uint8Array([1]), u64le(id)]);
}

function candidatePoolBuiltPayload(src: bigint, geometric: boolean, candidates: bigint[]): Uint8Array {
  return concatBytes([u64le(src), boolByte(geometric), nodeIdListPayload(candidates)]);
}

// Small deterministic tree — one "step 1" scope with a full corridor-skipped, non-teleport,
// non-cyclic connection, mirroring the smallest exact-sequence shape from the Rust-side
// `edge_based_single_step_emits_exact_event_sequence` test (a 1x2 field's first step):
//   root (0)
//     -> "step 1" scope (1)
//          -> CorridorRollSkipped (2)
//          -> SrcChosenByDepthFirst(src=1) (3)
//          -> TeleportRolled(src=1, fired=false) (4)
//          -> CyclicRolled(src=1, fired=false) (5)
//          -> CandidatePoolBuilt(src=1, [2]) (6)
//          -> DstWeightsComputed([2]) (7)
//          -> DstChosen(2) (8)
//          -> EdgeAdded(1,2) (9)
//          -> NodeActivated(2, parent=1) (10)
//          -> SrcExhausted(1) (11)
function buildEdgeBasedTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step 1") },
    { parent: 1, firstChild: null, nextSibling: 3, tag: EDGE_BASED_TAG.CORRIDOR_ROLL_SKIPPED, payloadBytes: new Uint8Array(0) },
    {
      parent: 1, firstChild: null, nextSibling: 4, tag: EDGE_BASED_TAG.SRC_CHOSEN_BY_DEPTH_FIRST,
      payloadBytes: concatBytes([u64le(1n), u32le(1), u32le(0), f64le(0.9)]),
    },
    {
      parent: 1, firstChild: null, nextSibling: 5, tag: EDGE_BASED_TAG.TELEPORT_ROLLED,
      payloadBytes: concatBytes([u64le(1n), f64le(0.8), f64le(0.0), boolByte(false)]),
    },
    {
      parent: 1, firstChild: null, nextSibling: 6, tag: EDGE_BASED_TAG.CYCLIC_ROLLED,
      payloadBytes: concatBytes([u64le(1n), f64le(0.7), f64le(0.0), boolByte(false)]),
    },
    { parent: 1, firstChild: null, nextSibling: 7, tag: EDGE_BASED_TAG.CANDIDATE_POOL_BUILT, payloadBytes: candidatePoolBuiltPayload(1n, true, [2n]) },
    {
      parent: 1, firstChild: null, nextSibling: 8, tag: EDGE_BASED_TAG.DST_WEIGHTS_COMPUTED,
      payloadBytes: concatBytes([nodeIdListPayload([2n]), f64ListPayload([1.0]), f64le(0.0), f64le(0.0), boolByte(true)]),
    },
    {
      parent: 1, firstChild: null, nextSibling: 9, tag: EDGE_BASED_TAG.DST_CHOSEN,
      payloadBytes: concatBytes([u64le(2n), f64le(0.5), f64le(1.0)]),
    },
    {
      parent: 1, firstChild: null, nextSibling: 10, tag: EDGE_BASED_TAG.EDGE_ADDED,
      payloadBytes: concatBytes([u64le(1n), u64le(2n), boolByte(false), boolByte(true)]),
    },
    {
      parent: 1, firstChild: null, nextSibling: 11, tag: EDGE_BASED_TAG.NODE_ACTIVATED,
      payloadBytes: concatBytes([u64le(2n), optionalNodeIdPayload(1n), u32le(1)]),
    },
    { parent: 1, firstChild: null, nextSibling: null, tag: EDGE_BASED_TAG.SRC_EXHAUSTED, payloadBytes: u64le(1n) },
  ]);
}

describe("decodeEdgeBasedEvent", () => {
  it("decodes CorridorRollSkipped (0 bytes)", () => {
    expect(decodeEdgeBasedEvent(EDGE_BASED_TAG.CORRIDOR_ROLL_SKIPPED, new Uint8Array(0))).toEqual({ kind: "CorridorRollSkipped" });
  });

  it("decodes CorridorRolled (25 bytes)", () => {
    const payload = concatBytes([u64le(7n), f64le(0.2), f64le(0.3), boolByte(true)]);
    expect(decodeEdgeBasedEvent(EDGE_BASED_TAG.CORRIDOR_ROLLED, payload)).toEqual({
      kind: "CorridorRolled", prev: 7n, roll: 0.2, corridorLength: 0.3, continued: true,
    });
  });

  it("decodes CorridorDeadNoUnseen (8 bytes)", () => {
    expect(decodeEdgeBasedEvent(EDGE_BASED_TAG.CORRIDOR_DEAD_NO_UNSEEN, u64le(4n))).toEqual({ kind: "CorridorDeadNoUnseen", prev: 4n });
  });

  it("decodes SrcChosenByDepthFirst (24 bytes)", () => {
    const payload = concatBytes([u64le(1n), u32le(3), u32le(1), f64le(0.5)]);
    expect(decodeEdgeBasedEvent(EDGE_BASED_TAG.SRC_CHOSEN_BY_DEPTH_FIRST, payload)).toEqual({
      kind: "SrcChosenByDepthFirst", src: 1n, activeLen: 3, position: 1, depthFirst: 0.5,
    });
  });

  it("decodes TeleportRolled (25 bytes)", () => {
    const payload = concatBytes([u64le(1n), f64le(0.05), f64le(0.1), boolByte(true)]);
    expect(decodeEdgeBasedEvent(EDGE_BASED_TAG.TELEPORT_ROLLED, payload)).toEqual({
      kind: "TeleportRolled", src: 1n, roll: 0.05, teleportChance: 0.1, fired: true,
    });
  });

  it("decodes TeleportAlreadyRolled (8 bytes)", () => {
    expect(decodeEdgeBasedEvent(EDGE_BASED_TAG.TELEPORT_ALREADY_ROLLED, u64le(1n))).toEqual({ kind: "TeleportAlreadyRolled", src: 1n });
  });

  it("decodes CyclicRolled (25 bytes)", () => {
    const payload = concatBytes([u64le(1n), f64le(0.5), f64le(0.15), boolByte(false)]);
    expect(decodeEdgeBasedEvent(EDGE_BASED_TAG.CYCLIC_ROLLED, payload)).toEqual({
      kind: "CyclicRolled", src: 1n, roll: 0.5, cyclicity: 0.15, fired: false,
    });
  });

  it("decodes CandidatePoolBuilt (variable length)", () => {
    expect(decodeEdgeBasedEvent(EDGE_BASED_TAG.CANDIDATE_POOL_BUILT, candidatePoolBuiltPayload(1n, true, [2n, 3n]))).toEqual({
      kind: "CandidatePoolBuilt", src: 1n, geometric: true, candidates: [2n, 3n],
    });
  });

  it("decodes SrcExhaustedEmptyPool (8 bytes)", () => {
    expect(decodeEdgeBasedEvent(EDGE_BASED_TAG.SRC_EXHAUSTED_EMPTY_POOL, u64le(1n))).toEqual({ kind: "SrcExhaustedEmptyPool", src: 1n });
  });

  it("decodes CyclicCandidatesComputed (variable length)", () => {
    expect(decodeEdgeBasedEvent(EDGE_BASED_TAG.CYCLIC_CANDIDATES_COMPUTED, candidatePoolBuiltPayload(1n, false, [4n]))).toEqual({
      kind: "CyclicCandidatesComputed", src: 1n, geometric: false, candidates: [4n],
    });
  });

  it("decodes CyclicEdgeAdded (18 bytes)", () => {
    const payload = concatBytes([u64le(1n), u64le(4n), boolByte(true), boolByte(false)]);
    expect(decodeEdgeBasedEvent(EDGE_BASED_TAG.CYCLIC_EDGE_ADDED, payload)).toEqual({ kind: "CyclicEdgeAdded", src: 1n, dst: 4n, teleport: true, bidirectional: false });
  });

  it("decodes CyclicEdgeRejected (17 bytes)", () => {
    const payload = concatBytes([u64le(1n), u64le(4n), boolByte(false)]);
    expect(decodeEdgeBasedEvent(EDGE_BASED_TAG.CYCLIC_EDGE_REJECTED, payload)).toEqual({ kind: "CyclicEdgeRejected", src: 1n, dst: 4n, teleport: false });
  });

  it("decodes DstWeightsComputed (variable length)", () => {
    const payload = concatBytes([nodeIdListPayload([2n, 3n]), f64ListPayload([1.5, 2.5]), f64le(0.4), f64le(0.1), boolByte(true)]);
    expect(decodeEdgeBasedEvent(EDGE_BASED_TAG.DST_WEIGHTS_COMPUTED, payload)).toEqual({
      kind: "DstWeightsComputed", candidates: [2n, 3n], weights: [1.5, 2.5], branching: 0.4, directionality: 0.1, directionalityEligible: true,
    });
  });

  it("decodes DstChosen (24 bytes)", () => {
    const payload = concatBytes([u64le(2n), f64le(0.63), f64le(3.0)]);
    expect(decodeEdgeBasedEvent(EDGE_BASED_TAG.DST_CHOSEN, payload)).toEqual({ kind: "DstChosen", dst: 2n, roll: 0.63, totalWeight: 3.0 });
  });

  it("decodes EdgeAdded (18 bytes)", () => {
    const payload = concatBytes([u64le(1n), u64le(2n), boolByte(false), boolByte(true)]);
    expect(decodeEdgeBasedEvent(EDGE_BASED_TAG.EDGE_ADDED, payload)).toEqual({ kind: "EdgeAdded", src: 1n, dst: 2n, teleport: false, bidirectional: true });
  });

  it("decodes EdgeRejected (17 bytes)", () => {
    const payload = concatBytes([u64le(1n), u64le(2n), boolByte(true)]);
    expect(decodeEdgeBasedEvent(EDGE_BASED_TAG.EDGE_REJECTED, payload)).toEqual({ kind: "EdgeRejected", src: 1n, dst: 2n, teleport: true });
  });

  it("decodes PresetSkipped (16 bytes)", () => {
    const payload = concatBytes([u64le(1n), u64le(2n)]);
    expect(decodeEdgeBasedEvent(EDGE_BASED_TAG.PRESET_SKIPPED, payload)).toEqual({ kind: "PresetSkipped", src: 1n, dst: 2n });
  });

  it("decodes NodeActivated with parent=Some (21 bytes)", () => {
    const payload = concatBytes([u64le(2n), optionalNodeIdPayload(1n), u32le(3)]);
    expect(decodeEdgeBasedEvent(EDGE_BASED_TAG.NODE_ACTIVATED, payload)).toEqual({ kind: "NodeActivated", node: 2n, parent: 1n, treeDepth: 3 });
  });

  it("decodes NodeActivated with parent=None (21 bytes)", () => {
    const payload = concatBytes([u64le(1n), optionalNodeIdPayload(null), u32le(0)]);
    expect(decodeEdgeBasedEvent(EDGE_BASED_TAG.NODE_ACTIVATED, payload)).toEqual({ kind: "NodeActivated", node: 1n, parent: null, treeDepth: 0 });
  });

  it("decodes SrcExhausted (8 bytes)", () => {
    expect(decodeEdgeBasedEvent(EDGE_BASED_TAG.SRC_EXHAUSTED, u64le(1n))).toEqual({ kind: "SrcExhausted", src: 1n });
  });

  it("throws on an unknown wire tag", () => {
    expect(() => decodeEdgeBasedEvent(99, new Uint8Array(0))).toThrow(/unknown wire tag/);
  });

  it("throws on a payload_len mismatch", () => {
    expect(() => decodeEdgeBasedEvent(EDGE_BASED_TAG.EDGE_ADDED, new Uint8Array(5))).toThrow(/payload_len/);
  });
});

describe("isMutatingEdgeBasedEvent", () => {
  it("SrcExhaustedEmptyPool/CyclicEdgeAdded/CyclicEdgeRejected/EdgeAdded/EdgeRejected/NodeActivated/SrcExhausted are mutating; every trace-only variant is not", () => {
    expect(isMutatingEdgeBasedEvent({ kind: "SrcExhaustedEmptyPool", src: 1n })).toBe(true);
    expect(isMutatingEdgeBasedEvent({ kind: "CyclicEdgeAdded", src: 1n, dst: 2n, teleport: false, bidirectional: true })).toBe(true);
    expect(isMutatingEdgeBasedEvent({ kind: "CyclicEdgeRejected", src: 1n, dst: 2n, teleport: false })).toBe(true);
    expect(isMutatingEdgeBasedEvent({ kind: "EdgeAdded", src: 1n, dst: 2n, teleport: false, bidirectional: true })).toBe(true);
    expect(isMutatingEdgeBasedEvent({ kind: "EdgeRejected", src: 1n, dst: 2n, teleport: false })).toBe(true);
    expect(isMutatingEdgeBasedEvent({ kind: "NodeActivated", node: 1n, parent: null, treeDepth: 0 })).toBe(true);
    expect(isMutatingEdgeBasedEvent({ kind: "SrcExhausted", src: 1n })).toBe(true);

    expect(isMutatingEdgeBasedEvent({ kind: "CorridorRollSkipped" })).toBe(false);
    expect(isMutatingEdgeBasedEvent({ kind: "TeleportAlreadyRolled", src: 1n })).toBe(false);
    expect(isMutatingEdgeBasedEvent({ kind: "PresetSkipped", src: 1n, dst: 2n })).toBe(false);
  });
});

describe("mutatingEdgeBasedEvents / applyEdgeBased", () => {
  it("skips scope nodes and trace-only events, keeping mutating ones in emission order", () => {
    const tape = buildEdgeBasedTape();
    const events = mutatingEdgeBasedEvents(tape);
    expect(events).toEqual([
      { kind: "EdgeAdded", src: 1n, dst: 2n, teleport: false, bidirectional: true },
      { kind: "NodeActivated", node: 2n, parent: 1n, treeDepth: 1 },
      { kind: "SrcExhausted", src: 1n },
    ]);
  });

  it("reconstructs edges and active/visited debug values up to targetStep, replaying from the start every call", () => {
    const tape = buildEdgeBasedTape();

    const step0 = applyEdgeBased(tape, 0); // EdgeAdded(1,2), bidirectional, basic (not teleport)
    expect(step0.edges).toEqual([{ from: 1n, to: 2n, kind: "basic" }, { from: 2n, to: 1n, kind: "basic" }]);
    expect(step0.debugValues.get("active")).toBeUndefined();
    expect(step0.step).toBe(0);

    const step1 = applyEdgeBased(tape, 1); // + NodeActivated(2, parent=1)
    expect(step1.debugValues.get("active")).toEqual([2n]);
    expect(step1.debugValues.get("visited")).toBeUndefined();

    const step2 = applyEdgeBased(tape, 2); // + SrcExhausted(1): active loses 1 (never had it), visited gains 1
    expect(step2.debugValues.get("active")).toEqual([2n]);
    expect(step2.debugValues.get("visited")).toEqual([1n]);
    expect(step2.step).toBe(2);
  });

  it("throws when targetStep is out of range", () => {
    const tape = buildEdgeBasedTape();
    expect(() => applyEdgeBased(tape, 3)).toThrow(/out of range/);
  });

  it("tags reconstructed edges with kind: teleport when EdgeAdded.teleport is true (regression for GitHub issue #144's teleport-rendering bug)", () => {
    // root (0) -> "step 1" scope (1) -> EdgeAdded(1,5,teleport=true,bidirectional=false) (2)
    const teleportEdgeAddedPayload = concatBytes([u64le(1n), u64le(5n), boolByte(true), boolByte(false)]);
    const tape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step 1") },
      { parent: 1, firstChild: null, nextSibling: null, tag: EDGE_BASED_TAG.EDGE_ADDED, payloadBytes: teleportEdgeAddedPayload },
    ]);
    const result = applyEdgeBased(tape, 0);
    expect(result.edges).toEqual([{ from: 1n, to: 5n, kind: "teleport" }]);
  });
});
