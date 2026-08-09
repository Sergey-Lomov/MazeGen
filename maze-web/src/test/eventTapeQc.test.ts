import { describe, it, expect } from "vitest";
import {
  nodeAt,
  decodeQcEvent, isMutatingQcEvent, mutatingQcEvents, mutatingQcEventsWithIndex, applyQc,
  decodeRecursiveBacktrackerEvent, mutatingRbEventsWithIndex,
  resolveDebugArenaMetadata, countMutatingEvents,
  TAG_SCOPE, RECURSIVE_BACKTRACKER_EVENT_TAG, QC_EVENT_TAG,
  type ParsedTape, type QcApplyResult,
} from "../debug/eventTape";
import {
  u64le, u32le, concatBytes, scopePayload, strPayload, pointNodesReplacedPayload, edgeAddedPayload,
  buildFixture, buildQcTwoSourceTape, buildLongQcChainTape, buildQcChainWithRemovals,
} from "./eventTapeQc.fixtures";

// --- decodeQcEvent: round-trip coverage for every wire tag, mirroring decodeEdgeBasedEvent's
// test shape (eventTape.test.ts) — one it() per variant.

describe("decodeQcEvent", () => {
  it("decodes IterationStarted (4 bytes)", () => {
    expect(decodeQcEvent(QC_EVENT_TAG.ITERATION_STARTED, u32le(2))).toEqual({ kind: "IterationStarted", iteration: 2 });
  });

  it("decodes CheckRan with issue: null", () => {
    const payload = concatBytes([strPayload("c1"), new Uint8Array([0])]);
    expect(decodeQcEvent(QC_EVENT_TAG.CHECK_RAN, payload)).toEqual({ kind: "CheckRan", checkId: "c1", issue: null });
  });

  it("decodes CheckRan with issue present and IssuePayload::None and an empty details map", () => {
    const payload = concatBytes([strPayload("c1"), new Uint8Array([1]), strPayload("missing_endpoints"), new Uint8Array([0]), u32le(0)]);
    expect(decodeQcEvent(QC_EVENT_TAG.CHECK_RAN, payload)).toEqual({
      kind: "CheckRan", checkId: "c1", issue: { issueKind: "missing_endpoints", payload: { kind: "None" }, details: new Map() },
    });
  });

  it("decodes CheckRan with IssuePayload::InvalidLoop and this check's own details", () => {
    // one entry: key "check1" -> one cycle -> one edge pair (1,2), then preset_locked=0
    const edgesMap = concatBytes([
      u32le(1), strPayload("check1"), u32le(1), u32le(1), u32le(1), u32le(2), new Uint8Array([0]),
    ]);
    // details: 1 entry -> "threshold" = "10"
    const detailsMap = concatBytes([u32le(1), strPayload("threshold"), strPayload("10")]);
    const payload = concatBytes([strPayload("c1"), new Uint8Array([1]), strPayload("invalid_loop"), new Uint8Array([1]), edgesMap, detailsMap]);
    expect(decodeQcEvent(QC_EVENT_TAG.CHECK_RAN, payload)).toEqual({
      kind: "CheckRan", checkId: "c1",
      issue: {
        issueKind: "invalid_loop", payload: { kind: "InvalidLoop", edges: new Map([["check1", [{ edges: [[1n, 2n]], presetLocked: false }]]]) },
        details: new Map([["threshold", "10"]]),
      },
    });
  });

  it("decodes CheckRan with IssuePayload::RegionNeedsExpansion and an empty details map", () => {
    // one entry: key "check1" -> one region -> one node (5), then preset_locked=1
    const nodesMap = concatBytes([
      u32le(1), strPayload("check1"), u32le(1), u32le(1), u32le(5), new Uint8Array([1]),
    ]);
    const payload = concatBytes([strPayload("c1"), new Uint8Array([1]), strPayload("region_needs_expansion"), new Uint8Array([2]), nodesMap, u32le(0)]);
    expect(decodeQcEvent(QC_EVENT_TAG.CHECK_RAN, payload)).toEqual({
      kind: "CheckRan", checkId: "c1",
      issue: {
        issueKind: "region_needs_expansion", payload: { kind: "RegionNeedsExpansion", nodes: new Map([["check1", [{ region: [5n], presetLocked: true }]]]) },
        details: new Map(),
      },
    });
  });

  it("decodes CheckRan with IssuePayload::RegionNeedsShrink and an empty details map", () => {
    // one entry: key "check1" -> one region -> one node (5), then preset_locked=0
    const nodesMap = concatBytes([
      u32le(1), strPayload("check1"), u32le(1), u32le(1), u32le(5), new Uint8Array([0]),
    ]);
    const payload = concatBytes([strPayload("c1"), new Uint8Array([1]), strPayload("region_needs_shrink"), new Uint8Array([3]), nodesMap, u32le(0)]);
    expect(decodeQcEvent(QC_EVENT_TAG.CHECK_RAN, payload)).toEqual({
      kind: "CheckRan", checkId: "c1",
      issue: {
        issueKind: "region_needs_shrink", payload: { kind: "RegionNeedsShrink", nodes: new Map([["check1", [{ region: [5n], presetLocked: false }]]]) },
        details: new Map(),
      },
    });
  });

  it("decodes CheckRan with IssuePayload::InvalidTeleport and an empty details map", () => {
    // one entry: key "check1" -> one group -> one edge pair (1,2), then preset_locked=0
    const groupsMap = concatBytes([
      u32le(1), strPayload("check1"), u32le(1), u32le(1), u32le(1), u32le(2), new Uint8Array([0]),
    ]);
    const payload = concatBytes([strPayload("c1"), new Uint8Array([1]), strPayload("invalid_teleport"), new Uint8Array([4]), groupsMap, u32le(0)]);
    expect(decodeQcEvent(QC_EVENT_TAG.CHECK_RAN, payload)).toEqual({
      kind: "CheckRan", checkId: "c1",
      issue: {
        issueKind: "invalid_teleport", payload: { kind: "InvalidTeleport", groups: new Map([["check1", [{ edges: [[1n, 2n]], presetLocked: false }]]]) },
        details: new Map(),
      },
    });
  });

  it("decodes CheckRan with IssuePayload::InvalidOneWay and an empty details map", () => {
    // one entry: key "check1" -> one group -> one edge pair (1,2), then preset_locked=0
    const groupsMap = concatBytes([
      u32le(1), strPayload("check1"), u32le(1), u32le(1), u32le(1), u32le(2), new Uint8Array([0]),
    ]);
    const payload = concatBytes([strPayload("c1"), new Uint8Array([1]), strPayload("invalid_one_way"), new Uint8Array([5]), groupsMap, u32le(0)]);
    expect(decodeQcEvent(QC_EVENT_TAG.CHECK_RAN, payload)).toEqual({
      kind: "CheckRan", checkId: "c1",
      issue: {
        issueKind: "invalid_one_way", payload: { kind: "InvalidOneWay", groups: new Map([["check1", [{ edges: [[1n, 2n]], presetLocked: false }]]]) },
        details: new Map(),
      },
    });
  });

  it("decodes CheckRan with IssuePayload::ExcessiveSccCount and an empty details map", () => {
    // one entry: key "check1" -> preset_locked=1, no nested lists (tag 8)
    const boolsMap = concatBytes([u32le(1), strPayload("check1"), new Uint8Array([1])]);
    const payload = concatBytes([strPayload("c1"), new Uint8Array([1]), strPayload("excessive_scc_count"), new Uint8Array([8]), boolsMap, u32le(0)]);
    expect(decodeQcEvent(QC_EVENT_TAG.CHECK_RAN, payload)).toEqual({
      kind: "CheckRan", checkId: "c1",
      issue: {
        issueKind: "excessive_scc_count", payload: { kind: "ExcessiveSccCount", presetLocked: new Map([["check1", true]]) },
        details: new Map(),
      },
    });
  });

  it("decodes IssuesMerged with IssuePayload::None and an empty details map", () => {
    const payload = concatBytes([strPayload("invalid_loop"), new Uint8Array([0]), u32le(0)]);
    expect(decodeQcEvent(QC_EVENT_TAG.ISSUES_MERGED, payload)).toEqual({
      kind: "IssuesMerged", issueKind: "invalid_loop", payload: { kind: "None" }, details: new Map(),
    });
  });

  it("decodes IssuesMerged with IssuePayload::InvalidLoop and a details map keyed by contributing check instance id", () => {
    // one entry: key "check1" -> one cycle -> one edge pair (1,2), then preset_locked=0
    const edgesMap = concatBytes([
      u32le(1), strPayload("check1"), u32le(1), u32le(1), u32le(1), u32le(2), new Uint8Array([0]),
    ]);
    // details: 1 contributing check ("check1") -> {"threshold": "10"}
    const detailsMap = concatBytes([u32le(1), strPayload("check1"), u32le(1), strPayload("threshold"), strPayload("10")]);
    const payload = concatBytes([strPayload("invalid_loop"), new Uint8Array([1]), edgesMap, detailsMap]);
    expect(decodeQcEvent(QC_EVENT_TAG.ISSUES_MERGED, payload)).toEqual({
      kind: "IssuesMerged", issueKind: "invalid_loop",
      payload: { kind: "InvalidLoop", edges: new Map([["check1", [{ edges: [[1n, 2n]], presetLocked: false }]]]) },
      details: new Map([["check1", new Map([["threshold", "10"]])]]),
    });
  });

  it("decodes IterationLimitReached (MaxIterations)", () => {
    expect(decodeQcEvent(QC_EVENT_TAG.ITERATION_LIMIT_REACHED, new Uint8Array([0]))).toEqual({ kind: "IterationLimitReached", limit: "MaxIterations" });
  });

  it("decodes IterationLimitReached (TimeBudget)", () => {
    expect(decodeQcEvent(QC_EVENT_TAG.ITERATION_LIMIT_REACHED, new Uint8Array([1]))).toEqual({ kind: "IterationLimitReached", limit: "TimeBudget" });
  });

  it("decodes DirectedEdgeAdded (16 bytes)", () => {
    expect(decodeQcEvent(QC_EVENT_TAG.DIRECTED_EDGE_ADDED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "DirectedEdgeAdded", from: 1n, to: 2n });
  });

  it("decodes BidirectionalEdgeAdded (16 bytes)", () => {
    expect(decodeQcEvent(QC_EVENT_TAG.BIDIRECTIONAL_EDGE_ADDED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "BidirectionalEdgeAdded", a: 1n, b: 2n });
  });

  it("decodes DirectedTeleportAdded (16 bytes)", () => {
    expect(decodeQcEvent(QC_EVENT_TAG.DIRECTED_TELEPORT_ADDED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "DirectedTeleportAdded", from: 1n, to: 2n });
  });

  it("decodes BidirectionalTeleportAdded (16 bytes)", () => {
    expect(decodeQcEvent(QC_EVENT_TAG.BIDIRECTIONAL_TELEPORT_ADDED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "BidirectionalTeleportAdded", a: 1n, b: 2n });
  });

  it("decodes EdgeRemoved (16 bytes — from/to, GitHub issue #171's follow-up fix)", () => {
    expect(decodeQcEvent(QC_EVENT_TAG.EDGE_REMOVED, concatBytes([u64le(7n), u64le(8n)]))).toEqual({ kind: "EdgeRemoved", from: 7n, to: 8n });
  });

  it("decodes EdgeRemovedBetween (16 bytes)", () => {
    expect(decodeQcEvent(QC_EVENT_TAG.EDGE_REMOVED_BETWEEN, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "EdgeRemovedBetween", from: 1n, to: 2n });
  });

  it("decodes TeleportRemovedWithReverse (17 bytes — from/to of the primary id + reverseRemoved byte, GitHub issue #171's follow-up fix / #185's reverseRemoved fix)", () => {
    expect(decodeQcEvent(QC_EVENT_TAG.TELEPORT_REMOVED_WITH_REVERSE, concatBytes([u64le(3n), u64le(4n), new Uint8Array([1])]))).toEqual({ kind: "TeleportRemovedWithReverse", from: 3n, to: 4n, reverseRemoved: true });
  });

  it("decodes EdgeRemovedWithReverse (17 bytes — from/to of the primary id + reverseRemoved byte, GitHub issue #185)", () => {
    expect(decodeQcEvent(QC_EVENT_TAG.EDGE_REMOVED_WITH_REVERSE, concatBytes([u64le(5n), u64le(6n), new Uint8Array([1])]))).toEqual({ kind: "EdgeRemovedWithReverse", from: 5n, to: 6n, reverseRemoved: true });
  });

  it("decodes EdgeRemovedWithReverse with reverseRemoved false when only the primary direction existed", () => {
    expect(decodeQcEvent(QC_EVENT_TAG.EDGE_REMOVED_WITH_REVERSE, concatBytes([u64le(5n), u64le(6n), new Uint8Array([0])]))).toEqual({ kind: "EdgeRemovedWithReverse", from: 5n, to: 6n, reverseRemoved: false });
  });

  it("decodes StartSet (8 bytes)", () => {
    expect(decodeQcEvent(QC_EVENT_TAG.START_SET, u64le(1n))).toEqual({ kind: "StartSet", id: 1n });
  });

  it("decodes FinishSet (8 bytes)", () => {
    expect(decodeQcEvent(QC_EVENT_TAG.FINISH_SET, u64le(2n))).toEqual({ kind: "FinishSet", id: 2n });
  });

  it("decodes every *Declined variant identically to its mutating mirror except the kind", () => {
    expect(decodeQcEvent(QC_EVENT_TAG.DIRECTED_EDGE_DECLINED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "DirectedEdgeDeclined", from: 1n, to: 2n });
    expect(decodeQcEvent(QC_EVENT_TAG.BIDIRECTIONAL_EDGE_DECLINED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "BidirectionalEdgeDeclined", a: 1n, b: 2n });
    expect(decodeQcEvent(QC_EVENT_TAG.DIRECTED_TELEPORT_DECLINED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "DirectedTeleportDeclined", from: 1n, to: 2n });
    expect(decodeQcEvent(QC_EVENT_TAG.BIDIRECTIONAL_TELEPORT_DECLINED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "BidirectionalTeleportDeclined", a: 1n, b: 2n });
    expect(decodeQcEvent(QC_EVENT_TAG.EDGE_REMOVE_DECLINED, concatBytes([u64le(7n), u64le(8n)]))).toEqual({ kind: "EdgeRemoveDeclined", from: 7n, to: 8n });
    expect(decodeQcEvent(QC_EVENT_TAG.EDGE_REMOVE_BETWEEN_DECLINED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "EdgeRemoveBetweenDeclined", from: 1n, to: 2n });
    expect(decodeQcEvent(QC_EVENT_TAG.EDGE_REMOVE_WITH_REVERSE_DECLINED, concatBytes([u64le(5n), u64le(6n), new Uint8Array([0])]))).toEqual({ kind: "EdgeRemoveWithReverseDeclined", from: 5n, to: 6n, reverseRemoved: false });
    expect(decodeQcEvent(QC_EVENT_TAG.TELEPORT_REMOVE_WITH_REVERSE_DECLINED, concatBytes([u64le(3n), u64le(4n), new Uint8Array([0])]))).toEqual({ kind: "TeleportRemoveWithReverseDeclined", from: 3n, to: 4n, reverseRemoved: false });
    expect(decodeQcEvent(QC_EVENT_TAG.START_SET_DECLINED, u64le(1n))).toEqual({ kind: "StartSetDeclined", id: 1n });
    expect(decodeQcEvent(QC_EVENT_TAG.FINISH_SET_DECLINED, u64le(2n))).toEqual({ kind: "FinishSetDeclined", id: 2n });
  });

  it("decodes NodeRemoved/NodeRemoveDeclined/NodeRemoveProposed (8 bytes, GitHub issue #248)", () => {
    expect(decodeQcEvent(QC_EVENT_TAG.NODE_REMOVED, u64le(9n))).toEqual({ kind: "NodeRemoved", id: 9n });
    expect(decodeQcEvent(QC_EVENT_TAG.NODE_REMOVE_DECLINED, u64le(9n))).toEqual({ kind: "NodeRemoveDeclined", id: 9n });
    expect(decodeQcEvent(QC_EVENT_TAG.NODE_REMOVE_PROPOSED, u64le(9n))).toEqual({ kind: "NodeRemoveProposed", id: 9n });
  });

  it("decodes StrategyFailed (a plain length-prefixed strategy id string)", () => {
    expect(decodeQcEvent(QC_EVENT_TAG.STRATEGY_FAILED, strPayload("remove_split"))).toEqual({ kind: "StrategyFailed", strategyId: "remove_split" });
  });

  it("decodes every *Proposed variant identically to its mutating mirror except the kind", () => {
    expect(decodeQcEvent(QC_EVENT_TAG.DIRECTED_EDGE_PROPOSED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "DirectedEdgeProposed", from: 1n, to: 2n });
    expect(decodeQcEvent(QC_EVENT_TAG.BIDIRECTIONAL_EDGE_PROPOSED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "BidirectionalEdgeProposed", a: 1n, b: 2n });
    expect(decodeQcEvent(QC_EVENT_TAG.DIRECTED_TELEPORT_PROPOSED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "DirectedTeleportProposed", from: 1n, to: 2n });
    expect(decodeQcEvent(QC_EVENT_TAG.BIDIRECTIONAL_TELEPORT_PROPOSED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "BidirectionalTeleportProposed", a: 1n, b: 2n });
    expect(decodeQcEvent(QC_EVENT_TAG.EDGE_REMOVE_PROPOSED, concatBytes([u64le(7n), u64le(8n)]))).toEqual({ kind: "EdgeRemoveProposed", from: 7n, to: 8n });
    expect(decodeQcEvent(QC_EVENT_TAG.EDGE_REMOVE_BETWEEN_PROPOSED, concatBytes([u64le(1n), u64le(2n)]))).toEqual({ kind: "EdgeRemoveBetweenProposed", from: 1n, to: 2n });
    expect(decodeQcEvent(QC_EVENT_TAG.EDGE_REMOVE_WITH_REVERSE_PROPOSED, concatBytes([u64le(5n), u64le(6n)]))).toEqual({ kind: "EdgeRemoveWithReverseProposed", from: 5n, to: 6n });
    expect(decodeQcEvent(QC_EVENT_TAG.TELEPORT_REMOVE_WITH_REVERSE_PROPOSED, concatBytes([u64le(3n), u64le(4n)]))).toEqual({ kind: "TeleportRemoveWithReverseProposed", from: 3n, to: 4n });
    expect(decodeQcEvent(QC_EVENT_TAG.START_SET_PROPOSED, u64le(1n))).toEqual({ kind: "StartSetProposed", id: 1n });
    expect(decodeQcEvent(QC_EVENT_TAG.FINISH_SET_PROPOSED, u64le(2n))).toEqual({ kind: "FinishSetProposed", id: 2n });
  });

  it("throws on an unknown wire tag", () => {
    expect(() => decodeQcEvent(99, new Uint8Array(0))).toThrow(/unknown wire tag/);
  });

  it("throws on a payload_len mismatch for a fixed-size variant", () => {
    expect(() => decodeQcEvent(QC_EVENT_TAG.START_SET, new Uint8Array(3))).toThrow(/payload_len/);
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
    expect(isMutatingQcEvent({ kind: "EdgeRemovedWithReverse", from: 1n, to: 2n, reverseRemoved: true })).toBe(true);
    expect(isMutatingQcEvent({ kind: "TeleportRemovedWithReverse", from: 1n, to: 2n, reverseRemoved: true })).toBe(true);
    expect(isMutatingQcEvent({ kind: "StartSet", id: 1n })).toBe(true);
    expect(isMutatingQcEvent({ kind: "FinishSet", id: 1n })).toBe(true);
    expect(isMutatingQcEvent({ kind: "NodeRemoved", id: 1n })).toBe(true);

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
    expect(isMutatingQcEvent({ kind: "EdgeRemoveWithReverseDeclined", from: 1n, to: 2n, reverseRemoved: false })).toBe(false);
    expect(isMutatingQcEvent({ kind: "TeleportRemoveWithReverseDeclined", from: 1n, to: 2n, reverseRemoved: false })).toBe(false);
    expect(isMutatingQcEvent({ kind: "StartSetDeclined", id: 1n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "FinishSetDeclined", id: 1n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "DirectedEdgeProposed", from: 1n, to: 2n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "BidirectionalEdgeProposed", a: 1n, b: 2n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "DirectedTeleportProposed", from: 1n, to: 2n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "BidirectionalTeleportProposed", a: 1n, b: 2n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "EdgeRemoveProposed", from: 1n, to: 2n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "EdgeRemoveBetweenProposed", from: 1n, to: 2n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "EdgeRemoveWithReverseProposed", from: 1n, to: 2n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "TeleportRemoveWithReverseProposed", from: 1n, to: 2n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "StartSetProposed", id: 1n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "FinishSetProposed", id: 1n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "NodeRemoveDeclined", id: 1n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "NodeRemoveProposed", id: 1n })).toBe(false);
    expect(isMutatingQcEvent({ kind: "StrategyFailed", strategyId: "remove_split" })).toBe(false);
  });
});

// --- applyQc: apply-invariant coverage (mirrors applyEdgeBased's test shape) — a "stage s1" ->
// "iteration 1" -> "rule r1" tree with a mix of mutating and *Declined events, at a non-zero
// startNodeIndex (as it always is once merged after a generation source, Contract A).

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
    expect(result.removedNodes).toEqual([]);
    expect(result.step).toBe(3);
  });

  it("NodeRemoved (GitHub issue #248) accumulates into removedNodes, in emission order, deduplicated", () => {
    // root (0) -> NodeRemoved(7) (1) -> NodeRemoved(9) (2) -> NodeRemoved(7) (3, duplicate)
    const tape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: null, nextSibling: 2, tag: QC_EVENT_TAG.NODE_REMOVED, payloadBytes: u64le(7n) },
      { parent: 0, firstChild: null, nextSibling: 3, tag: QC_EVENT_TAG.NODE_REMOVED, payloadBytes: u64le(9n) },
      { parent: 0, firstChild: null, nextSibling: null, tag: QC_EVENT_TAG.NODE_REMOVED, payloadBytes: u64le(7n) },
    ]);
    const result = applyQc(tape, 2, undefined, 0);
    expect(result.removedNodes).toEqual([7n, 9n]);
  });

  it("PointNodesReplaced (GitHub issue #247's AddSplitStrategy rework) folds old_nodes into removedNodes and new_nodes into createdNodes", () => {
    const tape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: null, nextSibling: null, tag: QC_EVENT_TAG.POINT_NODES_REPLACED, payloadBytes: pointNodesReplacedPayload(5n, [5n], [20n, 21n], 2) },
    ]);
    const result = applyQc(tape, 0, undefined, 0);
    expect(result.removedNodes).toEqual([5n]);
    expect(result.createdNodes).toEqual([20n, 21n]);
  });

  it("resuming NodeRemoved accumulation from a previous result matches a full replay to the same targetStep", () => {
    const tape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: null, nextSibling: 2, tag: QC_EVENT_TAG.NODE_REMOVED, payloadBytes: u64le(7n) },
      { parent: 0, firstChild: null, nextSibling: null, tag: QC_EVENT_TAG.NODE_REMOVED, payloadBytes: u64le(9n) },
    ]);
    const from = applyQc(tape, 0, undefined, 0);
    const viaResume = applyQc(tape, 1, from, 0);
    const fromScratch = applyQc(tape, 1, undefined, 0);
    expect(viaResume.removedNodes).toEqual(fromScratch.removedNodes);
  });

  it("EdgeRemoved/TeleportRemovedWithReverse (resolved from,to — GitHub issue #171's follow-up fix) fold into the same keyed accumulator as EdgeRemovedBetween", () => {
    // root (0) -> BidirectionalEdgeAdded(1,2) (1) -> BidirectionalTeleportAdded(3,4) (2)
    //          -> EdgeRemoved(1,2) (3) -> TeleportRemovedWithReverse(3,4) (4)
    const tape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: null, nextSibling: 2, tag: QC_EVENT_TAG.BIDIRECTIONAL_EDGE_ADDED, payloadBytes: concatBytes([u64le(1n), u64le(2n)]) },
      { parent: 0, firstChild: null, nextSibling: 3, tag: QC_EVENT_TAG.BIDIRECTIONAL_TELEPORT_ADDED, payloadBytes: concatBytes([u64le(3n), u64le(4n)]) },
      { parent: 0, firstChild: null, nextSibling: 4, tag: QC_EVENT_TAG.EDGE_REMOVED, payloadBytes: concatBytes([u64le(1n), u64le(2n)]) },
      { parent: 0, firstChild: null, nextSibling: null, tag: QC_EVENT_TAG.TELEPORT_REMOVED_WITH_REVERSE, payloadBytes: concatBytes([u64le(3n), u64le(4n), new Uint8Array([1])]) },
    ]);
    // TeleportRemovedWithReverse must remove BOTH directions of the two-way teleport, even
    // though the wire event only names the primary (3,4) direction — the reverse (4,3) leg must
    // not survive as a dangling one-way edge (GitHub issue #185's sibling bug: applyQc used to
    // only clear the primary direction from its net accumulator).
    const result = applyQc(tape, 3, undefined, 0);
    expect(result.edges).toEqual([{ from: 2n, to: 1n, kind: "basic" }]);
    expect(result.removedEdges).toEqual([]);
  });

  it("EdgeRemovedWithReverse (GitHub issue #185) removes both directions of a bidirectional passage from the accumulator", () => {
    // root (0) -> BidirectionalEdgeAdded(1,2) (1) -> EdgeRemovedWithReverse(1,2) (2)
    const tape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: null, nextSibling: 2, tag: QC_EVENT_TAG.BIDIRECTIONAL_EDGE_ADDED, payloadBytes: concatBytes([u64le(1n), u64le(2n)]) },
      { parent: 0, firstChild: null, nextSibling: null, tag: QC_EVENT_TAG.EDGE_REMOVED_WITH_REVERSE, payloadBytes: concatBytes([u64le(1n), u64le(2n), new Uint8Array([1])]) },
    ]);
    const result = applyQc(tape, 1, undefined, 0);
    expect(result.edges).toEqual([]);
  });

  it("EdgeRemovedWithReverse with reverseRemoved=false does NOT clear the reverse direction — a one-way edge degenerating this command must not fabricate a phantom removed-edge entry (GitHub issue #185's follow-up fix)", () => {
    // Mirrors buildQcTwoSourceTape's shape: (1,2) belongs to an earlier source (generation, node
    // 3, outside QC's own scan window starting at node 5) — QC's own tape only ever sees the
    // removal, so `(1,2)` is absent from QC's local `net` and the remove call has to actually
    // reach into `removedFromEarlierSources`, exactly like a real cross-source replay would.
    // (2,1) was never added anywhere in either source; if the fix regressed to unconditionally
    // clearing the reverse too, it would fabricate a phantom `{ from: 2n, to: 1n }` entry here.
    const tape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: 2, nextSibling: 4, tag: TAG_SCOPE, payloadBytes: scopePayload("generation") },
      { parent: 1, firstChild: 3, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 2, firstChild: null, nextSibling: null, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 2n) },
      { parent: 0, firstChild: 5, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("quality_control") },
      { parent: 4, firstChild: null, nextSibling: null, tag: QC_EVENT_TAG.EDGE_REMOVED_WITH_REVERSE, payloadBytes: concatBytes([u64le(1n), u64le(2n), new Uint8Array([0])]) },
    ]);
    const result = applyQc(tape, 0, undefined, 5);
    expect(result.edges).toEqual([]);
    expect(result.removedEdges).toEqual([{ from: 1n, to: 2n }]);
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
    // colliding tag (QC_EVENT_TAG.ITERATION_STARTED == RECURSIVE_BACKTRACKER_EVENT_TAG.VERTEX_SELECTED == 1) would otherwise
    // mis-decode as an RB event.
    const rbEvents = mutatingRbEventsWithIndex(tape, 1, 2);
    expect(rbEvents).toHaveLength(1);
    expect(decodeRecursiveBacktrackerEvent(RECURSIVE_BACKTRACKER_EVENT_TAG.EDGE_ADDED, tape.payload.subarray(
      nodeAt(tape, rbEvents[0].nodeIndex).payloadOffset,
      nodeAt(tape, rbEvents[0].nodeIndex).payloadOffset + nodeAt(tape, rbEvents[0].nodeIndex).payloadLen,
    ))).toEqual({ kind: "EdgeAdded", from: 1n, to: 2n, bidirectional: true });
  });

  describe("end-to-end through resolveDebugArenaMetadata on a long chain (GitHub issue #128)", () => {
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
