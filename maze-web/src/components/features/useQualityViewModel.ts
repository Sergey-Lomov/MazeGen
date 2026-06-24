import { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { ParamDescriptor } from "../../wasm/types";
import { resolveCheckLabel, resolveCheckDescription, resolveIssueLabel, resolveStrategyLabel, resolveParamLabel } from "./qualityI18n";

export interface StrategyVM {
  id: string;
  label: string;
  handles: string;
  params: ParamDescriptor[];
}

export interface CheckVM {
  id: string;
  label: string;
  description: string;
  params: ParamDescriptor[];
}

export interface StrategySlotVM {
  /** Opaque rule id — join key with the store's `rules` (and what `setStrategy`/
   * `clearStrategy`/`toggleStrategyDisabled`/`addCheck`'s optional ruleId are keyed by). Not
   * derived from `checks` — a rule keeps its identity as its check composition changes. */
  ruleId: string;
  /** User-facing rule name, shown as the card header (e.g. "Rule 1"). */
  name: string;
  /** Issue kind this rule's strategy handles — resolved from any member check's issue_kinds[0]
   * (all checks in a rule are validated to share one kind). */
  kind: string;
  label: string;
  strategy: StrategyVM | null;
  disabled: boolean;
  /** Whole-rule toggle — when true, this rule's checks are excluded from generation entirely
   * (not just unfixed). Distinct from `disabled`. */
  ruleDisabled: boolean;
  /** Active checks that make up this rule. */
  producedBy: CheckVM[];
}

export interface QualityViewModel {
  /** Only selected (active) checks */
  checks: CheckVM[];
  /** One per rule in the store — not deduplicated by kind, since rules are how the user
   * splits/merges checks sharing a kind into independent or shared strategy slots. */
  strategySlots: StrategySlotVM[];
}

function localizeParams(params: ParamDescriptor[]): ParamDescriptor[] {
  return params.map((p) => ({
    ...p,
    label: resolveParamLabel(p.id, p.label),
  }));
}

export function useQualityViewModel(): QualityViewModel {
  const availableChecks = useMazeStore((s) => s.availableChecks);
  const selectedChecks = useMazeStore((s) => s.selectedChecks);
  const availableStrategies = useMazeStore((s) => s.availableStrategies);
  const rules = useMazeStore((s) => s.rules);

  return useMemo(() => {
    const activeDescriptors = selectedChecks
      .map((id) => availableChecks.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => c !== undefined);

    const checks: CheckVM[] = activeDescriptors.map((c) => ({
      id: c.id,
      label: resolveCheckLabel(c.id, c.label),
      description: resolveCheckDescription(c.id, c.description),
      params: localizeParams(c.params),
    }));

    const checkById = new Map(checks.map((c) => [c.id, c]));

    const strategySlots: StrategySlotVM[] = rules.map((r) => {
      const s = r.strategyId ? availableStrategies.find((s) => s.id === r.strategyId) : undefined;
      return {
        ruleId: r.id,
        name: r.name,
        kind: r.kind,
        label: resolveIssueLabel(r.kind),
        strategy: s
          ? { id: s.id, label: resolveStrategyLabel(s.id), handles: s.handles, params: localizeParams(s.params) }
          : null,
        disabled: r.disabled,
        ruleDisabled: r.ruleDisabled,
        producedBy: r.checks.map((id) => checkById.get(id)).filter((c): c is CheckVM => c !== undefined),
      };
    });

    return { checks, strategySlots };
  }, [availableChecks, selectedChecks, availableStrategies, rules]);
}
