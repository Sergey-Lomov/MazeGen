import * as m from "~/paraglide/messages";

type MessageFn = () => string;

export const paramI18n: Record<string, { label: MessageFn; description: MessageFn }> = {
  min_loops: {
    label: m["param.min_loops.label"] as MessageFn,
    description: m["param.min_loops.description"] as MessageFn,
  },
  length: {
    label: m["param.length.label"] as MessageFn,
    description: m["param.length.description"] as MessageFn,
  },
  comparison: {
    label: m["param.comparison.label"] as MessageFn,
    description: m["param.comparison.description"] as MessageFn,
  },
  cycle_kind: {
    label: m["param.cycle_kind.label"] as MessageFn,
    description: m["param.cycle_kind.description"] as MessageFn,
  },
  floor_mode: {
    label: m["param.floor_mode.label"] as MessageFn,
    description: m["param.floor_mode.description"] as MessageFn,
  },
  floor_scope: {
    label: m["param.floor_scope.label"] as MessageFn,
    description: m["param.floor_scope.description"] as MessageFn,
  },
  min_distinct_exits: {
    label: m["param.min_distinct_exits.label"] as MessageFn,
    description: m["param.min_distinct_exits.description"] as MessageFn,
  },
  min_distance_from_start: {
    label: m["param.min_distance_from_start.label"] as MessageFn,
    description: m["param.min_distance_from_start.description"] as MessageFn,
  },
  min_distance_from_finish: {
    label: m["param.min_distance_from_finish.label"] as MessageFn,
    description: m["param.min_distance_from_finish.description"] as MessageFn,
  },
  max_density: {
    label: m["param.max_density.label"] as MessageFn,
    description: m["param.max_density.description"] as MessageFn,
  },
  max_loops_count: {
    label: m["param.max_loops_count.label"] as MessageFn,
    description: m["param.max_loops_count.description"] as MessageFn,
  },
  min_density: {
    label: m["param.min_density.label"] as MessageFn,
    description: m["param.min_density.description"] as MessageFn,
  },
  avg_loop_length_estimate: {
    label: m["param.avg_loop_length_estimate.label"] as MessageFn,
    description: m["param.avg_loop_length_estimate.description"] as MessageFn,
  },
  path_weight: {
    label: m["param.path_weight.label"] as MessageFn,
    description: m["param.path_weight.description"] as MessageFn,
  },
  junction_weight: {
    label: m["param.junction_weight.label"] as MessageFn,
    description: m["param.junction_weight.description"] as MessageFn,
  },
  oneway_weight: {
    label: m["param.oneway_weight.label"] as MessageFn,
    description: m["param.oneway_weight.description"] as MessageFn,
  },
  teleport_weight: {
    label: m["param.teleport_weight.label"] as MessageFn,
    description: m["param.teleport_weight.description"] as MessageFn,
  },
  split_weight: {
    label: m["param.split_weight.label"] as MessageFn,
    description: m["param.split_weight.description"] as MessageFn,
  },
  vertical_passage_weight: {
    label: m["param.vertical_passage_weight.label"] as MessageFn,
    description: m["param.vertical_passage_weight.description"] as MessageFn,
  },
  elevator_weight: {
    label: m["param.elevator_weight.label"] as MessageFn,
    description: m["param.elevator_weight.description"] as MessageFn,
  },
  invalid_overlap_weight: {
    label: m["param.invalid_overlap_weight.label"] as MessageFn,
    description: m["param.invalid_overlap_weight.description"] as MessageFn,
  },
  valid_overlap_weight: {
    label: m["param.valid_overlap_weight.label"] as MessageFn,
    description: m["param.valid_overlap_weight.description"] as MessageFn,
  },
  reserve_percent: {
    label: m["param.reserve_percent.label"] as MessageFn,
    description: m["param.reserve_percent.description"] as MessageFn,
  },
  vertical_reserve_percent: {
    label: m["param.vertical_reserve_percent.label"] as MessageFn,
    description: m["param.vertical_reserve_percent.description"] as MessageFn,
  },
  src_mode: {
    label: m["param.src_mode.label"] as MessageFn,
    description: m["param.src_mode.description"] as MessageFn,
  },
  max_scc_count: {
    label: m["param.max_scc_count.label"] as MessageFn,
    description: m["param.max_scc_count.description"] as MessageFn,
  },
  min_region_size: {
    label: m["param.min_region_size.label"] as MessageFn,
    description: m["param.min_region_size.description"] as MessageFn,
  },
  min_region_ratio: {
    label: m["param.min_region_ratio.label"] as MessageFn,
    description: m["param.min_region_ratio.description"] as MessageFn,
  },
  max_region_size: {
    label: m["param.max_region_size.label"] as MessageFn,
    description: m["param.max_region_size.description"] as MessageFn,
  },
  max_region_ratio: {
    label: m["param.max_region_ratio.label"] as MessageFn,
    description: m["param.max_region_ratio.description"] as MessageFn,
  },
  target_mode: {
    label: m["param.target_mode.label"] as MessageFn,
    description: m["param.target_mode.description"] as MessageFn,
  },
  connection_mode: {
    label: m["param.connection_mode.label"] as MessageFn,
    description: m["param.connection_mode.description"] as MessageFn,
  },
  prefer_partially_connected: {
    label: m["param.prefer_partially_connected.label"] as MessageFn,
    description: m["param.prefer_partially_connected.description"] as MessageFn,
  },
  direction_mode: {
    label: m["param.direction_mode.label"] as MessageFn,
    description: m["param.direction_mode.description"] as MessageFn,
  },
  min_distance: {
    label: m["param.min_distance.label"] as MessageFn,
    description: m["param.min_distance.description"] as MessageFn,
  },
  locality: {
    label: m["param.locality.label"] as MessageFn,
    description: m["param.locality.description"] as MessageFn,
  },
  region_class: {
    label: m["param.region_class.label"] as MessageFn,
    description: m["param.region_class.description"] as MessageFn,
  },
  path_count: {
    label: m["param.path_count.label"] as MessageFn,
    description: m["param.path_count.description"] as MessageFn,
  },
  alternative_count: {
    label: m["param.alternative_count.label"] as MessageFn,
    description: m["param.alternative_count.description"] as MessageFn,
  },
  unreachable_count: {
    label: m["param.unreachable_count.label"] as MessageFn,
    description: m["param.unreachable_count.description"] as MessageFn,
  },
  trap_count: {
    label: m["param.trap_count.label"] as MessageFn,
    description: m["param.trap_count.description"] as MessageFn,
  },
  merge_priority: {
    label: m["param.merge_priority.label"] as MessageFn,
    description: m["param.merge_priority.description"] as MessageFn,
  },
  selection_mode: {
    label: m["param.selection_mode.label"] as MessageFn,
    description: m["param.selection_mode.description"] as MessageFn,
  },
  vertical_passage_priority: {
    label: m["param.vertical_passage_priority.label"] as MessageFn,
    description: m["param.vertical_passage_priority.description"] as MessageFn,
  },
  sample_mode: {
    label: m["param.sample_mode.label"] as MessageFn,
    description: m["param.sample_mode.description"] as MessageFn,
  },
  sample_size: {
    label: m["param.sample_size.label"] as MessageFn,
    description: m["param.sample_size.description"] as MessageFn,
  },
  distance: {
    label: m["param.distance.label"] as MessageFn,
    description: m["param.distance.description"] as MessageFn,
  },
  waypoint: {
    label: m["param.waypoint.label"] as MessageFn,
    description: m["param.waypoint.description"] as MessageFn,
  },
  edge: {
    label: m["param.edge.label"] as MessageFn,
    description: m["param.edge.description"] as MessageFn,
  },
  max_connections: {
    label: m["param.max_connections.label"] as MessageFn,
    description: m["param.max_connections.description"] as MessageFn,
  },
  edge_hub: {
    label: m["param.edge_hub.label"] as MessageFn,
    description: m["param.edge_hub.description"] as MessageFn,
  },
  edge_split: {
    label: m["param.edge_split.label"] as MessageFn,
    description: m["param.edge_split.description"] as MessageFn,
  },
  own_edge: {
    label: m["param.own_edge.label"] as MessageFn,
    description: m["param.own_edge.description"] as MessageFn,
  },
  other_edge: {
    label: m["param.other_edge.label"] as MessageFn,
    description: m["param.other_edge.description"] as MessageFn,
  },
  priority: {
    label: m["param.priority.label"] as MessageFn,
    description: m["param.priority.description"] as MessageFn,
  },
  protect_route: {
    label: m["param.protect_route.label"] as MessageFn,
    description: m["param.protect_route.description"] as MessageFn,
  },
  allow_reverse: {
    label: m["param.allow_reverse.label"] as MessageFn,
    description: m["param.allow_reverse.description"] as MessageFn,
  },
  min_one_ways: {
    label: m["param.min_one_ways.label"] as MessageFn,
    description: m["param.min_one_ways.description"] as MessageFn,
  },
  min_ratio: {
    label: m["param.min_ratio.label"] as MessageFn,
    description: m["param.min_ratio.description"] as MessageFn,
  },
  max_one_ways: {
    label: m["param.max_one_ways.label"] as MessageFn,
    description: m["param.max_one_ways.description"] as MessageFn,
  },
  max_ratio: {
    label: m["param.max_ratio.label"] as MessageFn,
    description: m["param.max_ratio.description"] as MessageFn,
  },
  min_teleports: {
    label: m["param.min_teleports.label"] as MessageFn,
    description: m["param.min_teleports.description"] as MessageFn,
  },
  min_teleport_ratio: {
    label: m["param.min_teleport_ratio.label"] as MessageFn,
    description: m["param.min_teleport_ratio.description"] as MessageFn,
  },
  entry_pick: {
    label: m["param.entry_pick.label"] as MessageFn,
    description: m["param.entry_pick.description"] as MessageFn,
  },
  unreachable_priority: {
    label: m["param.unreachable_priority.label"] as MessageFn,
    description: m["param.unreachable_priority.description"] as MessageFn,
  },
  desired_length: {
    label: m["param.desired_length.label"] as MessageFn,
    description: m["param.desired_length.description"] as MessageFn,
  },
  allow_out_of_interval: {
    label: m["param.allow_out_of_interval.label"] as MessageFn,
    description: m["param.allow_out_of_interval.description"] as MessageFn,
  },
  one_way_chance: {
    label: m["param.one_way_chance.label"] as MessageFn,
    description: m["param.one_way_chance.description"] as MessageFn,
  },
  loop_one_way_chance: {
    label: m["param.loop_one_way_chance.label"] as MessageFn,
    description: m["param.loop_one_way_chance.description"] as MessageFn,
  },
  vertical_loop_one_way_chance: {
    label: m["param.vertical_loop_one_way_chance.label"] as MessageFn,
    description: m["param.vertical_loop_one_way_chance.description"] as MessageFn,
  },
  attempts_limit: {
    label: m["param.attempts_limit.label"] as MessageFn,
    description: m["param.attempts_limit.description"] as MessageFn,
  },
  redistribute: {
    label: m["param.redistribute.label"] as MessageFn,
    description: m["param.redistribute.description"] as MessageFn,
  },
  max_split_count: {
    label: m["param.max_split_count.label"] as MessageFn,
    description: m["param.max_split_count.description"] as MessageFn,
  },
  max_split_density: {
    label: m["param.max_split_density.label"] as MessageFn,
    description: m["param.max_split_density.description"] as MessageFn,
  },
  max_elevator_count: {
    label: m["param.max_elevator_count.label"] as MessageFn,
    description: m["param.max_elevator_count.description"] as MessageFn,
  },
  max_elevator_density: {
    label: m["param.max_elevator_density.label"] as MessageFn,
    description: m["param.max_elevator_density.description"] as MessageFn,
  },
  split_group_geometric_proximity_distance: {
    label: m["param.split_group_geometric_proximity_distance.label"] as MessageFn,
    description: m["param.split_group_geometric_proximity_distance.description"] as MessageFn,
  },
  split_group_graph_proximity_distance: {
    label: m["param.split_group_graph_proximity_distance.label"] as MessageFn,
    description: m["param.split_group_graph_proximity_distance.description"] as MessageFn,
  },
  split_count: {
    label: m["param.split_count.label"] as MessageFn,
    description: m["param.split_count.description"] as MessageFn,
  },
  split_density: {
    label: m["param.split_density.label"] as MessageFn,
    description: m["param.split_density.description"] as MessageFn,
  },
  patterns: {
    label: m["param.patterns.label"] as MessageFn,
    description: m["param.patterns.description"] as MessageFn,
  },
  allow_lose_connections: {
    label: m["param.allow_lose_connections.label"] as MessageFn,
    description: m["param.allow_lose_connections.description"] as MessageFn,
  },
  allow_add_connections: {
    label: m["param.allow_add_connections.label"] as MessageFn,
    description: m["param.allow_add_connections.description"] as MessageFn,
  },
  max_attempts: {
    label: m["param.max_attempts.label"] as MessageFn,
    description: m["param.max_attempts.description"] as MessageFn,
  },
  split_config: {
    label: m["param.split_config.label"] as MessageFn,
    description: m["param.split_config.description"] as MessageFn,
  },
  count: {
    label: m["param.count.label"] as MessageFn,
    description: m["param.count.description"] as MessageFn,
  },
  direction: {
    label: m["param.direction.label"] as MessageFn,
    description: m["param.direction.description"] as MessageFn,
  },
  split_teleport_direction: {
    label: m["param.split_teleport_direction.label"] as MessageFn,
    description: m["param.split_teleport_direction.description"] as MessageFn,
  },
  max: {
    label: m["param.max.label"] as MessageFn,
    description: m["param.max.description"] as MessageFn,
  },
  min_detour: {
    label: m["param.min_detour.label"] as MessageFn,
    description: m["param.min_detour.description"] as MessageFn,
  },
  edge_scope: {
    label: m["param.edge_scope.label"] as MessageFn,
    description: m["param.edge_scope.description"] as MessageFn,
  },
  selection: {
    label: m["param.selection.label"] as MessageFn,
    description: m["param.selection.description"] as MessageFn,
  },
  protect_original: {
    label: m["param.protect_original.label"] as MessageFn,
    description: m["param.protect_original.description"] as MessageFn,
  },
  min_vertical_passages: {
    label: m["param.min_vertical_passages.label"] as MessageFn,
    description: m["param.min_vertical_passages.description"] as MessageFn,
  },
  min_vertical_passage_ratio: {
    label: m["param.min_vertical_passage_ratio.label"] as MessageFn,
    description: m["param.min_vertical_passage_ratio.description"] as MessageFn,
  },
  max_vertical_passages: {
    label: m["param.max_vertical_passages.label"] as MessageFn,
    description: m["param.max_vertical_passages.description"] as MessageFn,
  },
  one_way_balance: {
    label: m["param.one_way_balance.label"] as MessageFn,
    description: m["param.one_way_balance.description"] as MessageFn,
  },
  direction_balance: {
    label: m["param.direction_balance.label"] as MessageFn,
    description: m["param.direction_balance.description"] as MessageFn,
  },
  vertical_direction_balance: {
    label: m["param.vertical_direction_balance.label"] as MessageFn,
    description: m["param.vertical_direction_balance.description"] as MessageFn,
  },
  same_type_only: {
    label: m["param.same_type_only.label"] as MessageFn,
    description: m["param.same_type_only.description"] as MessageFn,
  },
  passage_type: {
    label: m["param.passage_type.label"] as MessageFn,
    description: m["param.passage_type.description"] as MessageFn,
  },
  count_incoming: {
    label: m["param.count_incoming.label"] as MessageFn,
    description: m["param.count_incoming.description"] as MessageFn,
  },
  adjacent_floors_only: {
    label: m["param.adjacent_floors_only.label"] as MessageFn,
    description: m["param.adjacent_floors_only.description"] as MessageFn,
  },
  span: {
    label: m["param.span.label"] as MessageFn,
    description: m["param.span.description"] as MessageFn,
  },
  max_elevator_stops: {
    label: m["param.max_elevator_stops.label"] as MessageFn,
    description: m["param.max_elevator_stops.description"] as MessageFn,
  },
  max_elevator_stops_per_floor: {
    label: m["param.max_elevator_stops_per_floor.label"] as MessageFn,
    description: m["param.max_elevator_stops_per_floor.description"] as MessageFn,
  },
  elevator_stops_skip: {
    label: m["param.elevator_stops_skip.label"] as MessageFn,
    description: m["param.elevator_stops_skip.description"] as MessageFn,
  },
  elevator_stops_span: {
    label: m["param.elevator_stops_span.label"] as MessageFn,
    description: m["param.elevator_stops_span.description"] as MessageFn,
  },
  min_elevator_count: {
    label: m["param.min_elevator_count.label"] as MessageFn,
    description: m["param.min_elevator_count.description"] as MessageFn,
  },
  min_elevator_density: {
    label: m["param.min_elevator_density.label"] as MessageFn,
    description: m["param.min_elevator_density.description"] as MessageFn,
  },
  skip: {
    label: m["param.skip.label"] as MessageFn,
    description: m["param.skip.description"] as MessageFn,
  },
  stop_count: {
    label: m["param.stop_count.label"] as MessageFn,
    description: m["param.stop_count.description"] as MessageFn,
  },
  length_interval: {
    label: m["param.length_interval.label"] as MessageFn,
    description: m["param.length_interval.description"] as MessageFn,
  },
  min_stops: {
    label: m["param.min_stops.label"] as MessageFn,
    description: m["param.min_stops.description"] as MessageFn,
  },
  min_stops_ratio: {
    label: m["param.min_stops_ratio.label"] as MessageFn,
    description: m["param.min_stops_ratio.description"] as MessageFn,
  },
  existing_reuse_balance: {
    label: m["param.existing_reuse_balance.label"] as MessageFn,
    description: m["param.existing_reuse_balance.description"] as MessageFn,
  },
  allow_span_extension: {
    label: m["param.allow_span_extension.label"] as MessageFn,
    description: m["param.allow_span_extension.description"] as MessageFn,
  },
  max_elevator_stop_gap: {
    label: m["param.max_elevator_stop_gap.label"] as MessageFn,
    description: m["param.max_elevator_stop_gap.description"] as MessageFn,
  },
  min_elevator_height: {
    label: m["param.min_elevator_height.label"] as MessageFn,
    description: m["param.min_elevator_height.description"] as MessageFn,
  },
  min_elevator_stop_count: {
    label: m["param.min_elevator_stop_count.label"] as MessageFn,
    description: m["param.min_elevator_stop_count.description"] as MessageFn,
  },
  allow_incomplete: {
    label: m["param.allow_incomplete.label"] as MessageFn,
    description: m["param.allow_incomplete.description"] as MessageFn,
  },
  balanced_growth: {
    label: m["param.balanced_growth.label"] as MessageFn,
    description: m["param.balanced_growth.description"] as MessageFn,
  },
  expand_elevator: {
    label: m["param.expand_elevator.label"] as MessageFn,
    description: m["param.expand_elevator.description"] as MessageFn,
  },
  max_compactness: {
    label: m["param.max_compactness.label"] as MessageFn,
    description: m["param.max_compactness.description"] as MessageFn,
  },
};

// Nested-strategy slot descriptions, keyed by `NestedSlot.slot_id` — same shape as `paramI18n`
// but for a slot rather than a param, since a slot has its own explanatory text independent of
// whichever strategy currently fills it.
export const nestedSlotI18n: Record<string, { description: MessageFn }> = {
  merge_target: {
    description: m["quality.nested_slot.merge_target.description"] as MessageFn,
  },
  loop_seed_target: {
    description: m["quality.nested_slot.loop_seed_target.description"] as MessageFn,
  },
};

// Labels for individual option values of Enum-kind params, keyed by `${paramId}.${value}`.
export const paramOptionI18n: Record<string, MessageFn> = {
  "expand_elevator.forbidden": m["param.expand_elevator.option.forbidden"] as MessageFn,
  "expand_elevator.discouraged": m["param.expand_elevator.option.discouraged"] as MessageFn,
  "expand_elevator.indifferent": m["param.expand_elevator.option.indifferent"] as MessageFn,
  "expand_elevator.preferred": m["param.expand_elevator.option.preferred"] as MessageFn,
  "expand_elevator.required": m["param.expand_elevator.option.required"] as MessageFn,
  "target_mode.largest": m["param.target_mode.option.largest"] as MessageFn,
  "target_mode.smallest": m["param.target_mode.option.smallest"] as MessageFn,
  "target_mode.random": m["param.target_mode.option.random"] as MessageFn,
  "target_mode.prefer_needy": m["param.target_mode.option.prefer_needy"] as MessageFn,
  "connection_mode.passage": m["param.connection_mode.option.passage"] as MessageFn,
  "connection_mode.one_way": m["param.connection_mode.option.one_way"] as MessageFn,
  "direction_mode.two_way": m["param.direction_mode.option.two_way"] as MessageFn,
  "direction_mode.one_way": m["param.direction_mode.option.one_way"] as MessageFn,
  "region_class.all": m["param.region_class.option.all"] as MessageFn,
  "region_class.path": m["param.region_class.option.path"] as MessageFn,
  "region_class.alternative": m["param.region_class.option.alternative"] as MessageFn,
  "region_class.unreachable": m["param.region_class.option.unreachable"] as MessageFn,
  "region_class.trap": m["param.region_class.option.trap"] as MessageFn,
  "merge_priority.smallest": m["param.merge_priority.option.smallest"] as MessageFn,
  "merge_priority.largest": m["param.merge_priority.option.largest"] as MessageFn,
  "merge_priority.random": m["param.merge_priority.option.random"] as MessageFn,
  "selection_mode.random": m["param.selection_mode.option.random"] as MessageFn,
  "selection_mode.shortest": m["param.selection_mode.option.shortest"] as MessageFn,
  "selection_mode.longest": m["param.selection_mode.option.longest"] as MessageFn,
  "vertical_passage_priority.prioritized": m["param.vertical_passage_priority.option.prioritized"] as MessageFn,
  "vertical_passage_priority.neutral": m["param.vertical_passage_priority.option.neutral"] as MessageFn,
  "vertical_passage_priority.protected": m["param.vertical_passage_priority.option.protected"] as MessageFn,
  "sample_mode.count": m["param.sample_mode.option.count"] as MessageFn,
  "sample_mode.percent": m["param.sample_mode.option.percent"] as MessageFn,
  "waypoint.start": m["param.waypoint.option.start"] as MessageFn,
  "waypoint.finish": m["param.waypoint.option.finish"] as MessageFn,
  "waypoint.any": m["param.waypoint.option.any"] as MessageFn,
  "edge.entry_only": m["param.edge.option.entry_only"] as MessageFn,
  "edge.entry_or_exit": m["param.edge.option.entry_or_exit"] as MessageFn,
  "edge_hub.entry": m["param.edge_hub.option.entry"] as MessageFn,
  "edge_hub.exit": m["param.edge_hub.option.exit"] as MessageFn,
  "edge_hub.entry_or_exit": m["param.edge_hub.option.entry_or_exit"] as MessageFn,
  "edge_split.entry": m["param.edge_split.option.entry"] as MessageFn,
  "edge_split.exit": m["param.edge_split.option.exit"] as MessageFn,
  "edge_split.entry_or_exit": m["param.edge_split.option.entry_or_exit"] as MessageFn,
  "own_edge.entry": m["param.own_edge.option.entry"] as MessageFn,
  "own_edge.exit": m["param.own_edge.option.exit"] as MessageFn,
  "own_edge.entry_or_exit": m["param.own_edge.option.entry_or_exit"] as MessageFn,
  "other_edge.entry": m["param.other_edge.option.entry"] as MessageFn,
  "other_edge.exit": m["param.other_edge.option.exit"] as MessageFn,
  "other_edge.entry_or_exit": m["param.other_edge.option.entry_or_exit"] as MessageFn,
  "priority.random": m["param.priority.option.random"] as MessageFn,
  "priority.problematic": m["param.priority.option.problematic"] as MessageFn,
  "priority.most_voluminous": m["param.priority.option.most_voluminous"] as MessageFn,
  "priority.least_voluminous": m["param.priority.option.least_voluminous"] as MessageFn,
  "priority.most_connected": m["param.priority.option.most_connected"] as MessageFn,
  "priority.least_connected": m["param.priority.option.least_connected"] as MessageFn,
  "edge_scope.split_only": m["param.edge_scope.option.split_only"] as MessageFn,
  "edge_scope.other_only": m["param.edge_scope.option.other_only"] as MessageFn,
  "edge_scope.any": m["param.edge_scope.option.any"] as MessageFn,
  "src_mode.random": m["param.src_mode.option.random"] as MessageFn,
  "src_mode.dead_end_priority": m["param.src_mode.option.dead_end_priority"] as MessageFn,
  "comparison.lt": m["param.comparison.option.lt"] as MessageFn,
  "comparison.gt": m["param.comparison.option.gt"] as MessageFn,
  "comparison.le": m["param.comparison.option.le"] as MessageFn,
  "comparison.ge": m["param.comparison.option.ge"] as MessageFn,
  "comparison.eq": m["param.comparison.option.eq"] as MessageFn,
  "cycle_kind.any": m["param.cycle_kind.option.any"] as MessageFn,
  "cycle_kind.two_way": m["param.cycle_kind.option.two_way"] as MessageFn,
  "cycle_kind.one_way": m["param.cycle_kind.option.one_way"] as MessageFn,
  "floor_mode.ignore": m["param.floor_mode.option.ignore"] as MessageFn,
  "floor_mode.as_coordinate": m["param.floor_mode.option.as_coordinate"] as MessageFn,
  "floor_mode.same_floor_only": m["param.floor_mode.option.same_floor_only"] as MessageFn,
  "floor_scope.whole_maze": m["param.floor_scope.option.whole_maze"] as MessageFn,
  "floor_scope.per_floor": m["param.floor_scope.option.per_floor"] as MessageFn,
  "entry_pick.random": m["param.entry_pick.option.random"] as MessageFn,
  "entry_pick.farthest_from_random": m["param.entry_pick.option.farthest_from_random"] as MessageFn,
  "direction.incoming": m["param.direction.option.incoming"] as MessageFn,
  "direction.outgoing": m["param.direction.option.outgoing"] as MessageFn,
  "direction.bidirectional": m["param.direction.option.bidirectional"] as MessageFn,
  "direction.any": m["param.direction.option.any"] as MessageFn,
  "passage_type.any": m["param.passage_type.option.any"] as MessageFn,
  "passage_type.two_way": m["param.passage_type.option.two_way"] as MessageFn,
  "passage_type.one_way": m["param.passage_type.option.one_way"] as MessageFn,
  "passage_type.one_way_down": m["param.passage_type.option.one_way_down"] as MessageFn,
  "passage_type.one_way_up": m["param.passage_type.option.one_way_up"] as MessageFn,
  "split_teleport_direction.incoming": m["param.split_teleport_direction.option.incoming"] as MessageFn,
  "split_teleport_direction.outgoing": m["param.split_teleport_direction.option.outgoing"] as MessageFn,
  "split_teleport_direction.bidirectional": m["param.split_teleport_direction.option.bidirectional"] as MessageFn,
  "split_teleport_direction.any": m["param.split_teleport_direction.option.any"] as MessageFn,
  "selection.random": m["param.selection.option.random"] as MessageFn,
  "selection.most_connected": m["param.selection.option.most_connected"] as MessageFn,
  "selection.least_connected": m["param.selection.option.least_connected"] as MessageFn,
  "selection.merge": m["param.selection.option.merge"] as MessageFn,
};

// Explanations for individual option values of Enum-kind params, shown under the param's
// own description in expanded detail views. Keyed the same way as `paramOptionI18n`.
export const paramOptionExplanationI18n: Record<string, MessageFn> = {
  "expand_elevator.forbidden": m["param.expand_elevator.option.forbidden.explanation"] as MessageFn,
  "expand_elevator.discouraged": m["param.expand_elevator.option.discouraged.explanation"] as MessageFn,
  "expand_elevator.indifferent": m["param.expand_elevator.option.indifferent.explanation"] as MessageFn,
  "expand_elevator.preferred": m["param.expand_elevator.option.preferred.explanation"] as MessageFn,
  "expand_elevator.required": m["param.expand_elevator.option.required.explanation"] as MessageFn,
  "passage_type.any": m["param.passage_type.option.any.explanation"] as MessageFn,
  "passage_type.two_way": m["param.passage_type.option.two_way.explanation"] as MessageFn,
  "passage_type.one_way": m["param.passage_type.option.one_way.explanation"] as MessageFn,
  "passage_type.one_way_down": m["param.passage_type.option.one_way_down.explanation"] as MessageFn,
  "passage_type.one_way_up": m["param.passage_type.option.one_way_up.explanation"] as MessageFn,
  "target_mode.largest": m["param.target_mode.option.largest.explanation"] as MessageFn,
  "target_mode.smallest": m["param.target_mode.option.smallest.explanation"] as MessageFn,
  "target_mode.random": m["param.target_mode.option.random.explanation"] as MessageFn,
  "target_mode.prefer_needy": m["param.target_mode.option.prefer_needy.explanation"] as MessageFn,
  "connection_mode.passage": m["param.connection_mode.option.passage.explanation"] as MessageFn,
  "connection_mode.one_way": m["param.connection_mode.option.one_way.explanation"] as MessageFn,
  "direction_mode.two_way": m["param.direction_mode.option.two_way.explanation"] as MessageFn,
  "direction_mode.one_way": m["param.direction_mode.option.one_way.explanation"] as MessageFn,
  "region_class.all": m["param.region_class.option.all.explanation"] as MessageFn,
  "region_class.path": m["param.region_class.option.path.explanation"] as MessageFn,
  "region_class.alternative": m["param.region_class.option.alternative.explanation"] as MessageFn,
  "region_class.unreachable": m["param.region_class.option.unreachable.explanation"] as MessageFn,
  "region_class.trap": m["param.region_class.option.trap.explanation"] as MessageFn,
  "merge_priority.smallest": m["param.merge_priority.option.smallest.explanation"] as MessageFn,
  "merge_priority.largest": m["param.merge_priority.option.largest.explanation"] as MessageFn,
  "merge_priority.random": m["param.merge_priority.option.random.explanation"] as MessageFn,
  "selection_mode.random": m["param.selection_mode.option.random.explanation"] as MessageFn,
  "selection_mode.shortest": m["param.selection_mode.option.shortest.explanation"] as MessageFn,
  "selection_mode.longest": m["param.selection_mode.option.longest.explanation"] as MessageFn,
  "vertical_passage_priority.prioritized": m["param.vertical_passage_priority.option.prioritized.explanation"] as MessageFn,
  "vertical_passage_priority.neutral": m["param.vertical_passage_priority.option.neutral.explanation"] as MessageFn,
  "vertical_passage_priority.protected": m["param.vertical_passage_priority.option.protected.explanation"] as MessageFn,
  "sample_mode.count": m["param.sample_mode.option.count.explanation"] as MessageFn,
  "sample_mode.percent": m["param.sample_mode.option.percent.explanation"] as MessageFn,
  "src_mode.random": m["param.src_mode.option.random.explanation"] as MessageFn,
  "src_mode.dead_end_priority": m["param.src_mode.option.dead_end_priority.explanation"] as MessageFn,
  "waypoint.start": m["param.waypoint.option.start.explanation"] as MessageFn,
  "waypoint.finish": m["param.waypoint.option.finish.explanation"] as MessageFn,
  "waypoint.any": m["param.waypoint.option.any.explanation"] as MessageFn,
  "edge.entry_only": m["param.edge.option.entry_only.explanation"] as MessageFn,
  "edge.entry_or_exit": m["param.edge.option.entry_or_exit.explanation"] as MessageFn,
  "edge_hub.entry": m["param.edge_hub.option.entry.explanation"] as MessageFn,
  "edge_hub.exit": m["param.edge_hub.option.exit.explanation"] as MessageFn,
  "edge_hub.entry_or_exit": m["param.edge_hub.option.entry_or_exit.explanation"] as MessageFn,
  "edge_split.entry": m["param.edge_split.option.entry.explanation"] as MessageFn,
  "edge_split.exit": m["param.edge_split.option.exit.explanation"] as MessageFn,
  "edge_split.entry_or_exit": m["param.edge_split.option.entry_or_exit.explanation"] as MessageFn,
  "own_edge.entry": m["param.own_edge.option.entry.explanation"] as MessageFn,
  "own_edge.exit": m["param.own_edge.option.exit.explanation"] as MessageFn,
  "own_edge.entry_or_exit": m["param.own_edge.option.entry_or_exit.explanation"] as MessageFn,
  "other_edge.entry": m["param.other_edge.option.entry.explanation"] as MessageFn,
  "other_edge.exit": m["param.other_edge.option.exit.explanation"] as MessageFn,
  "other_edge.entry_or_exit": m["param.other_edge.option.entry_or_exit.explanation"] as MessageFn,
  "priority.random": m["param.priority.option.random.explanation"] as MessageFn,
  "priority.problematic": m["param.priority.option.problematic.explanation"] as MessageFn,
  "priority.most_voluminous": m["param.priority.option.most_voluminous.explanation"] as MessageFn,
  "priority.least_voluminous": m["param.priority.option.least_voluminous.explanation"] as MessageFn,
  "priority.most_connected": m["param.priority.option.most_connected.explanation"] as MessageFn,
  "priority.least_connected": m["param.priority.option.least_connected.explanation"] as MessageFn,
  "edge_scope.split_only": m["param.edge_scope.option.split_only.explanation"] as MessageFn,
  "edge_scope.other_only": m["param.edge_scope.option.other_only.explanation"] as MessageFn,
  "edge_scope.any": m["param.edge_scope.option.any.explanation"] as MessageFn,
  "cycle_kind.any": m["param.cycle_kind.option.any.explanation"] as MessageFn,
  "cycle_kind.two_way": m["param.cycle_kind.option.two_way.explanation"] as MessageFn,
  "cycle_kind.one_way": m["param.cycle_kind.option.one_way.explanation"] as MessageFn,
  "floor_mode.ignore": m["param.floor_mode.option.ignore.explanation"] as MessageFn,
  "floor_mode.as_coordinate": m["param.floor_mode.option.as_coordinate.explanation"] as MessageFn,
  "floor_mode.same_floor_only": m["param.floor_mode.option.same_floor_only.explanation"] as MessageFn,
  "floor_scope.whole_maze": m["param.floor_scope.option.whole_maze.explanation"] as MessageFn,
  "floor_scope.per_floor": m["param.floor_scope.option.per_floor.explanation"] as MessageFn,
  "entry_pick.random": m["param.entry_pick.option.random.explanation"] as MessageFn,
  "entry_pick.farthest_from_random": m["param.entry_pick.option.farthest_from_random.explanation"] as MessageFn,
  "direction.incoming": m["param.direction.option.incoming.explanation"] as MessageFn,
  "direction.outgoing": m["param.direction.option.outgoing.explanation"] as MessageFn,
  "direction.bidirectional": m["param.direction.option.bidirectional.explanation"] as MessageFn,
  "direction.any": m["param.direction.option.any.explanation"] as MessageFn,
  "split_teleport_direction.incoming": m["param.split_teleport_direction.option.incoming.explanation"] as MessageFn,
  "split_teleport_direction.outgoing": m["param.split_teleport_direction.option.outgoing.explanation"] as MessageFn,
  "split_teleport_direction.bidirectional": m["param.split_teleport_direction.option.bidirectional.explanation"] as MessageFn,
  "split_teleport_direction.any": m["param.split_teleport_direction.option.any.explanation"] as MessageFn,
  "selection.random": m["param.selection.option.random.explanation"] as MessageFn,
  "selection.most_connected": m["param.selection.option.most_connected.explanation"] as MessageFn,
  "selection.least_connected": m["param.selection.option.least_connected.explanation"] as MessageFn,
  "selection.merge": m["param.selection.option.merge.explanation"] as MessageFn,
};

export function resolveParamLabel(id: string, fallback: string): string {
  return paramI18n[id]?.label() ?? fallback;
}

// Per-strategy override for a shared param's description (e.g. `priority`, reused by
// teleport/one-way/split strategies whose removal target differs) — checked before the generic
// `paramI18n` entry. `contextId` is the owning strategy's id.
const paramDescriptionOverrideI18n: Record<string, MessageFn> = {
  "priority.split_route_cut": m["param.priority.split_route_cut.description"] as MessageFn,
  "selection.remove_split": m["param.selection.remove_split.description"] as MessageFn,
};

export function resolveParamDescription(id: string, contextId?: string): string | undefined {
  const override = contextId ? paramDescriptionOverrideI18n[`${id}.${contextId}`] : undefined;
  return override?.() ?? paramI18n[id]?.description();
}

export function resolveParamOptionLabel(paramId: string, value: string): string {
  return paramOptionI18n[`${paramId}.${value}`]?.() ?? value;
}

// Per-strategy override for a shared param's option explanations, same rationale as
// `paramDescriptionOverrideI18n` — checked before the generic `paramOptionExplanationI18n` entry.
const paramOptionExplanationOverrideI18n: Record<string, MessageFn> = {
  "priority.random.split_route_cut": m["param.priority.split_route_cut.option.random.explanation"] as MessageFn,
  "priority.problematic.split_route_cut": m["param.priority.split_route_cut.option.problematic.explanation"] as MessageFn,
  "selection.random.remove_split": m["param.selection.remove_split.option.random.explanation"] as MessageFn,
  "selection.most_connected.remove_split": m["param.selection.remove_split.option.most_connected.explanation"] as MessageFn,
  "selection.least_connected.remove_split": m["param.selection.remove_split.option.least_connected.explanation"] as MessageFn,
  "selection.merge.remove_split": m["param.selection.remove_split.option.merge.explanation"] as MessageFn,
};

export function resolveParamOptionExplanation(paramId: string, value: string, contextId?: string): string | undefined {
  const override = contextId ? paramOptionExplanationOverrideI18n[`${paramId}.${value}.${contextId}`] : undefined;
  return override?.() ?? paramOptionExplanationI18n[`${paramId}.${value}`]?.();
}

export function resolveNestedSlotDescription(slotId: string): string | undefined {
  return nestedSlotI18n[slotId]?.description();
}

