use crate::Maze;
use crate::generation::PresetState;
use crate::quality_control::{INVALID_DEAD_END, InvalidDeadEndIssue, Issue};
use crate::repair::command::MutationCommand;
use crate::repair::nested_dispatch::{dispatch_weighted, slot_candidates, weighted_candidates};
use crate::repair::params::{StrategyParam, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{
    NestedDispatchKind, NestedSlot, NestedStrategyConfig, RepairStrategy,
};
use crate::space::Tessellation;
use rand::RngCore;
use std::collections::HashMap;

/// Slot id for the nested dead-end repair strategies this strategy dispatches across. Its own
/// constant, deliberately not `"fix_target"` (`DeadEndGroupSelectStrategy`'s "exactly one required
/// fixer" slot) and not `PriorityDeadEndStrategy`'s constant, even though the string coincides.
pub const SLOT_REPAIR_TARGET: &str = "dead_end_repair_target";

static NESTED_SLOTS: &[NestedSlot] = &[NestedSlot {
    slot_id: SLOT_REPAIR_TARGET,
    kind: INVALID_DEAD_END,
    min: 1,
    max: None,
    dispatch_kind: NestedDispatchKind::Weighted,
}];

/// Handles `INVALID_DEAD_END` — GitHub issue #855. Randomized counterpart of
/// `PriorityDeadEndStrategy`: picks one of its nested single-dead-end repair strategies by
/// weight (`param_overrides["weight"]`, resolved by `nested_dispatch::resolve_weight`) via
/// `dispatch_weighted`, retrying a different one (still weighted, without replacement) if the
/// chosen one returns `Failed`, until one succeeds or every candidate has been tried.
///
/// The issue is one selected dead end synthesized by `DeadEndGroupSelectStrategy`, so there is
/// nothing to split: it is passed through to `dispatch_weighted` unchanged. The dispatcher has no
/// params of its own; each nested repair keeps its own (for example `dead_end_one_way_chance`).
pub struct WeightedDeadEndStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidDeadEndIssue> for WeightedDeadEndStrategy {
    fn strategy_id(&self) -> &'static str {
        "weighted_dead_end"
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

        let candidate_configs = slot_candidates(nested, SLOT_REPAIR_TARGET);
        if candidate_configs.is_empty() {
            return (RepairResult::Failed, vec![]);
        }
        let candidates = weighted_candidates(&candidate_configs, SLOT_REPAIR_TARGET);

        dispatch_weighted(
            issue as &dyn Issue,
            maze,
            rng,
            preset_state,
            &candidates,
            &HashMap::new(),
        )
    }
}

crate::impl_erased_repair_strategy!(WeightedDeadEndStrategy, InvalidDeadEndIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::NodeId;
    use crate::random::MazeRng;
    use crate::repair::nested_dispatch::WEIGHT_KEY;
    use crate::repair::params::build_params;
    use crate::repair::strategies::test_utils::{DeadEndStub, maze_2x2};
    use crate::repair::strategy::ErasedRepairStrategy;
    use crate::space::SquareTessellation;
    use rand::SeedableRng;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn params() -> StrategyParams {
        build_params(
            <WeightedDeadEndStrategy as RepairStrategy<
                SquareTessellation,
                InvalidDeadEndIssue,
            >>::params(&WeightedDeadEndStrategy),
            None,
        )
    }

    fn issue(invalid: Vec<NodeId>) -> InvalidDeadEndIssue {
        InvalidDeadEndIssue::new_from_check("test", invalid)
    }

    fn nested_stub(
        name: &'static str,
        succeed: bool,
        weight: Option<&str>,
        calls: &Rc<RefCell<Vec<&'static str>>>,
    ) -> NestedStrategyConfig<SquareTessellation> {
        let strategy: Box<dyn ErasedRepairStrategy<SquareTessellation>> = Box::new(DeadEndStub {
            name,
            succeed,
            calls: calls.clone(),
        });
        let mut param_overrides = HashMap::new();
        if let Some(w) = weight {
            param_overrides.insert(WEIGHT_KEY.to_string(), w.to_string());
        }
        NestedStrategyConfig {
            slot: &NESTED_SLOTS[0],
            strategy,
            param_overrides,
            nested: vec![],
        }
    }

    fn run(
        invalid: Vec<NodeId>,
        seed: u64,
        nested: &[NestedStrategyConfig<SquareTessellation>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let mut rng = MazeRng::seed_from_u64(seed);
        <WeightedDeadEndStrategy as RepairStrategy<SquareTessellation, InvalidDeadEndIssue>>::apply(
            &WeightedDeadEndStrategy,
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
        let (result, commands) = run(vec![], 1, &[]);
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert!(commands.is_empty());
    }

    #[test]
    fn fails_when_no_candidate_fills_the_slot() {
        let (result, commands) = run(vec![0], 1, &[]);
        assert!(matches!(result, RepairResult::Failed));
        assert!(commands.is_empty());
    }

    #[test]
    fn runs_exactly_one_candidate_when_the_first_pick_succeeds() {
        let calls = Rc::new(RefCell::new(vec![]));
        let nested = [
            nested_stub("a", true, None, &calls),
            nested_stub("b", true, None, &calls),
        ];
        let (result, commands) = run(vec![0], 1, &nested);
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert_eq!(commands.len(), 1);
        assert_eq!(calls.borrow().len(), 1);
    }

    #[test]
    fn retries_a_different_candidate_after_a_failure() {
        let calls = Rc::new(RefCell::new(vec![]));
        let nested = [
            nested_stub("failing", false, None, &calls),
            nested_stub("working", true, None, &calls),
        ];
        for seed in 0..20 {
            calls.borrow_mut().clear();
            let (result, commands) = run(vec![0], seed, &nested);
            assert!(matches!(result, RepairResult::Fixed { .. }));
            assert_eq!(commands.len(), 1);
            assert_eq!(calls.borrow().last(), Some(&"working"));
        }
    }

    #[test]
    fn fails_after_trying_every_candidate_once() {
        let calls = Rc::new(RefCell::new(vec![]));
        let nested = [
            nested_stub("a", false, None, &calls),
            nested_stub("b", false, None, &calls),
        ];
        let (result, commands) = run(vec![0], 3, &nested);
        assert!(matches!(result, RepairResult::Failed));
        assert!(commands.is_empty());
        let mut seen = calls.borrow().clone();
        seen.sort_unstable();
        assert_eq!(seen, vec!["a", "b"]);
    }

    #[test]
    fn weights_bias_the_first_pick() {
        let calls = Rc::new(RefCell::new(vec![]));
        let nested = [
            nested_stub("heavy", true, Some("99"), &calls),
            nested_stub("light", true, Some("1"), &calls),
        ];
        for seed in 0..200 {
            run(vec![0], seed, &nested);
        }
        let heavy = calls.borrow().iter().filter(|&&n| n == "heavy").count();
        assert!(heavy > 170, "heavy picked {heavy}/200 times");
    }

    #[test]
    fn is_deterministic_for_a_fixed_seed() {
        let calls = Rc::new(RefCell::new(vec![]));
        let nested = [
            nested_stub("a", true, None, &calls),
            nested_stub("b", true, None, &calls),
            nested_stub("c", true, None, &calls),
        ];
        run(vec![0], 9, &nested);
        run(vec![0], 9, &nested);
        let calls = calls.borrow();
        assert_eq!(calls[0], calls[1]);
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

        // The failing stub carries all the weight, so the passage repair is reached only
        // through the retry-after-`Failed` path.
        let calls = Rc::new(RefCell::new(vec![]));
        let weighted = NestedStrategyConfig {
            slot: &FIX_SLOT,
            strategy: Box::new(WeightedDeadEndStrategy),
            param_overrides: HashMap::new(),
            nested: vec![
                nested_stub("failing", false, Some("1000"), &calls),
                NestedStrategyConfig {
                    slot: &NESTED_SLOTS[0],
                    strategy: Box::new(DeadEndToPassageStrategy),
                    param_overrides: HashMap::from([(WEIGHT_KEY.to_string(), "0.001".to_string())]),
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
            &[weighted],
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
            dispatch_kind: NestedDispatchKind::Weighted,
        };
        let calls = Rc::new(RefCell::new(vec![]));
        let mut config = nested_stub("other", true, None, &calls);
        config.slot = &OTHER_SLOT;
        let (result, _) = run(vec![0], 1, &[config]);
        assert!(matches!(result, RepairResult::Failed));
        assert!(calls.borrow().is_empty());
    }
}
