import type { MazeState, QcRuleState, CheckInstance, NestedStrategyState, QcProblem, QcProblemCode } from "../storeTypes";
import { QC_PROBLEM_CATEGORY } from "../storeTypes";
import type { ParamDescriptor, ParamKind } from "../../wasm/types";
import type { TessellationConfig } from "../../fieldConfig";
import { cellTypeKeysOf, shapeKeysOf } from "../../pixi/shapeTemplates";
import { activeLimitCount, parseNodeShapeLimits } from "../../components/features/nodeShapeLimits";
import { checkUnavailableReason } from "../../components/features/checkAvailability";

type QcState = Pick<MazeState, "rules" | "availableChecks" | "availableStrategies" | "availableRuleParams">;
export type QcTessellationResult = Pick<MazeState, "rules">;

/** A JSON pattern list filtered by shape. `kept` lists the surviving indices of the original list;
 *  `null` means the raw value is not a pattern list (left untouched, same "invalid reads as empty"
 *  contract `parse_split_patterns_param` follows). */
interface FilteredPatterns {
  raw: string;
  before: number;
  kept: number[];
}

function filterPatternArray(patterns: unknown[], shapes: readonly string[]): { patterns: unknown[]; kept: number[] } {
  const kept: number[] = [];
  patterns.forEach((pattern, i) => {
    const shape = (pattern as { shape?: unknown } | null)?.shape;
    if (typeof shape === "string" && shapes.includes(shape)) kept.push(i);
  });
  return { patterns: kept.map((i) => patterns[i]), kept };
}

function filterPatternList(raw: string | undefined, shapes: readonly string[]): FilteredPatterns | null {
  if (raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const { patterns, kept } = filterPatternArray(parsed, shapes);
    return { raw: kept.length === parsed.length ? raw : JSON.stringify(patterns), before: parsed.length, kept };
  } catch {
    return null;
  }
}

function filterSplitConfig(raw: string | undefined, shapes: readonly string[]): string | undefined {
  if (raw === undefined) return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return raw;
    const config = parsed as { patterns?: unknown };
    if (!Array.isArray(config.patterns)) return raw;
    const { patterns, kept } = filterPatternArray(config.patterns, shapes);
    return kept.length === config.patterns.length ? raw : JSON.stringify({ ...config, patterns });
  } catch {
    return raw;
  }
}

/** A `cell_type`-scoped bool param (`forbid_cell_type_<key>`) set to `"true"` whose cell type the
 *  new tessellation lacks is switched off: core rejects a forbidden key the tessellation does not
 *  have, and the param's row is hidden so the user could not clear it. */
function filterCellTypeParam(raw: string, key: string, cellTypes: readonly string[]): string {
  return raw === "true" && !cellTypes.includes(key) ? "false" : raw;
}

/** True when a non-empty pattern filter lost every pattern — an empty list means "any split tile",
 *  so keeping the owner would silently flip its meaning instead of narrowing it. */
function filterEmptied(filtered: FilteredPatterns | null): boolean {
  return filtered !== null && filtered.before > 0 && filtered.kept.length === 0;
}

/** Called for every param whose value the tessellation change altered in a way the user should
 *  review (GitHub issue #1044). */
type ReportProblem = (code: QcProblemCode, paramId: string) => void;

/** Filters one owner's own param map, reporting each change the user must review. Returns the same
 *  object when nothing changed. An emptied `pattern_list` filter is kept (as `[]`) and reported:
 *  the owner stays in the rule, flagged. */
function filterParams(
  params: Record<string, string>,
  descriptors: readonly ParamDescriptor[],
  shapes: readonly string[],
  cellTypes: () => readonly string[],
  report: ReportProblem,
): Record<string, string> {
  let next = params;
  for (const p of descriptors) {
    const raw = params[p.id];
    if (raw === undefined) continue;
    let value: string | undefined = raw;
    if (p.kind.type === "pattern_list") {
      const filtered = filterPatternList(raw, shapes);
      value = filtered?.raw ?? raw;
      if (filtered && filtered.kept.length < filtered.before) {
        report(filterEmptied(filtered) ? "patterns_emptied" : "patterns_dropped", p.id);
      }
    } else if (p.kind.type === "split_generation_config") {
      value = filterSplitConfig(raw, shapes);
      if (value !== raw) report("patterns_dropped", p.id);
    } else if (p.kind.type === "node_shape_limits") {
      // Limits are keyed by the tessellation's cell types and shapes; none carry over.
      if (activeLimitCount(parseNodeShapeLimits(raw)) > 0) {
        value = "{}";
        report("limits_reset", p.id);
      }
    } else if (p.visibility?.type === "cell_type") {
      value = filterCellTypeParam(raw, p.visibility.key, cellTypes());
    }
    if (value !== raw && value !== undefined) {
      if (next === params) next = { ...params };
      next[p.id] = value;
    }
  }
  return next;
}

function filterNested(
  nested: NestedStrategyState[],
  state: QcState,
  shapes: readonly string[],
  cellTypes: () => readonly string[],
  report: ReportProblem,
): NestedStrategyState[] {
  let changed = false;
  const next = nested.map((n) => {
    const descriptor = state.availableStrategies.find((s) => s.id === n.strategyId);
    const params = filterParams(n.params, descriptor?.params ?? [], shapes, cellTypes, report);
    const children = filterNested(n.nested, state, shapes, cellTypes, report);
    if (params === n.params && children === n.nested) return n;
    changed = true;
    return { ...n, params, nested: children };
  });
  return changed ? next : nested;
}

function isAddSplitConfig(kind: ParamKind): kind is Extract<ParamKind, { type: "add_split_config" }> {
  return kind.type === "add_split_config";
}

/** Re-indexes a strategy's `add_split_config` weights (a JSON `number[]` indexed against the
 *  rule-level pattern list) to the surviving patterns, or resets it to the node-count default
 *  when no pattern survived (the control switches back to plain `max_split_nodes`). */
function reindexWeights(
  params: Record<string, string>,
  descriptors: readonly ParamDescriptor[],
  kept: number[],
): Record<string, string> {
  let next = params;
  for (const p of descriptors) {
    if (!isAddSplitConfig(p.kind)) continue;
    const raw = params[p.id];
    if (raw === undefined || /^\d+$/.test(raw.trim())) continue;
    let weights: unknown;
    try {
      weights = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!Array.isArray(weights)) continue;
    const value = kept.length === 0
      ? String(p.kind.max_split_nodes_default)
      : JSON.stringify(kept.map((i) => weights[i] ?? 1.0));
    if (next === params) next = { ...params };
    next[p.id] = value;
  }
  return next;
}

const problemKey = (p: QcProblem) => `${p.code}|${p.scope}|${p.localId ?? ""}|${p.paramId ?? ""}`;

function sameProblems(a: readonly QcProblem[], b: readonly QcProblem[]): boolean {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map(problemKey));
  return b.every((p) => keys.has(problemKey(p)));
}

/** Quality control's own reaction to a tessellation change (GitHub issues #758, #1008, #1044). A split
 *  pattern belongs to a shape template, so every pattern list stored in QC config (check params,
 *  rule-level params, nested and top-level strategy params) keeps only the patterns whose template
 *  `tessellation` (the config being switched to) provides. Strategy weights indexed against a
 *  rule-level pattern list are re-indexed to match. Node-shape limits are keyed by the
 *  tessellation's cell types, so they reset to none.
 *
 *  Nothing is deleted: whatever the change altered is flagged as a `QcProblem` on the rule instead.
 *  Dropped patterns, an emptied pattern filter (an empty list means "any split tile", so it must not
 *  be used silently) and reset limits are `needs_reconfiguration`; a check the new tessellation makes
 *  unavailable (`CheckDescriptor.requires`, e.g. node-shape limits on irregular cells) is
 *  `cannot_apply`. Availability problems are re-evaluated on every call, so they clear once a later
 *  tessellation supports the check again.
 *  Returns the input `rules` reference unchanged when nothing is affected, so
 *  callers can detect data loss by identity. */
export function qcForTessellation(state: QcState, tessellation: TessellationConfig): QcTessellationResult {
  const shapes = shapeKeysOf(tessellation);
  // Lazy: only asked from core when some param is `cell_type`-scoped.
  let cellTypeKeys: readonly string[] | undefined;
  const cellTypes = () => (cellTypeKeys ??= cellTypeKeysOf(tessellation));
  let rulesChanged = false;
  const rules = state.rules.map((rule): QcRuleState => {
    let ruleParams = rule.params;
    let strategyParams = rule.strategyParams;
    const strategyDescriptor = rule.strategyId
      ? state.availableStrategies.find((s) => s.id === rule.strategyId)
      : undefined;
    const found: QcProblem[] = [];
    // A check the tessellation rules out cannot work, so reconfiguring it is pointless: it carries
    // its availability problem only, no param problems.
    const unavailable = new Map<number, QcProblemCode>();
    for (const check of rule.checks) {
      const descriptor = state.availableChecks.find((c) => c.id === check.typeId);
      const reason = descriptor ? checkUnavailableReason(descriptor, tessellation) : null;
      if (reason) unavailable.set(check.localId, reason.type);
    }
    // Same rule as for checks: a strategy the tessellation rules out carries its availability problem only.
    const strategyReason = strategyDescriptor ? checkUnavailableReason(strategyDescriptor, tessellation) : null;
    const reportStrategy: ReportProblem = (code, paramId) => found.push({ code, scope: "strategy", paramId });
    const reportNested: ReportProblem = (code, paramId) => found.push({ code, scope: "nested", paramId });
    if (strategyReason) found.push({ code: strategyReason.type, scope: "strategy" });
    else strategyParams = filterParams(strategyParams, strategyDescriptor?.params ?? [], shapes, cellTypes, reportStrategy);
    for (const p of state.availableRuleParams) {
      if (p.kind.type !== "pattern_list") continue;
      const filtered = filterPatternList(rule.params[p.id], shapes);
      if (!filtered || filtered.kept.length === filtered.before) continue;
      if (ruleParams === rule.params) ruleParams = { ...rule.params };
      ruleParams[p.id] = filtered.raw;
      const code: QcProblemCode = filterEmptied(filtered) ? "patterns_emptied" : "patterns_dropped";
      for (const check of rule.checks) {
        if (p.applies_to.includes(check.typeId) && !unavailable.has(check.localId)) found.push({ code, scope: "check", localId: check.localId, paramId: p.id });
      }
      if (rule.strategyId && !strategyReason && p.applies_to.includes(rule.strategyId)) {
        if (strategyDescriptor) {
          strategyParams = reindexWeights(strategyParams, strategyDescriptor.params, filtered.kept);
        }
        found.push({ code, scope: "strategy", paramId: p.id });
      }
    }

    let checksChanged = false;
    const checks: CheckInstance[] = [];
    for (const check of rule.checks) {
      const descriptor = state.availableChecks.find((c) => c.id === check.typeId);
      const unavailableCode = unavailable.get(check.localId);
      if (unavailableCode) {
        // Kept as configured: it cannot run, so its params are not worth migrating.
        found.push({ code: unavailableCode, scope: "check", localId: check.localId });
        checks.push(check);
        continue;
      }
      const report: ReportProblem = (code, paramId) => found.push({ code, scope: "check", localId: check.localId, paramId });
      const params = filterParams(check.params, descriptor?.params ?? [], shapes, cellTypes, report);
      if (params !== check.params) checksChanged = true;
      checks.push(params === check.params ? check : { ...check, params });
    }

    // Nested strategies belong to the inert strategy, so they are left alone too.
    const nestedStrategies = strategyReason ? rule.nestedStrategies : filterNested(rule.nestedStrategies, state, shapes, cellTypes, reportNested);

    const before = rule.problems ?? [];
    const merged = before.filter((p) => QC_PROBLEM_CATEGORY[p.code] !== "cannot_apply"
      && !(p.scope === "check" && p.localId !== undefined && unavailable.has(p.localId))
      && !(p.scope !== "check" && strategyReason));
    for (const p of found) {
      if (!merged.some((q) => problemKey(q) === problemKey(p))) merged.push(p);
    }
    const problemsChanged = !sameProblems(before, merged);

    if (ruleParams === rule.params && strategyParams === rule.strategyParams && !checksChanged && nestedStrategies === rule.nestedStrategies && !problemsChanged) return rule;
    rulesChanged = true;
    const { problems: _before, ...rest } = rule;
    return {
      ...rest,
      params: ruleParams,
      strategyParams,
      checks: checksChanged ? checks : rule.checks,
      nestedStrategies,
      ...(merged.length > 0 ? { problems: problemsChanged ? merged : before } : {}),
    };
  });

  return { rules: rulesChanged ? rules : state.rules };
}
