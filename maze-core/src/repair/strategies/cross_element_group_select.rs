use crate::Maze;
use crate::generation::PresetState;
use crate::quality_control::cross_element::{
    CrossElement, cross_element_edges, cross_element_preset_locked, cross_element_still_violates,
};
use crate::quality_control::{
    CrossElementGroupKind, INVALID_CROSS_ELEMENT, InvalidCrossElementGroupIssue,
    InvalidCrossElementIssue,
};
use crate::repair::command::MutationCommand;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategies::cross_element_nested::route_blocked;
use crate::repair::strategies::group_select::{
    PARAM_PRIORITY, PRIORITY_OPTIONS, PRIORITY_PROBLEMATIC, multi_target_group_select_apply,
    order_by_priority,
};
use crate::repair::strategy::{
    NestedDispatchKind, NestedSlot, NestedStrategyConfig, RepairStrategy,
};
use crate::space::Tessellation;
use rand::RngCore;

static PARAMS: &[StrategyParam] = &[StrategyParam {
    id: PARAM_PRIORITY,
    label: "Fix priority",
    kind: StrategyParamKind::Enum {
        options: PRIORITY_OPTIONS,
        default: PRIORITY_PROBLEMATIC,
    },
}];

/// Slot id for the nested strategy this strategy delegates each candidate element's removal to —
/// `CrossElementRemoveStrategy` by default, which resolves the per-type removal strategy itself.
pub const SLOT_FIX_TARGET: &str = "fix_target";

static NESTED_SLOTS: &[NestedSlot] = &[NestedSlot {
    slot_id: SLOT_FIX_TARGET,
    kind: INVALID_CROSS_ELEMENT,
    min: 1,
    max: Some(1),
    dispatch_kind: NestedDispatchKind::Unordered,
}];

/// Handles `INVALID_CROSS_ELEMENT_GROUP` — see GitHub issue #376. Produced by
/// `CrossElementGeometricProximityCheck` / `CrossElementGraphProximityCheck`: one group per
/// too-close unordered pair of logical elements (`to_remove: 1` — removing either breaks the
/// pair).
///
/// Standard group-select shape (GitHub issue #1060): `priority` picks which element of a flagged
/// group is tried first and the removal itself goes to the single nested `fix_target` strategy
/// (`CrossElementRemoveStrategy`), which resolves the per-type removal strategy. Built on
/// `group_select::multi_target_group_select_apply` rather than `group_select_apply` only for its
/// `wholly_protected_auto_resolve: false` switch. Its `nested_for` hook hands the nested slot a
/// single-element `InvalidCrossElementIssue::for_removal`, or `None` when the element cannot be
/// acted on:
/// - `Start` / `Finish` — never removable, always `None`. A `[Start, Finish]` pair (or any pair
///   both of whose elements are unremovable) has no actionable candidate; with
///   `wholly_protected_auto_resolve: false` its budget is kept and the strategy reports `Failed`,
///   so the issue survives and the user sees the constraint is unmet.
/// - A route-critical edge element under `protect_route` — `None` (its own underlying edge lies
///   on the current start->finish route).
///
/// `protect_route` (rule-level, resolved by the factory from `RuleParams`, mirroring
/// `OneWayGroupSelectStrategy` — see GitHub issue #253) — not a `StrategyParam`, no local
/// override.
pub struct CrossElementGroupSelectStrategy {
    pub protect_route: bool,
}

impl<T: Tessellation> RepairStrategy<T, InvalidCrossElementGroupIssue>
    for CrossElementGroupSelectStrategy
{
    fn strategy_id(&self) -> &'static str {
        "cross_element_group_select"
    }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn expected_nested(&self) -> &'static [NestedSlot] {
        NESTED_SLOTS
    }

    fn apply(
        &self,
        issue: &InvalidCrossElementGroupIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        if issue.groups().is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }
        let Some(fix_target) = nested.iter().find(|n| n.slot.slot_id == SLOT_FIX_TARGET) else {
            return (RepairResult::Failed, vec![]);
        };
        let fix_params = crate::repair::params::build_params(
            fix_target.strategy.params(),
            Some(&fix_target.param_overrides),
        );

        let nested_for = |element: &CrossElement, _others: &[&CrossElement]| {
            // Start / Finish are never removable.
            if matches!(element, CrossElement::Start(_) | CrossElement::Finish(_)) {
                return None;
            }
            if route_blocked(maze, self.protect_route, element) {
                return None;
            }
            // A preset-locked element (every underlying edge is a preset connection) must never be
            // removed by repair -- unlike the same-type proximity checks, the cross-element checks
            // do flag preset elements (the user still sees the constraint is violated), so the skip
            // lives here in the strategy, not in the check. A pair both of whose elements are
            // preset-locked has no actionable candidate: `wholly_protected_auto_resolve: false`
            // keeps its budget, the strategy reports `Failed`, and the issue survives so the user
            // sees the unmet constraint -- same handling as a `[Start, Finish]` pair.
            if cross_element_preset_locked(maze, preset_state, element) {
                return None;
            }
            // An element an earlier fix in the same pass already removed.
            if !cross_element_still_violates(maze, element) {
                return None;
            }
            let synthetic: Box<dyn crate::quality_control::Issue> =
                Box::new(InvalidCrossElementIssue::for_removal(
                    "cross_element_group_select",
                    element.clone(),
                ));
            Some((fix_target, &fix_params, synthetic))
        };

        // Whether `element` (some other still-live candidate, not the one just fixed) is moot
        // after `nested_commands` -- inferred from the commands themselves, not from `maze`'s
        // current graph, which is *not yet mutated* at this point (the strategy holds only `&Maze`;
        // actual mutation happens later in `apply_commands`). Mirrors
        // `TeleportGroupSelectStrategy`'s own `element_invalidated`: an element is moot when one of
        // its underlying edges (read from the still-unmutated `maze`, which is fine -- ids are
        // stable, only aliveness changes) is among the edges the just-applied commands remove.
        let prepare_invalidation = |cmds: &[MutationCommand], _maze: &Maze<T>| {
            crate::repair::command::removed_edge_ids(cmds)
                .into_iter()
                .collect::<std::collections::HashSet<crate::ids::EdgeId>>()
        };
        let element_invalidated = |removed: &std::collections::HashSet<crate::ids::EdgeId>,
                                   element: &CrossElement| {
            cross_element_edges(maze, element)
                .iter()
                .any(|id| removed.contains(id))
        };

        multi_target_group_select_apply::<T, CrossElementGroupKind, _>(
            issue.groups(),
            issue.invalid_sources(),
            maze,
            rng,
            preset_state,
            nested_for,
            prepare_invalidation,
            element_invalidated,
            order_by_priority(params),
            false,
        )
    }
}

crate::impl_erased_repair_strategy!(
    CrossElementGroupSelectStrategy,
    InvalidCrossElementGroupIssue
);

#[cfg(test)]
#[path = "cross_element_group_select_tests.rs"]
mod tests;
