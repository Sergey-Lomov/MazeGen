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

// root (0) -> "step" scope (1) -> EdgeAdded(1,2) (2) -> VertexVisited(2) (3) -> VertexPushed(2) (4)
//          -> "step" scope (5) -> DeadEnd (6) -> VertexPopped(2) (7)
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
      debugArena: { tape: buildTwoStepTape(), nodes, totalSteps: 4 },
      debugStep: 0,
    });
  });

  it("starts fully collapsed, showing only the two top-level step rows", () => {
    render(<DebugEventTree />);
    const stepLabel = m["debug.tree.step_scope"]();
    expect(screen.getAllByText(stepLabel)).toHaveLength(2);
    expect(screen.queryByText(/Edge added/)).not.toBeInTheDocument();
  });

  it("expanding a step's disclosure triangle reveals its children without changing debugStep", () => {
    const setDebugStep = vi.fn();
    useMazeStore.setState({ setDebugStep });
    render(<DebugEventTree />);

    const [firstDisclosure] = screen.getAllByText(m["debug.tree.step_scope"]())
      .map((el) => el.parentElement!.querySelector("span")!); // disclosure span is the row's first child
    fireEvent.click(firstDisclosure);

    expect(screen.getByText(/Edge added/)).toBeInTheDocument();
    expect(setDebugStep).not.toHaveBeenCalled();
  });

  it("clicking a row body jumps debugStep to that node's step", () => {
    const setDebugStep = vi.fn();
    useMazeStore.setState({ setDebugStep });
    render(<DebugEventTree />);

    const [firstStepRow] = screen.getAllByText(m["debug.tree.step_scope"]());
    fireEvent.click(firstStepRow);

    // First "step" scope (nodeIndex 1) has no preceding mutating event -> clamps to step 0.
    expect(setDebugStep).toHaveBeenCalledWith(0);
  });

  it("throws when an event references a node id absent from debugArena.nodes (fail loud, not NaN)", () => {
    // Same tape shape but VertexVisited references id 99, which isn't in `nodes`. The bad event
    // is a leaf under the top-level scope, so it's only decoded (and only throws) once expanded —
    // matches how DebugEventTree only calls rowLabel/narrationFor for currently-visible rows.
    const brokenTape = buildFixture([
      { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
      { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step") },
      { parent: 1, firstChild: null, nextSibling: null, tag: RB_TAG.VERTEX_VISITED, payloadBytes: vertexPayload(99n) },
    ]);
    useMazeStore.setState({ debugArena: { tape: brokenTape, nodes, totalSteps: 1 }, debugStep: 0 });

    // Suppress React's expected error-boundary console noise for this deliberate-throw case.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<DebugEventTree />);
    const disclosure = screen.getByText(m["debug.tree.step_scope"]()).parentElement!.querySelector("span")!;
    expect(() => fireEvent.click(disclosure)).toThrow(/node id 99 not found/);
    consoleError.mockRestore();
  });
});
