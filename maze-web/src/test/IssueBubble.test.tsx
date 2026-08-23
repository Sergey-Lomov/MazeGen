import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IssueBubble } from "../components/IssuesBlock";
import { useMazeStore } from "../store/mazeStore";
import type { IssueDto } from "../wasm/types";
import {
  invalidLoopIssue, invalidTeleportIssue, invalidOneWayIssue, invalidVerticalPassageIssue,
  regionNeedsExpansionIssue, invalidElevatorStopIssue, invalidSplitTileIssue, invalidSplitNodeGroupIssue,
  excessiveSccCountIssue,
} from "./issuesBlockFixtures";

// GitHub issue #195's review finding: IssuesBlock/IssueBubble had no test file at all -- the
// loopEdges/teleportEdges/regionNodes hover-selection branching (which payload.kind sets which
// store field) was untested. These tests cover the component itself, mirroring
// DebugRefBubble.test.tsx's "render + fireEvent + read the real store" pattern.

describe("IssueBubble floor badges (GitHub issue #365)", () => {
  it("a bubble whose edges span two floors shows L1/L2 badges; clicking one switches the active floor without opening the description modal", () => {
    const floor0 = { id: "floor_0", title: "Floor 1" };
    const floor1 = { id: "floor_1", title: "Floor 2" };
    useMazeStore.setState({
      floors: [floor0, floor1],
      activeFloorId: floor0.id,
      nodes: [
        { id: 1, x: 0, y: 0, i: 0, level: 0 },
        { id: 2, x: 0, y: 0, i: 0, level: 1 },
      ],
    });
    const issue = invalidLoopIssue("loop_length");
    render(<IssueBubble issue={issue} sourceCheck="loop_length" />);

    expect(screen.getByText("L1")).toBeInTheDocument();
    expect(screen.getByText("L2")).toBeInTheDocument();

    fireEvent.click(screen.getByText("L2"));
    expect(useMazeStore.getState().activeFloorId).toBe(floor1.id);
    // stopPropagation kept the click from also bubbling to the bubble's own onClick (opens the
    // description modal, whose title duplicates the bubble's own label) -- if it leaked, there
    // would be two "Loop validation" texts instead of one.
    expect(screen.getAllByText("Loop validation").length).toBe(1);
  });

  it("on a single-floor maze, a bubble shows no floor badges even though its edges technically span nodes", () => {
    const floor0 = { id: "floor_0", title: "Floor 1" };
    useMazeStore.setState({
      floors: [floor0],
      activeFloorId: floor0.id,
      nodes: [
        { id: 1, x: 0, y: 0, i: 0, level: 0 },
        { id: 2, x: 0, y: 0, i: 0, level: 0 },
      ],
    });
    const issue = invalidLoopIssue("loop_length");
    render(<IssueBubble issue={issue} sourceCheck="loop_length" />);

    expect(screen.queryByText("L1")).not.toBeInTheDocument();
  });

  it("GitHub issue #423: on a multi-floor maze, a bubble whose own edges stay on a single floor still shows that floor's badge", () => {
    const floor0 = { id: "floor_0", title: "Floor 1" };
    const floor1 = { id: "floor_1", title: "Floor 2" };
    useMazeStore.setState({
      floors: [floor0, floor1],
      activeFloorId: floor0.id,
      nodes: [
        { id: 1, x: 0, y: 0, i: 0, level: 0 },
        { id: 2, x: 0, y: 0, i: 0, level: 0 },
      ],
    });
    const issue = invalidLoopIssue("loop_length");
    render(<IssueBubble issue={issue} sourceCheck="loop_length" />);

    expect(screen.getByText("L1")).toBeInTheDocument();
    expect(screen.queryByText("L2")).not.toBeInTheDocument();
  });

  it("a bubble with no per-element highlight data (excessive_scc_count) shows no floor badges even on a multi-floor maze", () => {
    const floor0 = { id: "floor_0", title: "Floor 1" };
    const floor1 = { id: "floor_1", title: "Floor 2" };
    useMazeStore.setState({
      floors: [floor0, floor1],
      activeFloorId: floor0.id,
      nodes: [
        { id: 1, x: 0, y: 0, i: 0, level: 0 },
        { id: 2, x: 0, y: 0, i: 0, level: 1 },
      ],
    });
    const issue = excessiveSccCountIssue("scc_count", false);
    render(<IssueBubble issue={issue} sourceCheck="scc_count" />);

    expect(screen.queryByText("L1")).not.toBeInTheDocument();
    expect(screen.queryByText("L2")).not.toBeInTheDocument();
  });
});

describe("IssueBubble", () => {
  it("hovering an invalid_loop bubble sets hoveredIssueLoopEdges to this check's flattened edges; leaving clears it", () => {
    const issue = invalidLoopIssue("loop_length");
    render(<IssueBubble issue={issue} sourceCheck="loop_length" />);

    const bubble = screen.getByText("Loop validation");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toEqual([{ from: 1, to: 2, asWall: false }]);
    fireEvent.mouseLeave(bubble);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toBeNull();
  });

  it("hovering an invalid_teleport bubble sets hoveredIssueLoopEdges (shared edge-highlight path) to this check's flattened groups; leaving clears it", () => {
    const issue = invalidTeleportIssue("teleport_duplicates_connection");
    render(<IssueBubble issue={issue} sourceCheck="teleport_duplicates_connection" />);

    const bubble = screen.getByText("Teleport validation");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toEqual([{ from: 3, to: 4, asWall: false }]);
    fireEvent.mouseLeave(bubble);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toBeNull();
  });

  it("hovering an invalid_one_way bubble sets hoveredIssueLoopEdges (shared edge-highlight path, drawn as a wall — GitHub issue #377) to this check's flattened groups; leaving clears it", () => {
    const issue = invalidOneWayIssue("one_way_waypoint_distance");
    render(<IssueBubble issue={issue} sourceCheck="one_way_waypoint_distance" />);

    const bubble = screen.getByText("One-way validation");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toEqual([{ from: 3, to: 4, asWall: true }]);
    fireEvent.mouseLeave(bubble);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toBeNull();
  });

  it("hovering an invalid_vertical_passage bubble sets hoveredIssueRegionGroups to the flagged cells (region-square highlight, not an edge line); leaving clears it", () => {
    const issue = invalidVerticalPassageIssue("vertical_passage_group_geometric_proximity");
    render(<IssueBubble issue={issue} sourceCheck="vertical_passage_group_geometric_proximity" />);

    const bubble = screen.getByText("Vertical passage validation");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredIssueRegionGroups).toEqual([[3, 4]]);
    fireEvent.mouseLeave(bubble);
    expect(useMazeStore.getState().hoveredIssueRegionGroups).toBeNull();
  });

  it("hovering an invalid_vertical_passage bubble with two edges sharing a node dedupes it into one group (no double-filled cell)", () => {
    // Regression coverage for the double-fill bug: two flagged proximity pairs through the same
    // passage node must not draw that cell's fill/perimeter twice (mirrors the invalid_split_tile
    // dedup test above, GitHub issue #249's same rationale applied to vertical passages).
    const issue = invalidVerticalPassageIssue("vertical_passage_group_geometric_proximity", [
      { edges: [[3, 4]], preset_locked: false },
      { edges: [[4, 5]], preset_locked: false },
    ]);
    render(<IssueBubble issue={issue} sourceCheck="vertical_passage_group_geometric_proximity" />);

    const bubble = screen.getByText("Vertical passage validation");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredIssueRegionGroups).toEqual([[3, 4, 5]]);
    fireEvent.mouseLeave(bubble);
    expect(useMazeStore.getState().hoveredIssueRegionGroups).toBeNull();
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

  it("hovering an invalid_elevator_stop bubble sets hoveredIssueRegionGroups to one group per flagged stop (GitHub issue #399), not one merged group; leaving clears it", () => {
    const issue = invalidElevatorStopIssue("max_elevator_stops");
    render(<IssueBubble issue={issue} sourceCheck="max_elevator_stops" />);

    const bubble = screen.getByText("Elevator stop validation");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredIssueRegionGroups).toEqual([[5], [6]]);
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

  it("hovering an invalid_split_node_group bubble (reused invalid_split_tile payload shape) sets hoveredIssueRegionGroups", () => {
    const issue = invalidSplitNodeGroupIssue("max_split_tile_node_count");
    render(<IssueBubble issue={issue} sourceCheck="max_split_tile_node_count" />);

    const bubble = screen.getByText("Split node group validation");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredIssueRegionGroups).toEqual([[9]]);
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
