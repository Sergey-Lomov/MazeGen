import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DebugEventTree } from "../components/DebugEventTree";
import { useMazeStore } from "../store/mazeStore";
import { parseTape, TAG_SCOPE, NO_NODE, RB_TAG, type ParsedTape } from "../debug/eventTape";
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

// root (0) -> "step 1" scope (1) -> EdgeAdded(1,2) (2) -> VertexVisited(2) (3) -> VertexPushed(2) (4)
//          -> "step 2" scope (5) -> DeadEnd (6) -> VertexPopped(2) (7)
function buildTwoStepTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: 5, tag: TAG_SCOPE, payloadBytes: scopePayload("step 1") },
    { parent: 1, firstChild: null, nextSibling: 3, tag: RB_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 2n) },
    { parent: 1, firstChild: null, nextSibling: 4, tag: RB_TAG.VERTEX_VISITED, payloadBytes: vertexPayload(2n) },
    { parent: 1, firstChild: null, nextSibling: null, tag: RB_TAG.VERTEX_PUSHED, payloadBytes: vertexPayload(2n) },
    { parent: 0, firstChild: 6, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step 2") },
    { parent: 5, firstChild: null, nextSibling: 7, tag: RB_TAG.DEAD_END, payloadBytes: new Uint8Array(0) },
    { parent: 5, firstChild: null, nextSibling: null, tag: RB_TAG.VERTEX_POPPED, payloadBytes: vertexPayload(2n) },
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
      debugArena: { tape: buildTwoStepTape(), nodes, totalSteps: 4, checkpointFroms: [] },
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

    // Both top-level "step" scopes render a step-number column; the first one is "step 1"'s.
    const [firstStepCol] = screen.getAllByTestId("step-col");
    fireEvent.click(firstStepCol);

    // First "step 1" scope (nodeIndex 1) has no preceding mutating event -> clamps to step 0.
    expect(setDebugStep).toHaveBeenCalledWith(0);
  });

  it("jumps to the step shown in the column, not the nearest-preceding step for the scope node itself", () => {
    // "step 2" (nodeIndex 5) sits right after VertexPushed (step 2, nodeIndex 4) in arena order,
    // so the *nearest-preceding* step for node 5 itself would be 2. But the column displays "4"
    // (1-based) for "step 2" — its first mutating descendant, VertexPopped, is step 3. Clicking
    // must jump to 3, matching what's actually displayed, not the scope node's own nearest step.
    const setDebugStep = vi.fn();
    useMazeStore.setState({ setDebugStep });
    render(<DebugEventTree />);

    const [, secondStepCol] = screen.getAllByTestId("step-col");
    expect(secondStepCol).toHaveTextContent("4");
    fireEvent.click(secondStepCol);

    expect(setDebugStep).toHaveBeenCalledWith(3);
  });

  it("scope shows the first mutating descendant's step; a trace-only leaf shows a dash", () => {
    // "step 1" -> EdgeAdded (mutating, step 0), VertexVisited (mutating, step 1), VertexPushed
    // (mutating, step 2): first mutating descendant is EdgeAdded at step 0 -> displayed as "1".
    // "step 2" -> DeadEnd (trace-only), VertexPopped (mutating, step 3): first mutating
    // descendant is VertexPopped at step 3 -> displayed as "4". DeadEnd itself is trace-only,
    // so its own row shows a dash despite "step 2" showing a number.
    render(<DebugEventTree />);
    const stepCols = screen.getAllByTestId("step-col");
    expect(stepCols[0]).toHaveTextContent("1");
    expect(stepCols[1]).toHaveTextContent("4");

    fireEvent.click(screen.getByText(m["debug.tree.step_scope"]({ index: 2 })));
    const deadEndRow = screen.getByText(m["debug.tree.dead_end"]()).closest("div")!;
    expect(deadEndRow.querySelector('[data-testid="step-col"]')).toHaveTextContent("—");
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
      { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step 1") },
      { parent: 1, firstChild: null, nextSibling: null, tag: RB_TAG.VERTEX_VISITED, payloadBytes: vertexPayload(99n) },
    ]);
    useMazeStore.setState({ debugArena: { tape: brokenTape, nodes, totalSteps: 1, checkpointFroms: [] }, debugStep: 0 });

    // Suppress React's expected error-boundary console noise for this deliberate-throw case.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<DebugEventTree />);
    const stepScopeRow = screen.getByText(m["debug.tree.step_scope"]({ index: 1 }));
    expect(() => fireEvent.click(stepScopeRow)).toThrow(/node id 99 not found/);
    consoleError.mockRestore();
  });
});
