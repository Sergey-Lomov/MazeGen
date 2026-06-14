import { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { ParamDescriptor } from "../../wasm/types";
import { resolveCheckLabel, resolveCheckDescription, resolveIssueLabel, resolveIssueDescription, resolveStrategyLabel, resolveParamLabel } from "./qualityI18n";

export interface CheckVM {
  id: string;
  label: string;
  description: string;
  params: ParamDescriptor[];
}

export interface IssueVM {
  id: string;
  label: string;
  description: string;
}

export interface StrategyVM {
  id: string;
  label: string;
  handles: string;
  params: ParamDescriptor[];
}

export interface QualityViewModel {
  /** Only selected (active) checks */
  checks: CheckVM[];
  /** Issues produced by active checks only */
  issues: IssueVM[];
  /** issueId → currently selected strategy (or null) */
  issueStrategy: Record<string, StrategyVM | null>;
  /** issueId → list of checks that detect it */
  issueToChecks: Record<string, CheckVM[]>;
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

  return useMemo(() => {
    const checks: CheckVM[] = selectedChecks
      .map((id) => availableChecks.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => c !== undefined)
      .map((c) => ({
        id: c.id,
        label: resolveCheckLabel(c.id, c.label),
        description: resolveCheckDescription(c.id, c.description),
        params: localizeParams(c.params),
      }));

    const issueKindSet = new Set<string>();
    for (const c of availableChecks.filter((c) => selectedChecks.includes(c.id))) {
      for (const kind of c.issue_kinds) issueKindSet.add(kind);
    }
    const issues: IssueVM[] = Array.from(issueKindSet).map((kind) => ({
      id: kind,
      label: resolveIssueLabel(kind),
      description: resolveIssueDescription(kind),
    }));

    const issueToChecks: Record<string, CheckVM[]> = {};
    for (const check of checks) {
      const orig = availableChecks.find((c) => c.id === check.id);
      if (!orig) continue;
      for (const kind of orig.issue_kinds) {
        if (!issueToChecks[kind]) issueToChecks[kind] = [];
        issueToChecks[kind].push(check);
      }
    }

    const issueStrategy: Record<string, StrategyVM | null> = {};
    for (const issue of issues) {
      const strategyId = selectedStrategies[issue.id];
      if (!strategyId) {
        issueStrategy[issue.id] = null;
        continue;
      }
      const s = availableStrategies.find((s) => s.id === strategyId);
      issueStrategy[issue.id] = s
        ? { id: s.id, label: resolveStrategyLabel(s.id), handles: s.handles, params: localizeParams(s.params) }
        : null;
    }

    return { checks, issues, issueStrategy, issueToChecks };
  }, [availableChecks, selectedChecks, availableStrategies, selectedStrategies]);
}
