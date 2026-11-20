import * as m from "~/paraglide/messages";
import type { QcProblem, QcProblemCode } from "../../../store/storeTypes";

/** Text of a rule that holds no checks at all (derived, never stored as a `QcProblem`). */
export function resolveNoChecksProblemText(): string {
  return m["quality.problem_no_checks"]();
}

/** Text of a node-shape-limits check with no limits set (derived, never stored as a `QcProblem`). */
export function resolveLimitsEmptyProblemText(): string {
  return m["quality.problem_limits_empty"]();
}

/** Text of one rule problem (GitHub issue #1044): what happened and what the user can do. */
export function resolveProblemText(code: QcProblemCode, scope: QcProblem["scope"] = "check"): string {
  const ofStrategy = scope === "strategy";
  switch (code) {
    case "patterns_dropped":
      return m["quality.problem_patterns_dropped"]();
    case "patterns_emptied":
      return m["quality.problem_patterns_emptied"]();
    case "limits_reset":
      return m["quality.problem_limits_reset"]();
    case "irregular_tessellation":
      return ofStrategy ? m["quality.problem_irregular_tessellation_strategy"]() : m["quality.problem_irregular_tessellation"]();
    case "cell_sides_exceed":
      return ofStrategy ? m["quality.problem_cell_sides_exceed_strategy"]() : m["quality.problem_cell_sides_exceed"]();
  }
}
