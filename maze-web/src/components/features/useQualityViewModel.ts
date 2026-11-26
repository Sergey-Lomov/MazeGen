import { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { ParamDescriptor, StrategyDescriptor, NestedDispatchKind } from "../../wasm/types";
import { MAX_NESTED_STRATEGY_DEPTH, QC_PROBLEM_CATEGORY, hasNoActiveChecks, strategyUnavailable, visibleProblems, type NestedStrategyState, type QcProblem } from "../../store/storeTypes";
import { emptyLimitsCheckIds, noForbiddenCellTypeCheckIds } from "../../store/qcDerivedProblems";
import { zoneScopeProblem } from "../../domain/qcZoneScope";
import { resolveProblemText, resolveNoChecksProblemText, resolveNoZonesProblemText, resolveLimitsEmptyProblemText, resolveNoForbiddenCellTypeProblemText } from "./qualityI18n/problems";
import { resolveCheckLabel, resolveCheckCardLabel, resolveCheckDescription, resolveIssueLabel, resolveStrategyLabel, resolveParamLabel } from "./qualityI18n";
import { useLocale } from "../../i18n/useLocale";

/** Mirrors `NestedSlotDescriptor` with a camelCase field, consistent with every other VM type
 * in this module (the raw wasm DTO shape is snake_case; VM types are not). */
export interface NestedSlotVM {
  slotId: string;
  kind: string;
  min: number;
  max: number | null;
  dispatchKind: NestedDispatchKind;
}

export interface StrategyVM {
  id: string;
  label: string;
  handles: string;
  params: ParamDescriptor[];
  experimental: boolean;
  /** Nested-strategy slots this strategy accepts, if any — empty for every strategy without
   * nested slots (the overwhelming majority). Mirrors `StrategyDescriptor.nested_slots`. */
  nestedSlots: NestedSlotVM[];
}

/** One nested strategy assignment, resolved into a `StrategyVM` — mirrors `NestedStrategyState`
 * but with the strategy id resolved to its full descriptor (label, params, own nested slots),
 * same relationship `StrategySlotVM.strategy` has to `QcRuleState.strategyId`. Recursive. */
export interface NestedStrategyVM {
  slotId: string;
  strategy: StrategyVM;
  params: ParamDescriptor[];
  nested: NestedStrategyVM[];
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
  /// Full/unambiguous label for the card view (`RuleCheckRow`) — see `resolveCheckCardLabel`'s doc
  /// comment. Same as `label` for the majority of checks with no override.
  cardLabel: string;
  description: string;
  params: ParamDescriptor[];
  /** Per-check toggle — see `CheckInstance.disabled`'s doc comment in storeTypes.ts. */
  disabled: boolean;
  /** The tessellation rules this check out (`cannot_apply` problem, GitHub issue #1044): the row is
   * inert and only deletable. Independent of `disabled`, which the user can flip. */
  unavailable?: boolean;
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
  /** Resolved nested strategy assignments for `strategy`'s nested slots, one entry per filled
   * slot (matched by `slotId`) — empty when `strategy` has no nested slots or none are
   * configured yet. */
  nestedStrategies: NestedStrategyVM[];
  /** Rule-level parameter values (e.g. `protect_route`), keyed by `ParamDescriptor.id` — see
   * GitHub issue #253. Mirrors `QcRuleState.params` unchanged (no per-rule descriptor resolution
   * needed here, the catalog itself — `availableRuleParams` — is global and shown separately). */
  params: Record<string, string>;
  /** Mirrors `QcRuleState.collapsed` — see GitHub issue #320. */
  collapsed: boolean;
  /** The tessellation rules out this rule's strategy (`cannot_apply`, GitHub issue #1044): the
   * strategy panel is inert and only replaceable. */
  strategyUnavailable?: boolean;
  /** Resolved `QcRuleState.problems` (GitHub issue #1044); absent for a healthy rule. */
  problems?: QcProblemVM[];
}

/** One problem of a rule, ready to render. A problem of a member check names that check. The
 * category stays internal and never reaches the UI. */
export interface QcProblemVM {
  text: string;
  /** Label of the member check the problem belongs to; absent for a strategy-side problem. */
  checkLabel?: string;
  /** Stored problems this entry stands for; present only when the user may dismiss it
   * (`needs_reconfiguration`: accept the current settings as they are). */
  dismiss?: QcProblem[];
}

/** One stage's rule cards, in `RepairStageState.ruleIds` order — see GitHub issue #65. */
export interface QualityStageVM {
  stageId: string;
  name: string;
  slots: StrategySlotVM[];
  /** Whole-stage toggle — when true, every member rule is excluded from generation entirely.
   * Independent of any member rule's own `ruleDisabled`. */
  disabled: boolean;
  /** Mirrors `RepairStageState.collapsed` — see GitHub issue #320. */
  collapsed: boolean;
}

export interface QualityViewModel {
  /** All active check instances, across all rules. */
  checks: CheckVM[];
  /** Rule cards grouped by stage, in `state.stages` order — the source of truth for rendering
   * (`RulesColumn` renders through this, not `strategySlots`). */
  stages: QualityStageVM[];
  /** `stages.flatMap(s => s.slots)` — one per rule in the store, not deduplicated by kind, in
   * combined stage-then-rule order. Derived from `stages`, not an independent list — kept for
   * consumers outside `RulesColumn` that don't need the stage grouping itself. */
  strategySlots: StrategySlotVM[];
}

/** Single point of generation for the web-side composite check id — mirrors the wasm-side
 * `composite_check_id` in runner.rs (same `${ruleId}:${localId}` format), used here only as a
 * React key / selection identifier, never parsed back apart. */
export function compositeCheckId(ruleId: string, localId: number): string {
  return `${ruleId}:${localId}`;
}

function localizeParams(params: ParamDescriptor[], contextId?: string): ParamDescriptor[] {
  return params.map((p) => ({
    ...p,
    label: resolveParamLabel(p.id, p.label, contextId),
  }));
}

/** A problem on a rule-level param (a pattern list shared by several checks and the strategy) is one
 * problem of the rule, not one per consumer, so those collapse into a single unlabeled entry. */
export function buildProblems(problems: QcProblem[], producedBy: CheckVM[], ruleParamIds: ReadonlySet<string>): QcProblemVM[] {
  const groups = new Map<string, QcProblem[]>();
  const result: QcProblemVM[] = [];
  for (const p of problems) {
    const shared = p.paramId !== undefined && ruleParamIds.has(p.paramId);
    const key = shared ? `${p.code}|${p.paramId}` : `${p.code}|${p.scope}|${p.localId ?? ""}|${p.paramId ?? ""}`;
    const group = groups.get(key);
    if (group) {
      group.push(p);
      continue;
    }
    const members = [p];
    groups.set(key, members);
    result.push({
      text: resolveProblemText(p.code, p.scope, p.paramId),
      checkLabel: !shared && p.scope === "check" ? producedBy.find((c) => c.localId === p.localId)?.label : undefined,
      ...(QC_PROBLEM_CATEGORY[p.code] === "needs_reconfiguration" ? { dismiss: members } : {}),
    });
  }
  return result;
}

export function useQualityViewModel(): QualityViewModel {
  const availableChecks = useMazeStore((s) => s.availableChecks);
  const availableStrategies = useMazeStore((s) => s.availableStrategies);
  const rules = useMazeStore((s) => s.rules);
  const storeStages = useMazeStore((s) => s.stages);
  const availableRuleParams = useMazeStore((s) => s.availableRuleParams);
  const zones = useMazeStore((s) => s.zones);
  const zoneGroups = useMazeStore((s) => s.zoneGroups);
  const { locale } = useLocale();

  return useMemo(() => {
    const descriptorById = new Map(availableChecks.map((c) => [c.id, c]));
    const strategyById = new Map(availableStrategies.map((s) => [s.id, s]));
    const ruleParamIds = new Set(availableRuleParams.map((p) => p.id));

    function buildStrategyVM(d: StrategyDescriptor): StrategyVM {
      return {
        id: d.id,
        label: resolveStrategyLabel(d.id),
        handles: d.handles,
        params: localizeParams(d.params, d.id),
        experimental: d.experimental,
        nestedSlots: d.nested_slots.map((s) => ({ slotId: s.slot_id, kind: s.kind, min: s.min, max: s.max, dispatchKind: s.dispatch_kind })),
      };
    }

    // Recursive — resolves each `NestedStrategyState` into a `NestedStrategyVM`, dropping any
    // entry whose `strategyId` no longer resolves to a known descriptor (same defensive stale-
    // reference handling `producedBy`/`buildSlot` use elsewhere in this module). `depth` guards
    // against a pathologically deep tree (e.g. loaded from a project file) blowing the call
    // stack — see `MAX_NESTED_STRATEGY_DEPTH`'s doc comment.
    function buildNested(list: NestedStrategyState[], depth = 0): NestedStrategyVM[] {
      if (depth >= MAX_NESTED_STRATEGY_DEPTH) return [];
      return list
        .map((n): NestedStrategyVM | undefined => {
          const d = strategyById.get(n.strategyId);
          if (!d) return undefined;
          // GitHub issue #486: params the dispatcher owns (`reserve_percent`/`attempts_limit`)
          // are hidden on a nested node — the parent strategy resolves them once and feeds them
          // down, so a per-nested value would only conflict. `strategy.params` (used by the
          // select dialog for defaults etc.) keeps the full list; only this rendered `params`
          // descriptor is filtered.
          const suppressed = new Set(d.nested_suppressed_params ?? []);
          const nestedParams = d.params.filter((p) => !suppressed.has(p.id));
          return {
            slotId: n.slotId,
            strategy: buildStrategyVM(d),
            params: localizeParams(nestedParams, d.id),
            nested: buildNested(n.nested, depth + 1),
          };
        })
        .filter((n): n is NestedStrategyVM => n !== undefined);
    }

    function buildSlot(r: (typeof rules)[number]): StrategySlotVM {
      const s = r.strategyId ? strategyById.get(r.strategyId) : undefined;
      const producedBy: CheckVM[] = r.checks
        .map((check): CheckVM | undefined => {
          const descriptor = descriptorById.get(check.typeId);
          if (!descriptor) return undefined;
          return {
            id: compositeCheckId(r.id, check.localId),
            ruleId: r.id,
            localId: check.localId,
            typeId: check.typeId,
            label: resolveCheckLabel(descriptor.id, descriptor.label, check.params),
            cardLabel: resolveCheckCardLabel(descriptor.id, descriptor.label, check.params),
            description: resolveCheckDescription(descriptor.id, descriptor.description, check.params),
            params: localizeParams(descriptor.params),
            disabled: check.disabled,
            unavailable: (r.problems ?? []).some((p) => p.scope === "check" && p.localId === check.localId && QC_PROBLEM_CATEGORY[p.code] === "cannot_apply"),
          };
        })
        .filter((c): c is CheckVM => c !== undefined);
      const shown = visibleProblems(r);
      const noChecks = hasNoActiveChecks(r);
      const noZones = zoneScopeProblem(r, zones, zoneGroups);
      const emptyLimits = emptyLimitsCheckIds(r, availableChecks)
        .map((localId) => ({ text: resolveLimitsEmptyProblemText(), checkLabel: producedBy.find((c) => c.localId === localId)?.label }));
      const noCellTypes = noForbiddenCellTypeCheckIds(r, availableChecks)
        .map((localId) => ({ text: resolveNoForbiddenCellTypeProblemText(), checkLabel: producedBy.find((c) => c.localId === localId)?.label }));
      return {
        ruleId: r.id,
        // `null` = no custom name — resolve live so a locale switch re-translates it, same as
        // `label` below (GitHub issue #556).
        name: r.name ?? resolveIssueLabel(r.kind),
        kind: r.kind,
        label: resolveIssueLabel(r.kind),
        strategy: s ? buildStrategyVM(s) : null,
        disabled: r.disabled,
        ruleDisabled: r.ruleDisabled,
        producedBy,
        nestedStrategies: s ? buildNested(r.nestedStrategies) : [],
        params: r.params,
        collapsed: r.collapsed,
        ...(strategyUnavailable(r) ? { strategyUnavailable: true } : {}),
        ...(shown.length > 0 || noChecks || noZones || emptyLimits.length > 0 || noCellTypes.length > 0 ? { problems: [
          ...(noChecks ? [{ text: resolveNoChecksProblemText() }] : []),
          ...(noZones ? [{ text: resolveNoZonesProblemText(noZones) }] : []),
          ...emptyLimits,
          ...noCellTypes,
          ...buildProblems(shown, producedBy, ruleParamIds),
        ] } : {}),
      };
    }

    const ruleById = new Map(rules.map((r) => [r.id, r]));

    // `stages` is the source of truth for both grouping and order — a `ruleId` with no matching
    // rule (stale reference) is silently dropped, same defensive pattern `producedBy` above uses
    // for an unknown `typeId`: not an expected path under the store's own invariants, but a
    // render-time guard against a momentarily inconsistent state rather than a thrown error.
    const stages: QualityStageVM[] = storeStages.map((stage) => ({
      stageId: stage.id,
      name: stage.name,
      disabled: stage.disabled,
      collapsed: stage.collapsed,
      slots: stage.ruleIds
        .map((id) => ruleById.get(id))
        .filter((r): r is NonNullable<typeof r> => r !== undefined)
        .map(buildSlot),
    }));

    const strategySlots = stages.flatMap((s) => s.slots);
    const checks = strategySlots.flatMap((slot) => slot.producedBy);

    return { checks, stages, strategySlots };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `locale` isn't read directly, but
    // every `resolve*` call above reads the current paraglide locale internally; including it
    // here forces recompute on language switch (see GitHub issue #556).
  }, [availableChecks, availableStrategies, availableRuleParams, rules, storeStages, zones, zoneGroups, locale]);
}
