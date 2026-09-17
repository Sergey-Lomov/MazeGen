/** One active check, declared inline inside the `QcRuleState` it belongs to — see GitHub issue
 * #60. A check only ever exists inside exactly one rule's `checks`; there is no separate flat
 * "active checks" list. `localId` is unique only within its owning rule (not globally) — minted
 * by `nextLocalCheckId` (see `QcRuleState`), never reused even after the check is removed.
 * `typeId` is the check type's wire id (`CheckDescriptor.id`, e.g. `"min_region_count"`). `params`
 * are this instance's own param overrides — independent of any other instance of the same type. */
export interface CheckInstance {
  localId: number;
  typeId: string;
  params: Record<string, string>;
  /** Per-check toggle — when true, this check is excluded entirely from the next `generate()`
   * call (not sent to core at all), as if it were never selected, mirroring `QcRuleState.ruleDisabled`
   * gating, so a user can't stack duplicate instances of a type limited to one active instance by
   * disabling the existing one first — re-enabling it is a toggle away instead of an add. */
  disabled: boolean;
}

/** Hard cap on nested-strategy tree depth, shared by every function that recurses over
 * `NestedStrategyState`/`ProjectFileNestedStrategy`/`NestedStrategyVM` trees (project-file
 * validation, view-model construction, default-strategy auto-fill, generate-config
 * serialization, and the recursive `NestedStrategyPanel` render). Today's registry never nests
 * more than one level deep and cannot form a cycle (no nested-capable strategy accepts its own
 * `handles()` kind), but nothing in the data model itself prevents a future registry addition
 * from doing so, and a project file loaded from disk is not otherwise bounded at all — an
 * unguarded recursive walk over a maliciously or accidentally deep `nested` array would overflow
 * the call stack. 32 is far beyond any realistic use (today's deepest real tree is 1) while still
 * generous enough that legitimate deep nesting, if it's ever added, would have to be deliberately
 * pathological to hit it.
 */
export const MAX_NESTED_STRATEGY_DEPTH = 32;

/** One step of a nested-strategy address chain — `slotId` picks which slot at this level, `index`
 * picks which of possibly several entries filling that slot (`NestedSlot.max` may be `null`,
 * i.e. unbounded — see `weighted_region_merge`'s `merge_target` slot, GitHub issue #90). `index`
 * is the entry's position among sibling entries sharing this `slotId` specifically, not a
 * position in the whole (mixed-slot) list — see `entriesForSlot`. For a slot capped at 1 (the
 * overwhelming majority today), `index` is always `0`. */
export interface PathSegment {
  slotId: string;
  index: number;
}

/** One nested strategy assignment, filling one of the parent strategy's `nested_slots` (see
 * `StrategyDescriptor.nested_slots` and `Specs/repair.md`'s nested-strategy pattern). Recursive —
 * a nested strategy can itself have nested strategies. Lives per-rule (on `QcRuleState`), not in
 * the global `strategyParams` map — two rules using the same nesting-capable top-level strategy
 * (e.g. two `reduce_scc_count` rules) must be able to pick independent nested strategies/params.
 *
 * Several entries may share the same `slotId` when that slot's `max` is `null` or `> 1` (see
 * `weighted_region_merge`, GitHub issue #90) — `slotId` alone is therefore not a unique key into
 * a `NestedStrategyState[]` list; addressing a specific entry needs `(slotId, index)`, see
 * `PathSegment`/`entriesForSlot`. */
export interface NestedStrategyState {
  /** Which parent slot this fills — matches `StrategyDescriptor.nested_slots[].slot_id`. Not
   * unique within the owning list — see this interface's own doc comment. */
  slotId: string;
  strategyId: string;
  params: Record<string, string>;
  nested: NestedStrategyState[];
}

/** Every entry in `list` filling `slotId`, in list order — that order is this slot's own
 * `index` addressing (see `PathSegment`), so callers must never resort/filter this array by
 * anything other than `slotId` before indexing into it. Shared by every consumer that needs to
 * enumerate or index a slot's entries (store actions, `NestedStrategyPanel`,
 * `useQualityViewModel`'s `buildNested`, `findRawNested`) — generic over `{ slotId: string }`
 * so it works identically for the raw `NestedStrategyState[]` tree and the resolved
 * `NestedStrategyVM[]` tree (`useQualityViewModel.ts`), which share the same `slotId`-keyed
 * shape but are otherwise different types. */
export function entriesForSlot<T extends { slotId: string }>(list: T[], slotId: string): T[] {
  return list.filter((n) => n.slotId === slotId);
}

/** A user-defined rule: a group of active checks producing the same issue kind, sharing one
 * strategy. `id` is opaque (client-generated), not derived from `checks` — rule identity
 * survives adding/removing member checks. `checks` can become empty (e.g. after removing its
 * last member via the card's own X) without the rule being dropped, so the user can repopulate it. */
export interface QcRuleState {
  id: string;
  /** User-facing name, shown as the card header. Defaults to "Rule N" at creation time (see
   * `newRule` in generationSlice.ts). Editable via the card header's edit button. */
  name: string;
  /** Issue kind shared by all member checks, captured at rule-creation time. Kept on the rule
   * itself (not derived from `checks[0]`) so it survives `checks` becoming empty. */
  kind: string;
  checks: CheckInstance[];
  /** Monotonic counter minting this rule's `CheckInstance.localId`s — never reused, even after
   * a check is removed (see `CheckInstance`'s doc comment). Not serialized to project files
   * (see `projectExport`'s `serialize.ts`) — recomputed on load as `max(checks.map(localId)) + 1`. */
  nextLocalCheckId: number;
  strategyId: string | null;
  /** Strategy-only toggle — fix is skipped, but the rule's checks still run (QC still reports
   * the issue, just unfixed). Independent from `ruleDisabled` below. */
  disabled: boolean;
  /** Whole-rule toggle — when true, the rule's checks are excluded entirely from the next
   * generate() call (not sent to core at all), as if they were never selected. Distinct from
   * `disabled` (which only skips the fix, checks still run). */
  ruleDisabled: boolean;
  /** Nested strategy assignments for `strategyId`'s nested slots, keyed by slot — empty for
   * strategies without nested slots (the overwhelming majority). */
  nestedStrategies: NestedStrategyState[];
  /** Rule-level parameters (e.g. `protect_route`) — shared by every check/strategy in this rule
   * that has been migrated to consume it instead of its own per-instance override (GitHub issue
   * #253). Keyed by `ParamDescriptor.id`, same shape as `CheckInstance.params`. */
  params: Record<string, string>;
  /** UI-only collapse state for the rule card (GitHub issue #320) — hides checks, strategy panel,
   * and rule-level params when true. Purely cosmetic, has no effect on generation. */
  collapsed: boolean;
}

/** A named, ordered group of rule ids — see `Specs/repair.md`'s "Stages" section and GitHub
 * issue #65. Core dispatches repair one stage at a time, in `GenerationState.stages` array
 * order — only rules belonging to the current stage repair-dispatch until it has no more active
 * issues, then the next stage starts. Rule membership lives here (`ruleIds`), not as a field on
 * `QcRuleState` — see plan's "Stage — контейнер со списком rule id" decision. `stages` can be
 * empty — no "at least one stage" invariant (a stage is only ever created explicitly via
 * `addStage`, or implicitly by `appendRuleToStage` if a rule needs a home and none exists). */
export interface RepairStageState {
  id: string;
  /** User-facing name, shown as the section header. Defaults to "Stage N" at creation time (see
   * `newStage` in generationSlice.ts) — the very first stage instead defaults to a fixed
   * "Waypoints" name (`quality.default_stage_name`). Editable via the section header's edit button. */
  name: string;
  /** Order is significant — it's both this stage's rule dispatch grouping and its UI/
   * serialization order. Not deduplicated against other stages' `ruleIds` by this type itself —
   * the store's actions (`moveRule`, `removeRule`, etc.) are responsible for keeping each rule id
   * in exactly one stage's `ruleIds` at a time. */
  ruleIds: string[];
  /** Whole-stage toggle — when true, every member rule's checks are excluded entirely from the
   * next `generate()` call (the whole stage is omitted from `GenerateConfig.stages`, not sent
   * with an empty `rules` list), as if the stage didn't exist for this run. Independent of any
   * member rule's own `ruleDisabled`. */
  disabled: boolean;
  /** UI-only collapse state for the stage section (GitHub issue #320) — hides its rule cards when
   * true. Purely cosmetic, has no effect on generation. */
  collapsed: boolean;
}
