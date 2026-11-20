import type { ParamDescriptor } from "../wasm/types";
import { activeLimitCount, parseNodeShapeLimits } from "../components/features/nodeShapeLimits";
import { isRuleProblematic, type ProblemRule, type QcProblem } from "./qcRuleTypes";

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

/** Rules the feature card counts as problematic: stored problems, an empty rule, or empty limits.
 *  A disabled rule and the rules of a disabled stage are not counted. */
export function problematicRuleCount(
  rules: readonly (ProblemRule & { id: string; checks: readonly CheckLike[] })[],
  stages: readonly { ruleIds: readonly string[]; disabled: boolean }[],
  descriptors: readonly DescriptorLike[],
): number {
  const inDisabledStage = new Set(stages.filter((s) => s.disabled).flatMap((s) => s.ruleIds));
  return rules.filter((r) => !inDisabledStage.has(r.id) && !r.ruleDisabled
    && (isRuleProblematic(r) || emptyLimitsCheckIds(r, descriptors).length > 0)).length;
}
