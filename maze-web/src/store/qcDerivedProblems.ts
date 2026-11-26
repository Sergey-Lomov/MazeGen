import type { ParamDescriptor } from "../wasm/types";
import { activeLimitCount, parseNodeShapeLimits } from "../components/features/nodeShapeLimits";
import type { Zone } from "../wasm/mazeService";
import { zoneScopeHasNoZones } from "../domain/qcZoneScope";
import type { ZoneGroup } from "./zonesTypes";
import { isRuleProblematic, ruleHasSendableChecks, type ProblemRule, type QcProblem, type QcZoneScopeTarget } from "./qcRuleTypes";

/** Whether core receives anything from `rule`: it has sendable checks and, if bound to zones, some zone left. */
export function ruleIsSendable(
  rule: Parameters<typeof ruleHasSendableChecks>[0] & { zoneScope?: QcZoneScopeTarget },
  zones: readonly Zone[],
  groups: readonly ZoneGroup[],
): boolean {
  return ruleHasSendableChecks(rule) && !zoneScopeHasNoZones(rule, zones, groups);
}

type CheckLike = { localId: number; typeId: string; params: Record<string, string>; disabled: boolean };
type DescriptorLike = { id: string; params: readonly Pick<ParamDescriptor, "id" | "kind">[] };

/** Checks whose node-shape limits are empty (GitHub issue #1044): such a check never reports anything,
 *  so the rule is useless. Derived, never stored. Skips disabled checks and checks that already carry
 *  a problem of their own (a reset by a tessellation change, or "cannot apply"). */
export function emptyLimitsCheckIds(
  rule: { checks: readonly CheckLike[]; problems?: QcProblem[] },
  descriptors: readonly DescriptorLike[],
): number[] {
  return rule.checks
    .filter((check) => {
      if (check.disabled) return false;
      if ((rule.problems ?? []).some((p) => p.scope === "check" && p.localId === check.localId)) return false;
      const param = descriptors.find((d) => d.id === check.typeId)?.params.find((p) => p.kind.type === "node_shape_limits");
      return param !== undefined && activeLimitCount(parseNodeShapeLimits(check.params[param.id])) === 0;
    })
    .map((check) => check.localId);
}

/** Checks whose split-pattern template list is empty (GitHub issue #1095): without a declared
 * template, a shape check never reports anything. Like empty node-shape limits, this is derived
 * rather than persisted, and skips disabled or already-problematic checks to avoid duplicate
 * warnings for one cause. */
export function emptyPatternCheckIds(
  rule: { checks: readonly CheckLike[]; problems?: QcProblem[] },
  descriptors: readonly DescriptorLike[],
): number[] {
  return rule.checks
    .filter((check) => {
      if (check.disabled) return false;
      if ((rule.problems ?? []).some((p) => p.scope === "check" && p.localId === check.localId)) return false;
      if (check.typeId !== "split_pattern_shape") return false;
      const param = descriptors.find((d) => d.id === check.typeId)?.params.find((p) => p.kind.type === "pattern_list");
      if (!param) return false;
      try {
        const patterns: unknown = JSON.parse(check.params[param.id] ?? "[]");
        return !Array.isArray(patterns) || patterns.length === 0;
      } catch {
        return true;
      }
    })
    .map((check) => check.localId);
}

const CELL_TYPE_CHECK_ID = "cross_element_cell_type";
const FORBID_CELL_TYPE_PREFIX = "forbid_cell_type_";

/** `cross_element_cell_type` checks with no cell type marked forbidden: nothing can violate them, so they have no
 *  effect. Derived, never stored. Skips disabled checks and checks that already carry a problem of their own. */
export function noForbiddenCellTypeCheckIds(
  rule: { checks: readonly CheckLike[]; problems?: QcProblem[] },
  descriptors: readonly DescriptorLike[],
): number[] {
  const paramIds = descriptors.find((d) => d.id === CELL_TYPE_CHECK_ID)?.params.map((p) => p.id).filter((id) => id.startsWith(FORBID_CELL_TYPE_PREFIX)) ?? [];
  if (paramIds.length === 0) return [];
  return rule.checks
    .filter((check) => {
      if (check.typeId !== CELL_TYPE_CHECK_ID || check.disabled) return false;
      if ((rule.problems ?? []).some((p) => p.scope === "check" && p.localId === check.localId)) return false;
      return !paramIds.some((id) => check.params[id] === "true");
    })
    .map((check) => check.localId);
}

/** Rules the feature card counts as problematic: stored problems, an empty rule, empty limits or templates, or a zone scope
 *  with no zone left or forbidden cell type (GitHub issues #1039, #1095).
 *  A disabled rule and the rules of a disabled stage are not counted. */
export function problematicRuleCount(
  rules: readonly (ProblemRule & { id: string; checks: readonly CheckLike[]; zoneScope?: QcZoneScopeTarget })[],
  stages: readonly { ruleIds: readonly string[]; disabled: boolean }[],
  descriptors: readonly DescriptorLike[],
  zones: readonly Zone[],
  groups: readonly ZoneGroup[],
): number {
  const inDisabledStage = new Set(stages.filter((s) => s.disabled).flatMap((s) => s.ruleIds));
  return rules.filter((r) => !inDisabledStage.has(r.id) && !r.ruleDisabled
    && (isRuleProblematic(r) || zoneScopeHasNoZones(r, zones, groups)
      || emptyLimitsCheckIds(r, descriptors).length > 0
      || emptyPatternCheckIds(r, descriptors).length > 0
      || noForbiddenCellTypeCheckIds(r, descriptors).length > 0)).length;
}
