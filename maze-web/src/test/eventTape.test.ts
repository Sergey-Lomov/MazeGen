import { describe, it, expect } from "vitest";
import {
  parseTape, nodeAt, nodeView, mutatingRbEvents, applyRecursiveBacktracker,
  decodeRecursiveBacktrackerEvent, isMutatingRbEvent,
  parseCheckpoints, checkpointAt,
  resolveCheckpointFroms, nearestCheckpointFromAtOrBefore, resolveDebugArenaMetadata,
  decodeKruskalEvent, isMutatingKruskalEvent, applyKruskal, kruskalMergedRoot,
  TAG_SCOPE, NO_NODE, RB_TAG, KRUSKAL_TAG, CHECKPOINT_RECORD_SIZE,
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
