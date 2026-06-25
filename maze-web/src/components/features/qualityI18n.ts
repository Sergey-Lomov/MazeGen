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
  min_loops_count: {
    label: m["issue.min_loops_count.label"] as MessageFn,
    description: m["issue.min_loops_count.description"] as MessageFn,
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
};

export const paramI18n: Record<string, MessageFn> = {
  min_loops: m["param.min_loops.label"] as MessageFn,
  min_loop_length: m["param.min_loop_length.label"] as MessageFn,
  max_loop_length: m["param.max_loop_length.label"] as MessageFn,
  min_distinct_exits: m["param.min_distinct_exits.label"] as MessageFn,
  path_weight: m["param.path_weight.label"] as MessageFn,
  junction_weight: m["param.junction_weight.label"] as MessageFn,
  oneway_weight: m["param.oneway_weight.label"] as MessageFn,
  short_overlap_weight: m["param.short_overlap_weight.label"] as MessageFn,
  other_overlap_weight: m["param.other_overlap_weight.label"] as MessageFn,
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
  return paramI18n[id]?.() ?? fallback;
}
