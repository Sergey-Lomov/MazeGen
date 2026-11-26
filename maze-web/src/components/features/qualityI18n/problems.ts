import * as m from "~/paraglide/messages";
import type { QcProblem, QcProblemCode } from "../../../store/storeTypes";
import { resolveCellTypeLabel } from "./cellTypes";

const FORBID_CELL_TYPE_PARAM_PREFIX = "forbid_cell_type_";

function unavailableForbiddenCellType(paramId: string | undefined): string {
  const key = paramId?.startsWith(FORBID_CELL_TYPE_PARAM_PREFIX)
    ? paramId.slice(FORBID_CELL_TYPE_PARAM_PREFIX.length)
    : "cell";
  return resolveCellTypeLabel(key);
}

/** A rule problem as its warning shows it: under a check's label the text is joined as `label: reason`, with the
 *  reason's first letter lowercased. */
export function labelledProblemText(checkLabel: string | undefined, text: string): string {
  return checkLabel ? `${checkLabel}: ${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
}

/** Text of a rule that holds no checks at all (derived, never stored as a `QcProblem`). */
export function resolveNoChecksProblemText(): string {
  return m["quality.problem_no_checks"]();
}

/** Text of a rule bound to a zone or group that no longer exists, or that has no cells (derived, never stored as a `QcProblem`). */
export function resolveNoZonesProblemText(reason: "missing" | "empty"): string {
  return reason === "missing" ? m["quality.problem_no_zones"]() : m["quality.problem_zones_empty"]();
}

/** Text of a node-shape-limits check with no limits set (derived, never stored as a `QcProblem`). */
export function resolveLimitsEmptyProblemText(): string {
  return m["quality.problem_limits_empty"]();
}

/** Text of a split-pattern-shape check without any templates (derived, never stored). */
export function resolvePatternsEmptyProblemText(): string {
  return m["quality.problem_patterns_empty"]();
}

/** Text of a cell type check with no forbidden cell type selected (derived, never stored as a `QcProblem`). */
export function resolveNoForbiddenCellTypeProblemText(): string {
  return m["quality.problem_no_forbidden_cell_types"]();
}

/** Text of one rule problem (GitHub issue #1044): what happened and what the user can do. */
export function resolveProblemText(code: QcProblemCode, scope: QcProblem["scope"] = "check", paramId?: string): string {
  const ofStrategy = scope === "strategy";
  switch (code) {
    case "patterns_dropped":
      return m["quality.problem_patterns_dropped"]();
    case "patterns_emptied":
      return m["quality.problem_patterns_emptied"]();
    case "limits_reset":
      return m["quality.problem_limits_reset"]();
    case "forbidden_cell_type_unavailable":
      return m["quality.problem_forbidden_cell_type_unavailable"]({ cell_type: unavailableForbiddenCellType(paramId) });
    case "irregular_tessellation":
      return ofStrategy ? m["quality.problem_irregular_tessellation_strategy"]() : m["quality.problem_irregular_tessellation"]();
    case "cell_sides_exceed":
      return ofStrategy ? m["quality.problem_cell_sides_exceed_strategy"]() : m["quality.problem_cell_sides_exceed"]();
  }
}
