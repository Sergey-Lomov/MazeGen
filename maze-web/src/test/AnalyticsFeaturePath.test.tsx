import { describe, it, beforeEach, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AnalyticsFeature } from "../components/features/AnalyticsFeature";
import { useMazeStore } from "../store/mazeStore";
import type { MazeStatisticsDto, RouteInfoDto } from "../wasm/types";

// Regression coverage for GitHub issue #531: the Path section's element-type rows (one-way,
// teleport, split, vertical bidirectional/one-way, elevator) must each show only when the maze
// has at least one instance of that element type, maze-wide -- never unconditionally, and never
// hidden when the type is actually present.

const zeroElementsStats = {
  one_way_passages: 0,
  two_way_teleports: 0,
  one_way_teleports: 0,
  split_tile_count: 0,
  split_node_count: 0,
  split_groups: [],
};

const zeroVerticalStats = {
  bidirectional_passages: 0,
  one_way_passages_up: 0,
  one_way_passages_down: 0,
  elevator_groups: 0,
  elevator_stop_count: 0,
  average_elevator_stops: 0,
  cross_floor_teleports: 0,
};

const baseCellStats = { dead_ends: 1, straight: 0, turns: 0, junctions: [] };
const baseEdgeStats = { bidirectional: 1, walls: 0, total_pairs: 1 };

function makeStatistics(overrides: {
  elementsStats?: Partial<typeof zeroElementsStats>;
  verticalStats?: Partial<typeof zeroVerticalStats>;
}): MazeStatisticsDto {
  const elements_stats = { ...zeroElementsStats, ...overrides.elementsStats };
  const vertical_stats = { ...zeroVerticalStats, ...overrides.verticalStats };
  return {
    graph_stats: {
      floor_count: 1,
      node_count: 1,
      edge_count: 1,
      component_count: 1,
      average_degree: 1,
      cycle_count: 0,
      cycle_region_count: 0,
      simple_cycle_count: 0,
      node_component: {},
      pure_cycle_node_ids: [],
      pure_cycle_edge_pairs: [],
      cycle_analysis_overflowed: false,
      region_classes: {},
    },
    cell_count: { total: 1, by_floor: { 0: 1 } },
    cell_stats: { total: baseCellStats, by_floor: { 0: baseCellStats } },
    passage_stats: { total: baseEdgeStats, by_floor: { 0: baseEdgeStats } },
    elements_stats: { total: elements_stats, by_floor: { 0: elements_stats } },
    vertical_stats,
    elevator_stop_count: { total: 0, by_floor: { 0: 0 } },
  } as MazeStatisticsDto;
}

const baseRouteInfo: RouteInfoDto = {
  path_length: 2,
  junction_count: 0,
  one_way_count: 1,
  split_count: 1,
  teleport_count: 1,
  vertical_bidirectional_count: 1,
  vertical_one_way_count: 1,
  elevator_count: 1,
  score: null,
  path: [0, 1],
};

beforeEach(() => {
  useMazeStore.setState({
    analyticsSectionsExpanded: { path: true },
    routeInfo: baseRouteInfo,
  });
});

describe("AnalyticsFeature Path section element-type rows", () => {
  it("hides every element-type row when the maze has none of them", () => {
    useMazeStore.setState({ statistics: makeStatistics({}) });
    render(<AnalyticsFeature />);
    expect(screen.getByText("Path length")).toBeInTheDocument();
    expect(screen.queryByText("One-way on path")).not.toBeInTheDocument();
    expect(screen.queryByText("Teleports on path")).not.toBeInTheDocument();
    expect(screen.queryByText("Splits on path")).not.toBeInTheDocument();
    expect(screen.queryByText("Two-way vertical passages on path")).not.toBeInTheDocument();
    expect(screen.queryByText("One-way vertical passages on path")).not.toBeInTheDocument();
    expect(screen.queryByText("Elevator rides on path")).not.toBeInTheDocument();
  });

  it("shows the one-way row when the maze has one-way passages", () => {
    useMazeStore.setState({ statistics: makeStatistics({ elementsStats: { one_way_passages: 1 } }) });
    render(<AnalyticsFeature />);
    expect(screen.getByText("One-way on path")).toBeInTheDocument();
  });

  it("shows the teleport row when the maze has a one-way teleport (not just two-way)", () => {
    useMazeStore.setState({ statistics: makeStatistics({ elementsStats: { one_way_teleports: 1 } }) });
    render(<AnalyticsFeature />);
    expect(screen.getByText("Teleports on path")).toBeInTheDocument();
  });

  it("shows the split row when the maze has split tiles", () => {
    useMazeStore.setState({ statistics: makeStatistics({ elementsStats: { split_tile_count: 1 } }) });
    render(<AnalyticsFeature />);
    expect(screen.getByText("Splits on path")).toBeInTheDocument();
  });

  it("shows only the bidirectional vertical row when the maze has bidirectional vertical passages but no one-way ones", () => {
    useMazeStore.setState({ statistics: makeStatistics({ verticalStats: { bidirectional_passages: 1 } }) });
    render(<AnalyticsFeature />);
    expect(screen.getByText("Two-way vertical passages on path")).toBeInTheDocument();
    expect(screen.queryByText("One-way vertical passages on path")).not.toBeInTheDocument();
  });

  it("shows only the one-way vertical row when the maze has one-way vertical passages but no bidirectional ones", () => {
    useMazeStore.setState({ statistics: makeStatistics({ verticalStats: { one_way_passages_up: 1 } }) });
    render(<AnalyticsFeature />);
    expect(screen.getByText("One-way vertical passages on path")).toBeInTheDocument();
    expect(screen.queryByText("Two-way vertical passages on path")).not.toBeInTheDocument();
  });

  it("shows the elevator row when the maze has elevator groups", () => {
    useMazeStore.setState({ statistics: makeStatistics({ verticalStats: { elevator_groups: 1 } }) });
    render(<AnalyticsFeature />);
    expect(screen.getByText("Elevator rides on path")).toBeInTheDocument();
  });
});
