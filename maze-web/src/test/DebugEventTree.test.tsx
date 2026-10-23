import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { DebugEventTree, bubbleLabel } from "../components/DebugEventTree";
import { useMazeStore } from "../store/mazeStore";
import { TAG_SCOPE, RECURSIVE_BACKTRACKER_EVENT_TAG } from "../debug/eventTape";
import type { NodeDto } from "../wasm/types";
import * as m from "~/paraglide/messages";
import { getTooltipControl } from "./tooltipTestUtils";
import {
  buildFixture, buildTwoStepTape, buildOneWalkWilsonTape, buildLoopErasedDeadEndWilsonTape, buildGenerationPlusQcTape,
  scopePayload, vertexPayload,
} from "./debugEventTreeFixtures";

const nodes: NodeDto[] = [
  { id: 1, x: 0, y: 0, i: 0 },
  { id: 2, x: 3, y: 4, i: 0 },
];

// jsdom has no real layout — @tanstack/react-virtual's default `observeElementRect` measures the
// scroll container via `element.offsetWidth`/`offsetHeight` (see virtual-core's `getRect`), both
// zero by default (and the project's global ResizeObserver stub in setup.ts is a no-op, so it
// never delivers a real size either), which would make it render zero virtual rows. Stub a fixed
// viewport size so rows actually mount.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 320 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Top-level source scopes ("Generation"/"Quality Control") start collapsed like any other scope
// row (GitHub issue #186 — no longer auto-expanded on mount); every test that needs to see a
// source's own content clicks this first.
function expandGeneration() {
  fireEvent.click(screen.getByText(m["debug.tree.source_scope.generation"]()));
}

describe("DebugEventTree", () => {
  beforeEach(() => {
    useMazeStore.setState({
      debugArena: { tape: buildTwoStepTape(), algorithmKind: "recursive_backtracker", sources: [{ scopeName: "generation", kind: "recursive_backtracker", nodeIndex: 1, startStep: 0, endStep: 4, checkpointFroms: [] }], nodes, allNodes: nodes, totalSteps: 4, debugValueNames: [] },
      debugStep: 0,
    });
  });

  it("starts fully collapsed, showing only the top-level source row", () => {
    render(<DebugEventTree />);
    expect(screen.getByText(m["debug.tree.source_scope.generation"]())).toBeInTheDocument();
    expect(screen.queryByText(m["debug.tree.step_scope"]({ index: 1 }))).not.toBeInTheDocument();
    expect(screen.queryByText(/Passage added/)).not.toBeInTheDocument();
  });

  it("clicking the source row reveals the two top-level step rows, then a step row's body reveals its own children", () => {
    const setDebugStep = vi.fn();
    useMazeStore.setState({ setDebugStep });
    render(<DebugEventTree />);
    expandGeneration();

    expect(screen.getByText(m["debug.tree.step_scope"]({ index: 1 }))).toBeInTheDocument();
    expect(screen.getByText(m["debug.tree.step_scope"]({ index: 2 }))).toBeInTheDocument();
    expect(screen.queryByText(/Passage added/)).not.toBeInTheDocument();

    const firstStepRow = screen.getByText(m["debug.tree.step_scope"]({ index: 1 }));
    fireEvent.click(firstStepRow);

    expect(screen.getByText(/Passage added/)).toBeInTheDocument();
    expect(setDebugStep).not.toHaveBeenCalled();
  });

  it("clicking the step-number column jumps debugStep to that node's step", () => {
    const setDebugStep = vi.fn();
    useMazeStore.setState({ setDebugStep });
    render(<DebugEventTree />);
    expandGeneration();

    // The merged tree's auto-expanded former-root wrapper rows (GitHub issue #169) each render
    // their own step-col too — find "step 1"'s own column specifically.
    const firstStepCol = screen.getByText(m["debug.tree.step_scope"]({ index: 1 })).closest("div")!.querySelector('[data-testid="step-col"]')!;
    fireEvent.click(firstStepCol);

    // First "step 1" scope (nodeIndex 3, per the merged fixture's layout) has no preceding
    // mutating event -> clamps to step 0.
    expect(setDebugStep).toHaveBeenCalledWith(0);
  });

  it("jumps to the step shown in the column, not the nearest-preceding step for the scope node itself", () => {
    // "step 2" (nodeIndex 7, per the merged fixture's layout) sits right after VertexPushed (step
    // 2, nodeIndex 6) in arena order, so the *nearest-preceding* step for node 7 itself would be
    // 2. The column displays "3" (1-based) for "step 2" — its first child, DeadEnd (trace-only),
    // resolves to the nearest preceding mutating step, VertexPushed at step 2 (GitHub issue #186:
    // a scope's step is its first child's step, mutating or not, not the first *mutating*
    // descendant's). Clicking must jump to 2, matching what's actually displayed.
    const setDebugStep = vi.fn();
    useMazeStore.setState({ setDebugStep });
    render(<DebugEventTree />);
    expandGeneration();

    // The merged tree's auto-expanded former-root wrapper rows (GitHub issue #169) each render
    // their own step-col too — find "step 2"'s own column specifically rather than assuming it's
    // the second entry in document order.
    const secondStepCol = screen.getByText(m["debug.tree.step_scope"]({ index: 2 })).closest("div")!.querySelector('[data-testid="step-col"]')!;
    expect(secondStepCol).toHaveTextContent("3");
    fireEvent.click(secondStepCol);

    expect(setDebugStep).toHaveBeenCalledWith(2);
  });

  it("scope shows its first child's step, mutating or not; a trace-only leaf shows the nearest preceding mutating step (GitHub issues #166, #186)", () => {
    // "step 1" -> EdgeAdded (mutating, step 0), VertexVisited (mutating, step 1), VertexPushed
    // (mutating, step 2): first child is EdgeAdded itself, at step 0 -> displayed as "1".
    // "step 2" -> DeadEnd (trace-only), VertexPopped (mutating, step 3): first child is DeadEnd,
    // trace-only, resolving to the nearest preceding mutating step — VertexPushed, step 2 ->
    // displayed as "3", the same number DeadEnd's own row shows.
    render(<DebugEventTree />);
    expandGeneration();
    // The merged tree's auto-expanded former-root wrapper rows (GitHub issue #169) each render
    // their own step-col too — find "step 1"/"step 2"'s own columns specifically rather than
    // assuming the first two entries in document order.
    const stepOneCol = screen.getByText(m["debug.tree.step_scope"]({ index: 1 })).closest("div")!.querySelector('[data-testid="step-col"]');
    const stepTwoCol = screen.getByText(m["debug.tree.step_scope"]({ index: 2 })).closest("div")!.querySelector('[data-testid="step-col"]');
    expect(stepOneCol).toHaveTextContent("1");
    expect(stepTwoCol).toHaveTextContent("3");

    fireEvent.click(screen.getByText(m["debug.tree.step_scope"]({ index: 2 })));
    const deadEndRow = screen.getByText(m["debug.tree.dead_end"]()).closest("div")!;
    expect(deadEndRow.querySelector('[data-testid="step-col"]')).toHaveTextContent("3");
  });

  it("clicking a childless row's body (not just the step column) jumps to its displayed step (GitHub issue #166)", () => {
    const setDebugStep = vi.fn();
    useMazeStore.setState({ setDebugStep });
    render(<DebugEventTree />);
    expandGeneration();

    fireEvent.click(screen.getByText(m["debug.tree.step_scope"]({ index: 2 })));
    // DeadEnd is trace-only and has no children — clicking its row body (not the step-col) must
    // still jump, to the same nearest-preceding-mutating step ("3", 1-based) the column shows.
    fireEvent.click(screen.getByText(m["debug.tree.dead_end"]()));

    expect(setDebugStep).toHaveBeenCalledWith(2);
  });

  it("clicking a trace-only row highlights that row itself, not the mutating row whose step it jumped to (GitHub issue #166)", () => {
    // Real store (no setDebugStep mock) — debugStep must actually change so the tree's own
    // highlight-by-debugStep fallback would kick in if the click override didn't win.
    render(<DebugEventTree />);
    expandGeneration();

    // Expand "step 1" too, so VertexPushed's own row is present to assert against.
    fireEvent.click(screen.getByText(m["debug.tree.step_scope"]({ index: 1 })));
    fireEvent.click(screen.getByText(m["debug.tree.step_scope"]({ index: 2 })));
    // DeadEnd (trace-only) jumps to nearest-preceding mutating step 2 (VertexPushed's own step) —
    // without the click-node override, `resolveHighlightTarget` would highlight VertexPushed's
    // row instead of the row actually clicked.
    fireEvent.click(screen.getByText(m["debug.tree.dead_end"]()));

    const deadEndRow = screen.getByText(m["debug.tree.dead_end"]()).closest("div")!;
    const vertexPushedRow = screen.getByText(m["debug.tree.vertex_pushed"]()).closest("div")!;
    expect(deadEndRow.style.background).not.toBe("");
    expect(vertexPushedRow.style.background).toBe("");
  });

  it("hovering a node/edge ref bubble sets hoveredDebugRef; leaving clears it", () => {
    render(<DebugEventTree />);
    expandGeneration();
    fireEvent.click(screen.getByText(m["debug.tree.step_scope"]({ index: 1 })));

    const edgeBubble = screen.getByText("0:0 <-> 3:4");
    fireEvent.mouseEnter(edgeBubble);
    expect(useMazeStore.getState().hoveredDebugRef).toEqual({ kind: "edge", from: 1n, to: 2n, bidirectional: true });

    fireEvent.mouseLeave(edgeBubble);
    expect(useMazeStore.getState().hoveredDebugRef).toBeNull();
  });

  it("clicking a ref bubble does not bubble up to the row (no step jump, no toggle)", () => {
    const setDebugStep = vi.fn();
    useMazeStore.setState({ setDebugStep });
    render(<DebugEventTree />);
    expandGeneration();
    fireEvent.click(screen.getByText(m["debug.tree.step_scope"]({ index: 1 })));

    const edgeBubble = screen.getByText("0:0 <-> 3:4");
    fireEvent.click(edgeBubble);

    expect(setDebugStep).not.toHaveBeenCalled();
    // The row stayed expanded — a bubbled click would have hit the row's own onClick, which only
    // toggles collapse for rows with children (this leaf row has none, so a wrongly-bubbled click
    // would be a no-op here too; the real assertion is setDebugStep above plus the bubble still
    // being present, proving the row's click handler never fired via the bubble).
    expect(screen.getByText("0:0 <-> 3:4")).toBeInTheDocument();
  });

  it("renders a fallback #id bubble when an event references a node id absent from debugArena.nodes", () => {
    // Same tape shape but VertexVisited references id 99, which isn't in `nodes`. `nodes` is the
    // *final* post-run field snapshot — a node a later command legitimately removed/replaced
    // (`RemoveNode`, `ReplacePointNodes`) is genuinely absent from it even though an earlier
    // narration row still names it by its now-stale id. This must degrade gracefully (a `#id`
    // fallback bubble), not throw — a React render-time throw here previously took down the whole
    // debug panel (reported bug: a QC-time split-repair pass routinely replaces nodes).
    const brokenTape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("generation") },
      { parent: 1, firstChild: 3, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 2, firstChild: 4, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step 1") },
      { parent: 3, firstChild: null, nextSibling: null, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.VERTEX_VISITED, payloadBytes: vertexPayload(99n) },
    ]);
    useMazeStore.setState({ debugArena: { tape: brokenTape, algorithmKind: "recursive_backtracker", sources: [{ scopeName: "generation", kind: "recursive_backtracker", nodeIndex: 1, startStep: 0, endStep: 1, checkpointFroms: [] }], nodes, allNodes: nodes, totalSteps: 1, debugValueNames: [] }, debugStep: 0 });

    render(<DebugEventTree />);
    expandGeneration();
    const stepScopeRow = screen.getByText(m["debug.tree.step_scope"]({ index: 1 }));
    expect(() => fireEvent.click(stepScopeRow)).not.toThrow();
    expect(screen.getByText("#99")).toBeInTheDocument();
  });

  it("resolves real coordinates (not the #id fallback) for a node removed before the final snapshot", () => {
    // GitHub issue #271: a node minted then removed/replaced mid-run (e.g. `remove_split`,
    // `AddSplitStrategy`) is gone from the final `Field` by the time `nodes` (the post-run
    // snapshot) is built, but it must still resolve to real coordinates on narration steps that
    // precede its removal — that's exactly what `allNodes` (the ever-existed union) is for. Node
    // id 42 here is present in `allNodes` but deliberately absent from `nodes`.
    const removedNode: NodeDto = { id: 42, x: 7, y: 9, i: 0 };
    const tapeReferencingRemovedNode = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("generation") },
      { parent: 1, firstChild: 3, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 2, firstChild: 4, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step 1") },
      { parent: 3, firstChild: null, nextSibling: null, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.VERTEX_VISITED, payloadBytes: vertexPayload(42n) },
    ]);
    useMazeStore.setState({
      debugArena: {
        tape: tapeReferencingRemovedNode, algorithmKind: "recursive_backtracker",
        sources: [{ scopeName: "generation", kind: "recursive_backtracker", nodeIndex: 1, startStep: 0, endStep: 1, checkpointFroms: [] }],
        nodes, allNodes: [...nodes, removedNode], totalSteps: 1, debugValueNames: [],
      },
      debugStep: 0,
    });

    render(<DebugEventTree />);
    expandGeneration();
    const stepScopeRow = screen.getByText(m["debug.tree.step_scope"]({ index: 1 }));
    fireEvent.click(stepScopeRow);

    expect(screen.queryByText("#42")).not.toBeInTheDocument();
    expect(screen.getByText("7:9")).toBeInTheDocument();
  });
});

// --- Multi-floor bubbles (GitHub issue #350) ---

describe("DebugEventTree on a multi-floor maze", () => {
  const floorNodes: NodeDto[] = [
    { id: 1, x: 0, y: 0, i: 0, level: 1 },
    { id: 2, x: 3, y: 4, i: 0, level: 1 },
  ];
  const floors = [{ id: "floor_0", title: "Floor 1" }, { id: "floor_1", title: "Floor 2" }];

  beforeEach(() => {
    useMazeStore.setState({
      debugArena: { tape: buildTwoStepTape(), algorithmKind: "recursive_backtracker", sources: [{ scopeName: "generation", kind: "recursive_backtracker", nodeIndex: 1, startStep: 0, endStep: 4, checkpointFroms: [] }], nodes: floorNodes, allNodes: floorNodes, totalSteps: 4, debugValueNames: [] },
      debugStep: 0,
      floors,
      activeFloorId: "floor_0",
    });
  });

  it("prefixes a bubble's coordinates with its 1-based floor (Lf x:y)", () => {
    render(<DebugEventTree />);
    expandGeneration();
    fireEvent.click(screen.getByText(m["debug.tree.step_scope"]({ index: 1 })));
    // EdgeAdded(1, 2), bidirectional -> one "edge" bubble, "L2 0:0 <-> L2 3:4" — both nodes are
    // floor index 1 -> "L2".
    expect(screen.getByText("L2 0:0 <-> L2 3:4")).toBeInTheDocument();
  });

  it("clicking a bubble switches the active floor to the bubble's own floor", () => {
    render(<DebugEventTree />);
    expandGeneration();
    fireEvent.click(screen.getByText(m["debug.tree.step_scope"]({ index: 1 })));

    expect(useMazeStore.getState().activeFloorId).toBe("floor_0");
    fireEvent.click(screen.getByText("L2 0:0 <-> L2 3:4"));
    expect(useMazeStore.getState().activeFloorId).toBe("floor_1");
  });

  it("does not prefix bubbles with a floor on a single-floor maze", () => {
    useMazeStore.setState({ floors: [floors[0]], activeFloorId: "floor_0" });
    render(<DebugEventTree />);
    expandGeneration();
    fireEvent.click(screen.getByText(m["debug.tree.step_scope"]({ index: 1 })));
    expect(screen.getByText("0:0 <-> 3:4")).toBeInTheDocument();
    expect(screen.queryByText(/L2 /)).not.toBeInTheDocument();
  });
});

// --- Split-node narration suffix (GitHub issue #468) ---

describe("bubbleLabel split-node suffix", () => {
  // (2,2) is a split point (i=0, i=1); (5,5) has a single node.
  const coords = (id: bigint): { x: number; y: number; level: number; i: number; split: boolean } | null => {
    switch (id) {
      case 1n: return { x: 2, y: 2, level: 0, i: 0, split: true };
      case 2n: return { x: 2, y: 2, level: 0, i: 1, split: true };
      case 3n: return { x: 5, y: 5, level: 0, i: 0, split: false };
      default: return null;
    }
  };

  it("appends a compact (N{N}) suffix to a split point's node, none to a non-split endpoint", () => {
    // original node of the split point (i=0) -> N1; plain (5,5) node stays bare.
    expect(bubbleLabel({ kind: "edge", from: 1n, to: 3n, bidirectional: true }, coords)).toBe("2:2 (N1) <-> 5:5");
  });

  it("numbers a split point's non-original node by its per-point index + 1", () => {
    expect(bubbleLabel({ kind: "edge", from: 2n, to: 3n, bidirectional: true }, coords)).toBe("2:2 (N2) <-> 5:5");
  });

  it("prefixes the floor and still appends the suffix on a multi-floor maze", () => {
    expect(bubbleLabel({ kind: "node", id: 2n }, coords, true)).toBe("L1 2:2 (N2)");
  });

  it("falls back to #id for an unresolved node, no suffix", () => {
    expect(bubbleLabel({ kind: "node", id: 99n }, coords)).toBe("#99");
  });
});

describe("DebugEventTree with Wilson (GitHub issue #145's follow-up)", () => {
  beforeEach(() => {
    useMazeStore.setState({
      debugArena: { tape: buildOneWalkWilsonTape(), algorithmKind: "wilson", sources: [{ scopeName: "generation", kind: "wilson", nodeIndex: 1, startStep: 0, endStep: 3, checkpointFroms: [] }], nodes, allNodes: nodes, totalSteps: 3, debugValueNames: [] },
      debugStep: 0,
    });
  });

  it("labels a walk's two nested scopes as \"Route search\"/\"Route commit\", not numbered step scopes", () => {
    render(<DebugEventTree />);
    expandGeneration();

    const walkRow = screen.getByText(m["debug.tree.walk_scope"]({ index: 1 }));
    fireEvent.click(walkRow);

    expect(screen.getByText(m["debug.tree.search_scope"]())).toBeInTheDocument();
    expect(screen.getByText(m["debug.tree.commit_scope"]())).toBeInTheDocument();
    expect(screen.queryByText(m["debug.tree.step_scope"]({ index: 1 }))).not.toBeInTheDocument();
  });

  it("\"search\" contains StepTaken, \"commit\" contains EdgeAdded/NodeVisited", () => {
    render(<DebugEventTree />);
    expandGeneration();
    fireEvent.click(screen.getByText(m["debug.tree.walk_scope"]({ index: 1 })));
    fireEvent.click(screen.getByText(m["debug.tree.search_scope"]()));
    fireEvent.click(screen.getByText(m["debug.tree.commit_scope"]()));

    expect(screen.getByText(/Step taken/)).toBeInTheDocument();
    expect(screen.getByText(/Passage added/)).toBeInTheDocument();
    expect(screen.getByText(/Cell marked visited/)).toBeInTheDocument();
  });

  it("renders LoopErased/WalkDeadEnd narration — untouched by buildOneWalkWilsonTape's straight-line walk", () => {
    useMazeStore.setState({
      debugArena: { tape: buildLoopErasedDeadEndWilsonTape(), algorithmKind: "wilson", sources: [{ scopeName: "generation", kind: "wilson", nodeIndex: 1, startStep: 0, endStep: 3, checkpointFroms: [] }], nodes, allNodes: nodes, totalSteps: 3, debugValueNames: [] },
      debugStep: 0,
    });
    render(<DebugEventTree />);
    expandGeneration();
    fireEvent.click(screen.getByText(m["debug.tree.walk_scope"]({ index: 1 })));
    fireEvent.click(screen.getByText(m["debug.tree.search_scope"]()));

    expect(screen.getByText(/Loop erased/)).toBeInTheDocument();
    expect(screen.getByText(m["debug.tree.walk_dead_end"]())).toBeInTheDocument();
  });
});

describe("DebugEventTree with a two-source (generation + QC) tape (GitHub issue #147)", () => {
  beforeEach(() => {
    useMazeStore.setState({
      debugArena: {
        tape: buildGenerationPlusQcTape(),
        algorithmKind: "recursive_backtracker",
        sources: [
          { scopeName: "generation", kind: "recursive_backtracker", nodeIndex: 1, startStep: 0, endStep: 1, checkpointFroms: [] },
          { scopeName: "quality_control", kind: "quality_control", nodeIndex: 5, startStep: 1, endStep: 2, checkpointFroms: [] },
        ],
        nodes,
        allNodes: nodes,
        totalSteps: 2,
        debugValueNames: [],
      },
      debugStep: 0,
      stages: [{ id: "s1", name: "Waypoints" }] as never,
      rules: [{ id: "r1", name: "No dead ends" }] as never,
    });
  });

  it("shows exactly two top-level rows, localized, with no spurious extra nesting", () => {
    render(<DebugEventTree />);
    expect(screen.getByText(m["debug.tree.source_scope.generation"]())).toBeInTheDocument();
    expect(screen.getByText(m["debug.tree.source_scope.quality_control"]())).toBeInTheDocument();
    expect(screen.queryByText(m["debug.tree.step_scope"]({ index: 1 }))).not.toBeInTheDocument();

    // The generation source's own "step 1" scope must be a direct child of the "Generation" row,
    // not wrapped in a spurious extra step row (GitHub issue #169's former-root merge artifact is
    // transparent) — "Generation" itself starts collapsed like any other scope row (GitHub issue
    // #186), so "step 1" only appears once it's expanded.
    fireEvent.click(screen.getByText(m["debug.tree.source_scope.generation"]()));
    expect(screen.getByText(m["debug.tree.step_scope"]({ index: 1 }))).toBeInTheDocument();
  });

  it("the QC top-level row's step is its first child's global step, not a dash", () => {
    render(<DebugEventTree />);
    const qcRow = screen.getByText(m["debug.tree.source_scope.quality_control"]()).closest("div")!;
    // QC's first child, structurally, is IterationStarted — trace-only — which resolves to the
    // nearest preceding mutating step: generation's own EdgeAdded, global step 0 (0-based) ->
    // "1" (1-based), not BidirectionalEdgeAdded's step 1 (GitHub issue #186: a scope's step is
    // its first child's step, mutating or not, not the first *mutating* descendant's).
    expect(qcRow.querySelector('[data-testid="step-col"]')).toHaveTextContent("1");
  });

  it("resolves stage/rule scope labels through the live store's stages/rules, quoted", () => {
    render(<DebugEventTree />);
    // Top-level source scopes ("Generation"/"Quality Control") start collapsed (GitHub issue
    // #186) — expand "Quality Control" first so "stage s1"'s row becomes visible.
    fireEvent.click(screen.getByText(m["debug.tree.source_scope.quality_control"]()));
    expect(screen.getByText('Stage "Waypoints"')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Stage "Waypoints"'));
    fireEvent.click(screen.getByText(m["debug.tree.qc.iteration_scope"]({ iteration: 1 })));
    expect(screen.getByText('Rule "No dead ends"')).toBeInTheDocument();
  });
});

// --- Step-message search (GitHub issue #482) ---

describe("DebugEventTree step-message search", () => {
  const twoStepArena = () => ({
    tape: buildTwoStepTape(),
    algorithmKind: "recursive_backtracker" as const,
    sources: [{ scopeName: "generation", kind: "recursive_backtracker" as const, nodeIndex: 1, startStep: 0, endStep: 4, checkpointFroms: [] }],
    nodes,
    allNodes: nodes,
    totalSteps: 4,
    debugValueNames: [],
  });

  beforeEach(() => {
    useMazeStore.setState({ debugArena: twoStepArena(), debugStep: 0, debugSearchQuery: "", debugFocusNodeIndex: null, debugFocusToken: 0 });
  });

  function searchInput() {
    return screen.getByPlaceholderText(m["debug.search.placeholder"]()) as HTMLInputElement;
  }

  it("marks the collapsed ancestor scope of a match with a dot, without jumping", () => {
    const setDebugStep = vi.fn();
    useMazeStore.setState({ setDebugStep });
    render(<DebugEventTree />);
    // Tree is fully collapsed — "Cell" ("Cell marked visited"/"Cell added to stack"/"Cell removed
    // from stack") matches 3 event rows nested under the collapsed "Generation" row, which is the
    // only rendered ancestor and so is the one that carries the dot.
    fireEvent.change(searchInput(), { target: { value: "Cell" } });

    const generationRow = screen.getByText(m["debug.tree.source_scope.generation"]()).closest("[data-index]")!;
    expect(generationRow.querySelector('[data-testid="search-match-dot"]')).toBeInTheDocument();
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
    expect(setDebugStep).not.toHaveBeenCalled();
  });

  it("shows dots on matched rows once their scope is expanded", () => {
    render(<DebugEventTree />);
    expandGeneration();
    fireEvent.click(screen.getByText(m["debug.tree.step_scope"]({ index: 1 })));
    fireEvent.change(searchInput(), { target: { value: "passage added" } });

    // Only EdgeAdded ("Passage added ...") matches.
    expect(screen.getByText("1 / 1")).toBeInTheDocument();
    const dotted = screen.getByText(/Passage added/).closest('[data-index]')!;
    expect(dotted.querySelector('[data-testid="search-match-dot"]')).toBeInTheDocument();
    // Its ancestor "step 1" scope also carries the dot (a match anywhere in the subtree).
    const stepRow = screen.getByText(m["debug.tree.step_scope"]({ index: 1 })).closest("[data-index]")!;
    expect(stepRow.querySelector('[data-testid="search-match-dot"]')).toBeInTheDocument();
  });

  it("highlights the match row the same way a step-number click does, and moves debugStep for a mutating match", () => {
    // Real store actions (prior tests in this block inject vi.fn() mocks that leak — the setup has
    // no per-test store reset), no floor-switch path.
    const realActions = useMazeStore.getInitialState();
    useMazeStore.setState({
      floors: [], debugAutoSwitchFloor: false,
      setDebugStep: realActions.setDebugStep, focusDebugNode: realActions.focusDebugNode,
    });
    render(<DebugEventTree />);
    fireEvent.change(searchInput(), { target: { value: "Cell" } });
    // matches[0] = VertexVisited (step 1). Enter -> matches[1] = VertexPushed (step 2, mutating).
    fireEvent.keyDown(searchInput(), { key: "Enter" });

    expect(useMazeStore.getState().debugStep).toBe(2);
    const pushedRow = screen.getByText(m["debug.tree.vertex_pushed"]()).closest("[data-index]") as HTMLElement;
    expect(pushedRow.style.background).not.toBe("");
  });

  it("Enter advances to the next match and wraps; a mutating match also moves debugStep", () => {
    const focusDebugNode = vi.fn();
    const setDebugStep = vi.fn();
    useMazeStore.setState({ focusDebugNode, setDebugStep });
    render(<DebugEventTree />);
    fireEvent.change(searchInput(), { target: { value: "Cell" } });
    // 3 matches: VertexVisited (step 1), VertexPushed (step 2), VertexPopped (step 3). Initial
    // current = matches[0]; first Enter -> matches[1].
    fireEvent.keyDown(searchInput(), { key: "Enter" });
    expect(focusDebugNode).toHaveBeenCalledTimes(1);
    expect(setDebugStep).toHaveBeenLastCalledWith(2);

    fireEvent.keyDown(searchInput(), { key: "Enter" }); // -> matches[2], step 3
    fireEvent.keyDown(searchInput(), { key: "Enter" }); // wrap -> matches[0], step 1
    expect(setDebugStep).toHaveBeenLastCalledWith(1);
    expect(focusDebugNode).toHaveBeenCalledTimes(3);
  });

  it("Shift+Enter goes to the previous match, wrapping from the first", () => {
    const setDebugStep = vi.fn();
    useMazeStore.setState({ setDebugStep });
    render(<DebugEventTree />);
    fireEvent.change(searchInput(), { target: { value: "Cell" } });
    // current = matches[0]; Shift+Enter wraps to matches[2] (VertexPopped, step 3).
    fireEvent.keyDown(searchInput(), { key: "Enter", shiftKey: true });
    expect(setDebugStep).toHaveBeenLastCalledWith(3);
  });

  it("disables the nav buttons and makes Enter a no-op when there is 0 or 1 match", () => {
    const focusDebugNode = vi.fn();
    useMazeStore.setState({ focusDebugNode });
    render(<DebugEventTree />);
    fireEvent.change(searchInput(), { target: { value: "passage added" } }); // exactly 1 match

    expect(getTooltipControl(m["debug.search.next"]())).toBeDisabled();
    expect(getTooltipControl(m["debug.search.prev"]())).toBeDisabled();
    fireEvent.keyDown(searchInput(), { key: "Enter" });
    expect(focusDebugNode).not.toHaveBeenCalled();
  });

  it("navigating a scope-header match jumps debugStep to that scope's nearest-preceding step and selects the scope row (GitHub issue #482)", () => {
    const focusDebugNode = vi.fn();
    const setDebugStep = vi.fn();
    useMazeStore.setState({ focusDebugNode, setDebugStep });
    render(<DebugEventTree />);
    fireEvent.change(searchInput(), { target: { value: "step" } }); // "Step 1" + "Step 2" headers
    expect(screen.getByText("1 / 2")).toBeInTheDocument();

    fireEvent.keyDown(searchInput(), { key: "Enter" }); // -> "Step 2" scope (nodeIndex 7)
    expect(focusDebugNode).toHaveBeenCalledTimes(1);
    // "Step 2" scope's nearest-preceding step is VertexPushed (step 2), the same one its step
    // column shows — navigation activates it exactly as a row click would.
    expect(setDebugStep).toHaveBeenCalledWith(2);
  });

  it("syncs the match counter when an external step-column click lands on a match row (GitHub issue #482)", () => {
    // Real store actions (prior tests inject vi.fn() mocks that leak — no per-test store reset).
    const realActions = useMazeStore.getInitialState();
    useMazeStore.setState({
      floors: [], debugAutoSwitchFloor: false,
      setDebugStep: realActions.setDebugStep, focusDebugNode: realActions.focusDebugNode,
      focusDebugStep: realActions.focusDebugStep,
    });
    render(<DebugEventTree />);
    expandGeneration();
    fireEvent.click(screen.getByText(m["debug.tree.step_scope"]({ index: 1 })));
    fireEvent.change(searchInput(), { target: { value: "Cell" } });
    // 3 matches: VertexVisited (step 1), VertexPushed (step 2), VertexPopped (step 3). Counter
    // starts at matches[0].
    expect(screen.getByText("1 / 3")).toBeInTheDocument();

    // Click VertexPushed's own step column — a step change from outside the search nav that lands
    // on matches[1]. `effectiveCurrentNodeIndex` picks it up via `highlightedNodeIndex`.
    const pushedStepCol = screen.getByText(m["debug.tree.vertex_pushed"]())
      .closest("div")!.querySelector('[data-testid="step-col"]')!;
    fireEvent.click(pushedStepCol);
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
  });

  it("the input reflects debugSearchQuery, including an external reset to empty", () => {
    render(<DebugEventTree />);
    fireEvent.change(searchInput(), { target: { value: "Cell" } });
    expect(searchInput().value).toBe("Cell");

    act(() => useMazeStore.getState().setDebugMode(false));
    expect(searchInput().value).toBe("");
  });

  it("counts two matches when two rows render the same text", () => {
    // "Cell added to stack" (VertexPushed) and a second identical VertexPushed row — build a tape
    // where two mutating events narrate identically.
    const dupTape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("generation") },
      { parent: 1, firstChild: 3, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 2, firstChild: 4, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step 1") },
      { parent: 3, firstChild: null, nextSibling: 5, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.VERTEX_PUSHED, payloadBytes: vertexPayload(2n) },
      { parent: 3, firstChild: null, nextSibling: null, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.VERTEX_PUSHED, payloadBytes: vertexPayload(2n) },
    ]);
    useMazeStore.setState({
      debugArena: { ...twoStepArena(), tape: dupTape, totalSteps: 2 },
      debugStep: 0,
    });
    render(<DebugEventTree />);
    fireEvent.change(searchInput(), { target: { value: m["debug.tree.vertex_pushed"]().toLowerCase() } });
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
  });

  it("recomputes matches and resets the current match when the tape changes under an active query", () => {
    render(<DebugEventTree />);
    fireEvent.change(searchInput(), { target: { value: "Cell" } });
    expect(screen.getByText("1 / 3")).toBeInTheDocument();

    // Swap in the generation+QC tape — "Cell" no longer matches anything there.
    act(() => useMazeStore.setState({
      debugArena: {
        tape: buildGenerationPlusQcTape(),
        algorithmKind: "recursive_backtracker",
        sources: [
          { scopeName: "generation", kind: "recursive_backtracker", nodeIndex: 1, startStep: 0, endStep: 1, checkpointFroms: [] },
          { scopeName: "quality_control", kind: "quality_control", nodeIndex: 5, startStep: 1, endStep: 2, checkpointFroms: [] },
        ],
        nodes, allNodes: nodes, totalSteps: 2, debugValueNames: [],
      },
      debugStep: 0,
      stages: [{ id: "s1", name: "Waypoints" }] as never,
      rules: [{ id: "r1", name: "No dead ends" }] as never,
    }));
    expect(screen.getByText("0 / 0")).toBeInTheDocument();
  });
});
