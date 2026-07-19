import * as m from "~/paraglide/messages";

type MessageFn = () => string;

export const checkI18n: Record<string, { label: MessageFn; description: MessageFn }> = {
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
};

export const issueI18n: Record<string, { label: MessageFn; description: MessageFn }> = {
  missing_endpoints: {
    label: m["issue.missing_endpoints.label"] as MessageFn,
    description: m["issue.missing_endpoints.description"] as MessageFn,
  },
  unreachable_finish: {
    label: m["issue.unreachable_finish.label"] as MessageFn,
    description: m["issue.unreachable_finish.description"] as MessageFn,
  },
  missing_loops: {
    label: m["issue.missing_loops.label"] as MessageFn,
    description: m["issue.missing_loops.description"] as MessageFn,
  },
  invalid_loop: {
    label: m["issue.invalid_loop.label"] as MessageFn,
    description: m["issue.invalid_loop.description"] as MessageFn,
  },
  invalid_loop_group: {
    label: m["issue.invalid_loop_group.label"] as MessageFn,
    description: m["issue.invalid_loop_group.description"] as MessageFn,
  },
  excessive_scc_count: {
    label: m["issue.excessive_scc_count.label"] as MessageFn,
    description: m["issue.excessive_scc_count.description"] as MessageFn,
  },
  region_needs_expansion: {
    label: m["issue.region_needs_expansion.label"] as MessageFn,
    description: m["issue.region_needs_expansion.description"] as MessageFn,
  },
  region_needs_shrink: {
    label: m["issue.region_needs_shrink.label"] as MessageFn,
    description: m["issue.region_needs_shrink.description"] as MessageFn,
  },
  missing_regions: {
    label: m["issue.missing_regions.label"] as MessageFn,
    description: m["issue.missing_regions.description"] as MessageFn,
  },
  invalid_teleport: {
    label: m["issue.invalid_teleport.label"] as MessageFn,
    description: m["issue.invalid_teleport.description"] as MessageFn,
  },
  invalid_teleport_group: {
    label: m["issue.invalid_teleport_group.label"] as MessageFn,
    description: m["issue.invalid_teleport_group.description"] as MessageFn,
  },
  invalid_one_way: {
    label: m["issue.invalid_one_way.label"] as MessageFn,
    description: m["issue.invalid_one_way.description"] as MessageFn,
  },
  invalid_one_way_group: {
    label: m["issue.invalid_one_way_group.label"] as MessageFn,
    description: m["issue.invalid_one_way_group.description"] as MessageFn,
  },
  missing_one_ways: {
    label: m["issue.missing_one_ways.label"] as MessageFn,
    description: m["issue.missing_one_ways.description"] as MessageFn,
  },
};

export const NO_FIX_STRATEGY_ID = "no_fix";

export const strategyI18n: Record<string, { label: MessageFn; description: MessageFn }> = {
  no_fix: {
    label: m["strategy.no_fix.label"] as MessageFn,
    description: m["strategy.no_fix.description"] as MessageFn,
  },
  random_endpoints: {
    label: m["strategy.random_endpoints.label"] as MessageFn,
    description: m["strategy.random_endpoints.description"] as MessageFn,
  },
  farthest_endpoints: {
    label: m["strategy.farthest_endpoints.label"] as MessageFn,
    description: m["strategy.farthest_endpoints.description"] as MessageFn,
  },
  scored_endpoints: {
    label: m["strategy.scored_endpoints.label"] as MessageFn,
    description: m["strategy.scored_endpoints.description"] as MessageFn,
  },
  invalid_loop_random: {
    label: m["strategy.invalid_loop_random.label"] as MessageFn,
    description: m["strategy.invalid_loop_random.description"] as MessageFn,
  },
  invalid_loop_scored: {
    label: m["strategy.invalid_loop_scored.label"] as MessageFn,
    description: m["strategy.invalid_loop_scored.description"] as MessageFn,
  },
  invalid_loop_group_select: {
    label: m["strategy.invalid_loop_group_select.label"] as MessageFn,
    description: m["strategy.invalid_loop_group_select.description"] as MessageFn,
  },
  missing_loops_random: {
    label: m["strategy.missing_loops_random.label"] as MessageFn,
    description: m["strategy.missing_loops_random.description"] as MessageFn,
  },
  expand_region_passage: {
    label: m["strategy.expand_region_passage.label"] as MessageFn,
    description: m["strategy.expand_region_passage.description"] as MessageFn,
  },
  teleport_region_merge: {
    label: m["strategy.teleport_region_merge.label"] as MessageFn,
    description: m["strategy.teleport_region_merge.description"] as MessageFn,
  },
  region_shrink_split: {
    label: m["strategy.region_shrink_split.label"] as MessageFn,
    description: m["strategy.region_shrink_split.description"] as MessageFn,
  },
  missing_regions: {
    label: m["strategy.missing_regions.label"] as MessageFn,
    description: m["strategy.missing_regions.description"] as MessageFn,
  },
  reduce_scc_count: {
    label: m["strategy.reduce_scc_count.label"] as MessageFn,
    description: m["strategy.reduce_scc_count.description"] as MessageFn,
  },
  remove_teleport: {
    label: m["strategy.remove_teleport.label"] as MessageFn,
    description: m["strategy.remove_teleport.description"] as MessageFn,
  },
  teleport_group_proximity: {
    label: m["strategy.teleport_group_proximity.label"] as MessageFn,
    description: m["strategy.teleport_group_proximity.description"] as MessageFn,
  },
  weighted_region_merge: {
    label: m["strategy.weighted_region_merge.label"] as MessageFn,
    description: m["strategy.weighted_region_merge.description"] as MessageFn,
  },
  one_way_to_passage: {
    label: m["strategy.one_way_to_passage.label"] as MessageFn,
    description: m["strategy.one_way_to_passage.description"] as MessageFn,
  },
  one_way_to_wall: {
    label: m["strategy.one_way_to_wall.label"] as MessageFn,
    description: m["strategy.one_way_to_wall.description"] as MessageFn,
  },
  one_way_group_select: {
    label: m["strategy.one_way_group_select.label"] as MessageFn,
    description: m["strategy.one_way_group_select.description"] as MessageFn,
  },
  missing_one_ways_from_passage: {
    label: m["strategy.missing_one_ways_from_passage.label"] as MessageFn,
    description: m["strategy.missing_one_ways_from_passage.description"] as MessageFn,
  },
  missing_one_ways_from_wall: {
    label: m["strategy.missing_one_ways_from_wall.label"] as MessageFn,
    description: m["strategy.missing_one_ways_from_wall.description"] as MessageFn,
  },
};

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
  short_overlap_weight: {
    label: m["param.short_overlap_weight.label"] as MessageFn,
    description: m["param.short_overlap_weight.description"] as MessageFn,
  },
  other_overlap_weight: {
    label: m["param.other_overlap_weight.label"] as MessageFn,
    description: m["param.other_overlap_weight.description"] as MessageFn,
  },
  reserve_percent: {
    label: m["param.reserve_percent.label"] as MessageFn,
    description: m["param.reserve_percent.description"] as MessageFn,
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
};

// Nested-strategy slot descriptions, keyed by `NestedSlot.slot_id` — same shape as `paramI18n`
// but for a slot rather than a param, since a slot has its own explanatory text independent of
// whichever strategy currently fills it.
export const nestedSlotI18n: Record<string, { description: MessageFn }> = {
  merge_target: {
    description: m["quality.nested_slot.merge_target.description"] as MessageFn,
  },
};

// Labels for individual option values of Enum-kind params, keyed by `${paramId}.${value}`.
export const paramOptionI18n: Record<string, MessageFn> = {
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
  "own_edge.entry": m["param.own_edge.option.entry"] as MessageFn,
  "own_edge.exit": m["param.own_edge.option.exit"] as MessageFn,
  "own_edge.entry_or_exit": m["param.own_edge.option.entry_or_exit"] as MessageFn,
  "other_edge.entry": m["param.other_edge.option.entry"] as MessageFn,
  "other_edge.exit": m["param.other_edge.option.exit"] as MessageFn,
  "other_edge.entry_or_exit": m["param.other_edge.option.entry_or_exit"] as MessageFn,
  "priority.random": m["param.priority.option.random"] as MessageFn,
  "priority.problematic": m["param.priority.option.problematic"] as MessageFn,
  "comparison.lt": m["param.comparison.option.lt"] as MessageFn,
  "comparison.gt": m["param.comparison.option.gt"] as MessageFn,
  "comparison.le": m["param.comparison.option.le"] as MessageFn,
  "comparison.ge": m["param.comparison.option.ge"] as MessageFn,
  "comparison.eq": m["param.comparison.option.eq"] as MessageFn,
};

// Explanations for individual option values of Enum-kind params, shown under the param's
// own description in expanded detail views. Keyed the same way as `paramOptionI18n`.
export const paramOptionExplanationI18n: Record<string, MessageFn> = {
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
  "sample_mode.count": m["param.sample_mode.option.count.explanation"] as MessageFn,
  "sample_mode.percent": m["param.sample_mode.option.percent.explanation"] as MessageFn,
  "waypoint.start": m["param.waypoint.option.start.explanation"] as MessageFn,
  "waypoint.finish": m["param.waypoint.option.finish.explanation"] as MessageFn,
  "waypoint.any": m["param.waypoint.option.any.explanation"] as MessageFn,
  "edge.entry_only": m["param.edge.option.entry_only.explanation"] as MessageFn,
  "edge.entry_or_exit": m["param.edge.option.entry_or_exit.explanation"] as MessageFn,
  "edge_hub.entry": m["param.edge_hub.option.entry.explanation"] as MessageFn,
  "edge_hub.exit": m["param.edge_hub.option.exit.explanation"] as MessageFn,
  "edge_hub.entry_or_exit": m["param.edge_hub.option.entry_or_exit.explanation"] as MessageFn,
  "own_edge.entry": m["param.own_edge.option.entry.explanation"] as MessageFn,
  "own_edge.exit": m["param.own_edge.option.exit.explanation"] as MessageFn,
  "own_edge.entry_or_exit": m["param.own_edge.option.entry_or_exit.explanation"] as MessageFn,
  "other_edge.entry": m["param.other_edge.option.entry.explanation"] as MessageFn,
  "other_edge.exit": m["param.other_edge.option.exit.explanation"] as MessageFn,
  "other_edge.entry_or_exit": m["param.other_edge.option.entry_or_exit.explanation"] as MessageFn,
  "priority.random": m["param.priority.option.random.explanation"] as MessageFn,
  "priority.problematic": m["param.priority.option.problematic.explanation"] as MessageFn,
};

export function resolveCheckLabel(id: string, fallback: string): string {
  return checkI18n[id]?.label() ?? fallback;
}

export function resolveCheckDescription(id: string, fallback: string): string {
  return checkI18n[id]?.description() ?? fallback;
}

export function resolveIssueLabel(kind: string): string {
  return issueI18n[kind]?.label() ?? kind;
}

export function resolveIssueDescription(kind: string): string {
  return issueI18n[kind]?.description() ?? "";
}

export function resolveStrategyLabel(id: string): string {
  return strategyI18n[id]?.label() ?? id;
}

export function resolveStrategyDescription(id: string): string {
  return strategyI18n[id]?.description() ?? "";
}

export function resolveParamLabel(id: string, fallback: string): string {
  return paramI18n[id]?.label() ?? fallback;
}

export function resolveParamDescription(id: string): string | undefined {
  return paramI18n[id]?.description();
}

export function resolveParamOptionLabel(paramId: string, value: string): string {
  return paramOptionI18n[`${paramId}.${value}`]?.() ?? value;
}

export function resolveParamOptionExplanation(paramId: string, value: string): string | undefined {
  return paramOptionExplanationI18n[`${paramId}.${value}`]?.();
}

export function resolveNestedSlotDescription(slotId: string): string | undefined {
  return nestedSlotI18n[slotId]?.description();
}
