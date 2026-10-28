use crate::Maze;
use crate::generation::PresetState;
use crate::quality_control::{INVALID_DEAD_END, InvalidDeadEndIssue, Issue};
use crate::repair::command::MutationCommand;
use crate::repair::nested_dispatch::{dispatch_priority, slot_candidates};
use crate::repair::params::{StrategyParam, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{
    NestedDispatchKind, NestedSlot, NestedStrategyConfig, RepairStrategy,
};
use crate::space::Tessellation;
use rand::RngCore;
use std::collections::HashMap;

/// Slot id for the nested dead-end repair strategies this strategy dispatches across. Its own
/// constant, deliberately not `"fix_target"` — that string is `DeadEndGroupSelectStrategy`'s
/// "exactly one required fixer" slot (`max: Some(1)`), while this slot holds any number of
/// priority-ordered candidates (`max: None`).
pub const SLOT_REPAIR_TARGET: &str = "dead_end_repair_target";

static NESTED_SLOTS: &[NestedSlot] = &[NestedSlot {
    slot_id: SLOT_REPAIR_TARGET,
    kind: INVALID_DEAD_END,
    min: 1,
    max: None,
    dispatch_kind: NestedDispatchKind::Priority,
}];

/// Handles `INVALID_DEAD_END` — GitHub issue #854. Tries its nested single-dead-end repair
/// strategies in configured order (`dispatch_priority`) and uses the first result that is not
/// `Failed`; later candidates are never run once one succeeds.
///
/// The issue is one selected dead end synthesized by `DeadEndGroupSelectStrategy`, so there is
/// nothing to split: it is passed through to `dispatch_priority` unchanged. The dispatcher has no
/// params of its own; each nested repair keeps its own (for example `dead_end_one_way_chance`).
pub struct PriorityDeadEndStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidDeadEndIssue> for PriorityDeadEndStrategy {
    fn strategy_id(&self) -> &'static str {
        "priority_dead_end"
    }

    fn params(&self) -> &'static [StrategyParam] {
        &[]
    }

    fn expected_nested(&self) -> &'static [NestedSlot] {
        NESTED_SLOTS
    }

    fn apply(
        &self,
        issue: &InvalidDeadEndIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        _params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        if issue.invalid.is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let candidates = slot_candidates(nested, SLOT_REPAIR_TARGET);
        if candidates.is_empty() {
            return (RepairResult::Failed, vec![]);
        }

        dispatch_priority(
            issue as &dyn Issue,
            maze,
            rng,
            preset_state,
            &candidates,
            &HashMap::new(),
        )
    }
}

crate::impl_erased_repair_strategy!(PriorityDeadEndStrategy, InvalidDeadEndIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::NodeId;
    use crate::random::MazeRng;
    use crate::repair::params::build_params;
    use crate::repair::strategies::test_utils::{DeadEndStub, maze_2x2};
    use crate::repair::strategy::ErasedRepairStrategy;
    use crate::space::SquareTessellation;
    use rand::SeedableRng;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn params() -> StrategyParams {
        build_params(
            <PriorityDeadEndStrategy as RepairStrategy<
                SquareTessellation,
                InvalidDeadEndIssue,
            >>::params(&PriorityDeadEndStrategy),
            None,
        )
    }

    fn issue(invalid: Vec<NodeId>) -> InvalidDeadEndIssue {
        InvalidDeadEndIssue::new_from_check("test", invalid)
    }

    fn nested_stub(
        name: &'static str,
        succeed: bool,
        calls: &Rc<RefCell<Vec<&'static str>>>,
    ) -> NestedStrategyConfig<SquareTessellation> {
        let strategy: Box<dyn ErasedRepairStrategy<SquareTessellation>> = Box::new(DeadEndStub {
            name,
            succeed,
            calls: calls.clone(),
        });
        NestedStrategyConfig {
            slot: &NESTED_SLOTS[0],
            strategy,
            param_overrides: HashMap::new(),
            nested: vec![],
        }
    }

    fn run(
        invalid: Vec<NodeId>,
        nested: &[NestedStrategyConfig<SquareTessellation>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let mut rng = MazeRng::seed_from_u64(1);
        <PriorityDeadEndStrategy as RepairStrategy<SquareTessellation, InvalidDeadEndIssue>>::apply(
            &PriorityDeadEndStrategy,
            &issue(invalid),
            &maze_2x2(),
            &mut rng,
            &params(),
            &PresetState::empty(),
            nested,
        )
    }

    #[test]
    fn empty_issue_is_fixed_without_nested_configuration() {
        let (result, commands) = run(vec![], &[]);
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert!(commands.is_empty());
    }

    #[test]
    fn fails_when_no_candidate_fills_the_slot() {
        let (result, commands) = run(vec![0], &[]);
        assert!(matches!(result, RepairResult::Failed));
        assert!(commands.is_empty());
    }

    #[test]
    fn falls_through_to_the_next_candidate_after_a_failure() {
        let calls = Rc::new(RefCell::new(vec![]));
        let nested = [
            nested_stub("first", false, &calls),
            nested_stub("second", true, &calls),
        ];
        let (result, commands) = run(vec![0], &nested);
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert_eq!(commands.len(), 1);
        assert_eq!(*calls.borrow(), vec!["first", "second"]);
    }

    #[test]
    fn never_runs_a_lower_priority_candidate_once_one_succeeds() {
        let calls = Rc::new(RefCell::new(vec![]));
        let nested = [
            nested_stub("first", true, &calls),
            nested_stub("second", true, &calls),
        ];
        let (result, _) = run(vec![0], &nested);
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert_eq!(*calls.borrow(), vec!["first"]);
    }

    #[test]
    fn fails_after_trying_every_candidate() {
        let calls = Rc::new(RefCell::new(vec![]));
        let nested = [
            nested_stub("first", false, &calls),
            nested_stub("second", false, &calls),
        ];
        let (result, commands) = run(vec![0], &nested);
        assert!(matches!(result, RepairResult::Failed));
        assert!(commands.is_empty());
        assert_eq!(*calls.borrow(), vec!["first", "second"]);
    }

    #[test]
    fn works_as_the_fix_target_of_dead_end_group_select() {
        use crate::quality_control::InvalidDeadEndGroupIssue;
        use crate::repair::strategies::dead_end_group_select::SLOT_FIX_TARGET;
        use crate::repair::strategies::{DeadEndGroupSelectStrategy, DeadEndToPassageStrategy};

        static FIX_SLOT: NestedSlot = NestedSlot {
            slot_id: SLOT_FIX_TARGET,
            kind: INVALID_DEAD_END,
            min: 1,
            max: Some(1),
            dispatch_kind: NestedDispatchKind::Unordered,
        };

        let calls = Rc::new(RefCell::new(vec![]));
        let priority = NestedStrategyConfig {
            slot: &FIX_SLOT,
            strategy: Box::new(PriorityDeadEndStrategy),
            param_overrides: HashMap::new(),
            nested: vec![
                nested_stub("failing", false, &calls),
                NestedStrategyConfig {
                    slot: &NESTED_SLOTS[0],
                    strategy: Box::new(DeadEndToPassageStrategy),
                    param_overrides: HashMap::new(),
                    nested: vec![],
                },
            ],
        };
        let group_issue = InvalidDeadEndGroupIssue::new_from_check("test", vec![(vec![0], 1)]);
        let mut rng = MazeRng::seed_from_u64(1);
        let group_params = build_params(
            <DeadEndGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                InvalidDeadEndGroupIssue,
            >>::params(&DeadEndGroupSelectStrategy),
            None,
        );
        let (result, commands) = <DeadEndGroupSelectStrategy as RepairStrategy<
            SquareTessellation,
            InvalidDeadEndGroupIssue,
        >>::apply(
            &DeadEndGroupSelectStrategy,
            &group_issue,
            &maze_2x2(),
            &mut rng,
            &group_params,
            &PresetState::empty(),
            &[priority],
        );
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert_eq!(
            commands.len(),
            1,
            "one passage repairs the selected dead end"
        );
        assert_eq!(*calls.borrow(), vec!["failing"]);
    }

    #[test]
    fn ignores_candidates_from_another_slot() {
        static OTHER_SLOT: NestedSlot = NestedSlot {
            slot_id: "some_other_slot",
            kind: INVALID_DEAD_END,
            min: 1,
            max: None,
            dispatch_kind: NestedDispatchKind::Priority,
        };
        let calls = Rc::new(RefCell::new(vec![]));
        let mut config = nested_stub("other", true, &calls);
        config.slot = &OTHER_SLOT;
        let (result, _) = run(vec![0], &[config]);
        assert!(matches!(result, RepairResult::Failed));
        assert!(calls.borrow().is_empty());
    }
}
