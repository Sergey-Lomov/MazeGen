import { describe, it, beforeEach, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DetailedReportPanel } from "../components/features/AnalyticsFeature";
import { useMazeStore } from "../store/mazeStore";
import { activeFloorTessellationOf } from "../store/storeHelpers";
import type { MazeStatisticsDto } from "../wasm/types";

const baseElementsStats = {
  one_way_passages: 0,
  two_way_teleports: 0,
  one_way_teleports: 0,
  split_tile_count: 0,
  split_node_count: 0,
  split_groups: [],
};

const baseCellStats = { dead_ends: 1, straight: 0, turns: 0, junctions: [] };
const baseEdgeStats = { bidirectional: 1, walls: 0, total_pairs: 1 };

function makeStatistics(byFloor: Record<number, unknown>): MazeStatisticsDto {
  return {
    graph_stats: {
      floor_count: Object.keys(byFloor).length,
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
    cell_count: { total: 1, by_floor: Object.fromEntries(Object.keys(byFloor).map((k) => [k, 1])) },
    cell_stats: { total: baseCellStats, by_floor: Object.fromEntries(Object.keys(byFloor).map((k) => [k, baseCellStats])) },
    passage_stats: { total: baseEdgeStats, by_floor: Object.fromEntries(Object.keys(byFloor).map((k) => [k, baseEdgeStats])) },
    elements_stats: { total: baseElementsStats, by_floor: Object.fromEntries(Object.keys(byFloor).map((k) => [k, baseElementsStats])) },
    vertical_stats: { bidirectional_passages: 0, one_way_passages_up: 0, one_way_passages_down: 0, elevator_groups: 0, elevator_stop_count: 0, average_elevator_stops: 0, cross_floor_teleports: 0 },
    elevator_stop_count: { total: 0, by_floor: Object.fromEntries(Object.keys(byFloor).map((k) => [k, 0])) },
  } as MazeStatisticsDto;
}

beforeEach(() => {
  useMazeStore.setState({
    analyticsSectionsExpanded: { report_general: true, report_by_floors: true },
  });
});

describe("DetailedReportPanel", () => {
  it("renders the by-floors count matching the floors that have stats", () => {
    const statistics = makeStatistics({ 0: true });
    render(
      <DetailedReportPanel
        statistics={statistics}
        floors={[{ id: "floor-0", title: "Floor 1" }]}
        cfg={activeFloorTessellationOf(useMazeStore.getState())}
        nodes={[]}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Floor 1")).toBeInTheDocument();
  });

  it("does not crash and excludes a floor missing from statistics.by_floor (desync regression)", () => {
    // Only floor 0 has stats in the snapshot; floor 1 was added to the UI afterward
    // (e.g. via addFloor) without regenerating — statistics.*.by_floor has no "1" entry.
    const statistics = makeStatistics({ 0: true });
    render(
      <DetailedReportPanel
        statistics={statistics}
        floors={[{ id: "floor-0", title: "Floor 1" }, { id: "floor-1", title: "Floor 2" }]}
        cfg={activeFloorTessellationOf(useMazeStore.getState())}
        nodes={[]}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Floor 1")).toBeInTheDocument();
    expect(screen.queryByText("Floor 2")).not.toBeInTheDocument();
  });
});
