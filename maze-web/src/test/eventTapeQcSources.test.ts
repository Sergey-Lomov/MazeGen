import { describe, it, expect } from "vitest";
import { topLevelSourceScopes, sourceScopeForNode, applyQc, applyRecursiveBacktracker } from "../debug/eventTape";
import { adapterFor, adapterForNode, adapterForKind } from "../debug/algorithmRegistry";
import { selectDebugMazeView } from "../store/debugSelectors";
import type { DebugArenaHandle } from "../store/storeTypes";
import { buildQcTwoSourceTape } from "./eventTapeQc.fixtures";

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
      allNodes: [],
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
