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
    payload: { kind: "invalid_loop", edges: { [sourceCheck]: [{ edges: [[1, 2]], preset_locked: false }] } },
    source_checks: [sourceCheck],
    source_check_types: { [sourceCheck]: sourceCheck },
    details: {},
  };
}

function invalidTeleportIssue(sourceCheck: string): IssueDto {
  return {
    kind: "invalid_teleport",
    payload: { kind: "invalid_teleport", groups: { [sourceCheck]: [{ edges: [[3, 4]], preset_locked: false }] } },
    source_checks: [sourceCheck],
    source_check_types: { [sourceCheck]: sourceCheck },
    details: {},
  };
}

function invalidOneWayIssue(sourceCheck: string): IssueDto {
  return {
    kind: "invalid_one_way",
    payload: { kind: "invalid_one_way", groups: { [sourceCheck]: [{ edges: [[3, 4]], preset_locked: false }] } },
    source_checks: [sourceCheck],
    source_check_types: { [sourceCheck]: sourceCheck },
    details: {},
  };
}

function regionNeedsExpansionIssue(sourceCheck: string, regions: { region: number[]; preset_locked: boolean }[] = [{ region: [5, 6], preset_locked: false }]): IssueDto {
  return {
    kind: "region_needs_expansion",
    payload: { kind: "region_needs_expansion", nodes: { [sourceCheck]: regions } },
    source_checks: [sourceCheck],
    source_check_types: { [sourceCheck]: sourceCheck },
    details: {},
  };
}

function invalidSplitTileIssue(sourceCheck: string): IssueDto {
  // `split_distance_from_waypoint` (invalid_split_tile) resolves one group per flagged tile -- a
  // single flagged tile with 2 nodes (7 and 8, e.g. slot-0 plus one extra split node).
  return {
    kind: "invalid_split_tile",
    payload: { kind: "invalid_split_tile", groups: { [sourceCheck]: [{ tiles: [{ nodes: [7, 8], preset_locked: false }], preset_locked: false }] } },
    source_checks: [sourceCheck],
    source_check_types: { [sourceCheck]: sourceCheck },
    details: {},
  };
}

function excessiveSccCountIssue(sourceCheck: string, presetLocked: boolean): IssueDto {
  // Carries no per-element highlight data of its own (see `IssuePayloadDto::ExcessiveSccCount`'s
  // doc comment) -- just a single check-level `preset_locked` bool.
  return {
    kind: "excessive_scc_count",
    payload: { kind: "excessive_scc_count", preset_locked: { [sourceCheck]: presetLocked } },
    source_checks: [sourceCheck],
    source_check_types: { [sourceCheck]: sourceCheck },
    details: {},
  };
}

function invalidSplitNodeGroupIssue(sourceCheck: string): IssueDto {
  // Wire-reuse: `invalid_split_node_group` resolves through the same `invalid_split_tile` payload
  // shape (narrow on `payload.kind`, not `issue.kind` -- see IssuePayload's doc comment).
  // `max_split_tile_node_count`'s groups[i] is already exactly one overflowing tile.
  return {
    kind: "invalid_split_node_group",
    payload: { kind: "invalid_split_tile", groups: { [sourceCheck]: [{ tiles: [{ nodes: [9], preset_locked: false }], preset_locked: false }] } },
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

describe("IssuesBlock", () => {
  it("renders nothing for an empty issues list", () => {
    const { container } = render(<IssuesBlock issues={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders one bubble per contributing check for a merged issue, not one per issue", () => {
    const issue: IssueDto = {
      kind: "invalid_loop",
      payload: { kind: "invalid_loop", edges: { min_loop_length: [{ edges: [[1, 2]], preset_locked: false }], max_loop_length: [{ edges: [[3, 4]], preset_locked: false }] } },
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

  it("with showFullyPresetLockedIssues off, a surviving mixed bubble only highlights its non-preset-locked elements on hover", () => {
    // Regression: a bubble stays visible when it has at least one unlocked element, but hovering
    // it must not still light up the preset-locked cycles the toggle is hiding elsewhere.
    useMazeStore.getState().setShowFullyPresetLockedIssues(false);
    const issue: IssueDto = {
      kind: "invalid_loop",
      payload: {
        kind: "invalid_loop",
        edges: {
          loop_length: [
            { edges: [[1, 2]], preset_locked: true },
            { edges: [[3, 4]], preset_locked: false },
          ],
        },
      },
      source_checks: ["loop_length"],
      source_check_types: { loop_length: "loop_length" },
      details: {},
    };
    render(<IssueBubble issue={issue} sourceCheck="loop_length" />);

    const bubble = screen.getByText("Loop validation");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toEqual([[3, 4]]);
    fireEvent.mouseLeave(bubble);

    useMazeStore.getState().setShowFullyPresetLockedIssues(true);
  });

  it("with showFullyPresetLockedIssues off, a surviving mixed region_needs_expansion bubble (3 regions, 1 locked) only highlights its 2 non-preset-locked regions on hover", () => {
    // Regression: RegionHighlightRenderer draws each group independently with no positional
    // contract, so filtering out the locked region before mapping to `.region` must not disturb
    // the other two regions' rendering.
    useMazeStore.getState().setShowFullyPresetLockedIssues(false);
    const issue = regionNeedsExpansionIssue("min_region_size", [
      { region: [1, 2], preset_locked: false },
      { region: [3, 4], preset_locked: true },
      { region: [5, 6], preset_locked: false },
    ]);
    render(<IssueBubble issue={issue} sourceCheck="min_region_size" />);

    const bubble = screen.getByText("Region expansion");
    expect(bubble).toBeInTheDocument();
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredIssueRegionGroups).toEqual([[1, 2], [5, 6]]);
    fireEvent.mouseLeave(bubble);
    expect(useMazeStore.getState().hoveredIssueRegionGroups).toBeNull();

    useMazeStore.getState().setShowFullyPresetLockedIssues(true);
  });

  it("with showFullyPresetLockedIssues off, a region_needs_expansion bubble with every region locked is hidden entirely", () => {
    useMazeStore.getState().setShowFullyPresetLockedIssues(false);
    const issue = regionNeedsExpansionIssue("min_region_size", [{ region: [1, 2], preset_locked: true }]);
    render(<IssueBubble issue={issue} sourceCheck="min_region_size" />);
    expect(screen.queryByText("Region expansion")).not.toBeInTheDocument();

    useMazeStore.getState().setShowFullyPresetLockedIssues(true);
  });

  it("opening a region_needs_expansion bubble with locked regions shows the preset-locked summary phrase with the right count", () => {
    const issue = regionNeedsExpansionIssue("min_region_size", [
      { region: [1, 2], preset_locked: true },
      { region: [3, 4], preset_locked: false },
    ]);
    render(<IssueBubble issue={issue} sourceCheck="min_region_size" />);

    fireEvent.click(screen.getByText("Region expansion"));
    expect(screen.getByText("1 instance is set by presets and cannot be fixed")).toBeInTheDocument();
  });

  it("with showFullyPresetLockedIssues off, a fully preset-locked excessive_scc_count bubble is hidden entirely", () => {
    useMazeStore.getState().setShowFullyPresetLockedIssues(false);
    const issue = excessiveSccCountIssue("scc_count", true);
    render(<IssueBubble issue={issue} sourceCheck="scc_count" />);
    expect(screen.queryByText("Region group validation")).not.toBeInTheDocument();

    useMazeStore.getState().setShowFullyPresetLockedIssues(true);
  });

  it("with showFullyPresetLockedIssues off, a non-locked excessive_scc_count bubble stays visible", () => {
    useMazeStore.getState().setShowFullyPresetLockedIssues(false);
    const issue = excessiveSccCountIssue("scc_count", false);
    render(<IssueBubble issue={issue} sourceCheck="scc_count" />);
    expect(screen.getByText("Region group validation")).toBeInTheDocument();

    useMazeStore.getState().setShowFullyPresetLockedIssues(true);
  });

  it("opening a preset-locked excessive_scc_count bubble shows the preset-locked summary phrase", () => {
    const issue = excessiveSccCountIssue("scc_count", true);
    render(<IssueBubble issue={issue} sourceCheck="scc_count" />);

    fireEvent.click(screen.getByText("Region group validation"));
    expect(screen.getByText("1 instance is set by presets and cannot be fixed")).toBeInTheDocument();
  });

  it("collapsing the Issues section hides its bubbles; the section header itself stays visible", () => {
    const issue = invalidLoopIssue("loop_length");
    render(<IssuesBlock issues={[issue]} />);
    expect(screen.getByText("Loop validation")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Issues"));
    expect(screen.queryByText("Loop validation")).not.toBeInTheDocument();
    expect(screen.getByText("Issues")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Issues"));
    expect(screen.getByText("Loop validation")).toBeInTheDocument();
  });

  it("the preset-caused toggle switch flips showFullyPresetLockedIssues", () => {
    const issue = invalidLoopIssue("loop_length");
    render(<IssuesBlock issues={[issue]} />);
    expect(useMazeStore.getState().showFullyPresetLockedIssues).toBe(true);

    fireEvent.click(screen.getByRole("checkbox"));
    expect(useMazeStore.getState().showFullyPresetLockedIssues).toBe(false);

    useMazeStore.getState().setShowFullyPresetLockedIssues(true);
  });

  it("opening a bubble with locked elements shows the preset-locked summary phrase with the right count, not a per-element list", () => {
    const issue: IssueDto = {
      kind: "invalid_loop",
      payload: {
        kind: "invalid_loop",
        edges: {
          loop_length: [
            { edges: [[1, 2]], preset_locked: true },
            { edges: [[3, 4]], preset_locked: true },
            { edges: [[5, 6]], preset_locked: false },
          ],
        },
      },
      source_checks: ["loop_length"],
      source_check_types: { loop_length: "loop_length" },
      details: {},
    };
    render(<IssueBubble issue={issue} sourceCheck="loop_length" />);
    fireEvent.click(screen.getByText("Loop validation"));
    expect(screen.getByText("2 instances are set by presets and cannot be fixed")).toBeInTheDocument();
  });

  it("a fully preset-locked invalid_split_tile bubble is hidden when the toggle is off, and shows the summary phrase when on", () => {
    const issue: IssueDto = {
      kind: "invalid_split_tile",
      payload: { kind: "invalid_split_tile", groups: { split_distance_from_waypoint: [{ tiles: [{ nodes: [7], preset_locked: true }], preset_locked: true }] } },
      source_checks: ["split_distance_from_waypoint"],
      source_check_types: { split_distance_from_waypoint: "split_distance_from_waypoint" },
      details: {},
    };

    useMazeStore.getState().setShowFullyPresetLockedIssues(false);
    const { rerender } = render(<IssueBubble issue={issue} sourceCheck="split_distance_from_waypoint" />);
    expect(screen.queryByText("Split tile validation")).not.toBeInTheDocument();

    useMazeStore.getState().setShowFullyPresetLockedIssues(true);
    rerender(<IssueBubble issue={issue} sourceCheck="split_distance_from_waypoint" />);
    fireEvent.click(screen.getByText("Split tile validation"));
    expect(screen.getByText("1 instance is set by presets and cannot be fixed")).toBeInTheDocument();
  });

  it("max_split_count counts individual tiles, not the single field-wide group Rust bundles them into", () => {
    // Regression: 5 flagged tiles inside ONE Rust-side group must read as "5 instances", not "1".
    const issue: IssueDto = {
      kind: "invalid_split_tile_group",
      payload: {
        kind: "invalid_split_tile",
        groups: {
          max_split_count: [{
            tiles: [
              { nodes: [1], preset_locked: true },
              { nodes: [2], preset_locked: true },
              { nodes: [3], preset_locked: false },
              { nodes: [4], preset_locked: false },
              { nodes: [5], preset_locked: false },
            ],
            preset_locked: false,
          }],
        },
      },
      source_checks: ["max_split_count"],
      source_check_types: { max_split_count: "max_split_count" },
      details: {},
    };
    render(<IssueBubble issue={issue} sourceCheck="max_split_count" />);
    fireEvent.click(screen.getByText("Split tile group validation"));
    expect(screen.getByText("2 instances are set by presets and cannot be fixed")).toBeInTheDocument();
  });

  it("split_group_geometric_proximity counts pairs as one instance each, not one per tile", () => {
    const issue: IssueDto = {
      kind: "invalid_split_tile_group",
      payload: {
        kind: "invalid_split_tile",
        groups: {
          split_group_geometric_proximity: [
            { tiles: [{ nodes: [1], preset_locked: true }, { nodes: [2], preset_locked: true }], preset_locked: true },
            { tiles: [{ nodes: [3], preset_locked: true }, { nodes: [4], preset_locked: false }], preset_locked: false },
          ],
        },
      },
      source_checks: ["split_group_geometric_proximity"],
      source_check_types: { split_group_geometric_proximity: "split_group_geometric_proximity" },
      details: {},
    };
    render(<IssueBubble issue={issue} sourceCheck="split_group_geometric_proximity" />);
    fireEvent.click(screen.getByText("Split tile group validation"));
    expect(screen.getByText("1 instance is set by presets and cannot be fixed")).toBeInTheDocument();
  });

  it("with showFullyPresetLockedIssues off, a surviving mixed invalid_split_tile bubble only highlights its non-preset-locked nodes on hover", () => {
    useMazeStore.getState().setShowFullyPresetLockedIssues(false);
    const issue: IssueDto = {
      kind: "invalid_split_tile",
      payload: {
        kind: "invalid_split_tile",
        groups: {
          split_distance_from_waypoint: [
            { tiles: [{ nodes: [7], preset_locked: true }], preset_locked: true },
            { tiles: [{ nodes: [8], preset_locked: false }], preset_locked: false },
          ],
        },
      },
      source_checks: ["split_distance_from_waypoint"],
      source_check_types: { split_distance_from_waypoint: "split_distance_from_waypoint" },
      details: {},
    };
    render(<IssueBubble issue={issue} sourceCheck="split_distance_from_waypoint" />);

    const bubble = screen.getByText("Split tile validation");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredIssueRegionGroups).toEqual([[8]]);
    fireEvent.mouseLeave(bubble);

    useMazeStore.getState().setShowFullyPresetLockedIssues(true);
  });

  it("with showFullyPresetLockedIssues off, a surviving mixed invalid_split_route bubble only highlights its non-preset-locked route's edges on hover", () => {
    // Whole-route granularity, not per-edge-within-route -- a locked route is entirely hidden from
    // hover, an unlocked route's edges all still highlight.
    useMazeStore.getState().setShowFullyPresetLockedIssues(false);
    const issue: IssueDto = {
      kind: "invalid_split_route",
      payload: {
        kind: "invalid_split_route",
        routes: {
          split_node_connection_traversal_distance: [
            { edges: [{ from: 1, to: 2, is_split_edge: true }], preset_locked: true },
            { edges: [{ from: 3, to: 4, is_split_edge: false }], preset_locked: false },
          ],
        },
      },
      source_checks: ["split_node_connection_traversal_distance"],
      source_check_types: { split_node_connection_traversal_distance: "split_node_connection_traversal_distance" },
      details: {},
    };
    render(<IssueBubble issue={issue} sourceCheck="split_node_connection_traversal_distance" />);

    const bubble = screen.getByText("Split-tile traversal route validation");
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredIssueLoopEdges).toEqual([[3, 4]]);
    fireEvent.mouseLeave(bubble);

    useMazeStore.getState().setShowFullyPresetLockedIssues(true);
  });
});
