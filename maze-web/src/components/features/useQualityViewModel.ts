import { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { ParamDescriptor } from "../../wasm/types";
import { resolveCheckLabel, resolveCheckDescription, resolveIssueLabel, resolveStrategyLabel, resolveParamLabel } from "./qualityI18n";

export interface StrategyVM {
  id: string;
  label: string;
  handles: string;
  params: ParamDescriptor[];
  experimental: boolean;
}

/** One active `CheckInstance`, addressed by `(ruleId, localId)` — see GitHub issue #60. `id` is
 * a composite React key (`compositeCheckId(ruleId, localId)`), opaque outside this module — use
 * `ruleId`/`localId` for any store-action call, never parse `id` back apart. */
export interface CheckVM {
  id: string;
  ruleId: string;
  localId: number;
  typeId: string;
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
  /** All active check instances, across all rules. */
  checks: CheckVM[];
  /** One per rule in the store — not deduplicated by kind, since rules are how the user
   * splits/merges checks sharing a kind into independent or shared strategy slots. */
  strategySlots: StrategySlotVM[];
}

/** Single point of generation for the web-side composite check id — mirrors the wasm-side
 * `composite_check_id` in runner.rs (same `${ruleId}:${localId}` format), used here only as a
 * React key / selection identifier, never parsed back apart. */
export function compositeCheckId(ruleId: string, localId: number): string {
  return `${ruleId}:${localId}`;
}

function localizeParams(params: ParamDescriptor[]): ParamDescriptor[] {
  return params.map((p) => ({
    ...p,
    label: resolveParamLabel(p.id, p.label),
  }));
}

export function useQualityViewModel(): QualityViewModel {
  const availableChecks = useMazeStore((s) => s.availableChecks);
  const availableStrategies = useMazeStore((s) => s.availableStrategies);
  const rules = useMazeStore((s) => s.rules);

  return useMemo(() => {
    const descriptorById = new Map(availableChecks.map((c) => [c.id, c]));

    const strategySlots: StrategySlotVM[] = rules.map((r) => {
      const s = r.strategyId ? availableStrategies.find((s) => s.id === r.strategyId) : undefined;
      const producedBy: CheckVM[] = r.checks
        .map((check) => {
          const descriptor = descriptorById.get(check.typeId);
          if (!descriptor) return undefined;
          return {
            id: compositeCheckId(r.id, check.localId),
            ruleId: r.id,
            localId: check.localId,
            typeId: check.typeId,
            label: resolveCheckLabel(descriptor.id, descriptor.label),
            description: resolveCheckDescription(descriptor.id, descriptor.description),
            params: localizeParams(descriptor.params),
          };
        })
        .filter((c): c is CheckVM => c !== undefined);
      return {
        ruleId: r.id,
        name: r.name,
        kind: r.kind,
        label: resolveIssueLabel(r.kind),
        strategy: s
          ? { id: s.id, label: resolveStrategyLabel(s.id), handles: s.handles, params: localizeParams(s.params), experimental: s.experimental }
          : null,
        disabled: r.disabled,
        ruleDisabled: r.ruleDisabled,
        producedBy,
      };
    });

    const checks = strategySlots.flatMap((slot) => slot.producedBy);

    return { checks, strategySlots };
  }, [availableChecks, availableStrategies, rules]);
}
