import { describe, it, expect } from "vitest";
import { nodeView, TAG_SCOPE, QC_EVENT_TAG } from "../debug/eventTape";
import { adapterFor, type ScopeTitleLookup } from "../debug/algorithmRegistry";
import { buildFixture, scopePayload, u64le, concatBytes } from "./eventTapeQc.fixtures";

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
      { parent: 0, firstChild: null, nextSibling: 2, tag: QC_EVENT_TAG.START_SET, payloadBytes: u64le(10n) },
      { parent: 0, firstChild: null, nextSibling: null, tag: QC_EVENT_TAG.DIRECTED_EDGE_DECLINED, payloadBytes: concatBytes([u64le(30n), u64le(40n)]) },
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
      issue: { issueKind: "invalid_loop", payload: { kind: "InvalidLoop", edges: new Map([["check1", [{ edges: [[1n, 2n]], presetLocked: false }]]]) }, details: new Map() },
    });
    expect(tokens).toEqual([
      { kind: "text", text: 'Check "check1": issue found ' },
      { kind: "issue", issueKind: "invalid_loop", target: { cycle: { edges: [[1n, 2n]], asWall: false }, region: null }, reasons: ["Loop validation"] },
    ]);
  });

  it("CheckRan with a RegionNeedsExpansion payload carries a region highlight target, flattened across every contributing check", () => {
    const tokens = adapterFor("quality_control").narrationTokensFor({
      kind: "CheckRan", checkId: "check1",
      issue: { issueKind: "region_needs_expansion", payload: { kind: "RegionNeedsExpansion", nodes: new Map([["check1", [{ region: [5n, 6n], presetLocked: false }]]]) }, details: new Map() },
    });
    expect(tokens).toEqual([
      { kind: "text", text: 'Check "check1": issue found ' },
      { kind: "issue", issueKind: "region_needs_expansion", target: { cycle: null, region: { groups: [{ nodes: [5n, 6n], isSplit: false }] } }, reasons: ["Region expansion"] },
    ]);
  });

  it("CheckRan with a RegionNeedsShrink payload carries a region highlight target, flattened across every contributing check", () => {
    const tokens = adapterFor("quality_control").narrationTokensFor({
      kind: "CheckRan", checkId: "check1",
      issue: { issueKind: "region_needs_shrink", payload: { kind: "RegionNeedsShrink", nodes: new Map([["check1", [{ region: [5n, 6n], presetLocked: false }]]]) }, details: new Map() },
    });
    expect(tokens).toEqual([
      { kind: "text", text: 'Check "check1": issue found ' },
      { kind: "issue", issueKind: "region_needs_shrink", target: { cycle: null, region: { groups: [{ nodes: [5n, 6n], isSplit: false }] } }, reasons: ["Region split"] },
    ]);
  });

  it("CheckRan with an InvalidTeleport payload carries a cycle-shaped highlight target, flattened across every contributing check", () => {
    // A single flagged teleport (a group of size one) reuses the "cycle" target shape -- same
    // rendering path as a real cycle, see `issueHighlightTarget`'s doc comment.
    const tokens = adapterFor("quality_control").narrationTokensFor({
      kind: "CheckRan", checkId: "check1",
      issue: { issueKind: "invalid_teleport", payload: { kind: "InvalidTeleport", groups: new Map([["check1", [{ edges: [[1n, 2n]], presetLocked: false }]]]) }, details: new Map() },
    });
    expect(tokens).toEqual([
      { kind: "text", text: 'Check "check1": issue found ' },
      { kind: "issue", issueKind: "invalid_teleport", target: { cycle: { edges: [[1n, 2n]], asWall: false }, region: null }, reasons: ["Teleport validation"] },
    ]);
  });

  it("an InvalidTeleport payload with no actual groups (empty map) resolves to a null highlight target, not an empty-array target", () => {
    const tokens = adapterFor("quality_control").narrationTokensFor({
      kind: "CheckRan", checkId: "check1",
      issue: { issueKind: "invalid_teleport", payload: { kind: "InvalidTeleport", groups: new Map() }, details: new Map() },
    });
    expect(tokens).toEqual([
      { kind: "text", text: 'Check "check1": issue found ' },
      { kind: "issue", issueKind: "invalid_teleport", target: null, reasons: ["Teleport validation"] },
    ]);
  });

  it("CheckRan with an InvalidOneWay payload carries a cycle-shaped highlight target, flattened across every contributing check", () => {
    // A single flagged one-way (a group of size one) reuses the "cycle" target shape -- same
    // rendering path as a real cycle, see `issueHighlightTarget`'s doc comment.
    const tokens = adapterFor("quality_control").narrationTokensFor({
      kind: "CheckRan", checkId: "check1",
      issue: { issueKind: "invalid_one_way", payload: { kind: "InvalidOneWay", groups: new Map([["check1", [{ edges: [[1n, 2n]], presetLocked: false }]]]) }, details: new Map() },
    });
    expect(tokens).toEqual([
      { kind: "text", text: 'Check "check1": issue found ' },
      { kind: "issue", issueKind: "invalid_one_way", target: { cycle: { edges: [[1n, 2n]], asWall: true }, region: null }, reasons: ["One-way validation"] },
    ]);
  });

  it("an InvalidOneWay payload with no actual groups (empty map) resolves to a null highlight target, not an empty-array target", () => {
    const tokens = adapterFor("quality_control").narrationTokensFor({
      kind: "CheckRan", checkId: "check1",
      issue: { issueKind: "invalid_one_way", payload: { kind: "InvalidOneWay", groups: new Map() }, details: new Map() },
    });
    expect(tokens).toEqual([
      { kind: "text", text: 'Check "check1": issue found ' },
      { kind: "issue", issueKind: "invalid_one_way", target: null, reasons: ["One-way validation"] },
    ]);
  });

  it("CheckRan with an InvalidSplitTile payload carries a region-shaped highlight target, one group per flagged tile", () => {
    const tokens = adapterFor("quality_control").narrationTokensFor({
      kind: "CheckRan", checkId: "check1",
      issue: { issueKind: "invalid_split_tile", payload: { kind: "InvalidSplitTile", groups: new Map([["check1", [{ tiles: [{ nodes: [5n, 6n], presetLocked: false }], presetLocked: false }]]]) }, details: new Map([["distance", "3"]]) },
    }, { stageTitle: () => undefined, ruleTitle: () => undefined, checkTypeId: () => "split_distance_from_waypoint" });
    expect(tokens).toEqual([
      { kind: "text", text: 'Check "Distance from waypoint": issue found ' },
      { kind: "issue", issueKind: "invalid_split_tile", target: { cycle: null, region: { groups: [{ nodes: [5n, 6n], isSplit: true }] } }, reasons: ["Split node closer than 3 tiles to a waypoint"] },
    ]);
  });

  it("CheckRan with an InvalidSplitTile payload naming two distinct tiles merges them into one split group (GitHub issue #619)", () => {
    const tokens = adapterFor("quality_control").narrationTokensFor({
      kind: "CheckRan", checkId: "check1",
      issue: {
        issueKind: "invalid_split_tile",
        payload: {
          kind: "InvalidSplitTile",
          groups: new Map([["check1", [{ tiles: [{ nodes: [5n, 6n], presetLocked: false }, { nodes: [7n], presetLocked: false }], presetLocked: false }]]]),
        },
        details: new Map(),
      },
    });
    expect(tokens).toEqual([
      { kind: "text", text: 'Check "check1": issue found ' },
      { kind: "issue", issueKind: "invalid_split_tile", target: { cycle: null, region: { groups: [{ nodes: [5n, 6n, 7n], isSplit: true }] } }, reasons: ["Split tile validation"] },
    ]);
  });

  it("an InvalidSplitTile payload with no actual nodes (empty map) resolves to a null highlight target, not an empty-array target", () => {
    const tokens = adapterFor("quality_control").narrationTokensFor({
      kind: "CheckRan", checkId: "check1",
      issue: { issueKind: "invalid_split_tile", payload: { kind: "InvalidSplitTile", groups: new Map() }, details: new Map() },
    });
    expect(tokens).toEqual([
      { kind: "text", text: 'Check "check1": issue found ' },
      { kind: "issue", issueKind: "invalid_split_tile", target: null, reasons: ["Split tile validation"] },
    ]);
  });

  it("CheckRan with an InvalidVerticalPassage payload carries a region-shaped highlight target over the flagged edges' endpoint cells (GitHub issue #466), not a cycle-shaped one", () => {
    // A vertical passage connects two floors at the same x-y point -- a line between its endpoints
    // reads as a stray diagonal. Highlighted as cells instead, matching Analytics' IssuesBlock.
    const tokens = adapterFor("quality_control").narrationTokensFor({
      kind: "CheckRan", checkId: "check1",
      issue: { issueKind: "invalid_vertical_passage", payload: { kind: "InvalidVerticalPassage", groups: new Map([["check1", [{ edges: [[1n, 2n]], presetLocked: false }]]]) }, details: new Map() },
    });
    expect(tokens).toEqual([
      { kind: "text", text: 'Check "check1": issue found ' },
      { kind: "issue", issueKind: "invalid_vertical_passage", target: { cycle: null, region: { groups: [{ nodes: [1n, 2n], isSplit: false }] } }, reasons: ["Vertical passage validation"] },
    ]);
  });

  it("an InvalidVerticalPassage payload with no actual groups (empty map) resolves to a null highlight target", () => {
    const tokens = adapterFor("quality_control").narrationTokensFor({
      kind: "CheckRan", checkId: "check1",
      issue: { issueKind: "invalid_vertical_passage", payload: { kind: "InvalidVerticalPassage", groups: new Map() }, details: new Map() },
    });
    expect(tokens).toEqual([
      { kind: "text", text: 'Check "check1": issue found ' },
      { kind: "issue", issueKind: "invalid_vertical_passage", target: null, reasons: ["Vertical passage validation"] },
    ]);
  });

  it("CheckRan with an InvalidElevator payload carries a region-shaped highlight target over the elevator's fan-edge endpoint cells (GitHub issue #466), not a cycle-shaped one", () => {
    const tokens = adapterFor("quality_control").narrationTokensFor({
      kind: "CheckRan", checkId: "check1",
      issue: { issueKind: "invalid_elevator", payload: { kind: "InvalidElevator", groups: new Map([["check1", [{ edges: [[1n, 2n], [1n, 3n]], presetLocked: false }]]]) }, details: new Map() },
    });
    expect(tokens).toEqual([
      { kind: "text", text: 'Check "check1": issue found ' },
      { kind: "issue", issueKind: "invalid_elevator", target: { cycle: null, region: { groups: [{ nodes: [1n, 2n, 1n, 3n], isSplit: false }] } }, reasons: ["Elevator validation"] },
    ]);
  });

  it("an InvalidElevator payload with no actual groups (empty map) resolves to a null highlight target", () => {
    const tokens = adapterFor("quality_control").narrationTokensFor({
      kind: "CheckRan", checkId: "check1",
      issue: { issueKind: "invalid_elevator", payload: { kind: "InvalidElevator", groups: new Map() }, details: new Map() },
    });
    expect(tokens).toEqual([
      { kind: "text", text: 'Check "check1": issue found ' },
      { kind: "issue", issueKind: "invalid_elevator", target: null, reasons: ["Elevator validation"] },
    ]);
  });

  it("CheckRan with an InvalidCrossElementGroup payload mixing a one-way member (wall) and a split member carries both a cycle and a region highlight target at once (GitHub issue #619)", () => {
    const tokens = adapterFor("quality_control").narrationTokensFor({
      kind: "CheckRan", checkId: "check1",
      issue: {
        issueKind: "invalid_cross_element_group",
        payload: {
          kind: "InvalidCrossElementGroup",
          groups: new Map([["check1", [[
            { kind: "one_way", edges: [[3n, 4n]], nodes: [], tile: null, removable: true, presetLocked: false },
            { kind: "split", edges: [], nodes: [], tile: { nodes: [7n, 8n], presetLocked: false }, removable: true, presetLocked: false },
          ]]]]),
        },
        details: new Map(),
      },
    });
    expect(tokens).toEqual([
      { kind: "text", text: 'Check "check1": issue found ' },
      {
        kind: "issue", issueKind: "invalid_cross_element_group",
        target: { cycle: { edges: [[3n, 4n]], asWall: true }, region: { groups: [{ nodes: [7n, 8n], isSplit: true }] } },
        reasons: ["Elements too close"],
      },
    ]);
  });

  it("an InvalidCrossElementGroup payload with no actual groups (empty map) resolves to a null highlight target, not an empty-array target", () => {
    const tokens = adapterFor("quality_control").narrationTokensFor({
      kind: "CheckRan", checkId: "check1",
      issue: { issueKind: "invalid_cross_element_group", payload: { kind: "InvalidCrossElementGroup", groups: new Map() }, details: new Map() },
    });
    expect(tokens).toEqual([
      { kind: "text", text: 'Check "check1": issue found ' },
      { kind: "issue", issueKind: "invalid_cross_element_group", target: null, reasons: ["Elements too close"] },
    ]);
  });

  it("StrategyFailed narrates the strategy's resolved display label", () => {
    const tokens = adapterFor("quality_control").narrationTokensFor({ kind: "StrategyFailed", strategyId: "remove_split" });
    expect(tokens).toEqual([{ kind: "text", text: 'Strategy "Split tile removal" failed' }]);
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
      { kind: "issue", issueKind: "region_needs_expansion", target: null, reasons: ["Region expansion"] },
    ]);
  });

  it("CheckRan's reason resolves through DETAIL_LABELS when checkTypeId + details are both available (GitHub issue #171)", () => {
    const tokens = adapterFor("quality_control").narrationTokensFor(
      {
        kind: "CheckRan", checkId: "r1:check1",
        issue: { issueKind: "invalid_loop", payload: { kind: "None" }, details: new Map([["threshold", "10"]]) },
      },
      { stageTitle: () => undefined, ruleTitle: () => undefined, checkTypeId: (id) => (id === "r1:check1" ? "loop_length" : undefined) },
    );
    expect(tokens).toEqual([
      { kind: "text", text: 'Check "Loop length": issue found ' },
      { kind: "issue", issueKind: "invalid_loop", target: null, reasons: ["Loop length compared against 10 tiles"] },
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
        checkTypeId: (id) => (id === "r1:check1" || id === "r1:check2" ? "loop_length" : undefined),
      },
    );
    expect(tokens).toEqual([
      { kind: "text", text: "Merged into issue " },
      { kind: "issue", issueKind: "invalid_loop", target: null, reasons: ["Loop length compared against 10 tiles"] },
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
