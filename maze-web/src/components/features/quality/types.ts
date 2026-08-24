import type { PathSegment } from "../../../store/storeTypes";

/** Identifies which param-bearing entity owns a selected rule-level/check/strategy param — see
 * `QualitySelection`'s `"param"` variant. Mirrors the four places `ParamFields` is used inside
 * `RulesColumn`'s card (checks, strategy, nested strategies, rule-level params section). */
export type ParamOwner =
  | { kind: "check"; checkId: string }
  | { kind: "strategy"; ruleId: string }
  | { kind: "nested_strategy"; ruleId: string; path: PathSegment[] }
  | { kind: "rule"; ruleId: string };

export type QualitySelection =
  | { type: "check"; id: string }
  | { type: "strategy"; ruleId: string; strategyId: string }
  | { type: "logging"; ruleId: string }
  /** A nested-strategy slot entry, anywhere in the nesting chain under a rule's top-level
   * strategy. `path` is the same `(slotId, index)` chain `setNestedStrategy`/`NestedStrategyPanel`
   * use (see storeTypes.ts's doc comment on `setNestedStrategy`), resolved against
   * `vm.strategySlots` to find the `NestedStrategyVM` to show. */
  | { type: "nested_strategy"; ruleId: string; path: PathSegment[] }
  /** One param row, selected via its inline info icon/row click (GitHub issue #375) — shows that
   * single param's label/description, read-only, in the detail panel. `owner` identifies which
   * param-bearing entity this param belongs to, for locating its `ParamDescriptor`. */
  | { type: "param"; owner: ParamOwner; paramId: string }
  | null;
