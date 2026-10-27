import * as m from "~/paraglide/messages";

type MessageFn = () => string;

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
  dead_end_to_passage: {
    label: m["strategy.dead_end_to_passage.label"] as MessageFn,
    description: m["strategy.dead_end_to_passage.description"] as MessageFn,
  },
  dead_end_to_vertical_passage: {
    label: m["strategy.dead_end_to_vertical_passage.label"] as MessageFn,
    description: m["strategy.dead_end_to_vertical_passage.description"] as MessageFn,
  },
  dead_end_to_teleport: {
    label: m["strategy.dead_end_to_teleport.label"] as MessageFn,
    description: m["strategy.dead_end_to_teleport.description"] as MessageFn,
  },
  dead_end_group_select: {
    label: m["strategy.dead_end_group_select.label"] as MessageFn,
    description: m["strategy.dead_end_group_select.description"] as MessageFn,
  },
  missing_loops_random: {
    label: m["strategy.missing_loops_random.label"] as MessageFn,
    description: m["strategy.missing_loops_random.description"] as MessageFn,
  },
  missing_loops_vertical: {
    label: m["strategy.missing_loops_vertical.label"] as MessageFn,
    description: m["strategy.missing_loops_vertical.description"] as MessageFn,
  },
  missing_loops_split: {
    label: m["strategy.missing_loops_split.label"] as MessageFn,
    description: m["strategy.missing_loops_split.description"] as MessageFn,
  },
  missing_loops_teleport: {
    label: m["strategy.missing_loops_teleport.label"] as MessageFn,
    description: m["strategy.missing_loops_teleport.description"] as MessageFn,
  },
  priority_dead_end: {
    label: m["strategy.priority_dead_end.label"] as MessageFn,
    description: m["strategy.priority_dead_end.description"] as MessageFn,
  },
  priority_missing_loops: {
    label: m["strategy.priority_missing_loops.label"] as MessageFn,
    description: m["strategy.priority_missing_loops.description"] as MessageFn,
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
  add_teleport: {
    label: m["strategy.add_teleport.label"] as MessageFn,
    description: m["strategy.add_teleport.description"] as MessageFn,
  },
  teleport_group_select: {
    label: m["strategy.teleport_group_select.label"] as MessageFn,
    description: m["strategy.teleport_group_select.description"] as MessageFn,
  },
  weighted_dead_end: {
    label: m["strategy.weighted_dead_end.label"] as MessageFn,
    description: m["strategy.weighted_dead_end.description"] as MessageFn,
  },
  weighted_region_merge: {
    label: m["strategy.weighted_region_merge.label"] as MessageFn,
    description: m["strategy.weighted_region_merge.description"] as MessageFn,
  },
  priority_region_merge: {
    label: m["strategy.priority_region_merge.label"] as MessageFn,
    description: m["strategy.priority_region_merge.description"] as MessageFn,
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
  missing_teleports: {
    label: m["strategy.missing_teleports.label"] as MessageFn,
    description: m["strategy.missing_teleports.description"] as MessageFn,
  },
  remove_split: {
    label: m["strategy.remove_split.label"] as MessageFn,
    description: m["strategy.remove_split.description"] as MessageFn,
  },
  split_group_select: {
    label: m["strategy.split_group_select.label"] as MessageFn,
    description: m["strategy.split_group_select.description"] as MessageFn,
  },
  add_split: {
    label: m["strategy.add_split.label"] as MessageFn,
    description: m["strategy.add_split.description"] as MessageFn,
  },
  remove_split_node: {
    label: m["strategy.remove_split_node.label"] as MessageFn,
    description: m["strategy.remove_split_node.description"] as MessageFn,
  },
  remove_split_node_connection: {
    label: m["strategy.remove_split_node_connection.label"] as MessageFn,
    description: m["strategy.remove_split_node_connection.description"] as MessageFn,
  },
  split_node_connection_group_select: {
    label: m["strategy.split_node_connection_group_select.label"] as MessageFn,
    description: m["strategy.split_node_connection_group_select.description"] as MessageFn,
  },
  split_node_group_select: {
    label: m["strategy.split_node_group_select.label"] as MessageFn,
    description: m["strategy.split_node_group_select.description"] as MessageFn,
  },
  split_route_cut: {
    label: m["strategy.split_route_cut.label"] as MessageFn,
    description: m["strategy.split_route_cut.description"] as MessageFn,
  },
  add_vertical_passage: {
    label: m["strategy.add_vertical_passage.label"] as MessageFn,
    description: m["strategy.add_vertical_passage.description"] as MessageFn,
  },
  remove_vertical_passage: {
    label: m["strategy.remove_vertical_passage.label"] as MessageFn,
    description: m["strategy.remove_vertical_passage.description"] as MessageFn,
  },
  vertical_passage_group_select: {
    label: m["strategy.vertical_passage_group_select.label"] as MessageFn,
    description: m["strategy.vertical_passage_group_select.description"] as MessageFn,
  },
  remove_elevator: {
    label: m["strategy.remove_elevator.label"] as MessageFn,
    description: m["strategy.remove_elevator.description"] as MessageFn,
  },
  replace_elevator_with_passages: {
    label: m["strategy.replace_elevator_with_passages.label"] as MessageFn,
    description: m["strategy.replace_elevator_with_passages.description"] as MessageFn,
  },
  elevator_group_select: {
    label: m["strategy.elevator_group_select.label"] as MessageFn,
    description: m["strategy.elevator_group_select.description"] as MessageFn,
  },
  elevator_stop_group_select: {
    label: m["strategy.elevator_stop_group_select.label"] as MessageFn,
    description: m["strategy.elevator_stop_group_select.description"] as MessageFn,
  },
  remove_elevator_stop: {
    label: m["strategy.remove_elevator_stop.label"] as MessageFn,
    description: m["strategy.remove_elevator_stop.description"] as MessageFn,
  },
  add_elevator: {
    label: m["strategy.add_elevator.label"] as MessageFn,
    description: m["strategy.add_elevator.description"] as MessageFn,
  },
  add_elevator_stop: {
    label: m["strategy.add_elevator_stop.label"] as MessageFn,
    description: m["strategy.add_elevator_stop.description"] as MessageFn,
  },
  add_elevator_height_stop: {
    label: m["strategy.add_elevator_height_stop.label"] as MessageFn,
    description: m["strategy.add_elevator_height_stop.description"] as MessageFn,
  },
  add_elevator_stop_count: {
    label: m["strategy.add_elevator_stop_count.label"] as MessageFn,
    description: m["strategy.add_elevator_stop_count.description"] as MessageFn,
  },
  add_elevator_stop_for_gap: {
    label: m["strategy.add_elevator_stop_for_gap.label"] as MessageFn,
    description: m["strategy.add_elevator_stop_for_gap.description"] as MessageFn,
  },
  vertical_passage_region_merge: {
    label: m["strategy.vertical_passage_region_merge.label"] as MessageFn,
    description: m["strategy.vertical_passage_region_merge.description"] as MessageFn,
  },
  elevator_region_merge: {
    label: m["strategy.elevator_region_merge.label"] as MessageFn,
    description: m["strategy.elevator_region_merge.description"] as MessageFn,
  },
  cross_element_group_select: {
    label: m["strategy.cross_element_group_select.label"] as MessageFn,
    description: m["strategy.cross_element_group_select.description"] as MessageFn,
  },
  dead_end_to_split: {
    label: m["strategy.dead_end_to_split.label"] as MessageFn,
    description: m["strategy.dead_end_to_split.description"] as MessageFn,
  },
};

export function resolveStrategyLabel(id: string): string {
  return strategyI18n[id]?.label() ?? id;
}

// `cross_element_group_select` (GitHub issue #376) has one nested slot per element type, so the
// generic "Removal strategy" label is ambiguous there — each slot gets a type-specific label
// ("Teleport removal strategy", ...). Keyed by the slot's own `slot_id`, which is unique to this
// strategy; the underlying per-type removal strategies keep their own global labels unchanged.
const CROSS_ELEMENT_SLOT_LABELS: Record<string, MessageFn> = {
  teleport_fix: m["quality.nested_strategy.cross_element.teleport_label"] as MessageFn,
  one_way_fix: m["quality.nested_strategy.cross_element.one_way_label"] as MessageFn,
  vertical_passage_fix: m["quality.nested_strategy.cross_element.vertical_passage_label"] as MessageFn,
  elevator_stop_fix: m["quality.nested_strategy.cross_element.elevator_stop_label"] as MessageFn,
  split_fix: m["quality.nested_strategy.cross_element.split_label"] as MessageFn,
};

/** Label for a nested-strategy slot, chosen by the slot's own issue `kind` -- "merge" for a
 * region-expansion slot (the nested strategy merges regions), "repair" for a dead-end slot,
 * "add-elevator" for
 * `AddElevatorStopStrategy`'s slot (GitHub issue #408 — deliberately not "removal", the nested
 * strategy there adds a new elevator, it doesn't remove anything), "removal" for every other kind
 * (the nested strategy removes the flagged element). `slotId`, when it names one of
 * `cross_element_group_select`'s per-type slots, wins over the generic label. */
export function resolveNestedStrategyLabel(kind: string, slotId?: string): string {
  if (slotId && CROSS_ELEMENT_SLOT_LABELS[slotId]) return CROSS_ELEMENT_SLOT_LABELS[slotId]();
  if (kind === "region_needs_expansion") return m["quality.nested_strategy.merge_label"]();
  if (kind === "invalid_dead_end") return m["quality.nested_strategy.fix_label"]();
  if (kind === "missing_elevators") return m["quality.nested_strategy.add_elevator_label"]();
  return m["quality.nested_strategy.removal_label"]();
}

export function resolveStrategyDescription(id: string): string {
  return strategyI18n[id]?.description() ?? "";
}
