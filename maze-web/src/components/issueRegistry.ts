import * as m from "~/paraglide/messages";
import { resolveParamOptionLabel } from "./features/qualityI18n";

export type IssueSeverity = "warning" | "critical";
export type IssueInfo = { label: string; description: string; severity: IssueSeverity };

/// Single source of truth for issue kind -> {label, description, severity}. Shared by
/// IssuesBlock (renders the bubble) and FeaturesPanel (derives the Analytics card status/
/// comment from the same severities) -- any new issue kind only needs an entry here to show
/// up correctly in both places.
const KNOWN_ISSUES: Record<string, () => IssueInfo> = {
  missing_endpoints: () => ({ label: m["issue.missing_endpoints.label"](), description: m["issue.missing_endpoints.description"](), severity: "warning" }),
  unreachable_finish: () => ({ label: m["issue.unreachable_finish.label"](), description: m["issue.unreachable_finish.description"](), severity: "warning" }),
  missing_loops: () => ({ label: m["issue.missing_loops.label"](), description: m["issue.missing_loops.description"](), severity: "warning" }),
  invalid_loop: () => ({ label: m["issue.invalid_loop.label"](), description: m["issue.invalid_loop.description"](), severity: "warning" }),
  cycle_analysis_overflowed: () => ({ label: m["issue.cycle_analysis_overflowed.label"](), description: m["issue.cycle_analysis_overflowed.description"](), severity: "critical" }),
  repair_limit_reached: () => ({ label: m["issue.repair_limit_reached.label"](), description: m["issue.repair_limit_reached.description"](), severity: "critical" }),
  qc_no_progress: () => ({ label: m["issue.qc_no_progress.label"](), description: m["issue.qc_no_progress.description"](), severity: "critical" }),
  excessive_scc_count: () => ({ label: m["issue.excessive_scc_count.label"](), description: m["issue.excessive_scc_count.description"](), severity: "warning" }),
  region_needs_expansion: () => ({ label: m["issue.region_needs_expansion.label"](), description: m["issue.region_needs_expansion.description"](), severity: "warning" }),
  missing_regions: () => ({ label: m["issue.missing_regions.label"](), description: m["issue.missing_regions.description"](), severity: "warning" }),
};

export function resolveIssue(kind: string): IssueInfo {
  return KNOWN_ISSUES[kind]?.() ?? { label: kind, description: "", severity: "warning" };
}

/// Per-source-check label override, filled in with that check's raw detail values (see
/// `IssueDto.details`). Lets one `kind` (e.g. `invalid_loop`) read differently depending on
/// which check actually produced it -- "Loop shorter than 5 tiles" vs "Loop longer than 100
/// tiles" -- instead of a generic "Invalid loop" for both. A check id absent here falls back
/// to the kind's generic label (`resolveIssue`).
const DETAIL_LABELS: Record<string, (details: Record<string, string>) => string | undefined> = {
  min_loops_count: (d) => d.missing !== undefined ? m["issue.missing_loops.min_loops_count_label"]({ missing: d.missing }) : undefined,
  min_loop_density: (d) => d.missing !== undefined ? m["issue.missing_loops.min_loop_density_label"]({ missing: d.missing }) : undefined,
  min_loop_length: (d) => d.threshold !== undefined ? m["issue.invalid_loop.min_loop_length_label"]({ min_loop_length: d.threshold }) : undefined,
  max_loop_length: (d) => d.threshold !== undefined ? m["issue.invalid_loop.max_loop_length_label"]({ max_loop_length: d.threshold }) : undefined,
  external_escape_diversity: (d) => d.min_distinct_exits !== undefined ? m["issue.invalid_loop.external_escape_diversity_label"]({ min_distinct_exits: d.min_distinct_exits }) : undefined,
  loop_distance_from_start: (d) => d.min_distance_from_start !== undefined ? m["issue.invalid_loop.loop_distance_from_start_label"]({ min_distance_from_start: d.min_distance_from_start }) : undefined,
  loop_distance_from_finish: (d) => d.min_distance_from_finish !== undefined ? m["issue.invalid_loop.loop_distance_from_finish_label"]({ min_distance_from_finish: d.min_distance_from_finish }) : undefined,
  max_loop_density: (d) => d.max_density !== undefined ? m["issue.invalid_loop.max_loop_density_label"]({ max_density: d.max_density }) : undefined,
  // Keyed by the issue's own kind string, not a CheckId — `repair_limit_reached` carries no
  // source check (see `IssuesBlock`'s null-sourceCheck fallback).
  repair_limit_reached: (d) => d.limit === "max_iterations"
    ? m["issue.repair_limit_reached.max_iterations_label"]()
    : d.limit === "time_budget"
    ? m["issue.repair_limit_reached.time_budget_label"]()
    : undefined,
  qc_no_progress: (d) => d.rule_ids !== undefined ? m["issue.qc_no_progress.rule_ids_label"]({ rule_ids: d.rule_ids }) : undefined,
  scc_count: (d) => d.scc_count !== undefined && d.max_scc_count !== undefined
    ? m["issue.excessive_scc_count.scc_count_label"]({ scc_count: d.scc_count, max_scc_count: d.max_scc_count })
    : undefined,
  min_region_size: (d) => d.min_region_size !== undefined
    ? m["issue.region_needs_expansion.min_region_size_label"]({ min_region_size: d.min_region_size })
    : undefined,
  min_region_ratio: (d) => d.min_region_ratio !== undefined
    ? m["issue.region_needs_expansion.min_region_ratio_label"]({ min_region_ratio: d.min_region_ratio })
    : undefined,
  min_region_count: (d) => d.region_class !== undefined && d.count !== undefined
    ? m["issue.missing_regions.min_region_count_label"]({ region_class: resolveParamOptionLabel("region_class", d.region_class), min_count: d.count })
    : undefined,
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
