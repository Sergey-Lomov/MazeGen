import * as m from "~/paraglide/messages";

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
  min_loop_length: (d) => d.threshold !== undefined ? m["issue.invalid_loop.min_loop_length_label"]({ min_loop_length: d.threshold }) : undefined,
  max_loop_length: (d) => d.threshold !== undefined ? m["issue.invalid_loop.max_loop_length_label"]({ max_loop_length: d.threshold }) : undefined,
  external_escape_diversity: (d) => d.min_distinct_exits !== undefined ? m["issue.invalid_loop.external_escape_diversity_label"]({ min_distinct_exits: d.min_distinct_exits }) : undefined,
  loop_distance_from_start: (d) => d.min_distance_from_start !== undefined ? m["issue.invalid_loop.loop_distance_from_start_label"]({ min_distance_from_start: d.min_distance_from_start }) : undefined,
  loop_distance_from_finish: (d) => d.min_distance_from_finish !== undefined ? m["issue.invalid_loop.loop_distance_from_finish_label"]({ min_distance_from_finish: d.min_distance_from_finish }) : undefined,
  max_loop_density: (d) => d.max_density !== undefined ? m["issue.invalid_loop.max_loop_density_label"]({ max_density: d.max_density }) : undefined,
};

/// Resolves the label for one source check within an issue, falling back to the issue kind's
/// generic label when the check has no specific override or no details were recorded for it.
/// Warns (not throws — a missing entry is a display gap, not a correctness bug) when a check
/// reported non-empty `details` but has no `DETAIL_LABELS` entry to render them with, the same
/// way `resolveCheckKind` warns on a multi-kind check — both are "registry didn't keep up with
/// core" mistakes that are otherwise silent.
export function resolveIssueSourceLabel(kind: string, sourceCheck: string, details: Record<string, string> | undefined): string {
  const formatter = DETAIL_LABELS[sourceCheck];
  if (!formatter && details && Object.keys(details).length > 0) {
    console.error(`check "${sourceCheck}" reported details (${Object.keys(details).join(", ")}) but has no DETAIL_LABELS entry in issueRegistry.ts — falling back to the generic "${kind}" label`);
  }
  const override = formatter?.(details ?? {});
  return override ?? resolveIssue(kind).label;
}
