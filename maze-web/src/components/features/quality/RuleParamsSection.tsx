import { useMazeStore } from "../../../store/mazeStore";
import { useParamEditor } from "../useParamEditor";
import { ParamFields } from "../ParamFields";
import { qualityCanvasStyles as styles } from "./qualityCanvasStyles";
import { resolveParamLabel } from "../qualityI18n";
import { relevantRuleParams } from "../../../store/storeHelpers";
import type { StrategySlotVM } from "../useQualityViewModel";

interface Props {
  slot: StrategySlotVM;
}

// Rule-level parameters (e.g. `protect_route`) — shared by every check/strategy in this rule
// that has been migrated to consume it, see GitHub issue #253. Shown once per rule card, above
// the checks/strategy split, since a migrated param applies to both sides equally and can no
// longer be configured per-check/per-strategy. Not every rule shares the same rule-level
// parameter set — a param only shows up here when at least one of this rule's own checks or its
// strategy is in that param's `applies_to` list (e.g. `protect_route` is meaningless for a
// `min_region_count` rule, so it's filtered out for such rules).
export function RuleParamsSection({ slot }: Props) {
  const availableRuleParams = useMazeStore((s) => s.availableRuleParams);
  const setRuleParam = useMazeStore((s) => s.setRuleParam);

  const relevantParams = relevantRuleParams(
    availableRuleParams,
    slot.producedBy.map((c) => c.typeId),
    slot.strategy?.id ?? null,
  ).map((p) => ({ ...p, label: resolveParamLabel(p.id, p.label) }));

  const { values: editorValues, onChange } = useParamEditor({
    entityId: slot.ruleId,
    params: relevantParams,
    storeValues: slot.params,
    onCommit: (paramId, value) => setRuleParam(slot.ruleId, paramId, value),
  });

  if (relevantParams.length === 0) return null;

  return (
    <div style={styles.ruleParamsSection}>
      <ParamFields params={relevantParams} values={editorValues} onChange={onChange} />
    </div>
  );
}
