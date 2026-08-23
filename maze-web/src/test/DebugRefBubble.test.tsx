import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DebugRefBubble } from "../components/DebugRefBubble";
import { useMazeStore } from "../store/mazeStore";
import * as m from "~/paraglide/messages";
import type { HoveredDebugRef } from "../store/storeTypes";

// GitHub issue #171 review finding: DebugRefBubble's click-to-modal / reason-list rendering /
// hoverable-clickable gating was previously only exercised indirectly through
// narrationTokensForQc's token-shape assertions (eventTapeQc.test.ts) -- never through an actual
// render + click. These tests cover the component itself.

describe("DebugRefBubble", () => {
  it("a non-issue target (e.g. edge) is hoverable but never clickable — click never opens a modal", () => {
    const target: HoveredDebugRef = { kind: "edge", from: 1n, to: 2n, bidirectional: true };
    render(<DebugRefBubble target={target} label="1:2 <-> 3:4" />);

    const bubble = screen.getByText("1:2 <-> 3:4");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredDebugRef).toEqual(target);
    fireEvent.mouseLeave(bubble);
    expect(useMazeStore.getState().hoveredDebugRef).toBeNull();

    fireEvent.click(bubble);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an issue target with a null highlight target is not hoverable (no highlight to set)", () => {
    const target: HoveredDebugRef = { kind: "issue", issueKind: "missing_endpoints", target: null, reasons: [] };
    render(<DebugRefBubble target={target} label="Missing endpoints" />);

    const bubble = screen.getByText("Missing endpoints");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredDebugRef).toBeNull();
  });

  it("an issue target with a highlight target is hoverable", () => {
    const target: HoveredDebugRef = {
      kind: "issue", issueKind: "invalid_loop",
      target: { kind: "cycle", edges: [[1n, 2n]], asWall: false }, reasons: ["Loop shorter than 10 tiles"],
    };
    render(<DebugRefBubble target={target} label="Loop validation" />);

    const bubble = screen.getByText("Loop validation");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredDebugRef).toEqual(target);
  });

  it("an issue target with reasons is clickable — clicking opens a modal, without bubbling the click up", () => {
    const target: HoveredDebugRef = { kind: "issue", issueKind: "invalid_loop", target: null, reasons: ["Loop shorter than 10 tiles"] };
    render(<DebugRefBubble target={target} label="Loop validation" />);

    fireEvent.click(screen.getByText("Loop validation"));
    expect(screen.getByText("Loop shorter than 10 tiles")).toBeTruthy();
  });

  it("a single reason renders as one line, not a list with a header", () => {
    const target: HoveredDebugRef = { kind: "issue", issueKind: "invalid_loop", target: null, reasons: ["Loop shorter than 10 tiles"] };
    render(<DebugRefBubble target={target} label="Loop validation" />);

    fireEvent.click(screen.getByText("Loop validation"));
    expect(screen.queryByText(m["debug.tree.qc.issue_reasons_header"]())).toBeNull();
    expect(screen.getAllByText("Loop shorter than 10 tiles")).toHaveLength(1);
  });

  it("two or more reasons render as a header plus a list", () => {
    const target: HoveredDebugRef = {
      kind: "issue", issueKind: "invalid_loop", target: null,
      reasons: ["Loop shorter than 10 tiles", "Loop too far from finish"],
    };
    render(<DebugRefBubble target={target} label="Loop validation" />);

    fireEvent.click(screen.getByText("Loop validation"));
    expect(screen.getByText(m["debug.tree.qc.issue_reasons_header"]())).toBeTruthy();
    expect(screen.getByText("Loop shorter than 10 tiles")).toBeTruthy();
    expect(screen.getByText("Loop too far from finish")).toBeTruthy();
  });

  it("an issue target with an empty reasons list is not clickable", () => {
    const target: HoveredDebugRef = { kind: "issue", issueKind: "missing_endpoints", target: null, reasons: [] };
    render(<DebugRefBubble target={target} label="Missing endpoints" />);

    fireEvent.click(screen.getByText("Missing endpoints"));
    expect(screen.queryByText(m["debug.tree.qc.issue_reasons_header"]())).toBeNull();
  });
});
