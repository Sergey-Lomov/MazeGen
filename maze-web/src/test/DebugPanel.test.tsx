import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { DebugPanel } from "../components/DebugPanel";
import { useMazeStore } from "../store/mazeStore";
import { parseTape, resolveDebugArenaMetadata, parseCheckpoints, TAG_SCOPE, RB_TAG, NO_NODE, type ParsedTape } from "../debug/eventTape";
import type { NodeDto } from "../wasm/types";

// --- Fixture encoder — same shape as DebugEventTree.test.tsx's buildTwoStepTape (this component
// renders <DebugEventTree /> internally, which requires real "step N" scope nodes, not the flat
// under-root layout storeTestHelpers.ts's encodeEdgeAddedTape produces). Duplicated locally per
// that file's own precedent (small enough not to be worth a shared test-util yet).

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

// root (0) -> "step 1" scope (1) -> EdgeAdded(1,2) (2)  [1 mutating event: step 0]
//          -> "step 2" scope (3) -> EdgeAdded(2,3) (4)  [1 mutating event: step 1]
//          -> "step 3" scope (5) -> EdgeAdded(3,4) (6)  [1 mutating event: step 2]
function buildThreeStepTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: 3, tag: TAG_SCOPE, payloadBytes: scopePayload("step 1") },
    { parent: 1, firstChild: null, nextSibling: null, tag: RB_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 2n) },
    { parent: 0, firstChild: 4, nextSibling: 5, tag: TAG_SCOPE, payloadBytes: scopePayload("step 2") },
    { parent: 3, firstChild: null, nextSibling: null, tag: RB_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(2n, 3n) },
    { parent: 0, firstChild: 6, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step 3") },
    { parent: 5, firstChild: null, nextSibling: null, tag: RB_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(3n, 4n) },
  ]);
}

const nodes: NodeDto[] = [
  { id: 1, x: 0, y: 0 },
  { id: 2, x: 1, y: 0 },
  { id: 3, x: 2, y: 0 },
  { id: 4, x: 3, y: 0 },
];

function threeStepArena() {
  const tape = buildThreeStepTape();
  const emptyCheckpoints = parseCheckpoints(new Uint8Array(0), new Uint8Array(0));
  const { totalSteps, checkpointFroms } = resolveDebugArenaMetadata(tape, emptyCheckpoints);
  return { tape, nodes, totalSteps, checkpointFroms };
}

// jsdom has no real layout — DebugEventTree's virtualized list needs a non-zero viewport (see
// DebugEventTree.test.tsx's own setup for the underlying reason).
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 320 });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DebugPanel", () => {
  it("renders null when there is no debug arena", () => {
    useMazeStore.setState({ debugArena: null, debugStep: 0 });
    const { container } = render(<DebugPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the current step (1-based) and total steps", () => {
    useMazeStore.setState({ debugArena: threeStepArena(), debugStep: 1 });
    render(<DebugPanel />);
    expect(screen.getByText(/2 \/ 3/)).toBeInTheDocument();
  });

  it("shows the edge count reconstructed at the current debugStep, both directions per bidirectional EdgeAdded", () => {
    useMazeStore.setState({ debugArena: threeStepArena(), debugStep: 1 });
    render(<DebugPanel />);
    // debugStep 1 = first two EdgeAdded events applied, each bidirectional -> 4 edges.
    expect(screen.getByText(/\(4 edges\)/)).toBeInTheDocument();
  });

  it("recomputes the edge count when debugStep changes", () => {
    useMazeStore.setState({ debugArena: threeStepArena(), debugStep: 0 });
    const { rerender } = render(<DebugPanel />);
    expect(screen.getByText(/\(2 edges\)/)).toBeInTheDocument();

    useMazeStore.setState({ debugStep: 2 });
    rerender(<DebugPanel />);
    expect(screen.getByText(/\(6 edges\)/)).toBeInTheDocument();
  });

  it("does not recompute the edge count when an unrelated store field changes (debugArena/debugStep memoization)", () => {
    useMazeStore.setState({ debugArena: threeStepArena(), debugStep: 1 });
    const { rerender } = render(<DebugPanel />);
    expect(screen.getByText(/\(4 edges\)/)).toBeInTheDocument();

    // Force a re-render with debugArena/debugStep unchanged (same references) but some unrelated
    // store field touched — the memoized value must not be recomputed to a different (wrong)
    // result, and the displayed count must stay identical.
    useMazeStore.setState({ debugAutoPlayDelay: 999 });
    rerender(<DebugPanel />);
    expect(screen.getByText(/\(4 edges\)/)).toBeInTheDocument();
  });

  it("shows the stale-run warning when debugStale is true", () => {
    useMazeStore.setState({ debugArena: threeStepArena(), debugStep: 0, debugStale: true });
    render(<DebugPanel />);
    expect(screen.getByText(/outdated|stale/i)).toBeInTheDocument();
  });

  it("does not show the stale-run warning when debugStale is false", () => {
    useMazeStore.setState({ debugArena: threeStepArena(), debugStep: 0, debugStale: false });
    render(<DebugPanel />);
    expect(screen.queryByText(/outdated|stale/i)).not.toBeInTheDocument();
  });
});
