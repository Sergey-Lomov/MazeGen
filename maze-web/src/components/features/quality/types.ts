import type { PathSegment } from "../../../store/storeTypes";

export type QualitySelection =
  | { type: "check"; id: string }
  | { type: "strategy"; ruleId: string; strategyId: string }
  | { type: "logging"; ruleId: string }
  /** A nested-strategy slot entry, anywhere in the nesting chain under a rule's top-level
   * strategy. `path` is the same `(slotId, index)` chain `setNestedStrategy`/`NestedStrategyPanel`
   * use (see storeTypes.ts's doc comment on `setNestedStrategy`), resolved against
   * `vm.strategySlots` to find the `NestedStrategyVM` to show. */
  | { type: "nested_strategy"; ruleId: string; path: PathSegment[] }
  | null;
