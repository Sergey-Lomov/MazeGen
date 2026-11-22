use crate::Maze;
use crate::generation::PresetState;
use crate::quality_control::InvalidCrossElementIssue;
use crate::quality_control::cross_element::{CrossElement, cross_element_preset_locked};
use crate::repair::command::MutationCommand;
use crate::repair::params::StrategyParams;
use crate::repair::result::RepairResult;
use crate::repair::strategies::cross_element_nested::{
    NESTED_SLOTS, make_nested_issue, route_blocked, slot_for,
};
pub use crate::repair::strategies::cross_element_nested::{
    SLOT_ELEVATOR_STOP_FIX, SLOT_ONE_WAY_FIX, SLOT_SPLIT_FIX, SLOT_TELEPORT_FIX,
    SLOT_VERTICAL_PASSAGE_FIX,
};
use crate::repair::strategy::{NestedSlot, NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::RngCore;
use rand::seq::SliceRandom;

/// Handles `INVALID_CROSS_ELEMENT` — see GitHub issue #1060. Produced by
/// `CrossElementCellTypeCheck`: every element of the selected kinds sitting on a forbidden cell
/// type. Each flagged element is invalid on its own (no pair, no `to_remove` budget), so every
/// distinct element of the issue is removed, in random order, by the nested strategy of its kind.
/// This is also the nested `fix_target` strategy of `CrossElementGroupSelectStrategy`, which hands
/// it one element at a time (`InvalidCrossElementIssue::for_removal`).
///
/// An element with several violating ends (teleport, elevator stops) is one element and is removed
/// once. Not actionable, so skipped without failing the others:
/// - `Start` / `Finish` — never removable.
/// - A route-critical edge element under `protect_route` (rule-level, resolved by the factory from
///   `RuleParams`, no `StrategyParam`).
/// - A preset-locked element (`cross_element_preset_locked`).
///
/// Result: `Fixed` iff at least one nested call returned `Fixed`, `Failed` otherwise (the issue then
/// survives and the user sees the unmet constraint).
pub struct CrossElementRemoveStrategy {
    pub protect_route: bool,
}

impl<T: Tessellation> RepairStrategy<T, InvalidCrossElementIssue> for CrossElementRemoveStrategy {
    fn strategy_id(&self) -> &'static str {
        "cross_element_remove"
    }

    fn expected_nested(&self) -> &'static [NestedSlot] {
        NESTED_SLOTS
    }

    fn apply(
        &self,
        issue: &InvalidCrossElementIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        _params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        if issue.invalid_sources.is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        // Distinct elements (`invalid_sources` is keyed by element), sorted so the order does not
        // depend on `HashMap` iteration, then shuffled by the seeded rng.
        let mut elements: Vec<&CrossElement> = issue.invalid_sources.keys().collect();
        elements.sort_unstable();
        elements.shuffle(rng);

        let mut commands = Vec::new();
        let mut any_succeeded = false;
        for element in elements {
            // GitHub issue #976: stop on the QC deadline, keeping the fixes already collected.
            if crate::deadline::expired() {
                break;
            }
            if route_blocked(maze, self.protect_route, element)
                || cross_element_preset_locked(maze, preset_state, element)
            {
                continue;
            }
            let Some(slot_id) = slot_for(element) else {
                continue;
            };
            let Some(cfg) = nested.iter().find(|n| n.slot.slot_id == slot_id) else {
                continue;
            };
            let Some(synthetic) = make_nested_issue(maze, element, "cross_element_remove") else {
                continue;
            };
            let built = crate::repair::params::build_params(
                cfg.strategy.params(),
                Some(&cfg.param_overrides),
            );
            let (result, cmds) = cfg.strategy.apply(
                synthetic.as_ref(),
                maze,
                rng,
                &built,
                preset_state,
                &cfg.nested,
            );
            if matches!(result, RepairResult::Fixed { .. }) {
                any_succeeded = true;
                commands.extend(cmds);
            }
        }

        if any_succeeded {
            (RepairResult::Fixed { score: None }, commands)
        } else {
            (RepairResult::Failed, vec![])
        }
    }
}

crate::impl_erased_repair_strategy!(CrossElementRemoveStrategy, InvalidCrossElementIssue);

#[cfg(test)]
#[path = "cross_element_remove_tests.rs"]
mod tests;
