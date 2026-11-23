import { describe, it, expect } from "vitest";
import { buildProblems, type CheckVM } from "../components/features/useQualityViewModel";
import { emptyLimitsCheckIds, problematicRuleCount } from "../store/qcDerivedProblems";
import { isRuleProblematic, ruleHasSendableChecks, sendableChecks, visibleProblems, type QcProblem } from "../store/storeTypes";

const live = { localId: 0, disabled: false };
const check = (localId: number, label: string) => ({ localId, label }) as CheckVM;

describe("buildProblems (GitHub issue #1044)", () => {
  it("collapses a rule-level pattern problem flagged on several consumers into one unlabeled entry", () => {
    const problems: QcProblem[] = [
      { code: "patterns_emptied", scope: "check", localId: 0, paramId: "split_patterns" },
      { code: "patterns_emptied", scope: "check", localId: 1, paramId: "split_patterns" },
      { code: "patterns_emptied", scope: "strategy", paramId: "split_patterns" },
    ];
    const result = buildProblems(problems, [check(0, "Min splits"), check(1, "Max splits")], new Set(["split_patterns"]));
    expect(result).toHaveLength(1);
    expect(result[0].checkLabel).toBeUndefined();
  });

  it("keeps a check's own param problem labeled with the check", () => {
    const problems: QcProblem[] = [{ code: "patterns_emptied", scope: "check", localId: 0, paramId: "patterns" }];
    const result = buildProblems(problems, [check(0, "Split shape")], new Set(["split_patterns"]));
    expect(result.map((p) => p.checkLabel)).toEqual(["Split shape"]);
  });

  it("keeps same-code problems of different checks apart", () => {
    const problems: QcProblem[] = [
      { code: "patterns_emptied", scope: "check", localId: 0, paramId: "patterns" },
      { code: "patterns_emptied", scope: "check", localId: 1, paramId: "patterns" },
    ];
    expect(buildProblems(problems, [check(0, "A"), check(1, "B")], new Set())).toHaveLength(2);
  });
});

describe("isRuleProblematic (GitHub issue #1044)", () => {
  it("counts a rule without checks as problematic", () => {
    expect(isRuleProblematic({ checks: [] })).toBe(true);
  });

  it("counts a rule whose checks are all disabled as problematic", () => {
    expect(isRuleProblematic({ checks: [{ localId: 0, disabled: true }] })).toBe(true);
    expect(isRuleProblematic({ checks: [{ localId: 0, disabled: true }, live] })).toBe(false);
    expect(isRuleProblematic({ checks: [{ localId: 0, disabled: true }], ruleDisabled: true })).toBe(false);
  });

  it("counts a rule with a stored problem as problematic and a healthy one as not", () => {
    const problems: QcProblem[] = [{ code: "limits_reset", scope: "check", localId: 0, paramId: "limits" }];
    expect(isRuleProblematic({ checks: [live], problems })).toBe(true);
    expect(isRuleProblematic({ checks: [live] })).toBe(false);
  });

  it("keeps a disabled rule's warnings but does not count it", () => {
    const problems: QcProblem[] = [{ code: "limits_reset", scope: "check", localId: 0, paramId: "limits" }];
    const rule = { checks: [live], problems, ruleDisabled: true };
    expect(isRuleProblematic(rule)).toBe(false);
    expect(isRuleProblematic({ checks: [], ruleDisabled: true })).toBe(false);
    expect(visibleProblems(rule)).toEqual(problems);
  });

  it("hides the problems of a disabled check only", () => {
    const problems: QcProblem[] = [
      { code: "limits_reset", scope: "check", localId: 0, paramId: "limits" },
      { code: "patterns_dropped", scope: "check", localId: 1, paramId: "patterns" },
    ];
    const rule = { checks: [{ localId: 0, disabled: true }, { localId: 1, disabled: false }], problems };
    expect(visibleProblems(rule)).toEqual([problems[1]]);
    expect(isRuleProblematic({ ...rule, problems: [problems[0]] })).toBe(false);
  });

  it("hides a disabled strategy's problems and counts the rule healthy when none are left", () => {
    const problems: QcProblem[] = [{ code: "patterns_emptied", scope: "strategy", paramId: "p" }];
    const rule = { checks: [live], problems, disabled: true };
    expect(visibleProblems(rule)).toEqual([]);
    expect(isRuleProblematic(rule)).toBe(false);
    expect(ruleHasSendableChecks(rule)).toBe(true);
  });
});

describe("sendableChecks (GitHub issue #1044)", () => {
  const checks = [
    { localId: 0, disabled: false },
    { localId: 1, disabled: true },
    { localId: 2, disabled: false },
  ];

  it("skips disabled checks and checks carrying a problem", () => {
    const problems: QcProblem[] = [{ code: "irregular_tessellation", scope: "check", localId: 2 }];
    expect(sendableChecks({ checks, problems }).map((c) => c.localId)).toEqual([0]);
  });

  it("sends nothing from a rule whose strategy still needs reconfiguration", () => {
    const problems: QcProblem[] = [{ code: "patterns_emptied", scope: "strategy", paramId: "p" }];
    expect(ruleHasSendableChecks({ checks, problems })).toBe(false);
    expect(ruleHasSendableChecks({ checks })).toBe(true);
  });

  it("keeps sending the checks of a rule whose strategy is unavailable", () => {
    const problems: QcProblem[] = [{ code: "irregular_tessellation", scope: "strategy" }];
    expect(ruleHasSendableChecks({ checks, problems })).toBe(true);
  });
});

describe("problematicRuleCount (GitHub issue #1044)", () => {
  const empty = { checks: [] };
  const rules = [{ id: "a", ...empty }, { id: "b", ...empty }, { id: "c", ...empty, ruleDisabled: true }];

  it("counts problematic rules and skips disabled ones", () => {
    expect(problematicRuleCount(rules, [], [], [], [])).toBe(2);
  });

  it("skips every rule of a disabled stage", () => {
    const stages = [{ ruleIds: ["a"], disabled: true }, { ruleIds: ["b"], disabled: false }];
    expect(problematicRuleCount(rules, stages, [], [], [])).toBe(1);
  });
});

describe("emptyLimitsCheckIds (GitHub issue #1044)", () => {
  const descriptors = [{ id: "node_shape_limits", params: [{ id: "limits", kind: { type: "node_shape_limits" as const } }] }];
  const limitsCheck = (localId: number, limits: string, disabled = false) => ({ localId, typeId: "node_shape_limits", params: { limits }, disabled });
  const set = JSON.stringify({ "regular:4": { square: { min: 1, max: null } } });

  it("flags a limits check with no limits set and keeps a configured one clean", () => {
    const rule = { checks: [limitsCheck(0, "{}"), limitsCheck(1, set)] };
    expect(emptyLimitsCheckIds(rule, descriptors)).toEqual([0]);
  });

  it("skips a disabled check and one already carrying a problem", () => {
    const problems: QcProblem[] = [{ code: "limits_reset", scope: "check", localId: 1, paramId: "limits" }];
    const rule = { checks: [limitsCheck(0, "{}", true), limitsCheck(1, "{}")], problems };
    expect(emptyLimitsCheckIds(rule, descriptors)).toEqual([]);
  });

  it("makes the rule count as problematic", () => {
    const rules = [{ id: "a", checks: [limitsCheck(0, "{}")] }, { id: "b", checks: [limitsCheck(0, set)] }];
    expect(problematicRuleCount(rules, [], descriptors, [], [])).toBe(1);
  });
});
