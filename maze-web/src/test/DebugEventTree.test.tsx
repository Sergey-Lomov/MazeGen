import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DebugEventTree } from "../components/DebugEventTree";
import { useMazeStore } from "../store/mazeStore";
import { parseTape, TAG_SCOPE, NO_NODE, RB_TAG, WILSON_TAG, QC_TAG, type ParsedTape } from "../debug/eventTape";
import type { NodeDto } from "../wasm/types";
import * as m from "~/paraglide/messages";

// --- Fixture encoder — same shape as debugTreeSelectors.test.ts's buildTwoStepTape, duplicated
// locally per that file's own precedent (small enough not to be worth a shared test-util yet).

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
  // bidirectional=true (GitHub issue #135).
  return concatBytes([u64le(from), u64le(to), new Uint8Array([1])]);
}

function vertexPayload(id: bigint): Uint8Array {
  return u64le(id);
}

function stepTakenPayload(from: bigint, to: bigint): Uint8Array {
  return concatBytes([u64le(from), u64le(to)]);
}

function u32le(v: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, v, true);
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

// Every fixture is wrapped in the merge shape `event_log::merge_tapes` always produces (GitHub
// issue #169): node 0 = merged root, node 1 = "generation" top-level source scope, node 2 =
// the algorithm's own former root, one level deeper than pre-#169 fixtures had it. Real tags
// aren't namespaced here (single source, source_index 0 -> tag unchanged, see merge_tapes' docs)
// — only the extra two wrapper nodes need to exist for DebugEventTree's auto-expand-the-source-
// scope behavior to land on the right node.

// root (0) -> "generation" scope (1) -> former root (2) -> "step 1" scope (3)
//   -> EdgeAdded(1,2) (4) -> VertexVisited(2) (5) -> VertexPushed(2) (6)
//   -> "step 2" scope (7) -> DeadEnd (8) -> VertexPopped(2) (9)
function buildTwoStepTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("generation") },
    { parent: 1, firstChild: 3, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 2, firstChild: 4, nextSibling: 7, tag: TAG_SCOPE, payloadBytes: scopePayload("step 1") },
    { parent: 3, firstChild: null, nextSibling: 5, tag: RB_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 2n) },
    { parent: 3, firstChild: null, nextSibling: 6, tag: RB_TAG.VERTEX_VISITED, payloadBytes: vertexPayload(2n) },
    { parent: 3, firstChild: null, nextSibling: null, tag: RB_TAG.VERTEX_PUSHED, payloadBytes: vertexPayload(2n) },
    { parent: 2, firstChild: 8, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step 2") },
    { parent: 7, firstChild: null, nextSibling: 9, tag: RB_TAG.DEAD_END, payloadBytes: new Uint8Array(0) },
    { parent: 7, firstChild: null, nextSibling: null, tag: RB_TAG.VERTEX_POPPED, payloadBytes: vertexPayload(2n) },
  ]);
}

// root (0) -> "generation" scope (1) -> former root (2) -> "walk 1" scope (3) -> WalkStartPicked(1) (4)
//                                                        -> "search" scope (5) -> StepTaken(1,2) (6)
//                                                        -> "commit" scope (7) -> EdgeAdded(1,2) (8) -> NodeVisited(1) (9)
// Mirrors wilson.rs's `generate`'s new two-phase shape (GitHub issue #145's follow-up) — a walk
// scope's only nested scopes are exactly "search" then "commit", not one "step M" scope per step.
function buildOneWalkWilsonTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("generation") },
    { parent: 1, firstChild: 3, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 2, firstChild: 4, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("walk 1") },
    { parent: 3, firstChild: null, nextSibling: 5, tag: WILSON_TAG.WALK_START_PICKED, payloadBytes: vertexPayload(1n) },
    { parent: 3, firstChild: 6, nextSibling: 7, tag: TAG_SCOPE, payloadBytes: scopePayload("search") },
    { parent: 5, firstChild: null, nextSibling: null, tag: WILSON_TAG.STEP_TAKEN, payloadBytes: stepTakenPayload(1n, 2n) },
    { parent: 3, firstChild: 8, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("commit") },
    { parent: 7, firstChild: null, nextSibling: 9, tag: WILSON_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 2n) },
    { parent: 7, firstChild: null, nextSibling: null, tag: WILSON_TAG.NODE_VISITED, payloadBytes: vertexPayload(1n) },
  ]);
}

// root (0) -> "generation" scope (1) -> former root (2) -> "walk 1" scope (3) -> WalkStartPicked(1) (4)
//                                                        -> "search" scope (5) -> StepTaken(1,2) (6) -> LoopErased(2) (7) -> WalkDeadEnd (8)
// Covers wilsonNarrationTokensFor's LoopErased/WalkDeadEnd branches, which buildOneWalkWilsonTape
// doesn't exercise (its walk connects straight into "commit" without a loop or a dead end).
function buildLoopErasedDeadEndWilsonTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("generation") },
    { parent: 1, firstChild: 3, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 2, firstChild: 4, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("walk 1") },
    { parent: 3, firstChild: null, nextSibling: 5, tag: WILSON_TAG.WALK_START_PICKED, payloadBytes: vertexPayload(1n) },
    { parent: 3, firstChild: 6, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("search") },
    { parent: 5, firstChild: null, nextSibling: 7, tag: WILSON_TAG.STEP_TAKEN, payloadBytes: stepTakenPayload(1n, 2n) },
    { parent: 5, firstChild: null, nextSibling: 8, tag: WILSON_TAG.LOOP_ERASED, payloadBytes: vertexPayload(2n) },
    { parent: 5, firstChild: null, nextSibling: null, tag: WILSON_TAG.WALK_DEAD_END, payloadBytes: new Uint8Array(0) },
  ]);
}

const nodes: NodeDto[] = [
  { id: 1, x: 0, y: 0 },
  { id: 2, x: 3, y: 4 },
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

describe("DebugEventTree", () => {
  beforeEach(() => {
    useMazeStore.setState({
      debugArena: { tape: buildTwoStepTape(), algorithmKind: "recursive_backtracker", sources: [{ scopeName: "generation", kind: "recursive_backtracker", nodeIndex: 1, startStep: 0, endStep: 4 }], nodes, totalSteps: 4, checkpointFroms: [], debugValueNames: [] },
      debugStep: 0,
    });
  });

  it("starts fully collapsed, showing only the two top-level step rows", () => {
    render(<DebugEventTree />);
    expect(screen.getByText(m["debug.tree.step_scope"]({ index: 1 }))).toBeInTheDocument();
    expect(screen.getByText(m["debug.tree.step_scope"]({ index: 2 }))).toBeInTheDocument();
    expect(screen.queryByText(/Edge added/)).not.toBeInTheDocument();
  });

  it("clicking a step row's body reveals its children without changing debugStep", () => {
    const setDebugStep = vi.fn();
    useMazeStore.setState({ setDebugStep });
    render(<DebugEventTree />);

    const firstStepRow = screen.getByText(m["debug.tree.step_scope"]({ index: 1 }));
    fireEvent.click(firstStepRow);

    expect(screen.getByText(/Edge added/)).toBeInTheDocument();
    expect(setDebugStep).not.toHaveBeenCalled();
  });

  it("clicking the step-number column jumps debugStep to that node's step", () => {
    const setDebugStep = vi.fn();
    useMazeStore.setState({ setDebugStep });
    render(<DebugEventTree />);

    // The merged tree's auto-expanded "generation"/former-root wrapper rows (GitHub issue #169)
    // each render their own step-col too — find "step 1"'s own column specifically.
    const firstStepCol = screen.getByText(m["debug.tree.step_scope"]({ index: 1 })).closest("div")!.querySelector('[data-testid="step-col"]')!;
    fireEvent.click(firstStepCol);

    // First "step 1" scope (nodeIndex 3, per the merged fixture's layout) has no preceding
    // mutating event -> clamps to step 0.
    expect(setDebugStep).toHaveBeenCalledWith(0);
  });

  it("jumps to the step shown in the column, not the nearest-preceding step for the scope node itself", () => {
    // "step 2" (nodeIndex 7, per the merged fixture's layout) sits right after VertexPushed (step
    // 2, nodeIndex 6) in arena order, so the *nearest-preceding* step for node 7 itself would be
    // 2. But the column displays "4" (1-based) for "step 2" — its first mutating descendant,
    // VertexPopped, is step 3. Clicking must jump to 3, matching what's actually displayed, not
    // the scope node's own nearest step.
    const setDebugStep = vi.fn();
    useMazeStore.setState({ setDebugStep });
    render(<DebugEventTree />);

    // The merged tree's auto-expanded "generation"/former-root wrapper rows (GitHub issue #169)
    // each render their own step-col too — find "step 2"'s own column specifically rather than
    // assuming it's the second entry in document order.
    const secondStepCol = screen.getByText(m["debug.tree.step_scope"]({ index: 2 })).closest("div")!.querySelector('[data-testid="step-col"]')!;
    expect(secondStepCol).toHaveTextContent("4");
    fireEvent.click(secondStepCol);

    expect(setDebugStep).toHaveBeenCalledWith(3);
  });

  it("scope shows the first mutating descendant's step; a trace-only leaf shows the nearest preceding mutating step (GitHub issue #166)", () => {
    // "step 1" -> EdgeAdded (mutating, step 0), VertexVisited (mutating, step 1), VertexPushed
    // (mutating, step 2): first mutating descendant is EdgeAdded at step 0 -> displayed as "1".
    // "step 2" -> DeadEnd (trace-only), VertexPopped (mutating, step 3): first mutating
    // descendant is VertexPopped at step 3 -> displayed as "4". DeadEnd itself is trace-only, so
    // its own row shows the nearest preceding mutating step — VertexPushed, step 2 -> "3", not a
    // dash — despite "step 2" showing a different number ("4").
    render(<DebugEventTree />);
    // The merged tree's auto-expanded "generation"/former-root wrapper rows (GitHub issue #169)
    // each render their own step-col too — find "step 1"/"step 2"'s own columns specifically
    // rather than assuming the first two entries in document order.
    const stepOneCol = screen.getByText(m["debug.tree.step_scope"]({ index: 1 })).closest("div")!.querySelector('[data-testid="step-col"]');
    const stepTwoCol = screen.getByText(m["debug.tree.step_scope"]({ index: 2 })).closest("div")!.querySelector('[data-testid="step-col"]');
    expect(stepOneCol).toHaveTextContent("1");
    expect(stepTwoCol).toHaveTextContent("4");

    fireEvent.click(screen.getByText(m["debug.tree.step_scope"]({ index: 2 })));
    const deadEndRow = screen.getByText(m["debug.tree.dead_end"]()).closest("div")!;
    expect(deadEndRow.querySelector('[data-testid="step-col"]')).toHaveTextContent("3");
  });

  it("clicking a childless row's body (not just the step column) jumps to its displayed step (GitHub issue #166)", () => {
    const setDebugStep = vi.fn();
    useMazeStore.setState({ setDebugStep });
    render(<DebugEventTree />);

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

  it("throws when an event references a node id absent from debugArena.nodes (fail loud, not NaN)", () => {
    // Same tape shape but VertexVisited references id 99, which isn't in `nodes`. The bad event
    // is a leaf under the top-level scope, so it's only decoded (and only throws) once expanded —
    // matches how DebugEventTree only calls rowLabel/narrationFor for currently-visible rows.
    const brokenTape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("generation") },
      { parent: 1, firstChild: 3, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 2, firstChild: 4, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step 1") },
      { parent: 3, firstChild: null, nextSibling: null, tag: RB_TAG.VERTEX_VISITED, payloadBytes: vertexPayload(99n) },
    ]);
    useMazeStore.setState({ debugArena: { tape: brokenTape, algorithmKind: "recursive_backtracker", sources: [{ scopeName: "generation", kind: "recursive_backtracker", nodeIndex: 1, startStep: 0, endStep: 1 }], nodes, totalSteps: 1, checkpointFroms: [], debugValueNames: [] }, debugStep: 0 });

    // Suppress React's expected error-boundary console noise for this deliberate-throw case.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<DebugEventTree />);
    const stepScopeRow = screen.getByText(m["debug.tree.step_scope"]({ index: 1 }));
    expect(() => fireEvent.click(stepScopeRow)).toThrow(/node id 99 not found/);
    consoleError.mockRestore();
  });
});

describe("DebugEventTree with Wilson (GitHub issue #145's follow-up)", () => {
  beforeEach(() => {
    useMazeStore.setState({
      debugArena: { tape: buildOneWalkWilsonTape(), algorithmKind: "wilson", sources: [{ scopeName: "generation", kind: "wilson", nodeIndex: 1, startStep: 0, endStep: 3 }], nodes, totalSteps: 3, checkpointFroms: [], debugValueNames: [] },
      debugStep: 0,
    });
  });

  it("labels a walk's two nested scopes as \"Route search\"/\"Route commit\", not numbered step scopes", () => {
    render(<DebugEventTree />);

    const walkRow = screen.getByText(m["debug.tree.walk_scope"]({ index: 1 }));
    fireEvent.click(walkRow);

    expect(screen.getByText(m["debug.tree.search_scope"]())).toBeInTheDocument();
    expect(screen.getByText(m["debug.tree.commit_scope"]())).toBeInTheDocument();
    expect(screen.queryByText(m["debug.tree.step_scope"]({ index: 1 }))).not.toBeInTheDocument();
  });

  it("\"search\" contains StepTaken, \"commit\" contains EdgeAdded/NodeVisited", () => {
    render(<DebugEventTree />);
    fireEvent.click(screen.getByText(m["debug.tree.walk_scope"]({ index: 1 })));
    fireEvent.click(screen.getByText(m["debug.tree.search_scope"]()));
    fireEvent.click(screen.getByText(m["debug.tree.commit_scope"]()));

    expect(screen.getByText(/Step taken/)).toBeInTheDocument();
    expect(screen.getByText(/Edge added/)).toBeInTheDocument();
    expect(screen.getByText(/Tile marked visited/)).toBeInTheDocument();
  });

  it("renders LoopErased/WalkDeadEnd narration — untouched by buildOneWalkWilsonTape's straight-line walk", () => {
    useMazeStore.setState({
      debugArena: { tape: buildLoopErasedDeadEndWilsonTape(), algorithmKind: "wilson", sources: [{ scopeName: "generation", kind: "wilson", nodeIndex: 1, startStep: 0, endStep: 3 }], nodes, totalSteps: 3, checkpointFroms: [], debugValueNames: [] },
      debugStep: 0,
    });
    render(<DebugEventTree />);
    fireEvent.click(screen.getByText(m["debug.tree.walk_scope"]({ index: 1 })));
    fireEvent.click(screen.getByText(m["debug.tree.search_scope"]()));

    expect(screen.getByText(/Loop erased/)).toBeInTheDocument();
    expect(screen.getByText(m["debug.tree.walk_dead_end"]())).toBeInTheDocument();
  });
});

// root (0) -> "generation" scope (1) -> RB former root (2) -> "step 1" scope (3) -> EdgeAdded(1,2) (4)
//          -> "quality_control" scope (5) -> QC former root (6)
//               -> "stage s1" scope (7) -> "iteration 1" scope (8)
//                    -> IterationStarted(0) (9)
//                    -> "rule r1" scope (10) -> BidirectionalEdgeAdded(1,2) (11)
// Mirrors the real generation+QC merge shape `run_generate`/`merge_tapes` produce (GitHub issue
// #147) — covers all three tree-rendering regressions from that issue's bug batch at once: double
// nesting under a spurious extra "step 0" wrapper, wrong top-level step numbering, and raw
// `quality_control`/scope-name text instead of localized "Quality Control"/quoted stage-rule titles.
function buildGenerationPlusQcTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: 5, tag: TAG_SCOPE, payloadBytes: scopePayload("generation") },
    { parent: 1, firstChild: 3, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 2, firstChild: 4, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step 1") },
    { parent: 3, firstChild: null, nextSibling: null, tag: RB_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 2n) },
    { parent: 0, firstChild: 6, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("quality_control") },
    { parent: 5, firstChild: 7, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 6, firstChild: 8, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("stage s1") },
    { parent: 7, firstChild: 9, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("iteration 1") },
    { parent: 8, firstChild: null, nextSibling: 10, tag: QC_TAG.ITERATION_STARTED, payloadBytes: u32le(0) },
    { parent: 8, firstChild: 11, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("rule r1") },
    { parent: 10, firstChild: null, nextSibling: null, tag: QC_TAG.BIDIRECTIONAL_EDGE_ADDED, payloadBytes: concatBytes([u64le(1n), u64le(2n)]) },
  ]);
}

describe("DebugEventTree with a two-source (generation + QC) tape (GitHub issue #147)", () => {
  beforeEach(() => {
    useMazeStore.setState({
      debugArena: {
        tape: buildGenerationPlusQcTape(),
        algorithmKind: "recursive_backtracker",
        sources: [
          { scopeName: "generation", kind: "recursive_backtracker", nodeIndex: 1, startStep: 0, endStep: 1 },
          { scopeName: "quality_control", kind: "quality_control", nodeIndex: 5, startStep: 1, endStep: 2 },
        ],
        nodes,
        totalSteps: 2,
        checkpointFroms: [],
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
    // The generation source's own "step 1" scope must be a direct child of the "Generation" row,
    // not wrapped in a spurious extra step row — "Generation" is already auto-expanded on mount
    // (GitHub issue #169), so "step 1" is visible without any click, directly under it.
    expect(screen.getByText(m["debug.tree.step_scope"]({ index: 1 }))).toBeInTheDocument();
  });

  it("the QC top-level row's step is its first mutating descendant's global step, not a dash", () => {
    render(<DebugEventTree />);
    const qcRow = screen.getByText(m["debug.tree.source_scope.quality_control"]()).closest("div")!;
    // QC's own first mutating event (BidirectionalEdgeAdded) is global step 1 (0-based) -> "2" (1-based).
    expect(qcRow.querySelector('[data-testid="step-col"]')).toHaveTextContent("2");
  });

  it("resolves stage/rule scope labels through the live store's stages/rules, quoted", () => {
    render(<DebugEventTree />);
    // Top-level source scopes ("Generation"/"Quality Control") are auto-expanded on mount, so
    // "stage s1"'s row is already visible without clicking "Quality Control" first.
    expect(screen.getByText('Stage "Waypoints"')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Stage "Waypoints"'));
    fireEvent.click(screen.getByText(m["debug.tree.qc.iteration_scope"]({ iteration: 1 })));
    expect(screen.getByText('Rule "No dead ends"')).toBeInTheDocument();
  });
});
