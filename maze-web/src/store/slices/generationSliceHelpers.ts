import type { CheckDescriptor, StrategyDescriptor } from "../../wasm/types";
import { MAX_NESTED_STRATEGY_DEPTH, entriesForSlot } from "../storeTypes";
import type { QcRuleState, CheckInstance, RepairStageState, NestedStrategyState, PathSegment } from "../storeTypes";
import * as m from "~/paraglide/messages";

// Rule-kind matching across the store (addCheck/newRule below, RulesColumn's candidate filter,
// useQualityViewModel) all assume one issue kind per check and read issue_kinds[0]. No current
// check produces more than one kind, but nothing enforces it at the descriptor level — warn
// loudly instead of silently dropping the other kinds if that assumption is ever violated.
export function resolveCheckKind(descriptor: CheckDescriptor): string {
  if (descriptor.issue_kinds.length > 1) {
    console.error(`check "${descriptor.id}" produces multiple issue kinds (${descriptor.issue_kinds.join(", ")}); rules only support one kind per check — using "${descriptor.issue_kinds[0]}"`);
  }
  return descriptor.issue_kinds[0];
}

// Most checks may only have one active instance at a time, across all rules — only checks with
// `allow_multiple_instances` (none currently — see GitHub issue #60, retired) can have several
// independent configurations active simultaneously. Exported so component-layer
// candidate filters (RulesColumn, CheckSelectDialog) apply the exact same predicate the store
// itself enforces, instead of each re-implementing it.
export function isTypeAlreadyActive(rules: QcRuleState[], typeId: string): boolean {
  return rules.some((g) => g.checks.some((c) => c.typeId === typeId));
}

export function defaultParamsFor(descriptor: { params: CheckDescriptor["params"] }): Record<string, string> {
  return Object.fromEntries(
    descriptor.params.map((p) => [p.id, defaultParamValue(p.kind)])
  );
}

// "min,max" for interval params -- mirrors maze-core's `parse_param` Interval encoding
// (repair/params.rs).
function defaultParamValue(k: CheckDescriptor["params"][number]["kind"]): string {
  if (k.type === "bool") return k.default ? "true" : "false";
  if (k.type === "interval") return `${k.default_min},${k.default_max}`;
  // Empty pattern list -- "all"/"unconstrained" default (GitHub issue #247), same JSON encoding
  // `parse_split_patterns_param` round-trips.
  if (k.type === "pattern_list") return "[]";
  if (k.type === "split_generation_config") return JSON.stringify({ pattern_mode: false, max_split_nodes: 2, patterns: [] });
  if (k.type === "add_split_config") return String(k.max_split_nodes_default);
  return String(k.default);
}

// Auto-fills every mandatory nested slot (`min >= 1`) of `strategyId` with the first available
// strategy that handles the slot's kind, recursively — so a nested-capable strategy is never left
// in a state where its own `apply()` is guaranteed to fail for lack of a nested assignment (see
// GitHub issue #68's `ReduceSccCountStrategy`). "First compatible candidate" is a placeholder the
// user is expected to review/change on the rule's own card (`NestedStrategyPanel`'s edit button)
// — not a considered recommendation. A slot with no compatible candidate at all is left unfilled
// (defensive: shouldn't happen for any shipped strategy, but this must not crash if it did).
// `depth` guards against a future registry addition where two nested-capable strategies end up
// mutually compatible (A's slot resolves to B, B's slot resolves back to A) — nothing in the
// registry shape itself rules that out, so this recursion isn't otherwise provably finite.
export function buildDefaultNestedStrategies(strategyId: string, availableStrategies: StrategyDescriptor[], depth = 0): NestedStrategyState[] {
  if (depth >= MAX_NESTED_STRATEGY_DEPTH) return [];
  const descriptor = availableStrategies.find((s) => s.id === strategyId);
  if (!descriptor) return [];
  return descriptor.nested_slots
    .filter((slot) => slot.min >= 1)
    .map((slot): NestedStrategyState | undefined => {
      const candidate = availableStrategies.find((s) => s.handles === slot.kind);
      if (!candidate) return undefined;
      // A nested strategy's dispatcher-owned params (`nested_suppressed_params`, GitHub issue
      // #486) are resolved and injected by the parent dispatcher at apply() time — don't seed
      // them into the stored config, where they'd be dead keys the UI also hides.
      const suppressed = new Set(candidate.nested_suppressed_params ?? []);
      const params = Object.fromEntries(
        Object.entries(defaultParamsFor(candidate)).filter(([id]) => !suppressed.has(id))
      );
      return {
        slotId: slot.slot_id,
        strategyId: candidate.id,
        params,
        nested: buildDefaultNestedStrategies(candidate.id, availableStrategies, depth + 1),
      };
    })
    .filter((n): n is NestedStrategyState => n !== undefined);
}

// Default rule name = the issue kind's own label (the same text shown in IssueSelectDialog's
// picker), mirroring `qualityI18n.resolveIssueLabel`'s fallback to the raw kind — duplicated
// here rather than imported to keep the store layer free of component-layer imports.
function defaultRuleName(kind: string): string {
  const fn = (m as unknown as Record<string, (() => string) | undefined>)[`issue.${kind}.label`];
  return fn?.() ?? kind;
}

// `name` is plain user-editable text seeded from the current locale at creation time (renaming
// UI not implemented yet) — it does not re-translate later, same as any other user-entered
// string would not. `id` is a UUID, not a counter-derived string — a module-level counter resets
// on store re-initialization (HMR, project load, undo/redo replay) while previously-created rules
// (e.g. from an imported project) keep their old ids, so a fresh counter can mint an id that
// collides with one already in use. `nextLocalCheckId` starts at `checks.length` (the lowest id
// not already in use among the member checks passed in at creation).
export function newRule(kind: string, checks: CheckInstance[], strategyId: string | null, disabled: boolean, availableStrategies: StrategyDescriptor[]): QcRuleState {
  return {
    id: `rule_${crypto.randomUUID()}`,
    name: defaultRuleName(kind),
    kind,
    checks,
    nextLocalCheckId: checks.length,
    strategyId,
    disabled,
    ruleDisabled: false,
    nestedStrategies: strategyId ? buildDefaultNestedStrategies(strategyId, availableStrategies) : [],
    params: {},
    collapsed: false,
  };
}

// Default stage name — the very first stage (index 0) is seeded as "Путевые точки" ("Waypoints"),
// since it's the one every fresh project starts with and typically holds the endpoint-placement
// rules; later stages fall back to "Stage N" by creation-order position, not renumbered on
// rename/reorder (same pattern as `defaultRuleName`'s "Rule N" fallback in `validateQcRule`, see
// projectExport). `id` is a UUID for the same reason `newRule`'s `id` is — see that function's
// doc comment.
export function newStage(index: number, ruleIds: string[] = []): RepairStageState {
  return {
    id: `stage_${crypto.randomUUID()}`,
    name: index === 0 ? m["quality.default_stage_name"]() : `Stage ${index + 1}`,
    ruleIds,
    disabled: false,
    collapsed: false,
  };
}

// Appends `ruleId` to a stage's `ruleIds` — the "new rule goes at the end" placement used by
// `addCheck` (singleton path), `createRule`, and `removeCheckFromRule`'s new-singleton path.
// `targetStageId`, when given and resolving to a known stage, receives the rule (the per-stage
// "+ Add rule" toolbar button — see RulesColumn); otherwise falls back to the last stage. `stages`
// can legitimately be empty (there is no "at least one stage" invariant — a stage is only ever
// created explicitly via `addStage`, or implicitly here) — in that case a fresh stage is created
// to hold the new rule, rather than the rule ending up in no stage at all.
export function appendRuleToStage(stages: RepairStageState[], ruleId: string, targetStageId?: string): RepairStageState[] {
  if (stages.length === 0) return [newStage(0, [ruleId])];
  if (targetStageId && stages.some((s) => s.id === targetStageId)) {
    return stages.map((s) => s.id === targetStageId ? { ...s, ruleIds: [...s.ruleIds, ruleId] } : s);
  }
  return stages.map((s, i) => i === stages.length - 1 ? { ...s, ruleIds: [...s.ruleIds, ruleId] } : s);
}

// Walks `path` (see `PathSegment`'s/`setNestedStrategy`'s doc comment for the per-level
// slotId+index resolution rule) down to the entry it addresses, and replaces just that entry via
// `transform` — every level above the target is rebuilt through `.map`, preserving every sibling
// untouched. Shared by `setNestedStrategy`/`setNestedStrategyParam`/`removeNestedStrategy`, whose
// only difference is `transform`'s own return value (a replacement entry, an empty array to
// delete it, etc.) once the target is found; a stale path (target not found) is a no-op, returning
// `list` unchanged at whichever depth the lookup failed.
export function updateNestedAt(
  list: NestedStrategyState[],
  path: PathSegment[],
  transform: (target: NestedStrategyState) => NestedStrategyState[],
): NestedStrategyState[] {
  const [{ slotId, index }, ...rest] = path;
  const target = entriesForSlot(list, slotId)[index];
  if (!target) return list; // stale path (entry was removed elsewhere) — no-op.
  if (rest.length === 0) {
    return list.flatMap((n) => n === target ? transform(target) : [n]);
  }
  return list.map((n) => n === target ? { ...n, nested: updateNestedAt(n.nested, rest, transform) } : n);
}

// Swaps the entry addressed by `path` with its immediate sibling in `direction`, within the
// sibling list that owns it (same `slotId`, addressed by `index` — see `PathSegment`). Unlike
// `updateNestedAt` (which replaces one target entry via `transform`, at any depth), this mutates
// the *parent* list's own ordering, so the walk stops one level higher than the target itself. A
// no-op (returns `list` unchanged) if `path` is stale or the target has no sibling in `direction`.
export function moveNestedAt(
  list: NestedStrategyState[],
  path: PathSegment[],
  direction: "up" | "down",
): NestedStrategyState[] {
  const [{ slotId, index }, ...rest] = path;
  if (rest.length === 0) {
    const siblings = entriesForSlot(list, slotId);
    const otherIndex = direction === "up" ? index - 1 : index + 1;
    const target = siblings[index];
    const other = siblings[otherIndex];
    if (!target || !other) return list; // no sibling in that direction — no-op.
    // Swap by identity within the full (mixed-slot) `list`, preserving every other entry's
    // position — `entriesForSlot`'s own order is a view, not the source of truth for `list`.
    const targetPos = list.indexOf(target);
    const otherPos = list.indexOf(other);
    const next = [...list];
    next[targetPos] = other;
    next[otherPos] = target;
    return next;
  }
  const target = entriesForSlot(list, slotId)[index];
  if (!target) return list;
  return list.map((n) => n === target ? { ...n, nested: moveNestedAt(n.nested, rest, direction) } : n);
}
