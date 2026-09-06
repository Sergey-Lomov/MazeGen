import * as m from "~/paraglide/messages";

type MessageFn = () => string;

/// Picks a check's label based on its instance params, for the (rare) check whose displayed name
/// should reflect a configured option instead of staying fixed — e.g. `max_teleport_count` reads
/// "Кол-во телепортов на этаж" once `floor_scope` is set to `per_floor`, since the plain "Макс.
/// количество телепортов" label doesn't convey the per-floor evaluation. `params` is the check
/// instance's raw `Record<string, string>` (`CheckInstance.params`); absent for callers with no
/// instance in scope (falls through to `label`).
type ParamLabelFn = (params?: Record<string, string>) => string;

export const checkI18n: Record<string, { label: ParamLabelFn; description: ParamLabelFn; cardLabel?: ParamLabelFn }> = {
  missing_endpoints: {
    label: m["check.missing_endpoints.label"] as MessageFn,
    description: m["check.missing_endpoints.description"] as MessageFn,
  },
  unreachable_finish: {
    label: m["check.unreachable_finish.label"] as MessageFn,
    description: m["check.unreachable_finish.description"] as MessageFn,
  },
  min_loops_count: {
    label: m["check.min_loops_count.label"] as MessageFn,
    description: m["check.min_loops_count.description"] as MessageFn,
  },
  min_loop_density: {
    label: m["check.min_loop_density.label"] as MessageFn,
    description: m["check.min_loop_density.description"] as MessageFn,
  },
  loop_length: {
    label: m["check.loop_length.label"] as MessageFn,
    description: m["check.loop_length.description"] as MessageFn,
  },
  external_escape_diversity: {
    label: m["check.external_escape_diversity.label"] as MessageFn,
    description: m["check.external_escape_diversity.description"] as MessageFn,
  },
  loop_distance_from_start: {
    label: m["check.loop_distance_from_start.label"] as MessageFn,
    description: m["check.loop_distance_from_start.description"] as MessageFn,
  },
  loop_distance_from_finish: {
    label: m["check.loop_distance_from_finish.label"] as MessageFn,
    description: m["check.loop_distance_from_finish.description"] as MessageFn,
  },
  max_loop_density: {
    label: m["check.max_loop_density.label"] as MessageFn,
    description: m["check.max_loop_density.description"] as MessageFn,
  },
  max_loops_count: {
    label: m["check.max_loops_count.label"] as MessageFn,
    description: m["check.max_loops_count.description"] as MessageFn,
  },
  scc_count: {
    label: m["check.scc_count.label"] as MessageFn,
    description: m["check.scc_count.description"] as MessageFn,
  },
  min_region_size: {
    label: m["check.min_region_size.label"] as MessageFn,
    description: m["check.min_region_size.description"] as MessageFn,
  },
  min_region_ratio: {
    label: m["check.min_region_ratio.label"] as MessageFn,
    description: m["check.min_region_ratio.description"] as MessageFn,
  },
  max_region_size: {
    label: m["check.max_region_size.label"] as MessageFn,
    description: m["check.max_region_size.description"] as MessageFn,
  },
  max_region_ratio: {
    label: m["check.max_region_ratio.label"] as MessageFn,
    description: m["check.max_region_ratio.description"] as MessageFn,
  },
  min_region_count: {
    label: m["check.min_region_count.label"] as MessageFn,
    description: m["check.min_region_count.description"] as MessageFn,
  },
  teleport_duplicates_connection: {
    label: m["check.teleport_duplicates_connection.label"] as MessageFn,
    description: m["check.teleport_duplicates_connection.description"] as MessageFn,
  },
  teleport_waypoint_distance: {
    label: m["check.teleport_waypoint_distance.label"] as MessageFn,
    description: m["check.teleport_waypoint_distance.description"] as MessageFn,
  },
  teleport_geometric_length: {
    label: m["check.teleport_geometric_length.label"] as MessageFn,
    description: m["check.teleport_geometric_length.description"] as MessageFn,
  },
  teleport_graph_distance: {
    label: m["check.teleport_graph_distance.label"] as MessageFn,
    description: m["check.teleport_graph_distance.description"] as MessageFn,
  },
  teleport_super_hub_avoidance: {
    label: m["check.teleport_super_hub_avoidance.label"] as MessageFn,
    description: m["check.teleport_super_hub_avoidance.description"] as MessageFn,
  },
  teleport_split_intersection: {
    label: m["check.teleport_split_intersection.label"] as MessageFn,
    description: m["check.teleport_split_intersection.description"] as MessageFn,
  },
  teleport_group_proximity: {
    label: m["check.teleport_group_proximity.label"] as MessageFn,
    description: m["check.teleport_group_proximity.description"] as MessageFn,
  },
  one_way_waypoint_distance: {
    label: m["check.one_way_waypoint_distance.label"] as MessageFn,
    description: m["check.one_way_waypoint_distance.description"] as MessageFn,
  },
  one_way_group_geometric_proximity: {
    label: m["check.one_way_group_geometric_proximity.label"] as MessageFn,
    description: m["check.one_way_group_geometric_proximity.description"] as MessageFn,
  },
  one_way_group_graph_proximity: {
    label: m["check.one_way_group_graph_proximity.label"] as MessageFn,
    description: m["check.one_way_group_graph_proximity.description"] as MessageFn,
  },
  one_way_group_super_hub: {
    label: m["check.one_way_group_super_hub.label"] as MessageFn,
    description: m["check.one_way_group_super_hub.description"] as MessageFn,
  },
  min_one_way_count: {
    label: m["check.min_one_way_count.label"] as MessageFn,
    description: m["check.min_one_way_count.description"] as MessageFn,
  },
  min_one_way_ratio: {
    label: m["check.min_one_way_ratio.label"] as MessageFn,
    description: m["check.min_one_way_ratio.description"] as MessageFn,
  },
  max_one_way_count: {
    label: m["check.max_one_way_count.label"] as MessageFn,
    description: m["check.max_one_way_count.description"] as MessageFn,
  },
  max_one_way_ratio: {
    label: m["check.max_one_way_ratio.label"] as MessageFn,
    description: m["check.max_one_way_ratio.description"] as MessageFn,
  },
  min_teleport_count: {
    label: m["check.min_teleport_count.short_label"] as MessageFn,
    description: m["check.min_teleport_count.description"] as MessageFn,
    cardLabel: m["check.min_teleport_count.label"] as MessageFn,
  },
  min_teleport_ratio: {
    label: m["check.min_teleport_ratio.short_label"] as MessageFn,
    description: m["check.min_teleport_ratio.description"] as MessageFn,
    cardLabel: m["check.min_teleport_ratio.label"] as MessageFn,
  },
  split_distance_from_waypoint: {
    label: m["check.split_distance_from_waypoint.label"] as MessageFn,
    description: m["check.split_distance_from_waypoint.description"] as MessageFn,
    cardLabel: m["check.split_distance_from_waypoint.card_label"] as MessageFn,
  },
  split_teleport_intersection: {
    label: m["check.split_teleport_intersection.label"] as MessageFn,
    description: m["check.split_teleport_intersection.description"] as MessageFn,
  },
  split_pattern_shape: {
    label: m["check.split_pattern_shape.label"] as MessageFn,
    description: m["check.split_pattern_shape.description"] as MessageFn,
  },
  max_split_count: {
    label: m["check.max_split_count.label"] as MessageFn,
    description: m["check.max_split_count.description"] as MessageFn,
  },
  max_split_density: {
    label: m["check.max_split_density.label"] as MessageFn,
    description: m["check.max_split_density.description"] as MessageFn,
  },
  split_group_geometric_proximity: {
    label: m["check.split_group_geometric_proximity.label"] as MessageFn,
    description: m["check.split_group_geometric_proximity.description"] as MessageFn,
  },
  split_group_graph_proximity: {
    label: m["check.split_group_graph_proximity.label"] as MessageFn,
    description: m["check.split_group_graph_proximity.description"] as MessageFn,
  },
  split_count: {
    label: m["check.split_count.label"] as MessageFn,
    description: m["check.split_count.description"] as MessageFn,
  },
  split_density: {
    label: m["check.split_density.label"] as MessageFn,
    description: m["check.split_density.description"] as MessageFn,
  },
  split_node_connection_count: {
    label: m["check.split_node_connection_count.label"] as MessageFn,
    description: m["check.split_node_connection_count.description"] as MessageFn,
  },
  split_node_connection_per_neighbor: {
    label: m["check.split_node_connection_per_neighbor.label"] as MessageFn,
    description: m["check.split_node_connection_per_neighbor.description"] as MessageFn,
  },
  split_node_connection_per_face: {
    label: m["check.split_node_connection_per_face.label"] as MessageFn,
    description: m["check.split_node_connection_per_face.description"] as MessageFn,
  },
  split_node_connection_traversal_distance: {
    label: m["check.split_node_connection_traversal_distance.label"] as MessageFn,
    description: m["check.split_node_connection_traversal_distance.description"] as MessageFn,
  },
  max_split_tile_node_count: {
    label: m["check.max_split_tile_node_count.label"] as MessageFn,
    description: m["check.max_split_tile_node_count.description"] as MessageFn,
  },
  min_vertical_passage_count: {
    label: m["check.min_vertical_passage_count.short_label"] as MessageFn,
    description: m["check.min_vertical_passage_count.description"] as MessageFn,
    cardLabel: m["check.min_vertical_passage_count.label"] as MessageFn,
  },
  min_vertical_passage_ratio: {
    label: m["check.min_vertical_passage_ratio.short_label"] as MessageFn,
    description: m["check.min_vertical_passage_ratio.description"] as MessageFn,
    cardLabel: m["check.min_vertical_passage_ratio.label"] as MessageFn,
  },
  max_vertical_passage_count: {
    label: m["check.max_vertical_passage_count.short_label"] as MessageFn,
    description: m["check.max_vertical_passage_count.description"] as MessageFn,
    cardLabel: m["check.max_vertical_passage_count.label"] as MessageFn,
  },
  max_vertical_passage_ratio: {
    label: m["check.max_vertical_passage_ratio.short_label"] as MessageFn,
    description: m["check.max_vertical_passage_ratio.description"] as MessageFn,
    cardLabel: m["check.max_vertical_passage_ratio.label"] as MessageFn,
  },
  vertical_passage_group_geometric_proximity: {
    label: m["check.vertical_passage_group_geometric_proximity.short_label"] as MessageFn,
    description: m["check.vertical_passage_group_geometric_proximity.description"] as MessageFn,
    cardLabel: m["check.vertical_passage_group_geometric_proximity.label"] as MessageFn,
  },
  vertical_passage_group_graph_proximity: {
    label: m["check.vertical_passage_group_graph_proximity.short_label"] as MessageFn,
    description: m["check.vertical_passage_group_graph_proximity.description"] as MessageFn,
    cardLabel: m["check.vertical_passage_group_graph_proximity.label"] as MessageFn,
  },
  elevator_stop_count: {
    label: m["check.elevator_stop_count.short_label"] as MessageFn,
    description: m["check.elevator_stop_count.description"] as MessageFn,
    cardLabel: m["check.elevator_stop_count.label"] as MessageFn,
  },
  elevator_span: {
    label: m["check.elevator_span.short_label"] as MessageFn,
    description: m["check.elevator_span.description"] as MessageFn,
    cardLabel: m["check.elevator_span.label"] as MessageFn,
  },
  max_elevator_count: {
    label: m["check.max_elevator_count.label"] as MessageFn,
    description: m["check.max_elevator_count.description"] as MessageFn,
  },
  max_elevator_density: {
    label: m["check.max_elevator_density.label"] as MessageFn,
    description: m["check.max_elevator_density.description"] as MessageFn,
  },
  max_elevator_stops: {
    label: m["check.max_elevator_stops.label"] as MessageFn,
    description: m["check.max_elevator_stops.description"] as MessageFn,
  },
  max_elevator_stops_per_floor: {
    label: m["check.max_elevator_stops_per_floor.label"] as MessageFn,
    description: m["check.max_elevator_stops_per_floor.description"] as MessageFn,
  },
  elevator_stops_skip: {
    label: m["check.elevator_stops_skip.label"] as MessageFn,
    description: m["check.elevator_stops_skip.description"] as MessageFn,
  },
  elevator_stops_span: {
    label: m["check.elevator_stops_span.label"] as MessageFn,
    description: m["check.elevator_stops_span.description"] as MessageFn,
  },
  min_elevator_count: {
    label: m["check.min_elevator_count.label"] as MessageFn,
    description: m["check.min_elevator_count.description"] as MessageFn,
  },
  min_elevator_density: {
    label: m["check.min_elevator_density.label"] as MessageFn,
    description: m["check.min_elevator_density.description"] as MessageFn,
  },
  min_elevator_stops_per_area_count: {
    label: m["check.min_elevator_stops_per_area_count.short_label"] as MessageFn,
    description: m["check.min_elevator_stops_per_area_count.description"] as MessageFn,
    cardLabel: m["check.min_elevator_stops_per_area_count.label"] as MessageFn,
  },
  min_elevator_stops_per_area_density: {
    label: m["check.min_elevator_stops_per_area_density.short_label"] as MessageFn,
    description: m["check.min_elevator_stops_per_area_density.description"] as MessageFn,
    cardLabel: m["check.min_elevator_stops_per_area_density.label"] as MessageFn,
  },
  max_elevator_stop_gap: {
    label: m["check.max_elevator_stop_gap.label"] as MessageFn,
    description: m["check.max_elevator_stop_gap.description"] as MessageFn,
  },
  min_elevator_height: {
    label: m["check.min_elevator_height.label"] as MessageFn,
    description: m["check.min_elevator_height.description"] as MessageFn,
  },
  min_elevator_stop_count: {
    label: m["check.min_elevator_stop_count.short_label"] as MessageFn,
    description: m["check.min_elevator_stop_count.description"] as MessageFn,
    cardLabel: m["check.min_elevator_stop_count.label"] as MessageFn,
  },
  elevator_stop_group_geometric_proximity: {
    label: m["check.elevator_stop_group_geometric_proximity.short_label"] as MessageFn,
    description: m["check.elevator_stop_group_geometric_proximity.description"] as MessageFn,
    cardLabel: m["check.elevator_stop_group_geometric_proximity.label"] as MessageFn,
  },
  elevator_stop_group_graph_proximity: {
    label: m["check.elevator_stop_group_graph_proximity.short_label"] as MessageFn,
    description: m["check.elevator_stop_group_graph_proximity.description"] as MessageFn,
    cardLabel: m["check.elevator_stop_group_graph_proximity.label"] as MessageFn,
  },
  cross_element_geometric_proximity: {
    label: m["check.cross_element_geometric_proximity.short_label"] as MessageFn,
    description: m["check.cross_element_geometric_proximity.description"] as MessageFn,
    cardLabel: m["check.cross_element_geometric_proximity.label"] as MessageFn,
  },
  cross_element_graph_proximity: {
    label: m["check.cross_element_graph_proximity.short_label"] as MessageFn,
    description: m["check.cross_element_graph_proximity.description"] as MessageFn,
    cardLabel: m["check.cross_element_graph_proximity.label"] as MessageFn,
  },
  max_teleport_count: {
    label: (params) => params?.floor_scope === "per_floor"
      ? (m["check.max_teleport_count.label_per_floor"] as MessageFn)()
      : (m["check.max_teleport_count.label"] as MessageFn)(),
    description: (params) => params?.floor_scope === "per_floor"
      ? (m["check.max_teleport_count.description_per_floor"] as MessageFn)()
      : (m["check.max_teleport_count.description"] as MessageFn)(),
  },
  max_teleport_density: {
    label: (params) => params?.floor_scope === "per_floor"
      ? (m["check.max_teleport_density.label_per_floor"] as MessageFn)()
      : (m["check.max_teleport_density.label"] as MessageFn)(),
    description: (params) => params?.floor_scope === "per_floor"
      ? (m["check.max_teleport_density.description_per_floor"] as MessageFn)()
      : (m["check.max_teleport_density.description"] as MessageFn)(),
  },
};

export function resolveCheckLabel(id: string, fallback: string, params?: Record<string, string>): string {
  const label = checkI18n[id]?.label;
  return label ? label(params) : fallback;
}

/// Full/unambiguous label for a check already added to a rule (`RuleCheckRow`'s card) — falls
/// back to the short `resolveCheckLabel` for the (majority) of checks whose short label is already
/// unambiguous on its own; only a check whose short label reads oddly out of its list context
/// (e.g. `split_distance_from_waypoint`'s "Distance from waypoint", missing the "split-tile" it's
/// about) needs a `cardLabel` override here.
export function resolveCheckCardLabel(id: string, fallback: string, params?: Record<string, string>): string {
  const cardLabel = checkI18n[id]?.cardLabel;
  return cardLabel ? cardLabel(params) : resolveCheckLabel(id, fallback, params);
}

export function resolveCheckDescription(id: string, fallback: string, params?: Record<string, string>): string {
  const description = checkI18n[id]?.description;
  return description ? description(params) : fallback;
}
