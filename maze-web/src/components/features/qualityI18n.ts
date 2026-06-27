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
  min_loop_length: {
    label: m["check.min_loop_length.label"] as MessageFn,
    description: m["check.min_loop_length.description"] as MessageFn,
  },
  max_loop_length: {
    label: m["check.max_loop_length.label"] as MessageFn,
    description: m["check.max_loop_length.description"] as MessageFn,
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
  missing_loops_random: {
    label: m["strategy.missing_loops_random.label"] as MessageFn,
    description: m["strategy.missing_loops_random.description"] as MessageFn,
  },
};

export const paramI18n: Record<string, { label: MessageFn; description: MessageFn }> = {
  min_loops: {
    label: m["param.min_loops.label"] as MessageFn,
    description: m["param.min_loops.description"] as MessageFn,
  },
  min_loop_length: {
    label: m["param.min_loop_length.label"] as MessageFn,
    description: m["param.min_loop_length.description"] as MessageFn,
  },
  max_loop_length: {
    label: m["param.max_loop_length.label"] as MessageFn,
    description: m["param.max_loop_length.description"] as MessageFn,
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
