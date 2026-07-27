import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IssueBubble, IssuesBlock } from "../components/IssuesBlock";
import { useMazeStore } from "../store/mazeStore";
import type { IssueDto } from "../wasm/types";

// GitHub issue #195's review finding: IssuesBlock/IssueBubble had no test file at all -- the
// loopEdges/teleportEdges/regionNodes hover-selection branching (which payload.kind sets which
// store field) was untested. These tests cover the component itself, mirroring
// DebugRefBubble.test.tsx's "render + fireEvent + read the real store" pattern.

function invalidLoopIssue(sourceCheck: string): IssueDto {
  return {
    kind: "invalid_loop",
    payload: { kind: "invalid_loop", edges: { [sourceCheck]: [[[1, 2]]] } },
    source_checks: [sourceCheck],
    source_check_types: { [sourceCheck]: sourceCheck },
    details: {},
  };
}

function invalidTeleportIssue(sourceCheck: string): IssueDto {
  return {
    kind: "invalid_teleport",
    payload: { kind: "invalid_teleport", groups: { [sourceCheck]: [[[3, 4]]] } },
    source_checks: [sourceCheck],
    source_check_types: { [sourceCheck]: sourceCheck },
    details: {},
  };
}

function invalidOneWayIssue(sourceCheck: string): IssueDto {
  return {
    kind: "invalid_one_way",
    payload: { kind: "invalid_one_way", groups: { [sourceCheck]: [[[3, 4]]] } },
    source_checks: [sourceCheck],
    source_check_types: { [sourceCheck]: sourceCheck },
    details: {},
  };
}

function regionNeedsExpansionIssue(sourceCheck: string): IssueDto {
  return {
    kind: "region_needs_expansion",
    payload: { kind: "region_needs_expansion", nodes: { [sourceCheck]: [[5, 6]] } },
    source_checks: [sourceCheck],
    source_check_types: { [sourceCheck]: sourceCheck },
    details: {},
  };
}

function invalidSplitTileIssue(sourceCheck: string): IssueDto {
  return {
    kind: "invalid_split_tile",
    payload: { kind: "invalid_split_tile", nodes: { [sourceCheck]: [7, 8] } },
    source_checks: [sourceCheck],
    source_check_types: { [sourceCheck]: sourceCheck },
    details: {},
  };
}

describe("IssueBubble", () => {
  it("hovering an invalid_loop bubble sets hoveredIssueLoopEdges to this check's flattened edges; leaving clears it", () => {
    const issue = invalidLoopIssue("loop_length");
    render(<IssueBubble issue={issue} sourceCheck="loop_length" />);

    const bubble = screen.getByText("Loop validation");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toEqual([[1, 2]]);
    fireEvent.mouseLeave(bubble);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toBeNull();
  });

  it("hovering an invalid_teleport bubble sets hoveredIssueLoopEdges (shared edge-highlight path) to this check's flattened groups; leaving clears it", () => {
    const issue = invalidTeleportIssue("teleport_duplicates_connection");
    render(<IssueBubble issue={issue} sourceCheck="teleport_duplicates_connection" />);

    const bubble = screen.getByText("Teleport validation");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toEqual([[3, 4]]);
    fireEvent.mouseLeave(bubble);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toBeNull();
  });

  it("hovering an invalid_one_way bubble sets hoveredIssueLoopEdges (shared edge-highlight path) to this check's flattened groups; leaving clears it", () => {
    const issue = invalidOneWayIssue("one_way_waypoint_distance");
    render(<IssueBubble issue={issue} sourceCheck="one_way_waypoint_distance" />);

    const bubble = screen.getByText("One-way validation");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toEqual([[3, 4]]);
    fireEvent.mouseLeave(bubble);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toBeNull();
  });

  it("hovering a region_needs_expansion bubble sets hoveredIssueRegionGroups to this check's regions; leaving clears it", () => {
    const issue = regionNeedsExpansionIssue("min_region_size");
    render(<IssueBubble issue={issue} sourceCheck="min_region_size" />);

    const bubble = screen.getByText("Region expansion");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredIssueRegionGroups).toEqual([[5, 6]]);
    fireEvent.mouseLeave(bubble);
    expect(useMazeStore.getState().hoveredIssueRegionGroups).toBeNull();
  });

  it("hovering an invalid_split_tile bubble sets hoveredIssueRegionGroups to a single group of every flagged node (shared region-highlight path); leaving clears it", () => {
    // The payload is a flat node list (no group structure of its own) -- IssueBubble wraps every
    // flagged node into one group so it reuses RegionHighlightRenderer's per-point dedup: two
    // flagged nodes sharing the same split tile merge into one fill+perimeter instead of each
    // drawing its own overlapping border (GitHub issue #249 regression report).
    const issue = invalidSplitTileIssue("split_distance_from_waypoint");
    render(<IssueBubble issue={issue} sourceCheck="split_distance_from_waypoint" />);

    const bubble = screen.getByText("Split tile validation");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredIssueRegionGroups).toEqual([[7, 8]]);
    fireEvent.mouseLeave(bubble);
    expect(useMazeStore.getState().hoveredIssueRegionGroups).toBeNull();
  });

  it("a bubble with sourceCheck: null (no structural payload) is not hoverable -- no store field changes", () => {
    const issue: IssueDto = {
      kind: "cycle_analysis_overflowed",
      payload: { kind: "none" },
      source_checks: [],
      source_check_types: {},
      details: {},
    };
    render(<IssueBubble issue={issue} sourceCheck={null} />);

    const bubble = screen.getByText("Cycle analysis overflowed");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toBeNull();
    expect(useMazeStore.getState().hoveredIssueRegionGroups).toBeNull();
  });
});

describe("IssuesBlock", () => {
  it("renders nothing for an empty issues list", () => {
    const { container } = render(<IssuesBlock issues={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders one bubble per contributing check for a merged issue, not one per issue", () => {
    const issue: IssueDto = {
      kind: "invalid_loop",
      payload: { kind: "invalid_loop", edges: { min_loop_length: [[[1, 2]]], max_loop_length: [[[3, 4]]] } },
      source_checks: ["min_loop_length", "max_loop_length"],
      source_check_types: { min_loop_length: "min_loop_length", max_loop_length: "max_loop_length" },
      details: {},
    };
    render(<IssuesBlock issues={[issue]} />);

    // Two distinct source checks on one issue -> two independently-hoverable bubbles, each
    // isolated to its own check's edges (not both checks' edges combined into one bubble).
    const bubbles = screen.getAllByText("Loop validation");
    expect(bubbles.length).toBe(2);

    fireEvent.mouseEnter(bubbles[0]);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toEqual([[1, 2]]);
    fireEvent.mouseLeave(bubbles[0]);

    fireEvent.mouseEnter(bubbles[1]);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toEqual([[3, 4]]);
    fireEvent.mouseLeave(bubbles[1]);
  });
});
