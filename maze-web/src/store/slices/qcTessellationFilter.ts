import type { MazeState, QcRuleState, CheckInstance, NestedStrategyState } from "../storeTypes";
import type { ParamDescriptor, ParamKind } from "../../wasm/types";
import type { TessellationConfig } from "../../fieldConfig";
import { shapeKeysOf } from "../../pixi/shapeTemplates";

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

/** True when a non-empty pattern filter lost every pattern — an empty list means "any split tile",
 *  so keeping the owner would silently flip its meaning instead of narrowing it. */
function filterEmptied(filtered: FilteredPatterns | null): boolean {
  return filtered !== null && filtered.before > 0 && filtered.kept.length === 0;
}

/** Filters one owner's own param map. Returns the same object when nothing changed, `null` when
 *  the owner itself must go (a non-empty `pattern_list` filter lost every pattern). */
function filterParams(
  params: Record<string, string>,
  descriptors: readonly ParamDescriptor[],
  shapes: readonly string[],
): Record<string, string> | null {
  let next = params;
  for (const p of descriptors) {
    const raw = params[p.id];
    if (raw === undefined) continue;
    let value: string | undefined = raw;
    if (p.kind.type === "pattern_list") {
      const filtered = filterPatternList(raw, shapes);
      if (filterEmptied(filtered)) return null;
      value = filtered?.raw ?? raw;
    } else if (p.kind.type === "split_generation_config") {
      value = filterSplitConfig(raw, shapes);
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
): NestedStrategyState[] {
  let changed = false;
  const next = nested.map((n) => {
    const descriptor = state.availableStrategies.find((s) => s.id === n.strategyId);
    const params = filterParams(n.params, descriptor?.params ?? [], shapes) ?? n.params;
    const children = filterNested(n.nested, state, shapes);
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

/** Quality control's own reaction to a tessellation kind change (GitHub issue #758). A split pattern
 *  belongs to a shape template, so every pattern list stored in QC config (check params, rule-level
 *  params, nested and top-level strategy params) keeps only the patterns whose template
 *  `tessellation` (the config being switched to) provides. A check whose non-empty pattern filter
 *  (its own, or the rule-level one it consumes) loses every pattern is removed instead of being
 *  left with an empty list, since an empty filter means "any split tile". Strategy weights indexed against a rule-level pattern list are re-indexed to match.
 *  Returns the input `rules` reference unchanged when nothing is affected, so
 *  callers can detect data loss by identity. */
export function qcForTessellation(state: QcState, tessellation: TessellationConfig): QcTessellationResult {
  const shapes = shapeKeysOf(tessellation);
  let rulesChanged = false;
  const rules = state.rules.map((rule): QcRuleState => {
    let ruleParams = rule.params;
    let strategyParams = rule.strategyParams;
    const strategyDescriptor = rule.strategyId
      ? state.availableStrategies.find((s) => s.id === rule.strategyId)
      : undefined;
    strategyParams = filterParams(strategyParams, strategyDescriptor?.params ?? [], shapes) ?? strategyParams;
    const ruleFilteredCheckIds = new Set<string>();
    for (const p of state.availableRuleParams) {
      if (p.kind.type !== "pattern_list") continue;
      const filtered = filterPatternList(rule.params[p.id], shapes);
      if (!filtered || filtered.kept.length === filtered.before) continue;
      if (ruleParams === rule.params) ruleParams = { ...rule.params };
      ruleParams[p.id] = filtered.raw;
      if (filterEmptied(filtered)) p.applies_to.forEach((id) => ruleFilteredCheckIds.add(id));
      if (rule.strategyId && p.applies_to.includes(rule.strategyId)) {
        if (strategyDescriptor) {
          strategyParams = reindexWeights(strategyParams, strategyDescriptor.params, filtered.kept);
        }
      }
    }

    let checksChanged = false;
    const checks: CheckInstance[] = [];
    for (const check of rule.checks) {
      if (ruleFilteredCheckIds.has(check.typeId)) {
        checksChanged = true;
        continue;
      }
      const descriptor = state.availableChecks.find((c) => c.id === check.typeId);
      const params = filterParams(check.params, descriptor?.params ?? [], shapes);
      if (params === null) {
        checksChanged = true;
        continue;
      }
      if (params !== check.params) checksChanged = true;
      checks.push(params === check.params ? check : { ...check, params });
    }

    const nestedStrategies = filterNested(rule.nestedStrategies, state, shapes);
    if (ruleParams === rule.params && strategyParams === rule.strategyParams && !checksChanged && nestedStrategies === rule.nestedStrategies) return rule;
    rulesChanged = true;
    return { ...rule, params: ruleParams, strategyParams, checks: checksChanged ? checks : rule.checks, nestedStrategies };
  });

  return { rules: rulesChanged ? rules : state.rules };
}
