import * as m from "~/paraglide/messages";

type MessageFn = () => string;

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
  missing_teleports: {
    label: m["issue.missing_teleports.label"] as MessageFn,
    description: m["issue.missing_teleports.description"] as MessageFn,
  },
  invalid_split_tile: {
    label: m["issue.invalid_split_tile.label"] as MessageFn,
    description: m["issue.invalid_split_tile.description"] as MessageFn,
  },
  invalid_split_tile_group: {
    label: m["issue.invalid_split_tile_group.label"] as MessageFn,
    description: m["issue.invalid_split_tile_group.description"] as MessageFn,
  },
  missing_split_tiles: {
    label: m["issue.missing_split_tiles.label"] as MessageFn,
    description: m["issue.missing_split_tiles.description"] as MessageFn,
  },
  invalid_split_node: {
    label: m["issue.invalid_split_node.label"] as MessageFn,
    description: m["issue.invalid_split_node.description"] as MessageFn,
  },
  invalid_split_node_connection: {
    label: m["issue.invalid_split_node_connection.label"] as MessageFn,
    description: m["issue.invalid_split_node_connection.description"] as MessageFn,
  },
  invalid_split_node_connection_group: {
    label: m["issue.invalid_split_node_connection_group.label"] as MessageFn,
    description: m["issue.invalid_split_node_connection_group.description"] as MessageFn,
  },
  invalid_split_node_group: {
    label: m["issue.invalid_split_node_group.label"] as MessageFn,
    description: m["issue.invalid_split_node_group.description"] as MessageFn,
  },
  invalid_split_route: {
    label: m["issue.invalid_split_route.label"] as MessageFn,
    description: m["issue.invalid_split_route.description"] as MessageFn,
  },
  missing_vertical_passages: {
    label: m["issue.missing_vertical_passages.label"] as MessageFn,
    description: m["issue.missing_vertical_passages.description"] as MessageFn,
  },
  invalid_vertical_passage: {
    label: m["issue.invalid_vertical_passage.label"] as MessageFn,
    description: m["issue.invalid_vertical_passage.description"] as MessageFn,
  },
  invalid_vertical_passage_group: {
    label: m["issue.invalid_vertical_passage_group.label"] as MessageFn,
    description: m["issue.invalid_vertical_passage_group.description"] as MessageFn,
  },
  invalid_elevator: {
    label: m["issue.invalid_elevator.label"] as MessageFn,
    description: m["issue.invalid_elevator.description"] as MessageFn,
  },
  invalid_elevator_group: {
    label: m["issue.invalid_elevator_group.label"] as MessageFn,
    description: m["issue.invalid_elevator_group.description"] as MessageFn,
  },
  invalid_elevator_stop: {
    label: m["issue.invalid_elevator_stop.label"] as MessageFn,
    description: m["issue.invalid_elevator_stop.description"] as MessageFn,
  },
  invalid_elevator_stop_group: {
    label: m["issue.invalid_elevator_stop_group.label"] as MessageFn,
    description: m["issue.invalid_elevator_stop_group.description"] as MessageFn,
  },
  missing_elevators: {
    label: m["issue.missing_elevators.label"] as MessageFn,
    description: m["issue.missing_elevators.description"] as MessageFn,
  },
};

/** Section grouping for `IssueSelectDialog` only — distinct from `issueI18n`'s full labels,
 * which stay unchanged everywhere else (analytics bubble, RulesColumn, dialog titles, ...). */
export const issueSectionI18n: Record<string, MessageFn> = {
  missing_endpoints: m["issue_select.section.waypoints"] as MessageFn,
  unreachable_finish: m["issue_select.section.waypoints"] as MessageFn,
  missing_one_ways: m["issue_select.section.one_ways"] as MessageFn,
  invalid_one_way: m["issue_select.section.one_ways"] as MessageFn,
  invalid_one_way_group: m["issue_select.section.one_ways"] as MessageFn,
  missing_teleports: m["issue_select.section.teleports"] as MessageFn,
  invalid_teleport: m["issue_select.section.teleports"] as MessageFn,
  invalid_teleport_group: m["issue_select.section.teleports"] as MessageFn,
  missing_loops: m["issue_select.section.loops"] as MessageFn,
  invalid_loop: m["issue_select.section.loops"] as MessageFn,
  invalid_loop_group: m["issue_select.section.loops"] as MessageFn,
  missing_regions: m["issue_select.section.regions"] as MessageFn,
  region_needs_expansion: m["issue_select.section.regions"] as MessageFn,
  region_needs_shrink: m["issue_select.section.regions"] as MessageFn,
  excessive_scc_count: m["issue_select.section.regions"] as MessageFn,
  invalid_split_tile: m["issue_select.section.splits"] as MessageFn,
  invalid_split_tile_group: m["issue_select.section.splits"] as MessageFn,
  missing_split_tiles: m["issue_select.section.splits"] as MessageFn,
  invalid_split_node: m["issue_select.section.splits"] as MessageFn,
  invalid_split_node_connection_group: m["issue_select.section.splits"] as MessageFn,
  invalid_split_node_group: m["issue_select.section.splits"] as MessageFn,
  invalid_split_route: m["issue_select.section.splits"] as MessageFn,
  missing_vertical_passages: m["issue_select.section.vertical_passages"] as MessageFn,
  invalid_vertical_passage_group: m["issue_select.section.vertical_passages"] as MessageFn,
  invalid_elevator: m["issue_select.section.elevators"] as MessageFn,
  invalid_elevator_group: m["issue_select.section.elevators"] as MessageFn,
  invalid_elevator_stop: m["issue_select.section.elevators"] as MessageFn,
  invalid_elevator_stop_group: m["issue_select.section.elevators"] as MessageFn,
  missing_elevators: m["issue_select.section.elevators"] as MessageFn,
};

/** Short item labels for `IssueSelectDialog` only, indented under `issueSectionI18n`'s header —
 * distinct from `issueI18n`'s full labels, which stay unchanged everywhere else. */
export const issueShortLabelI18n: Record<string, MessageFn> = {
  missing_endpoints: m["issue_select.short_label.add"] as MessageFn,
  unreachable_finish: m["issue_select.short_label.validate"] as MessageFn,
  missing_one_ways: m["issue_select.short_label.add"] as MessageFn,
  invalid_one_way: m["issue_select.short_label.validate"] as MessageFn,
  invalid_one_way_group: m["issue_select.short_label.validate_groups"] as MessageFn,
  missing_teleports: m["issue_select.short_label.add"] as MessageFn,
  invalid_teleport: m["issue_select.short_label.validate"] as MessageFn,
  invalid_teleport_group: m["issue_select.short_label.validate_groups"] as MessageFn,
  missing_loops: m["issue_select.short_label.add"] as MessageFn,
  invalid_loop: m["issue_select.short_label.validate"] as MessageFn,
  invalid_loop_group: m["issue_select.short_label.validate_groups"] as MessageFn,
  missing_regions: m["issue_select.short_label.add"] as MessageFn,
  region_needs_expansion: m["issue_select.short_label.expansion"] as MessageFn,
  region_needs_shrink: m["issue_select.short_label.shrink"] as MessageFn,
  excessive_scc_count: m["issue_select.short_label.validate_groups"] as MessageFn,
  invalid_split_tile: m["issue_select.short_label.validate_tile"] as MessageFn,
  invalid_split_tile_group: m["issue_select.short_label.validate_tile_groups"] as MessageFn,
  missing_split_tiles: m["issue_select.short_label.add"] as MessageFn,
  invalid_split_node: m["issue_select.short_label.validate_node"] as MessageFn,
  invalid_split_node_connection_group: m["issue_select.short_label.validate_connection_groups"] as MessageFn,
  invalid_split_node_group: m["issue_select.short_label.validate_node_groups"] as MessageFn,
  invalid_split_route: m["issue_select.short_label.validate_route"] as MessageFn,
  missing_vertical_passages: m["issue_select.short_label.add"] as MessageFn,
  invalid_vertical_passage_group: m["issue_select.short_label.validate_groups"] as MessageFn,
  invalid_elevator: m["issue_select.short_label.validate"] as MessageFn,
  invalid_elevator_group: m["issue_select.short_label.validate_groups"] as MessageFn,
  invalid_elevator_stop: m["issue_select.short_label.validate"] as MessageFn,
  invalid_elevator_stop_group: m["issue_select.short_label.validate_stop_groups"] as MessageFn,
  missing_elevators: m["issue_select.short_label.add"] as MessageFn,
};

export function resolveIssueLabel(kind: string): string {
  return issueI18n[kind]?.label() ?? kind;
}

export function resolveIssueDescription(kind: string): string {
  return issueI18n[kind]?.description() ?? "";
}

/** Section header for `kind` in `IssueSelectDialog`. Falls back to `kind` itself for an
 * unmapped kind, mirroring `resolveIssueLabel`'s fallback. */
export function resolveIssueSection(kind: string): string {
  return issueSectionI18n[kind]?.() ?? kind;
}

/** Short, section-relative label for `kind` in `IssueSelectDialog` (e.g. "Add", "Validate") —
 * distinct from `resolveIssueLabel`'s full label used everywhere else. */
export function resolveIssueShortLabel(kind: string): string {
  return issueShortLabelI18n[kind]?.() ?? resolveIssueLabel(kind);
}

