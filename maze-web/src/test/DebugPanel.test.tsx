import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DebugPanel } from "../components/DebugPanel";
import { useMazeStore } from "../store/mazeStore";
import { parseTape, TAG_SCOPE, RECURSIVE_BACKTRACKER_EVENT_TAG, NO_NODE, type ParsedTape } from "../debug/eventTape";
import { adapterForKind } from "../debug/algorithmRegistry";
import type { NodeDto } from "../wasm/types";

// The step counter renders as three sibling nodes ("2", " / ", "3") inside one wrapper span, for a
// fixed-width layout (see DebugPanel.tsx's `stepLabelHalf`) — RTL's default `getByText` won't match
// the wrapper because the target text isn't a single text node, so match on `textContent` directly.
function getByStepText(text: RegExp) {
  return screen.getByText(
    (_, element) => !!element && element.tagName === "SPAN" && text.test(element.textContent ?? ""),
    { selector: "span" },
  );
}

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

// Wrapped in the merge shape `event_log::merge_tapes` always produces (GitHub issue #169): node 0
// = merged root, node 1 = "generation" top-level source scope, node 2 = the algorithm's own
// former root — one level deeper than pre-#169 fixtures had it. Real tags aren't namespaced here
// (single source, source_index 0 -> tag unchanged, see merge_tapes' docs).
//
// root (0) -> "generation" scope (1) -> former root (2)
//   -> "step 1" scope (3) -> EdgeAdded(1,2) (4)  [1 mutating event: step 0]
//   -> "step 2" scope (5) -> EdgeAdded(2,3) (6)  [1 mutating event: step 1]
//   -> "step 3" scope (7) -> EdgeAdded(3,4) (8)  [1 mutating event: step 2]
function buildThreeStepTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("generation") },
    { parent: 1, firstChild: 3, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 2, firstChild: 4, nextSibling: 5, tag: TAG_SCOPE, payloadBytes: scopePayload("step 1") },
    { parent: 3, firstChild: null, nextSibling: null, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 2n) },
    { parent: 2, firstChild: 6, nextSibling: 7, tag: TAG_SCOPE, payloadBytes: scopePayload("step 2") },
    { parent: 5, firstChild: null, nextSibling: null, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(2n, 3n) },
    { parent: 2, firstChild: 8, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step 3") },
    { parent: 7, firstChild: null, nextSibling: null, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(3n, 4n) },
  ]);
}

const nodes: NodeDto[] = [
  { id: 1, x: 0, y: 0, i: 0 },
  { id: 2, x: 1, y: 0, i: 0 },
  { id: 3, x: 2, y: 0, i: 0 },
  { id: 4, x: 3, y: 0, i: 0 },
];

function threeStepArena() {
  const tape = buildThreeStepTape();
  const { totalSteps, checkpointFroms } = adapterForKind("recursive_backtracker").resolveMetadata(tape);
  return {
    tape, algorithmKind: "recursive_backtracker" as const,
    sources: [{ scopeName: "generation", kind: "recursive_backtracker" as const, nodeIndex: 1, startStep: 0, endStep: totalSteps, checkpointFroms }],
    nodes, allNodes: nodes, totalSteps, debugValueNames: [],
  };
}

// Wrapped in the merge shape, same as buildThreeStepTape above:
// root (0) -> "generation" scope (1) -> former root (2)
//   -> "step 1" scope (3) -> EdgeAdded(1,2) (4)
//   -> "step 2" scope (5) -> EdgeAdded(2,3) (6)
//   -> ... stepCount scopes total, each with one mutating EdgeAdded event.
function buildManyStepTape(stepCount: number): ParsedTape {
  const fixtureNodes: FixtureNode[] = [
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("generation") },
    { parent: 1, firstChild: 3, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
  ];
  for (let i = 0; i < stepCount; i++) {
    const scopeIndex = fixtureNodes.length;
    const edgeIndex = scopeIndex + 1;
    const nextScopeIndex = i < stepCount - 1 ? edgeIndex + 1 : null;
    fixtureNodes.push({
      parent: 2,
      firstChild: edgeIndex,
      nextSibling: nextScopeIndex,
      tag: TAG_SCOPE,
      payloadBytes: scopePayload(`step ${i + 1}`),
    });
    fixtureNodes.push({
      parent: scopeIndex,
      firstChild: null,
      nextSibling: null,
      tag: RECURSIVE_BACKTRACKER_EVENT_TAG.EDGE_ADDED,
      payloadBytes: edgeAddedPayload(BigInt(i + 1), BigInt(i + 2)),
    });
  }
  return buildFixture(fixtureNodes);
}

function manyStepArena(stepCount: number) {
  const tape = buildManyStepTape(stepCount);
  const { totalSteps, checkpointFroms } = adapterForKind("recursive_backtracker").resolveMetadata(tape);
  const manyNodes: NodeDto[] = Array.from({ length: stepCount + 1 }, (_, i) => ({ id: i + 1, x: i, y: 0, i: 0 }));
  return {
    tape, algorithmKind: "recursive_backtracker" as const,
    sources: [{ scopeName: "generation", kind: "recursive_backtracker" as const, nodeIndex: 1, startStep: 0, endStep: totalSteps, checkpointFroms }],
    nodes: manyNodes, allNodes: manyNodes, totalSteps, debugValueNames: [],
  };
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

  it("clicking the SidePanel close button exits debug mode and stops autoplay", () => {
    useMazeStore.setState({ debugArena: threeStepArena(), debugStep: 0, debugMode: true });
    render(<DebugPanel />);
    // SidePanel's header close button carries no title/aria-label of its own — locate it via the
    // panel title text it sits alongside (header layout, see SidePanel.tsx).
    const title = screen.getByText("Debug");
    const closeBtn = title.closest("div")!.parentElement!.querySelector("button.hoverable") as HTMLButtonElement;
    fireEvent.click(closeBtn);
    expect(useMazeStore.getState().debugMode).toBe(false);
  });

  it("shows the current step (1-based) and total steps", () => {
    useMazeStore.setState({ debugArena: threeStepArena(), debugStep: 1 });
    render(<DebugPanel />);
    expect(getByStepText(/2 \/ 3/)).toBeInTheDocument();
  });

  it("keeps the step counter's half-width fixed as the current step's own digit count grows during scrubbing, so the ' / ' separator doesn't drift", () => {
    // Both reads happen within the same arena (fixed total=1234, 4 digits) — only the current
    // step's digit count changes (9 -> 1 digit, 999 -> 3 digits), which is what
    // `stepLabelHalfWidth` (sized off `total`, not the current step) is meant to stay stable under.
    useMazeStore.setState({ debugArena: manyStepArena(1234), debugStep: 8 });
    const { unmount } = render(<DebugPanel />);
    // The current-step half ("9") is its own span (see DebugPanel.tsx's `stepLabelHalf`), sized to
    // the total's digit count — check its width directly rather than the "9 / 1234" wrapper, which
    // has no width of its own.
    const shortLabel = screen.getByText("9", { selector: "span" });
    const shortWidth = shortLabel.style.width;
    expect(shortWidth).not.toBe("");
    unmount();

    useMazeStore.setState({ debugArena: manyStepArena(1234), debugStep: 998 });
    render(<DebugPanel />);
    const longLabel = screen.getByText("999", { selector: "span" });
    expect(longLabel.style.width).toBe(shortWidth);
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

  // --- Debug value toggles (GitHub issue #131) ---

  it("does not render a debug-value toggle section when the arena declares no debug values", () => {
    useMazeStore.setState({ debugArena: threeStepArena(), debugStep: 0, debugValueToggles: new Set() });
    render(<DebugPanel />);
    expect(screen.queryByText("Recursion stack")).not.toBeInTheDocument();
  });

  it("renders one toggle per debugValueNames entry, using the paraglide label when known", () => {
    const arena = { ...threeStepArena(), debugValueNames: [{ name: "recursion_stack", kind: "sequence" as const }] };
    useMazeStore.setState({ debugArena: arena, debugStep: 0, debugValueToggles: new Set() });
    render(<DebugPanel />);
    expect(screen.getByText("Recursion stack")).toBeInTheDocument();
  });

  it("falls back to the raw name for a debug value with no known i18n label", () => {
    const arena = { ...threeStepArena(), debugValueNames: [{ name: "some_future_value", kind: "region" as const }] };
    useMazeStore.setState({ debugArena: arena, debugStep: 0, debugValueToggles: new Set() });
    render(<DebugPanel />);
    expect(screen.getByText("some_future_value")).toBeInTheDocument();
  });

  it("toggle reflects debugValueToggles and calls toggleDebugValue on click", () => {
    const arena = { ...threeStepArena(), debugValueNames: [{ name: "recursion_stack", kind: "sequence" as const }] };
    useMazeStore.setState({ debugArena: arena, debugStep: 0, debugValueToggles: new Set() });
    render(<DebugPanel />);
    const checkbox = screen.getByText("Recursion stack").closest("div")!.querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    checkbox.click();
    expect(useMazeStore.getState().debugValueToggles.has("recursion_stack")).toBe(true);
  });

  // --- Auto-switch floors toggle (GitHub issue #350 follow-up) ---

  it("does not render the auto-switch-floors row on a single-floor maze", () => {
    useMazeStore.setState({ debugArena: threeStepArena(), debugStep: 0, floors: [{ id: "floor_0", title: "Floor 1" }] });
    render(<DebugPanel />);
    expect(screen.queryByText("Auto-switch floors")).not.toBeInTheDocument();
  });

  it("renders the auto-switch-floors row on a multi-floor maze, reflecting debugAutoSwitchFloor", () => {
    useMazeStore.setState({
      debugArena: threeStepArena(), debugStep: 0,
      floors: [{ id: "floor_0", title: "Floor 1" }, { id: "floor_1", title: "Floor 2" }],
      debugAutoSwitchFloor: true,
    });
    render(<DebugPanel />);
    const checkbox = screen.getByText("Auto-switch floors").closest("div")!.querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    checkbox.click();
    expect(useMazeStore.getState().debugAutoSwitchFloor).toBe(false);
  });

  // --- Step slider never switches the active floor (GitHub issue #451) ---

  it("dragging and releasing the step slider never changes the active floor, even with auto-switch on", () => {
    // Every arena node on floor 1 (index 1) — a floor auto-switch, if it fired, would move the
    // active floor from floor_0 to floor_1.
    const arena = { ...threeStepArena(), nodes: nodes.map((n) => ({ ...n, level: 1 })) };
    arena.allNodes = arena.nodes;
    useMazeStore.setState({
      debugArena: arena, debugStep: 0,
      floors: [{ id: "floor_0", title: "Floor 1" }, { id: "floor_1", title: "Floor 2" }],
      floorFields: {} as never,
      activeFloorId: "floor_0",
      debugAutoSwitchFloor: true,
    });
    render(<DebugPanel />);
    const slider = screen.getByRole("slider") as HTMLInputElement;

    fireEvent.change(slider, { target: { value: "2" } });
    fireEvent.pointerUp(slider);

    expect(useMazeStore.getState().debugStep).toBe(2);
    expect(useMazeStore.getState().activeFloorId).toBe("floor_0");
  });
});
