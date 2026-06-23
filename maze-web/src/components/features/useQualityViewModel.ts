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
  /** Issue kind this slot's strategy handles — the join key with `availableStrategies[].handles`
   * and with `selectedStrategies`/`disabledStrategies` in the store. */
  kind: string;
  label: string;
  strategy: StrategyVM | null;
  disabled: boolean;
  /** Active checks that produce this kind — N checks can share one kind, so a slot is one
   * per kind (not one per check) and lists every contributing check. Every check today
   * produces exactly one kind, so this is usually a single-element list, but built from
   * a dedup-by-kind pass over all active checks' issue_kinds rather than assumed 1:1. */
  producedBy: CheckVM[];
}

export interface QualityViewModel {
  /** Only selected (active) checks */
  checks: CheckVM[];
  /** One per distinct issue kind produced by active checks — not one per check, since
   * multiple checks can share a kind (see StrategySlotVM.producedBy). */
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
  const selectedStrategies = useMazeStore((s) => s.selectedStrategies);
  const disabledStrategies = useMazeStore((s) => s.disabledStrategies);

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
    const kindToCheckIds = new Map<string, string[]>();
    for (const desc of activeDescriptors) {
      for (const kind of desc.issue_kinds) {
        const ids = kindToCheckIds.get(kind) ?? [];
        ids.push(desc.id);
        kindToCheckIds.set(kind, ids);
      }
    }

    const strategySlots: StrategySlotVM[] = Array.from(kindToCheckIds.entries()).map(([kind, checkIds]) => {
      const strategyId = selectedStrategies[kind];
      const s = strategyId ? availableStrategies.find((s) => s.id === strategyId) : undefined;
      return {
        kind,
        label: resolveIssueLabel(kind),
        strategy: s
          ? { id: s.id, label: resolveStrategyLabel(s.id), handles: s.handles, params: localizeParams(s.params) }
          : null,
        disabled: Boolean(disabledStrategies[kind]),
        producedBy: checkIds.map((id) => checkById.get(id)!).filter(Boolean),
      };
    });

    return { checks, strategySlots };
  }, [availableChecks, selectedChecks, availableStrategies, selectedStrategies, disabledStrategies]);
}
