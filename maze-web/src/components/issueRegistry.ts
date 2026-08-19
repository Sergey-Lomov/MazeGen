import * as m from "~/paraglide/messages";
import { resolveParamOptionLabel, resolveCheckDescription } from "./features/qualityI18n";
import type { IssueDto } from "../wasm/types";

export type IssueSeverity = "warning" | "critical";
export type IssueInfo = { label: string; description: string; severity: IssueSeverity };

/// Check types whose flagged "instance" is really an individual split *tile*, not the whole
/// group its check reports (GitHub issue #245's review fix, item 2/3): `max_split_count`/
/// `max_split_density` bundle every split tile on the field into one `InvalidSplitTileGroupIssue`
/// group, but repair fixes them by removing specific tiles, one at a time -- so "how many preset
/// instances" must count tiles, not that one field-wide group. Every other split-tile-group check
/// (proximity pairs, `max_split_tile_node_count`) genuinely wants one instance per group -- see
/// `IssueSplitGroupPayload`'s doc comment on the Rust side.
export const TILE_GRANULARITY_CHECKS = new Set(["max_split_count", "max_split_density"]);

/// This `sourceCheck`'s own slice of `issue`'s payload, reduced to just the `preset_locked` flag
/// per element -- the single place in the whole project that switches on `payload.kind` to extract
/// preset-lock data. Covers every payload kind that carries `preset_locked` (loop/teleport/
/// one-way edge groups, split-tile/split-node group lists, split-route routes, region-needs-
/// expansion/shrink regions); `null` for a kind with no such data (no source check). Pure
/// extraction only -- no visibility/toggle semantics live here, see
/// `isFullyPresetLocked`/`isIssueEntirelyHidden` below and `IssuesBlock.tsx`'s `visibleGroup`
/// filter for those.
export function presetLockElementsFor(issue: IssueDto, sourceCheck: string): { preset_locked: boolean }[] | null {
  const payload = issue.payload;
  if (payload.kind === "invalid_loop") return payload.edges[sourceCheck] ?? null;
  if (payload.kind === "invalid_teleport") return payload.groups[sourceCheck] ?? null;
  if (payload.kind === "invalid_one_way") return payload.groups[sourceCheck] ?? null;
  if (payload.kind === "invalid_vertical_passage") return payload.groups[sourceCheck] ?? null;
  if (payload.kind === "invalid_elevator") return payload.groups[sourceCheck] ?? null;
  if (payload.kind === "invalid_elevator_stop") return payload.nodes[sourceCheck] ?? null;
  if (payload.kind === "invalid_split_tile") {
    const groups = payload.groups[sourceCheck] ?? null;
    if (groups == null) return null;
    const typeId = issue.source_check_types[sourceCheck] ?? sourceCheck;
    return TILE_GRANULARITY_CHECKS.has(typeId) ? groups.flatMap((g) => g.tiles) : groups;
  }
  if (payload.kind === "invalid_split_route") return payload.routes[sourceCheck] ?? null;
  if (payload.kind === "region_needs_expansion") return payload.nodes[sourceCheck] ?? null;
  if (payload.kind === "region_needs_shrink") return payload.nodes[sourceCheck] ?? null;
  if (payload.kind === "excessive_scc_count") {
    const locked = payload.preset_locked[sourceCheck];
    return locked === undefined ? null : [{ preset_locked: locked }];
  }
  return null;
}

/// Whether every element in `elements` is `preset_locked` (GitHub issue #245). `null`/empty
/// resolves `false`: a bubble with no preset-lock data at all is never "fully preset-locked" by
/// this check, it just doesn't participate in the toggle.
function isFullyPresetLocked(elements: { preset_locked: boolean }[] | null): boolean {
  return elements != null && elements.length > 0 && elements.every((e) => e.preset_locked);
}

/// Whether `showFullyPresetLockedIssues: false` would hide every one of `issue`'s bubbles (GitHub
/// issue #245's toggle) -- shared by `IssuesBlock` (bubble-level hiding) and `FeaturesPanel` (the
/// Analytics card's status/subtitle and issue count must agree with what's actually shown: an
/// issue whose every bubble is hidden must not count toward "N issues" either). An issue with no
/// `source_checks` at all (e.g. `cycle_analysis_overflowed`) never participates in the toggle, so
/// it's never hidden this way.
export function isIssueEntirelyHidden(issue: IssueDto, showFullyPresetLockedIssues: boolean): boolean {
  if (showFullyPresetLockedIssues) return false;
  if (issue.source_checks.length === 0) return false;
  return issue.source_checks.every((sourceCheck) => isFullyPresetLocked(presetLockElementsFor(issue, sourceCheck)));
}

/// Single source of truth for issue kind -> {label, description, severity}. Shared by
/// IssuesBlock (renders the bubble) and FeaturesPanel (derives the Analytics card status/
/// comment from the same severities) -- any new issue kind only needs an entry here to show
/// up correctly in both places.
const KNOWN_ISSUES: Record<string, () => IssueInfo> = {
  missing_endpoints: () => ({ label: m["issue.missing_endpoints.label"](), description: m["issue.missing_endpoints.description"](), severity: "warning" }),
  unreachable_finish: () => ({ label: m["issue.unreachable_finish.label"](), description: m["issue.unreachable_finish.description"](), severity: "warning" }),
  missing_loops: () => ({ label: m["issue.missing_loops.label"](), description: m["issue.missing_loops.description"](), severity: "warning" }),
  invalid_loop: () => ({ label: m["issue.invalid_loop.label"](), description: m["issue.invalid_loop.description"](), severity: "warning" }),
  invalid_loop_group: () => ({ label: m["issue.invalid_loop_group.label"](), description: m["issue.invalid_loop_group.description"](), severity: "warning" }),
  cycle_analysis_overflowed: () => ({ label: m["issue.cycle_analysis_overflowed.label"](), description: m["issue.cycle_analysis_overflowed.description"](), severity: "critical" }),
  repair_limit_reached: () => ({ label: m["issue.repair_limit_reached.label"](), description: m["issue.repair_limit_reached.description"](), severity: "critical" }),
  excessive_scc_count: () => ({ label: m["issue.excessive_scc_count.label"](), description: m["issue.excessive_scc_count.description"](), severity: "warning" }),
  region_needs_expansion: () => ({ label: m["issue.region_needs_expansion.label"](), description: m["issue.region_needs_expansion.description"](), severity: "warning" }),
  region_needs_shrink: () => ({ label: m["issue.region_needs_shrink.label"](), description: m["issue.region_needs_shrink.description"](), severity: "warning" }),
  missing_regions: () => ({ label: m["issue.missing_regions.label"](), description: m["issue.missing_regions.description"](), severity: "warning" }),
  invalid_teleport: () => ({ label: m["issue.invalid_teleport.label"](), description: m["issue.invalid_teleport.description"](), severity: "warning" }),
  invalid_teleport_group: () => ({ label: m["issue.invalid_teleport_group.label"](), description: m["issue.invalid_teleport_group.description"](), severity: "warning" }),
  invalid_one_way: () => ({ label: m["issue.invalid_one_way.label"](), description: m["issue.invalid_one_way.description"](), severity: "warning" }),
  invalid_one_way_group: () => ({ label: m["issue.invalid_one_way_group.label"](), description: m["issue.invalid_one_way_group.description"](), severity: "warning" }),
  missing_one_ways: () => ({ label: m["issue.missing_one_ways.label"](), description: m["issue.missing_one_ways.description"](), severity: "warning" }),
  missing_teleports: () => ({ label: m["issue.missing_teleports.label"](), description: m["issue.missing_teleports.description"](), severity: "warning" }),
  invalid_split_tile: () => ({ label: m["issue.invalid_split_tile.label"](), description: m["issue.invalid_split_tile.description"](), severity: "warning" }),
  invalid_split_tile_group: () => ({ label: m["issue.invalid_split_tile_group.label"](), description: m["issue.invalid_split_tile_group.description"](), severity: "warning" }),
  missing_split_tiles: () => ({ label: m["issue.missing_split_tiles.label"](), description: m["issue.missing_split_tiles.description"](), severity: "warning" }),
  invalid_split_node: () => ({ label: m["issue.invalid_split_node.label"](), description: m["issue.invalid_split_node.description"](), severity: "warning" }),
  invalid_split_node_connection_group: () => ({ label: m["issue.invalid_split_node_connection_group.label"](), description: m["issue.invalid_split_node_connection_group.description"](), severity: "warning" }),
  invalid_split_node_group: () => ({ label: m["issue.invalid_split_node_group.label"](), description: m["issue.invalid_split_node_group.description"](), severity: "warning" }),
  invalid_split_route: () => ({ label: m["issue.invalid_split_route.label"](), description: m["issue.invalid_split_route.description"](), severity: "warning" }),
  missing_vertical_passages: () => ({ label: m["issue.missing_vertical_passages.label"](), description: m["issue.missing_vertical_passages.description"](), severity: "warning" }),
  invalid_vertical_passage: () => ({ label: m["issue.invalid_vertical_passage.label"](), description: m["issue.invalid_vertical_passage.description"](), severity: "warning" }),
  invalid_vertical_passage_group: () => ({ label: m["issue.invalid_vertical_passage_group.label"](), description: m["issue.invalid_vertical_passage_group.description"](), severity: "warning" }),
  invalid_elevator: () => ({ label: m["issue.invalid_elevator.label"](), description: m["issue.invalid_elevator.description"](), severity: "warning" }),
  invalid_elevator_group: () => ({ label: m["issue.invalid_elevator_group.label"](), description: m["issue.invalid_elevator_group.description"](), severity: "warning" }),
  invalid_elevator_stop: () => ({ label: m["issue.invalid_elevator_stop.label"](), description: m["issue.invalid_elevator_stop.description"](), severity: "warning" }),
  invalid_elevator_stop_group: () => ({ label: m["issue.invalid_elevator_stop_group.label"](), description: m["issue.invalid_elevator_stop_group.description"](), severity: "warning" }),
  missing_elevators: () => ({ label: m["issue.missing_elevators.label"](), description: m["issue.missing_elevators.description"](), severity: "warning" }),
  area_missing_elevator_stops: () => ({ label: m["issue.area_missing_elevator_stops.label"](), description: m["issue.area_missing_elevator_stops.description"](), severity: "warning" }),
};

export function resolveIssue(kind: string): IssueInfo {
  return KNOWN_ISSUES[kind]?.() ?? { label: kind, description: "", severity: "warning" };
}

/// Check ids that never call `.with_detail(...)` on the Rust side (pure structural checks --
/// `MissingEndpointsCheck`, `UnreachableFinishCheck`, `TeleportDuplicatesConnectionCheck`) -- the
/// generic `issue.<kind>.label`/`.description` (via `resolveIssue`) already reads correctly for
/// these, so they need no override in `DETAIL_LABELS`/`DETAIL_DESCRIPTIONS` below. Named and
/// factored out (instead of a `() => undefined`/`() => resolveCheckDescription(...)` line per id)
/// so `codegen --check`'s flat per-check-id completeness diff (GitHub issue #405) -- which can't
/// tell a check with nothing to render apart from one whose entry was simply forgotten, since that
/// requires tracing `.with_detail` calls through shared check-core helpers, not a plain text scan
/// -- is satisfied by a single explicit list rather than scattered no-op closures.
const NO_DETAIL_CHECKS = ["missing_endpoints", "unreachable_finish", "teleport_duplicates_connection"] as const;

/// Per-source-check label override, filled in with that check's raw detail values (see
/// `IssueDto.details`). Lets one `kind` (e.g. `invalid_loop`) read differently depending on
/// which check actually produced it -- "Loop shorter than 5 tiles" vs "Loop longer than 100
/// tiles" -- instead of a generic "Invalid loop" for both. A check id absent here falls back
/// to the kind's generic label (`resolveIssue`).
export const DETAIL_LABELS: Record<string, (details: Record<string, string>) => string | undefined> = {
  ...Object.fromEntries(NO_DETAIL_CHECKS.map((id) => [id, () => undefined])),
  min_loops_count: (d) => d.missing !== undefined ? m["issue.missing_loops.min_loops_count_label"]({ missing: d.missing }) : undefined,
  min_loop_density: (d) => d.missing !== undefined ? m["issue.missing_loops.min_loop_density_label"]({ missing: d.missing }) : undefined,
  loop_length: (d) => d.threshold !== undefined ? m["issue.invalid_loop.loop_length_label"]({ threshold: d.threshold }) : undefined,
  external_escape_diversity: (d) => d.min_distinct_exits !== undefined ? m["issue.invalid_loop.external_escape_diversity_label"]({ min_distinct_exits: d.min_distinct_exits }) : undefined,
  loop_distance_from_start: (d) => d.min_distance_from_start !== undefined ? m["issue.invalid_loop.loop_distance_from_start_label"]({ min_distance_from_start: d.min_distance_from_start }) : undefined,
  loop_distance_from_finish: (d) => d.min_distance_from_finish !== undefined ? m["issue.invalid_loop.loop_distance_from_finish_label"]({ min_distance_from_finish: d.min_distance_from_finish }) : undefined,
  max_loop_density: (d) => d.max_density !== undefined ? m["issue.invalid_loop_group.max_loop_density_label"]({ max_density: d.max_density }) : undefined,
  max_loops_count: (d) => d.max_loops_count !== undefined ? m["issue.invalid_loop_group.max_loops_count_label"]({ max_loops_count: d.max_loops_count }) : undefined,
  // Keyed by the issue's own kind string, not a CheckId — `repair_limit_reached` carries no
  // source check (see `IssuesBlock`'s null-sourceCheck fallback).
  repair_limit_reached: (d) => d.limit === "max_iterations"
    ? m["issue.repair_limit_reached.max_iterations_label"]()
    : d.limit === "time_budget"
    ? m["issue.repair_limit_reached.time_budget_label"]()
    : undefined,
  scc_count: (d) => d.scc_count !== undefined && d.max_scc_count !== undefined
    ? m["issue.excessive_scc_count.scc_count_label"]({ scc_count: d.scc_count, max_scc_count: d.max_scc_count })
    : undefined,
  min_region_size: (d) => {
    if (d.min_region_size === undefined) return undefined;
    if (d.region_classes !== undefined) {
      const classes = d.region_classes.split(",").map((c) => resolveParamOptionLabel("region_class", c)).join(", ");
      return m["issue.region_needs_expansion.min_region_size_with_classes_label"]({ region_classes: classes, min_region_size: d.min_region_size });
    }
    return m["issue.region_needs_expansion.min_region_size_label"]({ min_region_size: d.min_region_size });
  },
  min_region_ratio: (d) => {
    if (d.min_region_ratio === undefined) return undefined;
    if (d.region_classes !== undefined) {
      const classes = d.region_classes.split(",").map((c) => resolveParamOptionLabel("region_class", c)).join(", ");
      return m["issue.region_needs_expansion.min_region_ratio_with_classes_label"]({ region_classes: classes, min_region_ratio: d.min_region_ratio });
    }
    return m["issue.region_needs_expansion.min_region_ratio_label"]({ min_region_ratio: d.min_region_ratio });
  },
  max_region_size: (d) => {
    if (d.max_region_size === undefined) return undefined;
    if (d.region_classes !== undefined) {
      const classes = d.region_classes.split(",").map((c) => resolveParamOptionLabel("region_class", c)).join(", ");
      return m["issue.region_needs_shrink.max_region_size_with_classes_label"]({ region_classes: classes, max_region_size: d.max_region_size });
    }
    return m["issue.region_needs_shrink.max_region_size_label"]({ max_region_size: d.max_region_size });
  },
  max_region_ratio: (d) => {
    if (d.max_region_ratio === undefined) return undefined;
    if (d.region_classes !== undefined) {
      const classes = d.region_classes.split(",").map((c) => resolveParamOptionLabel("region_class", c)).join(", ");
      return m["issue.region_needs_shrink.max_region_ratio_with_classes_label"]({ region_classes: classes, max_region_ratio: d.max_region_ratio });
    }
    return m["issue.region_needs_shrink.max_region_ratio_label"]({ max_region_ratio: d.max_region_ratio });
  },
  min_region_count: (d) => {
    if (d.region_classes === undefined) return undefined;
    const classes = d.region_classes.split(",");
    // Single deficit class: exact configured minimum is available (`min_count` detail) -- show
    // it. Multiple classes short at once have no single N to show, fall back to the class list.
    if (classes.length === 1 && d.min_count !== undefined) {
      return m["issue.missing_regions.min_region_count_single_label"]({
        region_class: resolveParamOptionLabel("region_class", classes[0]),
        min_count: d.min_count,
      });
    }
    return m["issue.missing_regions.min_region_count_label"]({
      region_classes: classes.map((c) => resolveParamOptionLabel("region_class", c)).join(", "),
    });
  },
  teleport_waypoint_distance: (d) => d.distance !== undefined ? m["issue.invalid_teleport.teleport_waypoint_distance_label"]({ distance: d.distance }) : undefined,
  teleport_geometric_length: (d) => d.length !== undefined ? m["issue.invalid_teleport.teleport_geometric_length_label"]({ length: d.length }) : undefined,
  teleport_graph_distance: (d) => d.distance !== undefined ? m["issue.invalid_teleport.teleport_graph_distance_label"]({ distance: d.distance }) : undefined,
  teleport_super_hub_avoidance: (d) => d.max_connections !== undefined ? m["issue.invalid_teleport.teleport_super_hub_avoidance_label"]({ max_connections: d.max_connections }) : undefined,
  // No detail values at all (a pure structural entry/exit-in-split-cell test, GitHub issue #257)
  // -- always returns the same static label regardless of `d`, unlike every other entry here.
  teleport_split_intersection: () => m["issue.invalid_teleport.teleport_split_intersection_label"](),
  teleport_group_proximity: (d) => d.distance !== undefined ? m["issue.invalid_teleport_group.teleport_group_proximity_label"]({ distance: d.distance }) : undefined,
  one_way_waypoint_distance: (d) => d.distance !== undefined ? m["issue.invalid_one_way.one_way_waypoint_distance_label"]({ distance: d.distance }) : undefined,
  one_way_group_geometric_proximity: (d) => d.distance !== undefined ? m["issue.invalid_one_way_group.one_way_group_geometric_proximity_label"]({ distance: d.distance }) : undefined,
  one_way_group_graph_proximity: (d) => d.distance !== undefined ? m["issue.invalid_one_way_group.one_way_group_graph_proximity_label"]({ distance: d.distance }) : undefined,
  one_way_group_super_hub: (d) => d.max_connections !== undefined ? m["issue.invalid_one_way_group.one_way_group_super_hub_label"]({ max_connections: d.max_connections }) : undefined,
  min_one_way_count: (d) => d.missing !== undefined ? m["issue.missing_one_ways.min_one_way_count_label"]({ missing: d.missing }) : undefined,
  min_one_way_ratio: (d) => d.missing !== undefined ? m["issue.missing_one_ways.min_one_way_ratio_label"]({ missing: d.missing }) : undefined,
  max_one_way_count: (d) => d.max_one_ways !== undefined ? m["issue.invalid_one_way_group.max_one_way_count_label"]({ max_one_ways: d.max_one_ways }) : undefined,
  max_one_way_ratio: (d) => d.max_ratio !== undefined ? m["issue.invalid_one_way_group.max_one_way_ratio_label"]({ max_ratio: d.max_ratio }) : undefined,
  min_teleport_count: (d) => d.missing !== undefined ? m["issue.missing_teleports.min_teleport_count_label"]({ missing: d.missing }) : undefined,
  min_teleport_ratio: (d) => d.missing !== undefined ? m["issue.missing_teleports.min_teleport_ratio_label"]({ missing: d.missing }) : undefined,
  split_distance_from_waypoint: (d) => d.distance !== undefined ? m["issue.invalid_split_tile.split_distance_from_waypoint_label"]({ distance: d.distance }) : undefined,
  // No detail values at all (a pure structural teleport-shape test, mirrors
  // `teleport_split_intersection` above) -- always returns the same static label regardless of `d`.
  split_teleport_intersection: () => m["issue.invalid_split_tile.split_teleport_intersection_label"](),
  max_split_count: (d) => d.max_split_count !== undefined ? m["issue.invalid_split_tile_group.max_split_count_label"]({ max_split_count: d.max_split_count }) : undefined,
  max_split_density: (d) => d.max_density !== undefined ? m["issue.invalid_split_tile_group.max_split_density_label"]({ max_density: d.max_density }) : undefined,
  split_group_geometric_proximity: (d) => d.distance !== undefined ? m["issue.invalid_split_tile_group.split_group_geometric_proximity_label"]({ distance: d.distance }) : undefined,
  split_group_graph_proximity: (d) => d.distance !== undefined ? m["issue.invalid_split_tile_group.split_group_graph_proximity_label"]({ distance: d.distance }) : undefined,
  split_count: (d) => d.missing !== undefined ? m["issue.missing_split_tiles.split_count_label"]({ missing: d.missing }) : undefined,
  split_density: (d) => d.missing !== undefined ? m["issue.missing_split_tiles.split_density_label"]({ missing: d.missing }) : undefined,
  split_node_connection_count: (d) => d.count !== undefined ? m["issue.invalid_split_node.split_node_connection_count_label"]({ count: d.count }) : undefined,
  split_node_connection_per_neighbor: (d) => d.max !== undefined ? m["issue.invalid_split_node_connection_group.split_node_connection_per_neighbor_label"]({ max: d.max }) : undefined,
  split_node_connection_per_face: (d) => d.max !== undefined ? m["issue.invalid_split_node_connection_group.split_node_connection_per_face_label"]({ max: d.max }) : undefined,
  split_node_connection_traversal_distance: (d) => d.min_detour !== undefined ? m["issue.invalid_split_route.split_node_connection_traversal_distance_label"]({ min_detour: d.min_detour }) : undefined,
  max_split_tile_node_count: (d) => d.max !== undefined ? m["issue.invalid_split_node_group.max_split_tile_node_count_label"]({ max: d.max }) : undefined,
  min_vertical_passage_count: (d) => d.missing !== undefined ? m["issue.missing_vertical_passages.min_vertical_passage_count_label"]({ missing: d.missing }) : undefined,
  min_vertical_passage_ratio: (d) => d.missing !== undefined ? m["issue.missing_vertical_passages.min_vertical_passage_ratio_label"]({ missing: d.missing }) : undefined,
  max_vertical_passage_count: (d) => d.max_vertical_passages !== undefined ? m["issue.invalid_vertical_passage_group.max_vertical_passage_count_label"]({ max_vertical_passages: d.max_vertical_passages }) : undefined,
  max_vertical_passage_ratio: (d) => d.max_ratio !== undefined ? m["issue.invalid_vertical_passage_group.max_vertical_passage_ratio_label"]({ max_ratio: d.max_ratio }) : undefined,
  vertical_passage_group_geometric_proximity: (d) => d.distance !== undefined ? m["issue.invalid_vertical_passage_group.vertical_passage_group_geometric_proximity_label"]({ distance: d.distance }) : undefined,
  vertical_passage_group_graph_proximity: (d) => d.distance !== undefined ? m["issue.invalid_vertical_passage_group.vertical_passage_group_graph_proximity_label"]({ distance: d.distance }) : undefined,
  elevator_stop_count: (d) => d.count !== undefined ? m["issue.invalid_elevator.elevator_stop_count_label"]({ count: d.count }) : undefined,
  elevator_span: (d) => d.span !== undefined ? m["issue.invalid_elevator.elevator_span_label"]({ span: d.span }) : undefined,
  max_elevator_count: (d) => d.max_elevator_count !== undefined ? m["issue.invalid_elevator_group.max_elevator_count_label"]({ max_elevator_count: d.max_elevator_count }) : undefined,
  max_elevator_density: (d) => d.max_elevator_density !== undefined ? m["issue.invalid_elevator_group.max_density_label"]({ max_density: d.max_elevator_density }) : undefined,
  max_elevator_stops: (d) => d.max_elevator_stops !== undefined ? m["issue.invalid_elevator_stop_group.max_elevator_stops_label"]({ max_elevator_stops: d.max_elevator_stops }) : undefined,
  max_elevator_stops_per_floor: (d) => d.max_elevator_stops_per_floor !== undefined ? m["issue.invalid_elevator_stop_group.max_elevator_stops_per_floor_label"]({ max_elevator_stops_per_floor: d.max_elevator_stops_per_floor }) : undefined,
  elevator_stops_skip: (d) => d.elevator_stops_skip !== undefined ? m["issue.invalid_elevator_stop_group.elevator_stops_skip_label"]({ elevator_stops_skip: d.elevator_stops_skip }) : undefined,
  elevator_stops_span: (d) => d.elevator_stops_span !== undefined ? m["issue.invalid_elevator_stop_group.elevator_stops_span_label"]({ elevator_stops_span: d.elevator_stops_span }) : undefined,
  min_elevator_count: (d) => d.missing !== undefined ? m["issue.missing_elevators.min_elevator_count_label"]({ missing: d.missing }) : undefined,
  min_elevator_density: (d) => d.missing !== undefined ? m["issue.missing_elevators.min_elevator_density_label"]({ missing: d.missing }) : undefined,
  min_elevator_stops_per_area_count: (d) => d.missing !== undefined ? m["issue.area_missing_elevator_stops.min_elevator_stops_per_area_count_label"]({ missing: d.missing }) : undefined,
  min_elevator_stops_per_area_density: (d) => d.missing !== undefined ? m["issue.area_missing_elevator_stops.min_elevator_stops_per_area_density_label"]({ missing: d.missing }) : undefined,
};

/// Resolves the label for one source check within an issue, falling back to the issue kind's
/// generic label when the check has no specific override or no details were recorded for it.
/// `typeId` is the check's type id (e.g. "min_region_count") — `DETAIL_LABELS` is keyed by type,
/// not by the opaque per-instance `sourceCheck` id (see GitHub issue #60: two instances of the
/// same type share one DETAIL_LABELS entry, since they format the same way). Warns (not throws
/// — a missing entry is a display gap, not a correctness bug) when a check reported non-empty
/// `details` but has no `DETAIL_LABELS` entry to render them with, the same way `resolveCheckKind`
/// warns on a multi-kind check — both are "registry didn't keep up with core" mistakes that are
/// otherwise silent.
export function resolveIssueSourceLabel(kind: string, typeId: string, details: Record<string, string> | undefined): string {
  const formatter = DETAIL_LABELS[typeId];
  if (!formatter && details && Object.keys(details).length > 0) {
    console.error(`check type "${typeId}" reported details (${Object.keys(details).join(", ")}) but has no DETAIL_LABELS entry in issueRegistry.ts — falling back to the generic "${kind}" label`);
  }
  const override = formatter?.(details ?? {});
  return override ?? resolveIssue(kind).label;
}

/// Per-source-check description override — same rationale as `DETAIL_LABELS`, for the longer
/// explanatory text shown in the bubble's modal. Most checks are fine sharing their kind's generic
/// description (`resolveIssue(kind).description`); only a check whose behavior meaningfully
/// diverges from its kind's generic wording needs an entry here. `resolveCheckDescription` reuses
/// the same `check.<id>.description` text the rule-card's own check picker already shows (already
/// phrased as "what the check does", no "why" — exactly what an issue-modal description needs, no
/// separate copy to keep in sync) — `teleport_split_intersection` uses its own dedicated
/// `issue.*` text instead, worded for the issue-modal context specifically.
const DETAIL_DESCRIPTIONS: Record<string, () => string> = {
  ...Object.fromEntries(NO_DETAIL_CHECKS.map((id) => [id, () => resolveCheckDescription(id, "")])),
  teleport_split_intersection: () => m["issue.invalid_teleport.teleport_split_intersection_description"](),
  teleport_waypoint_distance: () => resolveCheckDescription("teleport_waypoint_distance", ""),
  teleport_super_hub_avoidance: () => resolveCheckDescription("teleport_super_hub_avoidance", ""),
  split_distance_from_waypoint: () => resolveCheckDescription("split_distance_from_waypoint", ""),
  split_teleport_intersection: () => resolveCheckDescription("split_teleport_intersection", ""),
  max_vertical_passage_count: () => resolveCheckDescription("max_vertical_passage_count", ""),
  max_vertical_passage_ratio: () => resolveCheckDescription("max_vertical_passage_ratio", ""),
  vertical_passage_group_geometric_proximity: () => resolveCheckDescription("vertical_passage_group_geometric_proximity", ""),
  vertical_passage_group_graph_proximity: () => resolveCheckDescription("vertical_passage_group_graph_proximity", ""),
};

/// Resolves the description for one source check within an issue — mirrors
/// `resolveIssueSourceLabel`, falling back to the issue kind's generic description when the check
/// has no override in `DETAIL_DESCRIPTIONS`.
export function resolveIssueSourceDescription(kind: string, typeId: string): string {
  return DETAIL_DESCRIPTIONS[typeId]?.() ?? resolveIssue(kind).description;
}
