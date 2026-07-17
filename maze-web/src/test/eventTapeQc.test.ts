import { describe, it, expect } from "vitest";
import {
  parseTape, nodeAt, nodeView, topLevelSourceScopes, sourceScopeForNode,
  decodeQcEvent, isMutatingQcEvent, mutatingQcEvents, mutatingQcEventsWithIndex, applyQc,
  decodeRecursiveBacktrackerEvent, mutatingRbEventsWithIndex, applyRecursiveBacktracker,
  resolveDebugArenaMetadata, countMutatingEvents,
  TAG_SCOPE, NO_NODE, RB_TAG, QC_TAG,
  type ParsedTape, type QcApplyResult,
} from "../debug/eventTape";
import { adapterFor, adapterForNode, adapterForKind, type ScopeTitleLookup } from "../debug/algorithmRegistry";
import { selectDebugMazeView } from "../store/debugSelectors";
import type { DebugArenaHandle } from "../store/storeTypes";

// --- Fixture encoder, mirroring eventTape.test.ts's own local encoder (same precedent: small
// enough not to be worth a shared test-util yet).

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

function strPayload(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  return concatBytes([u32le(bytes.length), bytes]);
}

function edgeAddedPayload(from: bigint, to: bigint, bidirectional = true): Uint8Array {
  return concatBytes([u64le(from), u64le(to), new Uint8Array([bidirectional ? 1 : 0])]);
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

// --- decodeQcEvent: round-trip coverage for every wire tag, mirroring decodeEdgeBasedEvent's
// test shape (eventTape.test.ts) — one it() per variant.

describe("decodeQcEvent", () => {
  it("decodes IterationStarted (4 bytes)", () => {
    expect(decodeQcEvent(QC_TAG.ITERATION_STARTED, u32le(2))).toEqual({ kind: "IterationStarted", iteration: 2 });
  });

  it("decodes CheckRan with issue: null", () => {
    const payload = concatBytes([strPayload("c1"), new Uint8Array([0])]);
    expect(decodeQcEvent(QC_TAG.CHECK_RAN, payload)).toEqual({ kind: "CheckRan", checkId: "c1", issue: null });
  });

  it("decodes CheckRan with issue present and IssuePayload::None and an empty details map", () => {
    const payload = concatBytes([strPayload("c1"), new Uint8Array([1]), strPayload("missing_endpoints"), new Uint8Array([0]), u32le(0)]);
    expect(decodeQcEvent(QC_TAG.CHECK_RAN, payload)).toEqual({
      kind: "CheckRan", checkId: "c1", issue: { issueKind: "missing_endpoints", payload: { kind: "None" }, details: new Map() },
    });
  });

  it("decodes CheckRan with IssuePayload::InvalidLoop and this check's own details", () => {
    // one entry: key "check1" -> one cycle -> one edge pair (1,2)
    const edgesMap = concatBytes([
      u32le(1), strPayload("check1"), u32le(1), u32le(1), u32le(1), u32le(2),
    ]);
    // details: 1 entry -> "threshold" = "10"
    const detailsMap = concatBytes([u32le(1), strPayload("threshold"), strPayload("10")]);
    const payload = concatBytes([strPayload("c1"), new Uint8Array([1]), strPayload("invalid_loop"), new Uint8Array([1]), edgesMap, detailsMap]);
    expect(decodeQcEvent(QC_TAG.CHECK_RAN, payload)).toEqual({
      kind: "CheckRan", checkId: "c1",
      issue: {
        issueKind: "invalid_loop", payload: { kind: "InvalidLoop", edges: new Map([["check1", [[[1n, 2n]]]]]) },
        details: new Map([["threshold", "10"]]),
      },
    });
  });

  it("decodes CheckRan with IssuePayload::RegionNeedsExpansion and an empty details map", () => {
    // one entry: key "check1" -> one region -> one node (5)
    const nodesMap = concatBytes([
      u32le(1), strPayload("check1"), u32le(1), u32le(1), u32le(5),
    ]);
    const payload = concatBytes([strPayload("c1"), new Uint8Array([1]), strPayload("region_needs_expansion"), new Uint8Array([2]), nodesMap, u32le(0)]);
    expect(decodeQcEvent(QC_TAG.CHECK_RAN, payload)).toEqual({
      kind: "CheckRan", checkId: "c1",
      issue: {
        issueKind: "region_needs_expansion", payload: { kind: "RegionNeedsExpansion", nodes: new Map([["check1", [[5n]]]]) },
        details: new Map(),
      },
    });
  });

  it("decodes IssuesMerged with IssuePayload::None and an empty details map", () => {
    const payload = concatBytes([strPayload("invalid_loop"), new Uint8Array([0]), u32le(0)]);
    expect(decodeQcEvent(QC_TAG.ISSUES_MERGED, payload)).toEqual({
      kind: "IssuesMerged", issueKind: "invalid_loop", payload: { kind: "None" }, details: new Map(),
    });
  });

  it("decodes IssuesMerged with IssuePayload::InvalidLoop and a details map keyed by contributing check instance id", () => {
    // one entry: key "check1" -> one cycle -> one edge pair (1,2)
    const edgesMap = concatBytes([
      u32le(1), strPayload("check1"), u32le(1), u32le(1), u32le(1), u32le(2),
    ]);
    // details: 1 contributing check ("check1") -> {"threshold": "10"}
    const detailsMap = concatBytes([u32le(1), strPayload("check1"), u32le(1), strPayload("threshold"), strPayload("10")]);
    const payload = concatBytes([strPayload("invalid_loop"), new Uint8Array([1]), edgesMap, detailsMap]);
    expect(decodeQcEvent(QC_TAG.ISSUES_MERGED, payload)).toEqual({
      kind: "IssuesMerged", issueKind: "invalid_loop",
      payload: { kind: "InvalidLoop", edges: new Map([["check1", [[[1n, 2n]]]]]) },
      details: new Map([["check1", new Map([["threshold", "10"]])]]),
    });
  });

  it("decodes IterationLimitReached (MaxIterations)", () => {
    expect(decodeQcEvent(QC_TAG.ITERATION_LIMIT_REACHED, new Uint8Array([0]))).toEqual({ kind: "IterationLimitReached", limit: "MaxIterations" });
  });

  it("decodes IterationLimitReached (TimeBudget)", () => {
    expect(decodeQcEvent(QC_TAG.ITERATION_LIMIT_REACHED, new Uint8Array([1]))).toEqual({ kind: "IterationLimitReached", limit: "TimeBudget" });
  });

  it("decodes DirectedEdgeAdded (16 bytes)", () => {
    expect(decodeQcEvent(QC_TAG.DIRECTED_EDGE_ADDED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "DirectedEdgeAdded", from: 1n, to: 2n });
  });

  it("decodes BidirectionalEdgeAdded (16 bytes)", () => {
    expect(decodeQcEvent(QC_TAG.BIDIRECTIONAL_EDGE_ADDED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "BidirectionalEdgeAdded", a: 1n, b: 2n });
  });

  it("decodes DirectedTeleportAdded (16 bytes)", () => {
    expect(decodeQcEvent(QC_TAG.DIRECTED_TELEPORT_ADDED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "DirectedTeleportAdded", from: 1n, to: 2n });
  });

  it("decodes BidirectionalTeleportAdded (16 bytes)", () => {
    expect(decodeQcEvent(QC_TAG.BIDIRECTIONAL_TELEPORT_ADDED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "BidirectionalTeleportAdded", a: 1n, b: 2n });
  });

  it("decodes EdgeRemoved (16 bytes — from/to, GitHub issue #171's follow-up fix)", () => {
    expect(decodeQcEvent(QC_TAG.EDGE_REMOVED, concatBytes([u64le(7n), u64le(8n)]))).toEqual({ kind: "EdgeRemoved", from: 7n, to: 8n });
  });

  it("decodes EdgeRemovedBetween (16 bytes)", () => {
    expect(decodeQcEvent(QC_TAG.EDGE_REMOVED_BETWEEN, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "EdgeRemovedBetween", from: 1n, to: 2n });
  });

  it("decodes TeleportRemovedWithReverse (16 bytes — from/to, GitHub issue #171's follow-up fix)", () => {
    expect(decodeQcEvent(QC_TAG.TELEPORT_REMOVED_WITH_REVERSE, concatBytes([u64le(3n), u64le(4n)]))).toEqual({ kind: "TeleportRemovedWithReverse", from: 3n, to: 4n });
  });

  it("decodes StartSet (8 bytes)", () => {
    expect(decodeQcEvent(QC_TAG.START_SET, u64le(1n))).toEqual({ kind: "StartSet", id: 1n });
  });

  it("decodes FinishSet (8 bytes)", () => {
    expect(decodeQcEvent(QC_TAG.FINISH_SET, u64le(2n))).toEqual({ kind: "FinishSet", id: 2n });
  });

  it("decodes every *Declined variant identically to its mutating mirror except the kind", () => {
    expect(decodeQcEvent(QC_TAG.DIRECTED_EDGE_DECLINED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "DirectedEdgeDeclined", from: 1n, to: 2n });
    expect(decodeQcEvent(QC_TAG.BIDIRECTIONAL_EDGE_DECLINED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "BidirectionalEdgeDeclined", a: 1n, b: 2n });
    expect(decodeQcEvent(QC_TAG.DIRECTED_TELEPORT_DECLINED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "DirectedTeleportDeclined", from: 1n, to: 2n });
    expect(decodeQcEvent(QC_TAG.BIDIRECTIONAL_TELEPORT_DECLINED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "BidirectionalTeleportDeclined", a: 1n, b: 2n });
    expect(decodeQcEvent(QC_TAG.EDGE_REMOVE_DECLINED, concatBytes([u64le(7n), u64le(8n)]))).toEqual({ kind: "EdgeRemoveDeclined", from: 7n, to: 8n });
    expect(decodeQcEvent(QC_TAG.EDGE_REMOVE_BETWEEN_DECLINED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "EdgeRemoveBetweenDeclined", from: 1n, to: 2n });
    expect(decodeQcEvent(QC_TAG.TELEPORT_REMOVE_WITH_REVERSE_DECLINED, concatBytes([u64le(3n), u64le(4n)]))).toEqual({ kind: "TeleportRemoveWithReverseDeclined", from: 3n, to: 4n });
    expect(decodeQcEvent(QC_TAG.START_SET_DECLINED, u64le(1n))).toEqual({ kind: "StartSetDeclined", id: 1n });
    expect(decodeQcEvent(QC_TAG.FINISH_SET_DECLINED, u64le(2n))).toEqual({ kind: "FinishSetDeclined", id: 2n });
  });

  it("decodes every *Proposed variant identically to its mutating mirror except the kind", () => {
    expect(decodeQcEvent(QC_TAG.DIRECTED_EDGE_PROPOSED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "DirectedEdgeProposed", from: 1n, to: 2n });
    expect(decodeQcEvent(QC_TAG.BIDIRECTIONAL_EDGE_PROPOSED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "BidirectionalEdgeProposed", a: 1n, b: 2n });
    expect(decodeQcEvent(QC_TAG.DIRECTED_TELEPORT_PROPOSED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "DirectedTeleportProposed", from: 1n, to: 2n });
    expect(decodeQcEvent(QC_TAG.BIDIRECTIONAL_TELEPORT_PROPOSED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "BidirectionalTeleportProposed", a: 1n, b: 2n });
    expect(decodeQcEvent(QC_TAG.EDGE_REMOVE_PROPOSED, concatBytes([u64le(7n), u64le(8n)]))).toEqual({ kind: "EdgeRemoveProposed", from: 7n, to: 8n });
    expect(decodeQcEvent(QC_TAG.EDGE_REMOVE_BETWEEN_PROPOSED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "EdgeRemoveBetweenProposed", from: 1n, to: 2n });
    expect(decodeQcEvent(QC_TAG.TELEPORT_REMOVE_WITH_REVERSE_PROPOSED, concatBytes([u64le(3n), u64le(4n)]))).toEqual({ kind: "TeleportRemoveWithReverseProposed", from: 3n, to: 4n });
    expect(decodeQcEvent(QC_TAG.START_SET_PROPOSED, u64le(1n))).toEqual({ kind: "StartSetProposed", id: 1n });
    expect(decodeQcEvent(QC_TAG.FINISH_SET_PROPOSED, u64le(2n))).toEqual({ kind: "FinishSetProposed", id: 2n });
  });

  it("throws on an unknown wire tag", () => {
    expect(() => decodeQcEvent(99, new Uint8Array(0))).toThrow(/unknown wire tag/);
  });

  it("throws on a payload_len mismatch for a fixed-size variant", () => {
    expect(() => decodeQcEvent(QC_TAG.START_SET, new Uint8Array(3))).toThrow(/payload_len/);
  });
});

describe("isMutatingQcEvent", () => {
  it("exactly the 9 mutation-mirror variants are mutating; every trace and *Declined variant is not", () => {
    expect(isMutatingQcEvent({ kind: "DirectedEdgeAdded", from: 1n, to: 2n })).toBe(true);
    expect(isMutatingQcEvent({ kind: "BidirectionalEdgeAdded", a: 1n, b: 2n })).toBe(true);
    expect(isMutatingQcEvent({ kind: "DirectedTeleportAdded", from: 1n, to: 2n })).toBe(true);
    expect(isMutatingQcEvent({ kind: "BidirectionalTeleportAdded", a: 1n, b: 2n })).toBe(true);
    expect(isMutatingQcEvent({ kind: "EdgeRemoved", from: 1n, to: 2n })).toBe(true);
    expect(isMutatingQcEvent({ kind: "EdgeRemovedBetween", from: 1n, to: 2n })).toBe(true);
    expect(isMutatingQcEvent({ kind: "TeleportRemovedWithReverse", from: 1n, to: 2n })).toBe(true);
    expect(isMutatingQcEvent({ kind: "StartSet", id: 1n })).toBe(true);
    expect(isMutatingQcEvent({ kind: "FinishSet", id: 1n })).toBe(true);

    expect(isMutatingQcEvent({ kind: "IterationStarted", iteration: 0 })).toBe(false);
    expect(isMutatingQcEvent({ kind: "CheckRan", checkId: "c", issue: null })).toBe(false);
    expect(isMutatingQcEvent({ kind: "IssuesMerged", issueKind: "invalid_loop", payload: { kind: "None" }, details: new Map() })).toBe(false);
    expect(isMutatingQcEvent({ kind: "IterationLimitReached", limit: "MaxIterations" })).toBe(false);
    expect(isMutatingQcEvent({ kind: "DirectedEdgeDeclined", from: 1n, to: 2n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "BidirectionalEdgeDeclined", a: 1n, b: 2n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "DirectedTeleportDeclined", from: 1n, to: 2n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "BidirectionalTeleportDeclined", a: 1n, b: 2n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "EdgeRemoveDeclined", from: 1n, to: 2n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "EdgeRemoveBetweenDeclined", from: 1n, to: 2n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "TeleportRemoveWithReverseDeclined", from: 1n, to: 2n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "StartSetDeclined", id: 1n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "FinishSetDeclined", id: 1n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "DirectedEdgeProposed", from: 1n, to: 2n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "BidirectionalEdgeProposed", a: 1n, b: 2n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "DirectedTeleportProposed", from: 1n, to: 2n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "BidirectionalTeleportProposed", a: 1n, b: 2n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "EdgeRemoveProposed", from: 1n, to: 2n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "EdgeRemoveBetweenProposed", from: 1n, to: 2n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "TeleportRemoveWithReverseProposed", from: 1n, to: 2n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "StartSetProposed", id: 1n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "FinishSetProposed", id: 1n })).toBe(false);
  });
});

// --- applyQc: apply-invariant coverage (mirrors applyEdgeBased's test shape) — a "stage s1" ->
// "iteration 1" -> "rule r1" tree with a mix of mutating and *Declined events, at a non-zero
// startNodeIndex (as it always is once merged after a generation source, Contract A).

// root (0) -> "generation" scope (1) -> RB former root (2) -> EdgeAdded(1,2) (3)
//          -> "quality_control" scope (4) -> QC former root (5)
//               -> "stage s1" scope (6) -> "iteration 1" scope (7)
//                    -> IterationStarted(0) (8)
//                    -> "rule r1" scope (9)
//                         -> StartSet(10) (10)
//                         -> FinishSet(20) (11)
//                         -> BidirectionalEdgeAdded(10,20) (12)
//                         -> EdgeRemovedBetween(1,2) (13)
//                         -> DirectedEdgeDeclined(30,40) (14)
function buildQcTwoSourceTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: 4, tag: TAG_SCOPE, payloadBytes: scopePayload("generation") },
    { parent: 1, firstChild: 3, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 2, firstChild: null, nextSibling: null, tag: RB_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 2n) },
    { parent: 0, firstChild: 5, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("quality_control") },
    { parent: 4, firstChild: 6, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 5, firstChild: 7, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("stage s1") },
    { parent: 6, firstChild: 8, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("iteration 1") },
    { parent: 7, firstChild: null, nextSibling: 9, tag: QC_TAG.ITERATION_STARTED, payloadBytes: u32le(0) },
    { parent: 7, firstChild: 10, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("rule r1") },
    { parent: 9, firstChild: null, nextSibling: 11, tag: QC_TAG.START_SET, payloadBytes: u64le(10n) },
    { parent: 9, firstChild: null, nextSibling: 12, tag: QC_TAG.FINISH_SET, payloadBytes: u64le(20n) },
    { parent: 9, firstChild: null, nextSibling: 13, tag: QC_TAG.BIDIRECTIONAL_EDGE_ADDED, payloadBytes: concatBytes([u64le(10n), u64le(20n)]) },
    { parent: 9, firstChild: null, nextSibling: 14, tag: QC_TAG.EDGE_REMOVED_BETWEEN, payloadBytes: concatBytes([u64le(1n), u64le(2n)]) },
    { parent: 9, firstChild: null, nextSibling: null, tag: QC_TAG.DIRECTED_EDGE_DECLINED, payloadBytes: concatBytes([u64le(30n), u64le(40n)]) },
  ]);
}

describe("mutatingQcEvents / applyQc", () => {
  it("skips scope nodes and trace/*Declined events, keeping mutating ones in emission order", () => {
    const tape = buildQcTwoSourceTape();
    // QC's own source starts at node 5 (its former root) — scanning from there skips generation's
    // EdgeAdded entirely, mirroring how applyQc is always called with the QC top-level scope's own
    // nodeIndex, never 0.
    const events = mutatingQcEvents(tape, undefined, 5);
    expect(events).toEqual([
      { kind: "StartSet", id: 10n },
      { kind: "FinishSet", id: 20n },
      { kind: "BidirectionalEdgeAdded", a: 10n, b: 20n },
      { kind: "EdgeRemovedBetween", from: 1n, to: 2n },
    ]);
  });

  it("accumulates edges/removedEdges/start/finish across steps, in emission order", () => {
    const tape = buildQcTwoSourceTape();
    const result = applyQc(tape, 3, undefined, 5);
    expect(result.start).toBe(10n);
    expect(result.finish).toBe(20n);
    expect(result.edges).toEqual([{ from: 10n, to: 20n, kind: "basic" }, { from: 20n, to: 10n, kind: "basic" }]);
    expect(result.removedEdges).toEqual([{ from: 1n, to: 2n }]);
    expect(result.step).toBe(3);
  });

  it("EdgeRemoved/TeleportRemovedWithReverse (resolved from,to — GitHub issue #171's follow-up fix) fold into the same keyed accumulator as EdgeRemovedBetween", () => {
    // root (0) -> BidirectionalEdgeAdded(1,2) (1) -> BidirectionalTeleportAdded(3,4) (2)
    //          -> EdgeRemoved(1,2) (3) -> TeleportRemovedWithReverse(3,4) (4)
    const tape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: null, nextSibling: 2, tag: QC_TAG.BIDIRECTIONAL_EDGE_ADDED, payloadBytes: concatBytes([u64le(1n), u64le(2n)]) },
      { parent: 0, firstChild: null, nextSibling: 3, tag: QC_TAG.BIDIRECTIONAL_TELEPORT_ADDED, payloadBytes: concatBytes([u64le(3n), u64le(4n)]) },
      { parent: 0, firstChild: null, nextSibling: 4, tag: QC_TAG.EDGE_REMOVED, payloadBytes: concatBytes([u64le(1n), u64le(2n)]) },
      { parent: 0, firstChild: null, nextSibling: null, tag: QC_TAG.TELEPORT_REMOVED_WITH_REVERSE, payloadBytes: concatBytes([u64le(3n), u64le(4n)]) },
    ]);
    const result = applyQc(tape, 3, undefined, 0);
    expect(result.edges).toEqual([{ from: 2n, to: 1n, kind: "basic" }, { from: 4n, to: 3n, kind: "teleport" }]);
    expect(result.removedEdges).toEqual([]);
  });

  it("a *Declined event advances the step count but contributes nothing to edges/removedEdges/start/finish", () => {
    // targetStep 4 doesn't exist for this fixture (only 4 mutating events, steps 0..3) — instead,
    // confirm the *Declined event at the end of the scan is skipped by scanning past it with a
    // higher limit and checking event count stays at 4, not 5.
    const tape = buildQcTwoSourceTape();
    const events = mutatingQcEventsWithIndex(tape, 10, 5);
    expect(events).toHaveLength(4);
  });

  it("throws when targetStep is out of range", () => {
    const tape = buildQcTwoSourceTape();
    expect(() => applyQc(tape, 4, undefined, 5)).toThrow(/out of range/);
  });

  it("resuming from a previous result (GitHub issue #128's generalization) matches a full replay to the same targetStep, across edges/removedEdges/start/finish", () => {
    const tape = buildQcTwoSourceTape();
    const from = applyQc(tape, 1, undefined, 5); // StartSet, FinishSet
    const viaResume = applyQc(tape, 3, from, 5); // + BidirectionalEdgeAdded, EdgeRemovedBetween
    const fromScratch = applyQc(tape, 3, undefined, 5);
    expect(viaResume).toEqual(fromScratch);
  });

  it("stops before reaching QC's own events when scanning generation's own source (startIndex bound)", () => {
    const tape = buildQcTwoSourceTape();
    // Scanning RB's own mutating events from node 2 (its former root), bounded to RB's own single
    // mutating event via `limit` — mirrors how a real caller always knows generation's own
    // totalSteps (Contract A) and never scans past it into QC's own tag space, where a numerically
    // colliding tag (QC_TAG.ITERATION_STARTED == RB_TAG.VERTEX_SELECTED == 1) would otherwise
    // mis-decode as an RB event.
    const rbEvents = mutatingRbEventsWithIndex(tape, 1, 2);
    expect(rbEvents).toHaveLength(1);
    expect(decodeRecursiveBacktrackerEvent(RB_TAG.EDGE_ADDED, tape.payload.subarray(
      nodeAt(tape, rbEvents[0].nodeIndex).payloadOffset,
      nodeAt(tape, rbEvents[0].nodeIndex).payloadOffset + nodeAt(tape, rbEvents[0].nodeIndex).payloadLen,
    ))).toEqual({ kind: "EdgeAdded", from: 1n, to: 2n, bidirectional: true });
  });

  describe("end-to-end through resolveDebugArenaMetadata on a long chain (GitHub issue #128)", () => {
    /** A flat tape of `count` sequential `DirectedEdgeAdded(i, i+1)` events, directly under root
     *  (no generation source prefix — `applyQc`'s own `startNodeIndex` defaults to 0, matching a
     *  from-scratch scan starting right at this tape's own first node). `DirectedEdgeAdded` alone
     *  is mutating for QC and exercises the `net`/`removedFromEarlierSources` keyed-accumulator
     *  resume path this issue's generalization added. */
    function buildLongQcChainTape(count: number): ParsedTape {
      const nodes: FixtureNode[] = [{ parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") }];
      for (let i = 0; i < count; i++) {
        nodes.push({
          parent: 0,
          firstChild: null,
          nextSibling: i + 1 < count ? i + 2 : null,
          tag: QC_TAG.DIRECTED_EDGE_ADDED,
          payloadBytes: concatBytes([u64le(BigInt(i + 1)), u64le(BigInt(i + 2))]),
        });
      }
      return buildFixture(nodes);
    }

    function resolveQcMetadata(tape: ParsedTape) {
      return resolveDebugArenaMetadata<QcApplyResult>(
        tape,
        (t, s, e) => countMutatingEvents(t, decodeQcEvent, isMutatingQcEvent, s, e),
        (step, previous) => applyQc(tape, step, previous, 0),
        0, tape.nodeCount,
      );
    }

    it("caches a snapshot every CHECKPOINT_INTERVAL (500) mutating events, each matching a full replay to that step", () => {
      const tape = buildLongQcChainTape(1000);
      const { totalSteps, checkpointFroms } = resolveQcMetadata(tape);
      expect(totalSteps).toBe(1000);
      expect(checkpointFroms.map((f) => f.step)).toEqual([499, 999]);
      for (const snapshot of checkpointFroms) {
        expect(snapshot.result).toEqual(applyQc(tape, snapshot.step, undefined, 0));
      }
      expect(checkpointFroms[0].result.edges).toHaveLength(500);
    });

    it("chaining resume through two successive snapshots matches a from-scratch replay at the end", () => {
      const tape = buildLongQcChainTape(1000);
      const { checkpointFroms } = resolveQcMetadata(tape);
      const [first, second] = checkpointFroms;
      expect(second.result).toEqual(applyQc(tape, second.step, first.result, 0));
      expect(second.result).toEqual(applyQc(tape, second.step, undefined, 0));
    });

    /** 600 `DirectedEdgeAdded(i, i+1)` events (steps 0..599, crossing the first CHECKPOINT_INTERVAL
     *  boundary at step 499), followed by `EdgeRemovedBetween` events removing edge 1 (added at
     *  step 0, well before the snapshot) and edge 550 (added at step 549, after the snapshot but
     *  before targetStep) — exercises `removedFromEarlierSources`/`net.delete` seeded from a
     *  resumed `from`, not just monotonic growth (GitHub issue #128's review follow-up: none of
     *  the other long-chain assertions ever remove or re-add an id after the snapshot point). */
    function buildQcChainWithRemovals(): ParsedTape {
      const nodes: FixtureNode[] = [{ parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") }];
      const addCount = 600;
      for (let i = 0; i < addCount; i++) {
        nodes.push({
          parent: 0, firstChild: null, nextSibling: i + 1,
          tag: QC_TAG.DIRECTED_EDGE_ADDED,
          payloadBytes: concatBytes([u64le(BigInt(i + 1)), u64le(BigInt(i + 2))]),
        });
      }
      // Remove edge (1,2) [added at step 0, before the snapshot] and edge (550,551) [added at
      // step 549, after the snapshot].
      nodes.push({
        parent: 0, firstChild: null, nextSibling: addCount + 2,
        tag: QC_TAG.EDGE_REMOVED_BETWEEN,
        payloadBytes: concatBytes([u64le(1n), u64le(2n)]),
      });
      nodes.push({
        parent: 0, firstChild: null, nextSibling: null,
        tag: QC_TAG.EDGE_REMOVED_BETWEEN,
        payloadBytes: concatBytes([u64le(550n), u64le(551n)]),
      });
      return buildFixture(nodes);
    }

    it("resuming from a snapshot correctly folds a later removal of an edge added before the snapshot", () => {
      const tape = buildQcChainWithRemovals();
      const { checkpointFroms } = resolveQcMetadata(tape);
      const [first] = checkpointFroms; // step 499, before either removal

      const lastStep = 601; // 600 adds (0..599) + 2 removals (600, 601)
      const viaResume = applyQc(tape, lastStep, first.result, 0);
      const fromScratch = applyQc(tape, lastStep, undefined, 0);
      expect(viaResume).toEqual(fromScratch);
      // Both removed pairs are gone from `edges`; (1,2) was added before the snapshot `first` was
      // taken from, so this also confirms the snapshot's own edges/net state resumed correctly.
      // Neither pair reaches `removedEdges` — both were added *within this same call's own scan*
      // (whether resumed from `first` or replayed from scratch), so removing them just cancels
      // the add out of `net` rather than crossing into "removed from an earlier source" territory
      // (see `applyQc`'s own doc comment on `removedEdges`' semantics).
      expect(fromScratch.edges.some((e) => e.from === 1n && e.to === 2n)).toBe(false);
      expect(fromScratch.edges.some((e) => e.from === 550n && e.to === 551n)).toBe(false);
      expect(fromScratch.removedEdges).toEqual([]);
    });
  });
});

// --- Contract B (sourceScopeForNode/adapterForNode) + a real two-source (generation + QC) arena,
// exercising the exact shape run_generate/merge_tapes produces (GitHub issue #147).

describe("sourceScopeForNode", () => {
  it("resolves a deeply-nested QC node to its own top-level source scope, not generation's", () => {
    const tape = buildQcTwoSourceTape();
    expect(sourceScopeForNode(tape, 12)).toEqual({ scopeName: "quality_control", nodeIndex: 4 });
  });

  it("resolves a generation node to the generation scope", () => {
    const tape = buildQcTwoSourceTape();
    expect(sourceScopeForNode(tape, 3)).toEqual({ scopeName: "generation", nodeIndex: 1 });
  });

  it("resolves a top-level scope node itself to itself", () => {
    const tape = buildQcTwoSourceTape();
    expect(sourceScopeForNode(tape, 4)).toEqual({ scopeName: "quality_control", nodeIndex: 4 });
  });

  it("throws for the merged root itself (node 0)", () => {
    const tape = buildQcTwoSourceTape();
    expect(() => sourceScopeForNode(tape, 0)).toThrow(/merged root/);
  });
});

describe("adapterForNode / adapterForKind — two-source dispatch (GitHub issue #147)", () => {
  it("dispatches a generation node to the recursive_backtracker adapter and a QC node to the quality_control adapter, from the same tape", () => {
    const tape = buildQcTwoSourceTape();
    const sourceEventKinds = ["recursive_backtracker" as const, "quality_control" as const];

    const rbAdapter = adapterForNode(tape, 3, sourceEventKinds);
    expect(rbAdapter).toBe(adapterFor("recursive_backtracker"));

    const qcAdapter = adapterForNode(tape, 12, sourceEventKinds);
    expect(qcAdapter).toBe(adapterFor("quality_control"));
  });

  it("adapterForKind resolves every EventedEventKind including quality_control", () => {
    expect(adapterForKind("quality_control")).toBe(adapterFor("quality_control"));
    expect(adapterForKind("recursive_backtracker")).toBe(adapterFor("recursive_backtracker"));
  });
});

describe("topLevelSourceScopes — real generation+QC merge shape", () => {
  it("lists both top-level source scopes in order", () => {
    const tape = buildQcTwoSourceTape();
    expect(topLevelSourceScopes(tape)).toEqual([
      { scopeName: "generation", nodeIndex: 1 },
      { scopeName: "quality_control", nodeIndex: 4 },
    ]);
  });
});

describe("applyRecursiveBacktracker / applyQc — full two-source replay, mirrors selectDebugMazeView's real dispatch", () => {
  it("replays generation's own step independently of QC's, from their own respective startNodeIndex", () => {
    const tape = buildQcTwoSourceTape();

    // Generation source: 1 mutating event (EdgeAdded), replayed from its own former root (node 2).
    const generationResult = applyRecursiveBacktracker(tape, 0);
    expect(generationResult.edges).toEqual([{ from: 1n, to: 2n }, { from: 2n, to: 1n }]);

    // QC source: 4 mutating events, replayed from its own former root (node 5) — must not include
    // or be affected by generation's own EdgeAdded, confirming the two sources stay independent
    // contributions (Contract C) even though both live in the same merged tape.
    const qcResult = applyQc(tape, 3, undefined, 5);
    expect(qcResult.edges).toEqual([{ from: 10n, to: 20n, kind: "basic" }, { from: 20n, to: 10n, kind: "basic" }]);
    expect(qcResult.removedEdges).toEqual([{ from: 1n, to: 2n }]);
  });
});

// --- QC_ADAPTER.scopeLabel / narrationTokensForQc — title resolution via ScopeTitleLookup
// (GitHub issue #147's raw-uuid regression: rule/stage titles must resolve through the live store
// lookup, quoted, both in the tree's scope labels and in narration text, not just one of the two).

describe("QC_ADAPTER.scopeLabel — stage/rule title resolution (GitHub issue #147)", () => {
  const titleLookup: ScopeTitleLookup = {
    stageTitle: (id) => (id === "s1" ? "Waypoints" : undefined),
    ruleTitle: (id) => (id === "r1" ? "No dead ends" : undefined),
    checkTypeId: () => undefined,
  };

  it("resolves a stage scope's title through titleLookup, quoted", () => {
    expect(adapterFor("quality_control").scopeLabel("stage s1", [], titleLookup)).toBe('Stage "Waypoints"');
  });

  it("resolves a rule scope's title through titleLookup, quoted", () => {
    expect(adapterFor("quality_control").scopeLabel("rule r1", [], titleLookup)).toBe('Rule "No dead ends"');
  });

  it("falls back to the raw id, quoted, when titleLookup doesn't recognize it", () => {
    expect(adapterFor("quality_control").scopeLabel("stage unknown", [], titleLookup)).toBe('Stage "unknown"');
  });

  it("falls back to the raw id, quoted, when titleLookup is absent entirely", () => {
    expect(adapterFor("quality_control").scopeLabel("rule r1", [])).toBe('Rule "r1"');
  });

  it("leaves an iteration scope's label untouched by titleLookup (no id to resolve)", () => {
    expect(adapterFor("quality_control").scopeLabel("iteration 2", [], titleLookup)).toBe("Iteration 2");
  });

  it("resolves a strategy scope's id to its registry display label, quoted, ignoring titleLookup (fixed, not per-instance, title)", () => {
    expect(adapterFor("quality_control").scopeLabel("strategy random_endpoints", [], titleLookup)).toBe('Strategy "Random endpoints"');
  });

  it("falls back to the raw strategy id, quoted, when the registry doesn't recognize it", () => {
    expect(adapterFor("quality_control").scopeLabel("strategy unknown_strategy", [], titleLookup)).toBe('Strategy "unknown_strategy"');
  });

  it("labels the fixed \"apply requests\" scope with no children as 0/0", () => {
    expect(adapterFor("quality_control").scopeLabel("apply requests", [], titleLookup)).toBe("Apply requests (0/0)");
  });

  it("tallies the \"apply requests\" scope's own applied/total count off its direct children", () => {
    // "apply requests" scope (0) -> StartSet(10) (1), DirectedEdgeDeclined(30,40) (2) -- 1 applied
    // (mutating StartSet) out of 2 total (StartSet + the *Declined event).
    const tape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("apply requests") },
      { parent: 0, firstChild: null, nextSibling: 2, tag: QC_TAG.START_SET, payloadBytes: u64le(10n) },
      { parent: 0, firstChild: null, nextSibling: null, tag: QC_TAG.DIRECTED_EDGE_DECLINED, payloadBytes: concatBytes([u64le(30n), u64le(40n)]) },
    ]);
    const children = nodeView(tape, 0).children();
    expect(adapterFor("quality_control").scopeLabel("apply requests", children, titleLookup)).toBe("Apply requests (1/2)");
  });
});

describe("narrationTokensForQc — CheckRan/IssuesMerged/*Proposed ignore titleLookup for stage/rule titles (GitHub issue #147, no dedicated dispatch-result narration line); checkId resolution is GitHub issue #171", () => {
  // "r1:check1" resolves to the "missing_endpoints" check type via checkTypeId (GitHub issue
  // #171) — checkId on the wire is now a check *instance* id, not a type id.
  const titleLookup: ScopeTitleLookup = {
    stageTitle: () => undefined,
    ruleTitle: (id) => (id === "r1" ? "No dead ends" : undefined),
    checkTypeId: (id) => (id === "r1:check1" ? "missing_endpoints" : undefined),
  };

  it("CheckRan narration resolves checkId (an instance id) to its check type's registry display label via titleLookup.checkTypeId, and an issue bubble with no highlight target/reasons for IssuePayload::None with empty details", () => {
    const tokens = adapterFor("quality_control").narrationTokensFor(
      { kind: "CheckRan", checkId: "r1:check1", issue: { issueKind: "invalid_loop", payload: { kind: "None" }, details: new Map() } },
      titleLookup,
    );
    expect(tokens).toEqual([
      { kind: "text", text: 'Check "Start and finish present": issue found ' },
      { kind: "issue", issueKind: "invalid_loop", target: null, reasons: ["Loop validation"] },
    ]);
  });

  it("CheckRan falls back to the raw instance id when titleLookup doesn't recognize it (absent, or checkTypeId returns undefined)", () => {
    const tokens = adapterFor("quality_control").narrationTokensFor({
      kind: "CheckRan", checkId: "check1", issue: { issueKind: "invalid_loop", payload: { kind: "None" }, details: new Map() },
    });
    expect(tokens).toEqual([
      { kind: "text", text: 'Check "check1": issue found ' },
      { kind: "issue", issueKind: "invalid_loop", target: null, reasons: ["Loop validation"] },
    ]);
  });

  it("CheckRan with no issue narrates cleanly", () => {
    const tokens = adapterFor("quality_control").narrationTokensFor({ kind: "CheckRan", checkId: "check1", issue: null });
    expect(tokens).toEqual([{ kind: "text", text: 'Check "check1": no issue' }]);
  });

  it("CheckRan with an InvalidLoop payload carries a cycle highlight target, flattened across every contributing check", () => {
    const tokens = adapterFor("quality_control").narrationTokensFor({
      kind: "CheckRan", checkId: "check1",
      issue: { issueKind: "invalid_loop", payload: { kind: "InvalidLoop", edges: new Map([["check1", [[[1n, 2n]]]]]) }, details: new Map() },
    });
    expect(tokens).toEqual([
      { kind: "text", text: 'Check "check1": issue found ' },
      { kind: "issue", issueKind: "invalid_loop", target: { kind: "cycle", edges: [[1n, 2n]] }, reasons: ["Loop validation"] },
    ]);
  });

  it("CheckRan with a RegionNeedsExpansion payload carries a region highlight target, flattened across every contributing check", () => {
    const tokens = adapterFor("quality_control").narrationTokensFor({
      kind: "CheckRan", checkId: "check1",
      issue: { issueKind: "region_needs_expansion", payload: { kind: "RegionNeedsExpansion", nodes: new Map([["check1", [[5n, 6n]]]]) }, details: new Map() },
    });
    expect(tokens).toEqual([
      { kind: "text", text: 'Check "check1": issue found ' },
      { kind: "issue", issueKind: "region_needs_expansion", target: { kind: "region", nodes: [5n, 6n] }, reasons: ["Region validation"] },
    ]);
  });

  it("an InvalidLoop payload with no actual edges (empty map) resolves to a null highlight target, not an empty-array target", () => {
    const tokens = adapterFor("quality_control").narrationTokensFor({
      kind: "CheckRan", checkId: "check1",
      issue: { issueKind: "invalid_loop", payload: { kind: "InvalidLoop", edges: new Map() }, details: new Map() },
    });
    expect(tokens).toEqual([
      { kind: "text", text: 'Check "check1": issue found ' },
      { kind: "issue", issueKind: "invalid_loop", target: null, reasons: ["Loop validation"] },
    ]);
  });

  it("a RegionNeedsExpansion payload with no actual nodes (empty map) resolves to a null highlight target, not an empty-array target", () => {
    const tokens = adapterFor("quality_control").narrationTokensFor({
      kind: "CheckRan", checkId: "check1",
      issue: { issueKind: "region_needs_expansion", payload: { kind: "RegionNeedsExpansion", nodes: new Map() }, details: new Map() },
    });
    expect(tokens).toEqual([
      { kind: "text", text: 'Check "check1": issue found ' },
      { kind: "issue", issueKind: "region_needs_expansion", target: null, reasons: ["Region validation"] },
    ]);
  });

  it("CheckRan's reason resolves through DETAIL_LABELS when checkTypeId + details are both available (GitHub issue #171)", () => {
    const tokens = adapterFor("quality_control").narrationTokensFor(
      {
        kind: "CheckRan", checkId: "r1:check1",
        issue: { issueKind: "invalid_loop", payload: { kind: "None" }, details: new Map([["threshold", "10"]]) },
      },
      { stageTitle: () => undefined, ruleTitle: () => undefined, checkTypeId: (id) => (id === "r1:check1" ? "min_loop_length" : undefined) },
    );
    expect(tokens).toEqual([
      { kind: "text", text: 'Check "Minimum loop length": issue found ' },
      { kind: "issue", issueKind: "invalid_loop", target: null, reasons: ["Loop shorter than 10 tiles"] },
    ]);
  });

  it("IssuesMerged narrates an issue bubble with one reason per contributing check, deduplicated", () => {
    const details = new Map([
      ["r1:check1", new Map([["threshold", "10"]])],
      ["r1:check2", new Map([["threshold", "10"]])],
    ]);
    const tokens = adapterFor("quality_control").narrationTokensFor(
      { kind: "IssuesMerged", issueKind: "invalid_loop", payload: { kind: "None" }, details },
      {
        stageTitle: () => undefined, ruleTitle: () => undefined,
        checkTypeId: (id) => (id === "r1:check1" || id === "r1:check2" ? "min_loop_length" : undefined),
      },
    );
    expect(tokens).toEqual([
      { kind: "text", text: "Merged into issue " },
      { kind: "issue", issueKind: "invalid_loop", target: null, reasons: ["Loop shorter than 10 tiles"] },
    ]);
  });

  it("IssuesMerged falls back to the generic issue label as the reason when titleLookup is absent", () => {
    const tokens = adapterFor("quality_control").narrationTokensFor({
      kind: "IssuesMerged", issueKind: "invalid_loop", payload: { kind: "None" }, details: new Map([["check1", new Map()]]),
    });
    expect(tokens).toEqual([
      { kind: "text", text: "Merged into issue " },
      { kind: "issue", issueKind: "invalid_loop", target: null, reasons: ["Loop validation"] },
    ]);
  });

  it("StartSetProposed/FinishSetProposed narrate what the strategy asked for, distinct from StartSet/FinishSet", () => {
    const startTokens = adapterFor("quality_control").narrationTokensFor({ kind: "StartSetProposed", id: 3n });
    expect(startTokens).toEqual([{ kind: "text", text: "Start proposed: " }, { kind: "node", id: 3n }]);
    const finishTokens = adapterFor("quality_control").narrationTokensFor({ kind: "FinishSetProposed", id: 4n });
    expect(finishTokens).toEqual([{ kind: "text", text: "Finish proposed: " }, { kind: "node", id: 4n }]);
  });
});

// --- selectDebugMazeView — real end-to-end two-source (generation + QC) combine (GitHub issue
// #147's regression: applyQc's old add/remove-as-two-independent-lists design couldn't resolve
// intra-contribution add-then-remove ordering; mergeDebugMazeView is the only place this is
// actually exercised against a real merged tape, not a hand-built contribution).

describe("selectDebugMazeView — two-source (generation + QC) combine (GitHub issue #147)", () => {
  function buildArena(): DebugArenaHandle {
    const tape = buildQcTwoSourceTape();
    return {
      tape,
      algorithmKind: "recursive_backtracker",
      sources: [
        { scopeName: "generation", kind: "recursive_backtracker", nodeIndex: 1, startStep: 0, endStep: 1, checkpointFroms: [] },
        { scopeName: "quality_control", kind: "quality_control", nodeIndex: 4, startStep: 1, endStep: 5, checkpointFroms: [] },
      ],
      nodes: [],
      totalSteps: 5,
      debugValueNames: [],
    };
  }

  it("at a step within generation's own range, only generation's edge contributes", () => {
    const view = selectDebugMazeView(buildArena(), 0);
    expect(view?.edges).toEqual([{ from: 1, to: 2, kind: "basic" }, { from: 2, to: 1, kind: "basic" }]);
  });

  it("once debugStep reaches QC's range, QC's add/remove patch applies on top of generation's edges in order", () => {
    const view = selectDebugMazeView(buildArena(), 4);
    // Generation's own EdgeAdded(1,2) contributed both directions (1->2, 2->1, RB's own
    // bidirectional flag); QC's EdgeRemovedBetween(1,2) only retracts the 1->2 direction (its own
    // `from`/`to` pair), leaving 2->1 in place, and QC's own BidirectionalEdgeAdded(10,20) is
    // present — the exact ordering bug this test guards against: a naive "concat all edges, concat
    // all removals, filter once" pass can't express "remove one specific directed edge added by an
    // earlier source, then also add unrelated new edges from a later source" correctly if it
    // doesn't preserve source order.
    expect(view?.edges).toEqual([
      { from: 2, to: 1, kind: "basic" },
      { from: 10, to: 20, kind: "basic" },
      { from: 20, to: 10, kind: "basic" },
    ]);
  });

  it("start/finish stay null before QC's range is reached, then reflect QC's own StartSet/FinishSet once it is", () => {
    expect(selectDebugMazeView(buildArena(), 0)?.start).toBeNull();
    expect(selectDebugMazeView(buildArena(), 0)?.finish).toBeNull();
    const view = selectDebugMazeView(buildArena(), 4);
    expect(view?.start).toBe(10);
    expect(view?.finish).toBe(20);
  });
});
