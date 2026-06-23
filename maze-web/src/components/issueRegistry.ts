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
  min_loops_count: () => ({ label: m["issue.min_loops_count.label"](), description: m["issue.min_loops_count.description"](), severity: "warning" }),
  invalid_loop: () => ({ label: m["issue.invalid_loop.label"](), description: m["issue.invalid_loop.description"](), severity: "warning" }),
  cycle_analysis_overflowed: () => ({ label: m["issue.cycle_analysis_overflowed.label"](), description: m["issue.cycle_analysis_overflowed.description"](), severity: "critical" }),
};

export function resolveIssue(kind: string): IssueInfo {
  return KNOWN_ISSUES[kind]?.() ?? { label: kind, description: "", severity: "warning" };
}
