import { describe, it, expect } from "vitest";
import {
  parseTape, nodeAt, nodeView, mutatingRbEvents, applyRecursiveBacktracker,
  decodeRecursiveBacktrackerEvent, isMutatingRecursiveBacktrackerEvent,
  resolveDebugArenaMetadata, countMutatingEvents,
  decodeKruskalEvent, isMutatingKruskalEvent, applyKruskal, kruskalMergedRoot,
  decodeWilsonEvent, isMutatingWilsonEvent, mutatingWilsonEvents, applyWilson,
  decodeVertexBasedEvent, isMutatingVertexBasedEvent, mutatingVertexBasedEvents, applyVertexBased,
  topLevelSourceScopes,
  TAG_SCOPE, NO_NODE, RECURSIVE_BACKTRACKER_EVENT_TAG, KRUSKAL_EVENT_TAG, WILSON_EVENT_TAG, VERTEX_BASED_EVENT_TAG,
  SOURCE_SHIFT, SOURCE_MASK, LOCAL_TAG_MASK,
  type ParsedTape, type ApplyResult, type KruskalApplyResult, type WilsonApplyResult, type VertexBasedApplyResult,
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

/** A flat tape (no scopes beyond root) of `count` sequential single-tag events, `tag`/`payloadFor`
 *  supplying the per-algorithm event shape — shared by every `buildLong*ChainTape` fixture that
 *  exercises `resolveDebugArenaMetadata`'s internal `CHECKPOINT_INTERVAL` pacing (500 mutating
 *  events) for a given algorithm's event stream. */
function buildLongChainTape(count: number, tag: number, payloadFor: (i: number) => Uint8Array): ParsedTape {
  const nodes: FixtureNode[] = [{ parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") }];
  for (let i = 0; i < count; i++) {
    nodes.push({
      parent: 0,
      firstChild: null,
      nextSibling: i + 1 < count ? i + 2 : null,
      tag,
      payloadBytes: payloadFor(i),
    });
  }
  return buildFixture(nodes);
}

/** Builds a `resolveDebugArenaMetadata` wrapper bound to one algorithm's decode/isMutating/apply
 *  triple — shared by every `resolve*Metadata` convenience function in this file, each of which
 *  mirrors that algorithm's real `*_ADAPTER.resolveMetadata` (`algorithmRegistry.ts`). */
function makeMetadataResolver<TEvent, TResult extends { step: number; nodeIndex: number }>(
  decode: (tag: number, bytes: Uint8Array) => TEvent,
  isMutating: (event: TEvent) => boolean,
  apply: (tape: ParsedTape, step: number, previous?: TResult) => TResult,
) {
  return (tape: ParsedTape) => resolveDebugArenaMetadata<TResult>(
    tape,
    (t, s, e) => countMutatingEvents(t, decode, isMutating, s, e),
    (step, previous) => apply(tape, step, previous),
    0, tape.nodeCount,
  );
}

// Tree shape used by the exact-sequence test and several invariant tests:
//   root (0)
//     -> "step" scope (1) -> EdgeAdded(1,2) (2) -> VertexVisited(2) (3) -> VertexPushed(2) (4)
//     -> "step" scope (5) -> DeadEnd (6) -> VertexPopped(2) (7)
function buildTwoStepTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: 5, tag: TAG_SCOPE, payloadBytes: scopePayload("step") },
    { parent: 1, firstChild: null, nextSibling: 3, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 2n) },
    { parent: 1, firstChild: null, nextSibling: 4, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.VERTEX_VISITED, payloadBytes: vertexPayload(2n) },
    { parent: 1, firstChild: null, nextSibling: null, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.VERTEX_PUSHED, payloadBytes: vertexPayload(2n) },
    { parent: 0, firstChild: 6, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step") },
    { parent: 5, firstChild: null, nextSibling: 7, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.DEAD_END, payloadBytes: new Uint8Array(0) },
    { parent: 5, firstChild: null, nextSibling: null, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.VERTEX_POPPED, payloadBytes: vertexPayload(2n) },
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
    expect(isMutatingRecursiveBacktrackerEvent({ kind: "EdgeAdded", from: 1n, to: 2n, bidirectional: true })).toBe(true);
    expect(isMutatingRecursiveBacktrackerEvent({ kind: "VertexVisited", id: 1n })).toBe(true);
    expect(isMutatingRecursiveBacktrackerEvent({ kind: "VertexPopped", id: 1n })).toBe(true);
    expect(isMutatingRecursiveBacktrackerEvent({ kind: "VertexPushed", id: 1n })).toBe(true);
    expect(isMutatingRecursiveBacktrackerEvent({ kind: "VertexSelected", id: 1n })).toBe(false);
    expect(isMutatingRecursiveBacktrackerEvent({ kind: "CandidatesComputed", ids: [] })).toBe(false);
    expect(isMutatingRecursiveBacktrackerEvent({ kind: "DeadEnd" })).toBe(false);
    expect(isMutatingRecursiveBacktrackerEvent({ kind: "CandidateChosen", id: 1n })).toBe(false);
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
    expect(firstStepChildren[0].payload()).toEqual({ kind: "event", tag: RECURSIVE_BACKTRACKER_EVENT_TAG.EDGE_ADDED, bytes: edgeAddedPayload(1n, 2n) });

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
      { parent: 0, firstChild: null, nextSibling: 2, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 2n) },
      { parent: 0, firstChild: null, nextSibling: 3, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(2n, 3n) },
      { parent: 0, firstChild: null, nextSibling: null, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(3n, 4n) },
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
    expect(decodeRecursiveBacktrackerEvent(RECURSIVE_BACKTRACKER_EVENT_TAG.VERTEX_SELECTED, vertexPayload(7n))).toEqual({ kind: "VertexSelected", id: 7n });
  });

  it("decodes CandidateChosen", () => {
    expect(decodeRecursiveBacktrackerEvent(RECURSIVE_BACKTRACKER_EVENT_TAG.CANDIDATE_CHOSEN, vertexPayload(7n))).toEqual({ kind: "CandidateChosen", id: 7n });
  });
});

describe("decodeRecursiveBacktrackerEvent — malformed payload handling", () => {
  it("throws on an unknown tag", () => {
    expect(() => decodeRecursiveBacktrackerEvent(99, new Uint8Array(0))).toThrow();
  });

  it("throws when a fixed-size event's payload_len doesn't match, for every fixed-size variant", () => {
    expect(() => decodeRecursiveBacktrackerEvent(RECURSIVE_BACKTRACKER_EVENT_TAG.VERTEX_SELECTED, new Uint8Array(7))).toThrow();
    expect(() => decodeRecursiveBacktrackerEvent(RECURSIVE_BACKTRACKER_EVENT_TAG.CANDIDATE_CHOSEN, new Uint8Array(7))).toThrow();
    expect(() => decodeRecursiveBacktrackerEvent(RECURSIVE_BACKTRACKER_EVENT_TAG.VERTEX_VISITED, new Uint8Array(7))).toThrow();
    expect(() => decodeRecursiveBacktrackerEvent(RECURSIVE_BACKTRACKER_EVENT_TAG.VERTEX_POPPED, new Uint8Array(7))).toThrow();
    expect(() => decodeRecursiveBacktrackerEvent(RECURSIVE_BACKTRACKER_EVENT_TAG.VERTEX_PUSHED, new Uint8Array(7))).toThrow();
    expect(() => decodeRecursiveBacktrackerEvent(RECURSIVE_BACKTRACKER_EVENT_TAG.EDGE_ADDED, new Uint8Array(15))).toThrow();
    expect(() => decodeRecursiveBacktrackerEvent(RECURSIVE_BACKTRACKER_EVENT_TAG.DEAD_END, new Uint8Array(1))).toThrow();
  });

  it("throws when CandidatesComputed's payload is shorter than the 4-byte length prefix", () => {
    expect(() => decodeRecursiveBacktrackerEvent(RECURSIVE_BACKTRACKER_EVENT_TAG.CANDIDATES_COMPUTED, new Uint8Array(2))).toThrow();
  });

  it("throws when CandidatesComputed's payload_len doesn't match 4 + count*8", () => {
    const malformed = concatBytes([u32le(2), u64le(1n)]); // claims 2 ids, only provides 1
    expect(() => decodeRecursiveBacktrackerEvent(RECURSIVE_BACKTRACKER_EVENT_TAG.CANDIDATES_COMPUTED, malformed)).toThrow();
  });

  it("decodes a well-formed CandidatesComputed payload", () => {
    const payload = candidatesComputedPayload([10n, 20n, 30n]);
    const event = decodeRecursiveBacktrackerEvent(RECURSIVE_BACKTRACKER_EVENT_TAG.CANDIDATES_COMPUTED, payload);
    expect(event).toEqual({ kind: "CandidatesComputed", ids: [10n, 20n, 30n] });
  });

  it("decodes an empty CandidatesComputed payload (count=0)", () => {
    const event = decodeRecursiveBacktrackerEvent(RECURSIVE_BACKTRACKER_EVENT_TAG.CANDIDATES_COMPUTED, candidatesComputedPayload([]));
    expect(event).toEqual({ kind: "CandidatesComputed", ids: [] });
  });
});

describe("mutatingRbEvents — bounded scan", () => {
  it("limit stops the scan early without decoding the rest of the tape", () => {
    const tape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: null, nextSibling: 2, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 2n) },
      { parent: 0, firstChild: null, nextSibling: 3, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(2n, 3n) },
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
      { parent: 0, firstChild: null, nextSibling: null, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 2n, false) },
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

// --- Intermediate snapshot checkpoints (GitHub issue #128) ---
// Snapshots are now computed entirely on the web side by `resolveDebugArenaMetadata`, from the
// plain event tape — there is no separate checkpoint buffer to decode. `CHECKPOINT_INTERVAL` is
// an internal constant (500 mutating events); these tests build a long flat chain of `EdgeAdded`
// events to actually cross that threshold.

/** A flat tape (no scopes beyond root) of `count` sequential `EdgeAdded` events,
 *  `i -> i+1` for `i` in `[1, count]` — long enough to exercise `resolveDebugArenaMetadata`'s
 *  internal `CHECKPOINT_INTERVAL` pacing when `count >= 500`. */
function buildLongEdgeChainTape(count: number): ParsedTape {
  return buildLongChainTape(count, RECURSIVE_BACKTRACKER_EVENT_TAG.EDGE_ADDED, (i) => edgeAddedPayload(BigInt(i + 1), BigInt(i + 2), false));
}

/** Convenience wrapper mirroring `RB_ADAPTER.resolveMetadata` (`algorithmRegistry.ts`) — every
 *  test in this `describe` block exercises RB through the same generic `resolveDebugArenaMetadata`
 *  production code actually calls it with, rather than a bespoke RB-only helper. */
function resolveRbMetadata(tape: ParsedTape, startIndex = 0, endIndex = tape.nodeCount) {
  return resolveDebugArenaMetadata<ApplyResult>(
    tape,
    (t, s, e) => countMutatingEvents(t, decodeRecursiveBacktrackerEvent, isMutatingRecursiveBacktrackerEvent, s, e),
    (step, previous) => applyRecursiveBacktracker(tape, step, previous, startIndex, endIndex),
    startIndex, endIndex,
  );
}

describe("resolveDebugArenaMetadata", () => {
  it("totalSteps matches mutatingRbEvents(tape).length and checkpointFroms is empty for a short run", () => {
    const tape = buildTwoStepTape();
    const { totalSteps, checkpointFroms } = resolveRbMetadata(tape);
    expect(totalSteps).toBe(mutatingRbEvents(tape).length);
    expect(checkpointFroms).toEqual([]);
  });

  it("totalSteps is 0 and checkpointFroms is empty for a tape with no mutating events", () => {
    const tape = buildFixture([
      { parent: null, firstChild: null, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    ]);
    const { totalSteps, checkpointFroms } = resolveRbMetadata(tape);
    expect(totalSteps).toBe(0);
    expect(checkpointFroms).toEqual([]);
  });

  it("caches a snapshot every CHECKPOINT_INTERVAL (500) mutating events", () => {
    const tape = buildLongEdgeChainTape(1000);
    const { totalSteps, checkpointFroms } = resolveRbMetadata(tape);
    expect(totalSteps).toBe(1000);
    expect(checkpointFroms.map((f) => f.step)).toEqual([499, 999]);
  });

  it("a cached snapshot's edges/step match a full replay to the same step", () => {
    const tape = buildLongEdgeChainTape(1000);
    const { checkpointFroms } = resolveRbMetadata(tape);
    const snapshot = checkpointFroms[0];
    const fromScratch = applyRecursiveBacktracker(tape, snapshot.step);
    expect(snapshot.result.edges).toEqual(fromScratch.edges);
  });

  it("a cached snapshot plugged into applyRecursiveBacktracker as `from` matches a full replay further ahead", () => {
    const tape = buildLongEdgeChainTape(1000);
    const { checkpointFroms } = resolveRbMetadata(tape);
    const [from] = checkpointFroms;

    const viaSnapshot = applyRecursiveBacktracker(tape, 999, from.result);
    const fromScratch = applyRecursiveBacktracker(tape, 999);
    expect(viaSnapshot.edges).toEqual(fromScratch.edges);
  });

  it("no snapshot is cached when the run is shorter than CHECKPOINT_INTERVAL", () => {
    const tape = buildLongEdgeChainTape(499);
    const { totalSteps, checkpointFroms } = resolveRbMetadata(tape);
    expect(totalSteps).toBe(499);
    expect(checkpointFroms).toEqual([]);
  });
});

// --- Kruskal (GitHub issue #146) ---

function rootsComparedPayload(rootA: bigint, rootB: bigint): Uint8Array {
  return concatBytes([u64le(rootA), u64le(rootB)]);
}

function rootsComparedFullPayload(from: bigint, to: bigint, rootOfFrom: bigint, rootOfTo: bigint): Uint8Array {
  return concatBytes([u64le(from), u64le(to), u64le(rootOfFrom), u64le(rootOfTo)]);
}

function presetUnionsAppliedPayload(pairs: [bigint, bigint, "basic" | "teleport"][]): Uint8Array {
  return concatBytes([
    u32le(pairs.length),
    ...pairs.flatMap(([a, b, kind]) => [u64le(a), u64le(b), new Uint8Array([kind === "teleport" ? 1 : 0])]),
  ]);
}

// Tree shape used by several tests below:
//   root (0)
//     -> PresetUnionsApplied([(1,2,basic)]) (1)
//     -> "edge 1" scope (2) -> EdgeSelected(1,3) (3) -> RootsCompared(1,3) (4) -> EdgeAdded(1,3) (5) -> SetsMerged(1,3) (6)
//     -> "edge 2" scope (7) -> EdgeSelected(3,1) (8) -> RootsCompared(1,1) (9) -> EdgeRejected (10)
function buildKruskalTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: null, nextSibling: 2, tag: KRUSKAL_EVENT_TAG.PRESET_UNIONS_APPLIED, payloadBytes: presetUnionsAppliedPayload([[1n, 2n, "basic"]]) },
    { parent: 0, firstChild: 3, nextSibling: 7, tag: TAG_SCOPE, payloadBytes: scopePayload("edge 1") },
    { parent: 2, firstChild: null, nextSibling: 4, tag: KRUSKAL_EVENT_TAG.EDGE_SELECTED, payloadBytes: rootsComparedPayload(1n, 3n) },
    { parent: 2, firstChild: null, nextSibling: 5, tag: KRUSKAL_EVENT_TAG.ROOTS_COMPARED, payloadBytes: rootsComparedFullPayload(1n, 3n, 1n, 3n) },
    { parent: 2, firstChild: null, nextSibling: 6, tag: KRUSKAL_EVENT_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 3n) },
    { parent: 2, firstChild: null, nextSibling: null, tag: KRUSKAL_EVENT_TAG.SETS_MERGED, payloadBytes: rootsComparedPayload(1n, 3n) },
    { parent: 0, firstChild: 8, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("edge 2") },
    { parent: 7, firstChild: null, nextSibling: 9, tag: KRUSKAL_EVENT_TAG.EDGE_SELECTED, payloadBytes: rootsComparedPayload(3n, 1n) },
    { parent: 7, firstChild: null, nextSibling: 10, tag: KRUSKAL_EVENT_TAG.ROOTS_COMPARED, payloadBytes: rootsComparedFullPayload(3n, 1n, 1n, 1n) },
    { parent: 7, firstChild: null, nextSibling: null, tag: KRUSKAL_EVENT_TAG.EDGE_REJECTED, payloadBytes: new Uint8Array(0) },
  ]);
}

describe("decodeKruskalEvent", () => {
  it("decodes EdgesShuffled (variable-length)", () => {
    const bytes = concatBytes([u32le(2), u64le(5n), u64le(9n), u64le(1n), u64le(2n)]);
    expect(decodeKruskalEvent(KRUSKAL_EVENT_TAG.EDGES_SHUFFLED, bytes)).toEqual({
      kind: "EdgesShuffled", edges: [[5n, 9n], [1n, 2n]],
    });
  });

  it("decodes EdgeSelected (16 bytes)", () => {
    expect(decodeKruskalEvent(KRUSKAL_EVENT_TAG.EDGE_SELECTED, rootsComparedPayload(1n, 3n))).toEqual({
      kind: "EdgeSelected", from: 1n, to: 3n,
    });
  });

  it("decodes RootsCompared (32 bytes)", () => {
    expect(decodeKruskalEvent(KRUSKAL_EVENT_TAG.ROOTS_COMPARED, rootsComparedFullPayload(1n, 3n, 1n, 3n))).toEqual({
      kind: "RootsCompared", from: 1n, to: 3n, rootOfFrom: 1n, rootOfTo: 3n,
    });
  });

  it("decodes SetsMerged (16 bytes)", () => {
    expect(decodeKruskalEvent(KRUSKAL_EVENT_TAG.SETS_MERGED, rootsComparedPayload(1n, 3n))).toEqual({
      kind: "SetsMerged", rootA: 1n, rootB: 3n,
    });
  });

  it("decodes EdgeRejected (0 bytes)", () => {
    expect(decodeKruskalEvent(KRUSKAL_EVENT_TAG.EDGE_REJECTED, new Uint8Array(0))).toEqual({
      kind: "EdgeRejected",
    });
  });

  it("decodes EdgeAdded (17 bytes)", () => {
    expect(decodeKruskalEvent(KRUSKAL_EVENT_TAG.EDGE_ADDED, edgeAddedPayload(1n, 3n))).toEqual({
      kind: "EdgeAdded", from: 1n, to: 3n, bidirectional: true,
    });
  });

  it("decodes PresetUnionsApplied (variable-length)", () => {
    expect(decodeKruskalEvent(
      KRUSKAL_EVENT_TAG.PRESET_UNIONS_APPLIED,
      presetUnionsAppliedPayload([[1n, 2n, "basic"], [4n, 5n, "teleport"]]),
    )).toEqual({
      kind: "PresetUnionsApplied", pairs: [[1n, 2n, "basic"], [4n, 5n, "teleport"]],
    });
  });

  it("throws on an unknown wire tag", () => {
    expect(() => decodeKruskalEvent(99, new Uint8Array(0))).toThrow(/unknown wire tag/);
  });

  it("throws on a payload_len mismatch", () => {
    expect(() => decodeKruskalEvent(KRUSKAL_EVENT_TAG.EDGE_ADDED, new Uint8Array(5))).toThrow(/payload_len/);
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
    // PresetUnionsApplied([(1,2,basic)]) seeds edges with its own directed pair (GitHub issue
    // #193) before EdgeAdded(1,3)'s own bidirectional contribution.
    expect(step0.edges).toEqual([
      { from: 1n, to: 2n, kind: "basic" },
      { from: 1n, to: 3n }, { from: 3n, to: 1n },
    ]);
    // dsuGroups starts from PresetUnionsApplied([(1,2,basic)]) then EdgeAdded's own find(1)/find(3)
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

  it("GitHub issue #193: seeds a preset teleport's PresetUnionsApplied pair into edges with kind \"teleport\"", () => {
    const tape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: null, nextSibling: 2, tag: KRUSKAL_EVENT_TAG.PRESET_UNIONS_APPLIED, payloadBytes: presetUnionsAppliedPayload([[1n, 2n, "teleport"]]) },
      { parent: 0, firstChild: 3, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("edge 1") },
      { parent: 2, firstChild: null, nextSibling: 4, tag: KRUSKAL_EVENT_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(3n, 4n) },
      { parent: 2, firstChild: null, nextSibling: null, tag: KRUSKAL_EVENT_TAG.SETS_MERGED, payloadBytes: rootsComparedPayload(3n, 4n) },
    ]);
    const result = applyKruskal(tape, 0);
    expect(result.edges).toEqual([
      { from: 1n, to: 2n, kind: "teleport" },
      { from: 3n, to: 4n }, { from: 4n, to: 3n },
    ]);
  });

  it("without any PresetUnionsApplied event, dsuGroups starts from singleton sets", () => {
    const tape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("edge 1") },
      { parent: 1, firstChild: null, nextSibling: 3, tag: KRUSKAL_EVENT_TAG.ROOTS_COMPARED, payloadBytes: rootsComparedFullPayload(1n, 2n, 1n, 2n) },
      { parent: 1, firstChild: null, nextSibling: 4, tag: KRUSKAL_EVENT_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 2n) },
      { parent: 1, firstChild: null, nextSibling: null, tag: KRUSKAL_EVENT_TAG.SETS_MERGED, payloadBytes: rootsComparedPayload(1n, 2n) },
    ]);
    const result = applyKruskal(tape, 1);
    expect(result.dsuGroups.get(1n)).toBe(1n);
    expect(result.dsuGroups.get(2n)).toBe(1n);
  });

  it("GitHub issue #227: finds PresetUnionsApplied when Kruskal isn't the tape's first top-level source (multi-source tape, #169/#225)", () => {
    // merged root (0)
    //   -> "preset_setup" wrapper (1) -> some unrelated preset-setup event (2)
    //   -> "generation" wrapper (3) -> PresetUnionsApplied([(1,2,basic)]) (4)
    //        -> "edge 1" scope (5) -> EdgeAdded(1,3) (6) -> SetsMerged(1,3) (7)
    const tape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("merged root") },
      { parent: 0, firstChild: 2, nextSibling: 3, tag: TAG_SCOPE, payloadBytes: scopePayload("preset_setup") },
      { parent: 1, firstChild: null, nextSibling: null, tag: KRUSKAL_EVENT_TAG.EDGE_REJECTED, payloadBytes: new Uint8Array(0) },
      { parent: 0, firstChild: 4, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("generation") },
      { parent: 3, firstChild: null, nextSibling: 5, tag: KRUSKAL_EVENT_TAG.PRESET_UNIONS_APPLIED, payloadBytes: presetUnionsAppliedPayload([[1n, 2n, "basic"]]) },
      { parent: 3, firstChild: 6, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("edge 1") },
      { parent: 5, firstChild: null, nextSibling: 7, tag: KRUSKAL_EVENT_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 3n) },
      { parent: 5, firstChild: null, nextSibling: null, tag: KRUSKAL_EVENT_TAG.SETS_MERGED, payloadBytes: rootsComparedPayload(1n, 3n) },
    ]);
    // Kruskal's own source content starts at node 4 (the "generation" wrapper's firstChild).
    const result = applyKruskal(tape, 0, undefined, 4, tape.nodeCount);
    expect(result.dsuGroups.get(1n)).toBe(1n);
    expect(result.dsuGroups.get(2n)).toBe(1n);
    expect(result.edges).toContainEqual({ from: 1n, to: 2n, kind: "basic" });
  });

  it("resuming from a previous result (GitHub issue #128's generalization) matches a full replay to the same targetStep", () => {
    const tape = buildKruskalTape();
    const from = applyKruskal(tape, 0);
    const viaResume = applyKruskal(tape, 1, from);
    const fromScratch = applyKruskal(tape, 1);
    expect(viaResume).toEqual(fromScratch);
  });

  describe("end-to-end through resolveDebugArenaMetadata on a long chain (GitHub issue #128)", () => {
    /** A flat tape of `count` sequential `EdgeAdded` events, `i -> i+1` for `i` in `[1, count]`
     *  (mirrors `buildLongEdgeChainTape` above, RB-tag'd) — `EdgeAdded` alone is mutating for
     *  Kruskal, so this is enough to cross `CHECKPOINT_INTERVAL` without a real DSU-merge shape. */
    function buildLongKruskalChainTape(count: number): ParsedTape {
      return buildLongChainTape(count, KRUSKAL_EVENT_TAG.EDGE_ADDED, (i) => edgeAddedPayload(BigInt(i + 1), BigInt(i + 2)));
    }

    const resolveKruskalMetadata = makeMetadataResolver<ReturnType<typeof decodeKruskalEvent>, KruskalApplyResult>(
      decodeKruskalEvent, isMutatingKruskalEvent, applyKruskal,
    );

    it("caches a snapshot every CHECKPOINT_INTERVAL (500) mutating events, each matching a full replay to that step", () => {
      const tape = buildLongKruskalChainTape(1000);
      const { totalSteps, checkpointFroms } = resolveKruskalMetadata(tape);
      expect(totalSteps).toBe(1000);
      expect(checkpointFroms.map((f) => f.step)).toEqual([499, 999]);
      for (const snapshot of checkpointFroms) {
        expect(snapshot.result).toEqual(applyKruskal(tape, snapshot.step));
      }
    });

    it("chaining resume through two successive snapshots matches a from-scratch replay at the end", () => {
      const tape = buildLongKruskalChainTape(1000);
      const { checkpointFroms } = resolveKruskalMetadata(tape);
      const [first, second] = checkpointFroms;
      expect(second.result).toEqual(applyKruskal(tape, second.step, first.result));
      expect(second.result).toEqual(applyKruskal(tape, second.step));
    });
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
    { parent: 1, firstChild: null, nextSibling: 3, tag: WILSON_EVENT_TAG.WALK_START_PICKED, payloadBytes: vertexPayload(5n) },
    { parent: 1, firstChild: 4, nextSibling: 6, tag: TAG_SCOPE, payloadBytes: scopePayload("step 1") },
    { parent: 3, firstChild: null, nextSibling: 5, tag: WILSON_EVENT_TAG.STEP_TAKEN, payloadBytes: stepTakenPayload(5n, 3n) },
    { parent: 3, firstChild: null, nextSibling: null, tag: WILSON_EVENT_TAG.LOOP_ERASED, payloadBytes: vertexPayload(3n) },
    { parent: 1, firstChild: 7, nextSibling: 8, tag: TAG_SCOPE, payloadBytes: scopePayload("step 2") },
    { parent: 6, firstChild: null, nextSibling: null, tag: WILSON_EVENT_TAG.STEP_TAKEN, payloadBytes: stepTakenPayload(3n, 1n) },
    { parent: 1, firstChild: null, nextSibling: 9, tag: WILSON_EVENT_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(5n, 3n) },
    { parent: 1, firstChild: null, nextSibling: 10, tag: WILSON_EVENT_TAG.NODE_VISITED, payloadBytes: vertexPayload(5n) },
    { parent: 1, firstChild: null, nextSibling: 11, tag: WILSON_EVENT_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(3n, 1n) },
    { parent: 1, firstChild: null, nextSibling: null, tag: WILSON_EVENT_TAG.NODE_VISITED, payloadBytes: vertexPayload(3n) },
  ]);
}

describe("decodeWilsonEvent", () => {
  it("decodes StartVisited (8 bytes)", () => {
    expect(decodeWilsonEvent(WILSON_EVENT_TAG.START_VISITED, vertexPayload(5n))).toEqual({
      kind: "StartVisited", id: 5n,
    });
  });

  it("decodes WalkStartPicked (8 bytes)", () => {
    expect(decodeWilsonEvent(WILSON_EVENT_TAG.WALK_START_PICKED, vertexPayload(5n))).toEqual({
      kind: "WalkStartPicked", id: 5n,
    });
  });

  it("decodes StepTaken (16 bytes)", () => {
    expect(decodeWilsonEvent(WILSON_EVENT_TAG.STEP_TAKEN, stepTakenPayload(5n, 3n))).toEqual({
      kind: "StepTaken", from: 5n, to: 3n,
    });
  });

  it("decodes LoopErased (8 bytes)", () => {
    expect(decodeWilsonEvent(WILSON_EVENT_TAG.LOOP_ERASED, vertexPayload(3n))).toEqual({
      kind: "LoopErased", node: 3n,
    });
  });

  it("decodes WalkDeadEnd (0 bytes)", () => {
    expect(decodeWilsonEvent(WILSON_EVENT_TAG.WALK_DEAD_END, new Uint8Array(0))).toEqual({
      kind: "WalkDeadEnd",
    });
  });

  it("decodes EdgeAdded (17 bytes)", () => {
    expect(decodeWilsonEvent(WILSON_EVENT_TAG.EDGE_ADDED, edgeAddedPayload(5n, 3n))).toEqual({
      kind: "EdgeAdded", from: 5n, to: 3n, bidirectional: true,
    });
  });

  it("decodes NodeVisited (8 bytes)", () => {
    expect(decodeWilsonEvent(WILSON_EVENT_TAG.NODE_VISITED, vertexPayload(5n))).toEqual({
      kind: "NodeVisited", id: 5n,
    });
  });

  it("throws on an unknown wire tag", () => {
    expect(() => decodeWilsonEvent(99, new Uint8Array(0))).toThrow(/unknown wire tag/);
  });

  it("throws on a payload_len mismatch", () => {
    expect(() => decodeWilsonEvent(WILSON_EVENT_TAG.EDGE_ADDED, new Uint8Array(5))).toThrow(/payload_len/);
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

  it("resuming from a previous result (GitHub issue #128's generalization) matches a full replay to the same targetStep, across edges/debugValues/debugMaps/debugVertices", () => {
    const tape = buildWilsonTape();
    const from = applyWilson(tape, 4); // WalkStartPicked, StepTaken x2, LoopErased, EdgeAdded
    const viaResume = applyWilson(tape, 7, from); // + NodeVisited, EdgeAdded, NodeVisited
    const fromScratch = applyWilson(tape, 7);
    expect(viaResume).toEqual(fromScratch);
  });

  describe("end-to-end through resolveDebugArenaMetadata on a long chain (GitHub issue #128)", () => {
    /** A flat tape of `count` sequential `NodeVisited(i)` events — `NodeVisited` alone is
     *  mutating for Wilson and inserts into the "visited" (Region-kind) debug value, exercising
     *  the presence-Set resume path this issue's Wilson fix specifically targeted. */
    function buildLongWilsonChainTape(count: number): ParsedTape {
      return buildLongChainTape(count, WILSON_EVENT_TAG.NODE_VISITED, (i) => vertexPayload(BigInt(i + 1)));
    }

    const resolveWilsonMetadata = makeMetadataResolver<ReturnType<typeof decodeWilsonEvent>, WilsonApplyResult>(
      decodeWilsonEvent, isMutatingWilsonEvent, applyWilson,
    );

    it("caches a snapshot every CHECKPOINT_INTERVAL (500) mutating events, each matching a full replay to that step", () => {
      const tape = buildLongWilsonChainTape(1000);
      const { totalSteps, checkpointFroms } = resolveWilsonMetadata(tape);
      expect(totalSteps).toBe(1000);
      expect(checkpointFroms.map((f) => f.step)).toEqual([499, 999]);
      for (const snapshot of checkpointFroms) {
        expect(snapshot.result).toEqual(applyWilson(tape, snapshot.step));
      }
      // The 500th distinct id (index 499, 1-based node id 500) must be present in the first
      // snapshot's "visited" list — pins down that presence-Set resume didn't silently drop it.
      expect(checkpointFroms[0].result.debugValues.get("visited")).toHaveLength(500);
    });

    it("chaining resume through two successive snapshots matches a from-scratch replay at the end", () => {
      const tape = buildLongWilsonChainTape(1000);
      const { checkpointFroms } = resolveWilsonMetadata(tape);
      const [first, second] = checkpointFroms;
      expect(second.result).toEqual(applyWilson(tape, second.step, first.result));
      expect(second.result).toEqual(applyWilson(tape, second.step));
    });
  });
});

// --- Shared payload-encoding helpers (used by CustomVertexBased fixtures below) ---

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


function candidatePoolBuiltPayload(src: bigint, geometric: boolean, candidates: bigint[]): Uint8Array {
  return concatBytes([u64le(src), boolByte(geometric), nodeIdListPayload(candidates)]);
}

// --- CustomVertexBased (GitHub issue #143) ---

function optionalReasonByte(v: boolean): Uint8Array {
  return boolByte(v);
}

// Small deterministic tree — one "step 1" scope, mirroring the smallest exact-sequence shape from
// the Rust-side `vertex_based_single_step_emits_exact_event_sequence` test (a 1x2 field's first
// step — corridor_chance = 1.0, teleport/cyclic disabled):
//   root (0)
//     -> "step 1" scope (1)
//          -> SrcChosenFromFrontier(src=1) (2)
//          -> TeleportRolled(src=1, fired=false) (3)
//          -> CyclicRolled(src=1, fired=false) (4)
//          -> CorridorRolled(isCorridor=true) (5)
//          -> CandidateChosen(1,2) (6)
//          -> EdgeAdded(1,2) (7)
//          -> NodeVisited(2, parent=1) (8)
function buildVertexBasedTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step 1") },
    {
      parent: 1, firstChild: null, nextSibling: 3, tag: VERTEX_BASED_EVENT_TAG.SRC_CHOSEN_FROM_FRONTIER,
      payloadBytes: concatBytes([u64le(1n), u32le(1), u32le(0), f64le(0.0)]),
    },
    {
      parent: 1, firstChild: null, nextSibling: 4, tag: VERTEX_BASED_EVENT_TAG.TELEPORT_ROLLED,
      payloadBytes: concatBytes([u64le(1n), f64le(0.8), f64le(0.0), boolByte(false)]),
    },
    {
      parent: 1, firstChild: null, nextSibling: 5, tag: VERTEX_BASED_EVENT_TAG.CYCLIC_ROLLED,
      payloadBytes: concatBytes([u64le(1n), f64le(0.7), f64le(0.0), boolByte(false)]),
    },
    {
      parent: 1, firstChild: null, nextSibling: 6, tag: VERTEX_BASED_EVENT_TAG.CORRIDOR_ROLLED,
      payloadBytes: concatBytes([f64le(0.1), f64le(1.0), boolByte(true)]),
    },
    {
      parent: 1, firstChild: null, nextSibling: 7, tag: VERTEX_BASED_EVENT_TAG.CANDIDATE_CHOSEN,
      payloadBytes: concatBytes([u64le(1n), u64le(2n), boolByte(false)]),
    },
    {
      parent: 1, firstChild: null, nextSibling: 8, tag: VERTEX_BASED_EVENT_TAG.EDGE_ADDED,
      payloadBytes: concatBytes([u64le(1n), u64le(2n), boolByte(true)]),
    },
    { parent: 1, firstChild: null, nextSibling: null, tag: VERTEX_BASED_EVENT_TAG.NODE_VISITED, payloadBytes: concatBytes([u64le(2n), u64le(1n)]) },
  ]);
}

describe("decodeVertexBasedEvent", () => {
  it("decodes TeleportBridgeRolled (17 bytes)", () => {
    const payload = concatBytes([f64le(0.05), f64le(0.1), boolByte(true)]);
    expect(decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.TELEPORT_BRIDGE_ROLLED, payload)).toEqual({
      kind: "TeleportBridgeRolled", roll: 0.05, teleportChance: 0.1, fired: true,
    });
  });

  it("decodes TeleportBridgeAdded (17 bytes)", () => {
    const payload = concatBytes([u64le(1n), u64le(2n), boolByte(true)]);
    expect(decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.TELEPORT_BRIDGE_ADDED, payload)).toEqual({
      kind: "TeleportBridgeAdded", src: 1n, dst: 2n, bidirectional: true,
    });
  });

  it("decodes ReserveCandidateRejected (9 bytes)", () => {
    const payload = concatBytes([u64le(3n), optionalReasonByte(true)]);
    expect(decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.RESERVE_CANDIDATE_REJECTED, payload)).toEqual({
      kind: "ReserveCandidateRejected", node: 3n, alreadyVisited: true,
    });
  });

  it("decodes ReserveCandidateChosen (8 bytes)", () => {
    expect(decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.RESERVE_CANDIDATE_CHOSEN, u64le(3n))).toEqual({ kind: "ReserveCandidateChosen", node: 3n });
  });

  it("decodes ReserveExhausted (0 bytes)", () => {
    expect(decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.RESERVE_EXHAUSTED, new Uint8Array(0))).toEqual({ kind: "ReserveExhausted" });
  });

  it("decodes BridgeAdded (17 bytes)", () => {
    const payload = concatBytes([u64le(1n), u64le(2n), boolByte(false)]);
    expect(decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.BRIDGE_ADDED, payload)).toEqual({ kind: "BridgeAdded", src: 1n, dst: 2n, bidirectional: false });
  });

  it("decodes SrcChosenFromFrontier (24 bytes)", () => {
    const payload = concatBytes([u64le(1n), u32le(3), u32le(1), f64le(0.5)]);
    expect(decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.SRC_CHOSEN_FROM_FRONTIER, payload)).toEqual({
      kind: "SrcChosenFromFrontier", src: 1n, frontierLen: 3, position: 1, depthFirst: 0.5,
    });
  });

  it("decodes TeleportRolled (25 bytes)", () => {
    const payload = concatBytes([u64le(1n), f64le(0.05), f64le(0.1), boolByte(true)]);
    expect(decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.TELEPORT_ROLLED, payload)).toEqual({
      kind: "TeleportRolled", src: 1n, roll: 0.05, teleportChance: 0.1, fired: true,
    });
  });

  it("decodes CyclicRolled (25 bytes)", () => {
    const payload = concatBytes([u64le(1n), f64le(0.5), f64le(0.15), boolByte(false)]);
    expect(decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.CYCLIC_ROLLED, payload)).toEqual({
      kind: "CyclicRolled", src: 1n, roll: 0.5, cyclicity: 0.15, fired: false,
    });
  });

  it("decodes CyclicCandidatesComputed (variable length)", () => {
    expect(decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.CYCLIC_CANDIDATES_COMPUTED, candidatePoolBuiltPayload(1n, false, [4n]))).toEqual({
      kind: "CyclicCandidatesComputed", src: 1n, geometric: false, candidates: [4n],
    });
  });

  it("decodes CyclicEdgeAdded (18 bytes)", () => {
    const payload = concatBytes([u64le(1n), u64le(4n), boolByte(true), boolByte(false)]);
    expect(decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.CYCLIC_EDGE_ADDED, payload)).toEqual({
      kind: "CyclicEdgeAdded", src: 1n, dst: 4n, teleport: true, bidirectional: false,
    });
  });

  it("decodes CorridorRolled (17 bytes)", () => {
    const payload = concatBytes([f64le(0.2), f64le(0.3), boolByte(true)]);
    expect(decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.CORRIDOR_ROLLED, payload)).toEqual({
      kind: "CorridorRolled", roll: 0.2, corridorChance: 0.3, isCorridor: true,
    });
  });

  it("decodes CandidateChosen (17 bytes)", () => {
    const payload = concatBytes([u64le(1n), u64le(2n), boolByte(true)]);
    expect(decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.CANDIDATE_CHOSEN, payload)).toEqual({
      kind: "CandidateChosen", src: 1n, dst: 2n, usedDirectionality: true,
    });
  });

  it("decodes JunctionSlotRolled (21 bytes)", () => {
    const payload = concatBytes([u32le(2), f64le(0.3), f64le(0.5), boolByte(true)]);
    expect(decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.JUNCTION_SLOT_ROLLED, payload)).toEqual({
      kind: "JunctionSlotRolled", slot: 2, roll: 0.3, branching: 0.5, taken: true,
    });
  });

  it("decodes StartVisited (8 bytes)", () => {
    expect(decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.START_VISITED, u64le(1n))).toEqual({ kind: "StartVisited", node: 1n });
  });

  it("decodes SingleCandidateSkipsDirectionality (8 bytes)", () => {
    expect(decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.SINGLE_CANDIDATE_SKIPS_DIRECTIONALITY, u64le(7n))).toEqual({
      kind: "SingleCandidateSkipsDirectionality", node: 7n,
    });
  });

  it("decodes NoParentSkipsDirectionality (8 bytes)", () => {
    expect(decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.NO_PARENT_SKIPS_DIRECTIONALITY, u64le(4n))).toEqual({
      kind: "NoParentSkipsDirectionality", node: 4n,
    });
  });

  it("decodes DirectionalityRolled (18 bytes)", () => {
    const payload = concatBytes([f64le(0.1), f64le(0.4), boolByte(true), boolByte(false)]);
    expect(decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.DIRECTIONALITY_ROLLED, payload)).toEqual({
      kind: "DirectionalityRolled", roll: 0.1, directionality: 0.4, fired: true, straightFound: false,
    });
  });

  it("decodes JunctionCandidatesChosen (variable length)", () => {
    const payload = concatBytes([u64le(1n), nodeIdListPayload([2n, 3n])]);
    expect(decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.JUNCTION_CANDIDATES_CHOSEN, payload)).toEqual({
      kind: "JunctionCandidatesChosen", src: 1n, candidates: [2n, 3n],
    });
  });

  it("decodes EdgeAdded (17 bytes)", () => {
    const payload = concatBytes([u64le(1n), u64le(2n), boolByte(true)]);
    expect(decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.EDGE_ADDED, payload)).toEqual({ kind: "EdgeAdded", src: 1n, dst: 2n, bidirectional: true });
  });

  it("decodes PresetNeighborVisited (16 bytes)", () => {
    const payload = concatBytes([u64le(1n), u64le(2n)]);
    expect(decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.PRESET_NEIGHBOR_VISITED, payload)).toEqual({ kind: "PresetNeighborVisited", src: 1n, dst: 2n });
  });

  it("decodes TeleportConnectAdded (17 bytes)", () => {
    const payload = concatBytes([u64le(1n), u64le(2n), boolByte(false)]);
    expect(decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.TELEPORT_CONNECT_ADDED, payload)).toEqual({ kind: "TeleportConnectAdded", src: 1n, dst: 2n, bidirectional: false });
  });

  it("decodes NodeVisited (16 bytes)", () => {
    const payload = concatBytes([u64le(2n), u64le(1n)]);
    expect(decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.NODE_VISITED, payload)).toEqual({ kind: "NodeVisited", node: 2n, parent: 1n });
  });

  it("decodes NodeQueuedToReserve (8 bytes)", () => {
    expect(decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.NODE_QUEUED_TO_RESERVE, u64le(5n))).toEqual({ kind: "NodeQueuedToReserve", node: 5n });
  });

  it("throws on an unknown wire tag", () => {
    expect(() => decodeVertexBasedEvent(99, new Uint8Array(0))).toThrow(/unknown wire tag/);
  });

  it("throws on a payload_len mismatch", () => {
    expect(() => decodeVertexBasedEvent(VERTEX_BASED_EVENT_TAG.EDGE_ADDED, new Uint8Array(5))).toThrow(/payload_len/);
  });
});

describe("isMutatingVertexBasedEvent", () => {
  it("TeleportBridgeAdded/BridgeAdded/CyclicEdgeAdded/EdgeAdded/PresetNeighborVisited/TeleportConnectAdded/NodeVisited/NodeQueuedToReserve/ReserveCandidateChosen are mutating; every trace-only variant is not", () => {
    expect(isMutatingVertexBasedEvent({ kind: "TeleportBridgeAdded", src: 1n, dst: 2n, bidirectional: true })).toBe(true);
    expect(isMutatingVertexBasedEvent({ kind: "BridgeAdded", src: 1n, dst: 2n, bidirectional: true })).toBe(true);
    expect(isMutatingVertexBasedEvent({ kind: "CyclicEdgeAdded", src: 1n, dst: 2n, teleport: false, bidirectional: true })).toBe(true);
    expect(isMutatingVertexBasedEvent({ kind: "EdgeAdded", src: 1n, dst: 2n, bidirectional: true })).toBe(true);
    expect(isMutatingVertexBasedEvent({ kind: "PresetNeighborVisited", src: 1n, dst: 2n })).toBe(true);
    expect(isMutatingVertexBasedEvent({ kind: "TeleportConnectAdded", src: 1n, dst: 2n, bidirectional: true })).toBe(true);
    expect(isMutatingVertexBasedEvent({ kind: "NodeVisited", node: 2n, parent: 1n })).toBe(true);
    expect(isMutatingVertexBasedEvent({ kind: "NodeQueuedToReserve", node: 2n })).toBe(true);
    expect(isMutatingVertexBasedEvent({ kind: "ReserveCandidateChosen", node: 2n })).toBe(true);
    expect(isMutatingVertexBasedEvent({ kind: "StartVisited", node: 1n })).toBe(true);
    expect(isMutatingVertexBasedEvent({ kind: "SrcChosenFromFrontier", src: 1n, frontierLen: 1, position: 0, depthFirst: 0.5 })).toBe(true);

    expect(isMutatingVertexBasedEvent({ kind: "ReserveExhausted" })).toBe(false);
    expect(isMutatingVertexBasedEvent({ kind: "TeleportRolled", src: 1n, roll: 0.1, teleportChance: 0.2, fired: false })).toBe(false);
    expect(isMutatingVertexBasedEvent({ kind: "ReserveCandidateRejected", node: 1n, alreadyVisited: false })).toBe(false);
    expect(isMutatingVertexBasedEvent({ kind: "JunctionSlotRolled", slot: 1, roll: 0.1, branching: 0.5, taken: false })).toBe(false);
    expect(isMutatingVertexBasedEvent({ kind: "SingleCandidateSkipsDirectionality", node: 1n })).toBe(false);
    expect(isMutatingVertexBasedEvent({ kind: "NoParentSkipsDirectionality", node: 1n })).toBe(false);
    expect(isMutatingVertexBasedEvent({ kind: "DirectionalityRolled", roll: 0.1, directionality: 0.4, fired: true, straightFound: false })).toBe(false);
  });
});

describe("mutatingVertexBasedEvents / applyVertexBased", () => {
  it("skips scope nodes and trace-only events, keeping mutating ones in emission order", () => {
    const tape = buildVertexBasedTape();
    const events = mutatingVertexBasedEvents(tape);
    expect(events).toEqual([
      { kind: "SrcChosenFromFrontier", src: 1n, frontierLen: 1, position: 0, depthFirst: 0.0 },
      { kind: "EdgeAdded", src: 1n, dst: 2n, bidirectional: true },
      { kind: "NodeVisited", node: 2n, parent: 1n },
    ]);
  });

  it("reconstructs edges and visited/frontier/reserve debug values up to targetStep, replaying from the start every call", () => {
    const tape = buildVertexBasedTape();

    // Step 0: SrcChosenFromFrontier(src=1) — no edges yet, but "frontier" gets a map entry
    // (empty array) since the Remove delta fires even though 1 was never inserted first (a
    // no-op remove on the replay side, mirroring the Rust reserve-remove convention).
    const step0 = applyVertexBased(tape, 0);
    expect(step0.edges).toEqual([]);
    expect(step0.debugValues.get("frontier")).toEqual([]);
    expect(step0.step).toBe(0);

    const step1 = applyVertexBased(tape, 1); // + EdgeAdded(1,2), bidirectional, basic
    expect(step1.edges).toEqual([{ from: 1n, to: 2n, kind: "basic" }, { from: 2n, to: 1n, kind: "basic" }]);
    expect(step1.debugValues.get("visited")).toBeUndefined();
    expect(step1.step).toBe(1);

    const step2 = applyVertexBased(tape, 2); // + NodeVisited(2, parent=1)
    expect(step2.debugValues.get("visited")).toEqual([2n]);
    expect(step2.debugValues.get("frontier")).toEqual([2n]);
    // "reserve" gets a map entry (empty array) even though only a Remove delta ever touched it —
    // NodeVisited unconditionally reports a "reserve" Remove delta (see
    // vertexBasedDebugValueDeltasFor's doc comment), and the apply loop creates the per-name
    // array on first occurrence of a name regardless of op.
    expect(step2.debugValues.get("reserve")).toEqual([]);
    expect(step2.step).toBe(2);
  });

  it("throws when targetStep is out of range", () => {
    const tape = buildVertexBasedTape();
    expect(() => applyVertexBased(tape, 3)).toThrow(/out of range/);
  });

  it("resuming from a previous result (GitHub issue #128's generalization) matches a full replay to the same targetStep, across visited/frontier/reserve debug values", () => {
    const tape = buildVertexBasedTape();
    const from = applyVertexBased(tape, 0); // SrcChosenFromFrontier
    const viaResume = applyVertexBased(tape, 2, from); // + EdgeAdded, NodeVisited
    const fromScratch = applyVertexBased(tape, 2);
    expect(viaResume).toEqual(fromScratch);
  });

  describe("end-to-end through resolveDebugArenaMetadata on a long chain (GitHub issue #128)", () => {
    /** A flat tape of `count` sequential `NodeVisited(i, parent=i-1)` events — `NodeVisited`
     *  alone is mutating for VertexBased and touches all three of visited/frontier/reserve at
     *  once (insert/insert/remove), exercising the Set-per-name resume path built from
     *  `from.debugValues`. */
    function buildLongVertexBasedChainTape(count: number): ParsedTape {
      return buildLongChainTape(count, VERTEX_BASED_EVENT_TAG.NODE_VISITED, (i) => concatBytes([u64le(BigInt(i + 1)), u64le(BigInt(i))]));
    }

    const resolveVertexBasedMetadata = makeMetadataResolver<ReturnType<typeof decodeVertexBasedEvent>, VertexBasedApplyResult>(
      decodeVertexBasedEvent, isMutatingVertexBasedEvent, applyVertexBased,
    );

    it("caches a snapshot every CHECKPOINT_INTERVAL (500) mutating events, each matching a full replay to that step", () => {
      const tape = buildLongVertexBasedChainTape(1000);
      const { totalSteps, checkpointFroms } = resolveVertexBasedMetadata(tape);
      expect(totalSteps).toBe(1000);
      expect(checkpointFroms.map((f) => f.step)).toEqual([499, 999]);
      for (const snapshot of checkpointFroms) {
        expect(snapshot.result).toEqual(applyVertexBased(tape, snapshot.step));
      }
      expect(checkpointFroms[0].result.debugValues.get("visited")).toHaveLength(500);
    });

    it("chaining resume through two successive snapshots matches a from-scratch replay at the end", () => {
      const tape = buildLongVertexBasedChainTape(1000);
      const { checkpointFroms } = resolveVertexBasedMetadata(tape);
      const [first, second] = checkpointFroms;
      expect(second.result).toEqual(applyVertexBased(tape, second.step, first.result));
      expect(second.result).toEqual(applyVertexBased(tape, second.step));
    });
  });

  it("removes a node from reserve on NodeVisited even without a preceding ReserveCandidateChosen (the connected/free_preset/teleport-connect paths)", () => {
    // root (0) -> "step 1" scope (1) -> NodeQueuedToReserve(3) (2) -> NodeVisited(3, parent=1) (3)
    const tape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step 1") },
      { parent: 1, firstChild: null, nextSibling: 3, tag: VERTEX_BASED_EVENT_TAG.NODE_QUEUED_TO_RESERVE, payloadBytes: u64le(3n) },
      { parent: 1, firstChild: null, nextSibling: null, tag: VERTEX_BASED_EVENT_TAG.NODE_VISITED, payloadBytes: concatBytes([u64le(3n), u64le(1n)]) },
    ]);
    const result = applyVertexBased(tape, 1);
    expect(result.debugValues.get("reserve")).toEqual([]);
    expect(result.debugValues.get("visited")).toEqual([3n]);
  });

  it("tags reconstructed edges with kind: teleport for TeleportBridgeAdded/TeleportConnectAdded, and for a teleport-pool CyclicEdgeAdded", () => {
    // root (0) -> "step 1" scope (1) -> TeleportBridgeAdded(1,5,bidirectional=false) (2)
    const teleportBridgePayload = concatBytes([u64le(1n), u64le(5n), boolByte(false)]);
    const tape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step 1") },
      { parent: 1, firstChild: null, nextSibling: null, tag: VERTEX_BASED_EVENT_TAG.TELEPORT_BRIDGE_ADDED, payloadBytes: teleportBridgePayload },
    ]);
    const result = applyVertexBased(tape, 0);
    expect(result.edges).toEqual([{ from: 1n, to: 5n, kind: "teleport" }]);
  });
});

// --- Multi-source merge (GitHub issue #169): topLevelSourceScopes + tag namespace unpacking in
// nodeAt. Every tape produced by `event_log::merge_tapes` (maze-core/src/event_log/mod.rs) has
// this shape: node 0 is the merged root, its children are one top-level source scope per source
// (in order), each wrapping that source's own former root. Tags on non-scope nodes carry a
// source-index prefix in the high byte (`(sourceIndex << SOURCE_SHIFT) | localTag`); TAG_SCOPE is
// never namespaced.

/** Builds a two-source merged fixture: root (0) -> "generation" scope (1) -> former root (2)
 *  -> EdgeAdded (3, source_index 0, RB tag) -> "quality_control" scope (4) -> former root (5)
 *  -> EdgeAdded (6, source_index 1, Kruskal tag) — mirrors merge_tapes' real output shape,
 *  including the namespace prefix merge_tapes bakes into non-scope tags. */
function buildTwoSourceMergedTape(): ParsedTape {
  const rbLocalTag = RECURSIVE_BACKTRACKER_EVENT_TAG.EDGE_ADDED;
  const kruskalLocalTag = KRUSKAL_EVENT_TAG.EDGE_ADDED;
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: 4, tag: TAG_SCOPE, payloadBytes: scopePayload("generation") },
    { parent: 1, firstChild: 3, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 2, firstChild: null, nextSibling: null, tag: (0 << SOURCE_SHIFT) | rbLocalTag, payloadBytes: edgeAddedPayload(1n, 2n) },
    { parent: 0, firstChild: 5, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("quality_control") },
    { parent: 4, firstChild: 6, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 5, firstChild: null, nextSibling: null, tag: (1 << SOURCE_SHIFT) | kruskalLocalTag, payloadBytes: edgeAddedPayload(3n, 4n) },
  ]);
}

describe("topLevelSourceScopes", () => {
  it("walks the merged root's direct children in order", () => {
    const tape = buildTwoSourceMergedTape();
    expect(topLevelSourceScopes(tape)).toEqual([
      { scopeName: "generation", nodeIndex: 1 },
      { scopeName: "quality_control", nodeIndex: 4 },
    ]);
  });

  it("walks whatever the root's direct children actually are — this module's own single-source RB fixture is intentionally flat (not merge-wrapped), so it has two", () => {
    // buildTwoStepTape's root has two direct "step" scope children rather than one merge-added
    // wrapper scope — topLevelSourceScopes doesn't know or care whether a tape went through
    // merge_tapes; it's a pure "walk root's children" helper. The merge-wrapped shape is covered
    // by buildTwoSourceMergedTape above.
    const tape = buildTwoStepTape();
    const scopes = topLevelSourceScopes(tape);
    expect(scopes.map((s) => s.scopeName)).toEqual(["step", "step"]);
  });
});

describe("nodeAt — multi-source tag namespace unpacking", () => {
  it("unpacks source_index 0 to a zero source-mask nibble, tag numerically equal to the local tag", () => {
    const tape = buildTwoSourceMergedTape();
    const record = nodeAt(tape, 3); // the RB EdgeAdded node, source_index 0
    expect(record.sourceIndex).toBe(0);
    expect(record.tag).toBe(RECURSIVE_BACKTRACKER_EVENT_TAG.EDGE_ADDED);
  });

  it("unpacks source_index 1 to a nonzero source-mask nibble, stripping the prefix from the local tag", () => {
    const tape = buildTwoSourceMergedTape();
    const record = nodeAt(tape, 6); // the Kruskal EdgeAdded node, source_index 1
    expect(record.sourceIndex).toBe(1);
    expect(record.tag).toBe(KRUSKAL_EVENT_TAG.EDGE_ADDED);
  });

  it("never namespaces TAG_SCOPE nodes regardless of which source they belong to", () => {
    const tape = buildTwoSourceMergedTape();
    for (const index of [0, 1, 2, 4, 5]) {
      const record = nodeAt(tape, index);
      expect(record.tag).toBe(TAG_SCOPE);
      expect(record.sourceIndex).toBe(0);
    }
  });

  it("decoded event tags stay usable by the existing per-algorithm decoders even though two sources share the same local tag value", () => {
    const tape = buildTwoSourceMergedTape();
    const rbRecord = nodeAt(tape, 3);
    const rbBytes = tape.payload.subarray(rbRecord.payloadOffset, rbRecord.payloadOffset + rbRecord.payloadLen);
    expect(decodeRecursiveBacktrackerEvent(rbRecord.tag, rbBytes)).toEqual({ kind: "EdgeAdded", from: 1n, to: 2n, bidirectional: true });

    const kruskalRecord = nodeAt(tape, 6);
    const kruskalBytes = tape.payload.subarray(kruskalRecord.payloadOffset, kruskalRecord.payloadOffset + kruskalRecord.payloadLen);
    expect(decodeKruskalEvent(kruskalRecord.tag, kruskalBytes)).toEqual({ kind: "EdgeAdded", from: 3n, to: 4n, bidirectional: true });
  });

  it("SOURCE_MASK/LOCAL_TAG_MASK partition the full u16 tag space with no overlap", () => {
    expect(SOURCE_MASK & LOCAL_TAG_MASK).toBe(0);
    expect(SOURCE_MASK | LOCAL_TAG_MASK).toBe(0xffff);
  });
});
