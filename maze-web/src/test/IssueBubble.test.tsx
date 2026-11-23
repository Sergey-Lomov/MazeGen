import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IssueBubble } from "../components/IssuesBlock";
import { useMazeStore } from "../store/mazeStore";
import { presetEndpoint } from "../domain/presetEndpoint";
import type { IssueDto } from "../wasm/types";
import {
  invalidLoopIssue, invalidTeleportIssue, invalidOneWayIssue, invalidVerticalPassageIssue,
  regionNeedsExpansionIssue, invalidElevatorStopIssue, invalidSplitTileIssue, invalidSplitNodeGroupIssue,
  excessiveSccCountIssue, invalidCrossElementGroupIssue,
} from "./issuesBlockFixtures";

// GitHub issue #195's review finding: IssuesBlock/IssueBubble had no test file at all -- the
// loopEdges/teleportEdges/regionNodes hover-selection branching (which payload.kind sets which
// store field) was untested. These tests cover the component itself, mirroring
// DebugRefBubble.test.tsx's "render + fireEvent + read the real store" pattern.

beforeEach(() => {
  useMazeStore.setState({ nodes: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((id) => ({ id, x: id, y: 0, i: 0, level: 0 })), hoveredCoordinateWarning: null });
});

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

  it("GitHub issue #1007: a per-floor missing-loops deficit badges every short floor and navigates to it", () => {
    const floor0 = { id: "floor_0", title: "Floor 1" };
    const floor1 = { id: "floor_1", title: "Floor 2" };
    const floor2 = { id: "floor_2", title: "Floor 3" };
    useMazeStore.setState({ floors: [floor0, floor1, floor2], activeFloorId: floor0.id, nodes: [] });
    const issue: IssueDto = {
      kind: "missing_loops",
      payload: { kind: "area_deficit", areas: { min_loops_count: [0, 2] } },
      source_checks: ["min_loops_count"],
      source_check_types: { min_loops_count: "min_loops_count" },
      details: { min_loops_count: { missing: "2" } },
    };
    render(<IssueBubble issue={issue} sourceCheck="min_loops_count" />);

    expect(screen.getByText("L1")).toBeInTheDocument();
    expect(screen.queryByText("L2")).not.toBeInTheDocument();
    expect(screen.getByText("L3")).toBeInTheDocument();
    fireEvent.click(screen.getByText("L3"));
    expect(useMazeStore.getState().activeFloorId).toBe(floor2.id);
  });

  it("a per-floor missing-one-ways deficit uses its AreaDeficit floors for badges", () => {
    const floors = [
      { id: "floor_0", title: "Floor 1" },
      { id: "floor_1", title: "Floor 2" },
    ];
    useMazeStore.setState({ floors, activeFloorId: floors[0].id, nodes: [] });
    const issue: IssueDto = {
      kind: "missing_one_ways",
      payload: { kind: "area_deficit", areas: { min_one_way_count: [1] } },
      source_checks: ["min_one_way_count"],
      source_check_types: { min_one_way_count: "min_one_way_count" },
      details: { min_one_way_count: { missing: "1" } },
    };
    render(<IssueBubble issue={issue} sourceCheck="min_one_way_count" />);

    expect(screen.queryByText("L1")).not.toBeInTheDocument();
    expect(screen.getByText("L2")).toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByText("Missing 1 one-way passage(s) to reach the required minimum"));
    expect(useMazeStore.getState().hoveredCoordinateWarning).toBeNull();
  });
});

describe("IssueBubble", () => {
  it("hovering an invalid_loop bubble sets hoveredIssueLoopEdges to this check's flattened edges; leaving clears it", () => {
    const issue = invalidLoopIssue("loop_length");
    render(<IssueBubble issue={issue} sourceCheck="loop_length" />);

    const bubble = screen.getByText("Loop validation");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toMatchObject([{ from: 1, to: 2, asWall: false }]);
    fireEvent.mouseLeave(bubble);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toBeNull();
  });

  it("hovering an invalid_teleport bubble highlights both endpoint cells; leaving clears it", () => {
    const issue = invalidTeleportIssue("teleport_duplicates_connection");
    useMazeStore.setState({ nodes: [3, 4, 5].map((id) => ({ id, x: id, y: 0, i: 0, level: 0 })), hoveredCoordinateWarning: null });
    render(<IssueBubble issue={issue} sourceCheck="teleport_duplicates_connection" />);

    const bubble = screen.getByText("Teleport validation");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toBeNull();
    expect(useMazeStore.getState().hoveredCoordinateWarning?.targets).toEqual([presetEndpoint([3, 0], undefined, 0), presetEndpoint([4, 0], undefined, 0)]);
    fireEvent.mouseLeave(bubble);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toBeNull();
    expect(useMazeStore.getState().hoveredCoordinateWarning).toBeNull();
  });

  it("hovering an invalid_one_way bubble highlights both linked cells as a region; leaving clears it", () => {
    const issue = invalidOneWayIssue("one_way_waypoint_distance");
    render(<IssueBubble issue={issue} sourceCheck="one_way_waypoint_distance" />);

    const bubble = screen.getByText("One-way validation");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toMatchObject([{ from: 3, to: 4, asWall: true }]);
    fireEvent.mouseLeave(bubble);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toBeNull();
  });

  it("hovering an invalid_vertical_passage bubble sets the coordinate warning to the flagged cells (cell highlight, not an edge line); leaving clears it", () => {
    const issue = invalidVerticalPassageIssue("vertical_passage_group_geometric_proximity");
    useMazeStore.setState({ nodes: [3, 4, 5].map((id) => ({ id, x: id, y: 0, i: 0, level: 0 })), hoveredCoordinateWarning: null });
    render(<IssueBubble issue={issue} sourceCheck="vertical_passage_group_geometric_proximity" />);

    const bubble = screen.getByText("Vertical passage validation");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredCoordinateWarning?.targets).toEqual([presetEndpoint([3, 0], undefined, 0), presetEndpoint([4, 0], undefined, 0)]);
    fireEvent.mouseLeave(bubble);
    expect(useMazeStore.getState().hoveredCoordinateWarning).toBeNull();
  });

  it("hovering an invalid_vertical_passage bubble with two edges sharing a node dedupes it into one group (no double-filled cell)", () => {
    // Regression coverage for the double-fill bug: two flagged proximity pairs through the same
    // passage node must not draw that cell's fill/perimeter twice (mirrors the invalid_split_tile
    // dedup test above, GitHub issue #249's same rationale applied to vertical passages).
    const issue = invalidVerticalPassageIssue("vertical_passage_group_geometric_proximity", [
      { edges: [[3, 4]], preset_locked: false },
      { edges: [[4, 5]], preset_locked: false },
    ]);
    useMazeStore.setState({ nodes: [3, 4, 5].map((id) => ({ id, x: id, y: 0, i: 0, level: 0 })), hoveredCoordinateWarning: null });
    render(<IssueBubble issue={issue} sourceCheck="vertical_passage_group_geometric_proximity" />);

    const bubble = screen.getByText("Vertical passage validation");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredCoordinateWarning?.targets).toEqual([presetEndpoint([3, 0], undefined, 0), presetEndpoint([4, 0], undefined, 0), presetEndpoint([5, 0], undefined, 0)]);
    fireEvent.mouseLeave(bubble);
    expect(useMazeStore.getState().hoveredCoordinateWarning).toBeNull();
  });

  it("hovering a region_needs_expansion bubble sets the coordinate warning to this check's regions; leaving clears it", () => {
    const issue = regionNeedsExpansionIssue("min_region_size");
    render(<IssueBubble issue={issue} sourceCheck="min_region_size" />);

    const bubble = screen.getByText("Region expansion");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredCoordinateWarning?.targets).toEqual([presetEndpoint([5, 0], undefined, 0), presetEndpoint([6, 0], undefined, 0)]);
    fireEvent.mouseLeave(bubble);
    expect(useMazeStore.getState().hoveredCoordinateWarning).toBeNull();
  });

  it("hovering an invalid_elevator_stop bubble sets the coordinate warning to one group per flagged stop (GitHub issue #399), not one merged group; leaving clears it", () => {
    const issue = invalidElevatorStopIssue("max_elevator_stops");
    render(<IssueBubble issue={issue} sourceCheck="max_elevator_stops" />);

    const bubble = screen.getByText("Elevator stop validation");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredCoordinateWarning?.targets).toEqual([presetEndpoint([5, 0], undefined, 0), presetEndpoint([6, 0], undefined, 0)]);
    fireEvent.mouseLeave(bubble);
    expect(useMazeStore.getState().hoveredCoordinateWarning).toBeNull();
  });

  it("hovering an invalid_split_tile bubble sets the coordinate warning to one merged split group; leaving clears it", () => {
    // Flagged tiles merge into one region group with the outward split inset (GitHub issue #249
    // regression report; `isSplit: true` picks that inset explicitly, GitHub issue #619) --
    // adjacent flagged tiles read as one merged split area, same as any other region.
    const issue = invalidSplitTileIssue("split_distance_from_waypoint");
    render(<IssueBubble issue={issue} sourceCheck="split_distance_from_waypoint" />);

    const bubble = screen.getByText("Split tile validation");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredCoordinateWarning?.targets).toEqual([presetEndpoint([7, 0], undefined, 0), presetEndpoint([8, 0], undefined, 0)]);
    fireEvent.mouseLeave(bubble);
    expect(useMazeStore.getState().hoveredCoordinateWarning).toBeNull();
  });

  it("hovering an invalid_cross_element_group bubble with a teleport+split pair sets the coordinate warning to one group per member, not merged; leaving clears it", () => {
    // Each pair member keeps its own group (GitHub issue #619) -- the teleport's cell and the
    // split's cells never merge into one contour just because they're both part of the same
    // flagged pair, even when tessellation-adjacent.
    const issue = invalidCrossElementGroupIssue("cross_element_geometric_proximity", [
      { kind: "teleport", nodes: [1] },
      { kind: "split", nodes: [7, 8] },
    ]);
    render(<IssueBubble issue={issue} sourceCheck="cross_element_geometric_proximity" />);

    const bubble = screen.getByText("Elements too close");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredCoordinateWarning?.targets).toEqual([presetEndpoint([1, 0], undefined, 0), presetEndpoint([7, 0], undefined, 0), presetEndpoint([8, 0], undefined, 0)]);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toBeNull();
    fireEvent.mouseLeave(bubble);
    expect(useMazeStore.getState().hoveredCoordinateWarning).toBeNull();
  });

  it("hovering an invalid_cross_element_group bubble with a one-way member draws it as a wall (hoveredIssueLoopEdges) while the other member still draws as a cell, both set together", () => {
    const issue = invalidCrossElementGroupIssue("cross_element_graph_proximity", [
      { kind: "one_way", edges: [[3, 4]] },
      { kind: "split", nodes: [7, 8] },
    ]);
    render(<IssueBubble issue={issue} sourceCheck="cross_element_graph_proximity" />);

    const bubble = screen.getByText("Elements too close");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toMatchObject([{ from: 3, to: 4, asWall: true }]);
    expect(useMazeStore.getState().hoveredCoordinateWarning?.targets).toEqual([presetEndpoint([7, 0], undefined, 0), presetEndpoint([8, 0], undefined, 0)]);
    fireEvent.mouseLeave(bubble);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toBeNull();
    expect(useMazeStore.getState().hoveredCoordinateWarning).toBeNull();
  });

  it("hovering an invalid_split_node_group bubble (reused invalid_split_tile payload shape) sets the coordinate warning", () => {
    const issue = invalidSplitNodeGroupIssue("max_split_tile_node_count");
    render(<IssueBubble issue={issue} sourceCheck="max_split_tile_node_count" />);

    const bubble = screen.getByText("Split node group validation");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredCoordinateWarning?.targets).toEqual([presetEndpoint([9, 0], undefined, 0)]);
    fireEvent.mouseLeave(bubble);
    expect(useMazeStore.getState().hoveredCoordinateWarning).toBeNull();
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
    expect(useMazeStore.getState().hoveredCoordinateWarning).toBeNull();
  });
});
