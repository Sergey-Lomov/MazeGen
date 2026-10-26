use crate::Maze;
use crate::generation::PresetState;
use crate::ids::NodeId;
use crate::quality_control::{
    DeadEndGroupKind, INVALID_DEAD_END, InvalidDeadEndGroupIssue, InvalidDeadEndIssue,
};
use crate::repair::command::MutationCommand;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategies::group_select::{
    PARAM_PRIORITY, PRIORITY_OPTIONS, PRIORITY_PROBLEMATIC, group_select_apply,
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

pub const SLOT_FIX_TARGET: &str = "fix_target";

static NESTED_SLOTS: &[NestedSlot] = &[NestedSlot {
    slot_id: SLOT_FIX_TARGET,
    kind: INVALID_DEAD_END,
    min: 1,
    max: Some(1),
    dispatch_kind: NestedDispatchKind::Unordered,
}];

/// Selects dead ends from every `INVALID_DEAD_END_GROUP` budget and delegates each selected node
/// to a nested single-node repair. The shared group candidate pass owns global deduplication,
/// priority ordering, failed-candidate eviction, and accounting across overlapping groups.
pub struct DeadEndGroupSelectStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidDeadEndGroupIssue> for DeadEndGroupSelectStrategy {
    fn strategy_id(&self) -> &'static str {
        "dead_end_group_select"
    }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn expected_nested(&self) -> &'static [NestedSlot] {
        NESTED_SLOTS
    }

    fn apply(
        &self,
        issue: &InvalidDeadEndGroupIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let matching: Vec<&NestedStrategyConfig<T>> = nested
            .iter()
            .filter(|n| n.slot.slot_id == SLOT_FIX_TARGET)
            .collect();
        debug_assert!(
            matching.len() <= 1,
            "DeadEndGroupSelectStrategy: expected at most one \"{SLOT_FIX_TARGET}\" nested strategy"
        );
        let Some(&fix_target) = matching.first() else {
            return if issue.groups.is_empty() {
                (RepairResult::Fixed { score: None }, vec![])
            } else {
                (RepairResult::Failed, vec![])
            };
        };

        let build_nested_issue = |source_check: &str,
                                  target: &NodeId,
                                  others: &[NodeId]|
         -> Box<dyn crate::quality_control::Issue> {
            Box::new(InvalidDeadEndIssue::new_from_group_select(
                source_check,
                *target,
                others,
            ))
        };
        let element_invalidated = |node: &NodeId, commands: &[MutationCommand], _maze: &Maze<T>| {
            commands.iter().any(|command| match command {
                // A directed addition only gives its source a new outgoing edge. Its destination
                // can still be a dead end, so it must remain eligible for a later repair.
                MutationCommand::AddDirectedEdge { from, .. }
                | MutationCommand::AddDirectedTeleport { from, .. } => node == from,
                MutationCommand::AddBidirectionalEdge { a, b }
                | MutationCommand::AddBidirectionalTeleport { a, b } => node == a || node == b,
                // Replacing a point removes its old node id, so a different reported dead end at
                // that point is no longer live and must consume its group's budget as well.
                MutationCommand::ReplacePointNodes { at, .. } => node == at,
                _ => false,
            })
        };

        group_select_apply::<T, DeadEndGroupKind>(
            issue,
            maze,
            rng,
            preset_state,
            fix_target,
            |_| true,
            build_nested_issue,
            element_invalidated,
            crate::repair::strategies::group_select::order_by_priority(params),
        )
    }
}

crate::impl_erased_repair_strategy!(DeadEndGroupSelectStrategy, InvalidDeadEndGroupIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::IdGenerator;
    use crate::graph::Graph;
    use crate::quality_control::InvalidDeadEndIssue;
    use crate::random::MazeRng;
    use crate::repair::params::build_params;
    use crate::space::{MultiLevelField, SquareTessellation, square_rect};
    use rand::SeedableRng;
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::sync::Arc;

    fn maze() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(2, 2), &mut ids).unwrap();
        let mut graph = Graph::new();
        for node in field.all_node_ids() {
            graph.add_node(node);
        }
        Maze::new(field, graph)
    }

    fn issue(groups: Vec<(Vec<NodeId>, u32)>) -> InvalidDeadEndGroupIssue {
        InvalidDeadEndGroupIssue::new_from_check("max_dead_end_count", groups)
    }

    fn params() -> StrategyParams {
        build_params(
            <DeadEndGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                InvalidDeadEndGroupIssue,
            >>::params(&DeadEndGroupSelectStrategy),
            None,
        )
    }

    struct FailingRepair {
        tried: Rc<RefCell<Vec<NodeId>>>,
    }

    impl<T: Tessellation> RepairStrategy<T, InvalidDeadEndIssue> for FailingRepair {
        fn strategy_id(&self) -> &'static str {
            "test_failing_dead_end_repair"
        }

        fn apply(
            &self,
            issue: &InvalidDeadEndIssue,
            _: &Maze<T>,
            _: &mut dyn RngCore,
            _: &StrategyParams,
            _: &PresetState,
            _: &[NestedStrategyConfig<T>],
        ) -> (RepairResult, Vec<MutationCommand>) {
            self.tried.borrow_mut().extend(&issue.invalid);
            (RepairResult::Failed, vec![])
        }
    }

    crate::impl_erased_repair_strategy!(FailingRepair, InvalidDeadEndIssue);

    struct ResolvesTwo;

    impl<T: Tessellation> RepairStrategy<T, InvalidDeadEndIssue> for ResolvesTwo {
        fn strategy_id(&self) -> &'static str {
            "test_resolves_two_dead_ends"
        }

        fn apply(
            &self,
            issue: &InvalidDeadEndIssue,
            _: &Maze<T>,
            _: &mut dyn RngCore,
            _: &StrategyParams,
            _: &PresetState,
            _: &[NestedStrategyConfig<T>],
        ) -> (RepairResult, Vec<MutationCommand>) {
            let [source] = issue.invalid.as_slice() else {
                return (RepairResult::Failed, vec![]);
            };
            (
                RepairResult::Fixed { score: None },
                vec![MutationCommand::AddBidirectionalTeleport { a: *source, b: 0 }],
            )
        }
    }

    crate::impl_erased_repair_strategy!(ResolvesTwo, InvalidDeadEndIssue);

    struct AddsOneWay;

    impl<T: Tessellation> RepairStrategy<T, InvalidDeadEndIssue> for AddsOneWay {
        fn strategy_id(&self) -> &'static str {
            "test_adds_one_way"
        }

        fn apply(
            &self,
            issue: &InvalidDeadEndIssue,
            _: &Maze<T>,
            _: &mut dyn RngCore,
            _: &StrategyParams,
            _: &PresetState,
            _: &[NestedStrategyConfig<T>],
        ) -> (RepairResult, Vec<MutationCommand>) {
            let [source] = issue.invalid.as_slice() else {
                return (RepairResult::Failed, vec![]);
            };
            (
                RepairResult::Fixed { score: None },
                vec![MutationCommand::AddDirectedTeleport {
                    from: *source,
                    to: 0,
                }],
            )
        }
    }

    crate::impl_erased_repair_strategy!(AddsOneWay, InvalidDeadEndIssue);

    struct ReplacesOther;

    impl<T: Tessellation> RepairStrategy<T, InvalidDeadEndIssue> for ReplacesOther {
        fn strategy_id(&self) -> &'static str {
            "test_replaces_other_dead_end"
        }

        fn apply(
            &self,
            issue: &InvalidDeadEndIssue,
            _: &Maze<T>,
            _: &mut dyn RngCore,
            _: &StrategyParams,
            _: &PresetState,
            _: &[NestedStrategyConfig<T>],
        ) -> (RepairResult, Vec<MutationCommand>) {
            let [source] = issue.invalid.as_slice() else {
                return (RepairResult::Failed, vec![]);
            };
            let other = if *source == 0 { 1 } else { 0 };
            (
                RepairResult::Fixed { score: None },
                vec![MutationCommand::ReplacePointNodes {
                    at: other,
                    nodes: vec![vec![]],
                }],
            )
        }
    }

    crate::impl_erased_repair_strategy!(ReplacesOther, InvalidDeadEndIssue);

    fn nested(
        strategy: Box<dyn crate::repair::ErasedRepairStrategy<SquareTessellation>>,
    ) -> NestedStrategyConfig<SquareTessellation> {
        NestedStrategyConfig {
            slot: &NESTED_SLOTS[0],
            strategy,
            param_overrides: Default::default(),
            nested: vec![],
        }
    }

    #[test]
    fn empty_groups_succeed_without_nested_configuration() {
        let mut rng = MazeRng::seed_from_u64(1);
        let (result, commands) = DeadEndGroupSelectStrategy.apply(
            &issue(vec![]),
            &maze(),
            &mut rng,
            &params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert!(commands.is_empty());
    }

    #[test]
    fn missing_nested_configuration_fails_for_live_groups() {
        let mut rng = MazeRng::seed_from_u64(1);
        let (result, _) = DeadEndGroupSelectStrategy.apply(
            &issue(vec![(vec![0], 1)]),
            &maze(),
            &mut rng,
            &params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn failed_shared_candidate_is_not_retried_from_its_other_group() {
        let tried = Rc::new(RefCell::new(vec![]));
        let config = nested(Box::new(FailingRepair {
            tried: tried.clone(),
        }));
        let mut rng = MazeRng::seed_from_u64(2);
        let (result, commands) = DeadEndGroupSelectStrategy.apply(
            &issue(vec![(vec![0], 1), (vec![0], 1)]),
            &maze(),
            &mut rng,
            &params(),
            &PresetState::empty(),
            &[config],
        );
        assert!(matches!(result, RepairResult::Failed));
        assert!(commands.is_empty());
        assert_eq!(*tried.borrow(), vec![0]);
    }

    #[test]
    fn problematic_priority_tries_the_most_shared_candidate_first() {
        let tried = Rc::new(RefCell::new(vec![]));
        let config = nested(Box::new(FailingRepair {
            tried: tried.clone(),
        }));
        let mut rng = MazeRng::seed_from_u64(4);
        let (result, _) = DeadEndGroupSelectStrategy.apply(
            &issue(vec![(vec![0, 1], 1), (vec![1], 1)]),
            &maze(),
            &mut rng,
            &params(),
            &PresetState::empty(),
            &[config],
        );
        assert!(matches!(result, RepairResult::Failed));
        assert_eq!(*tried.borrow(), vec![1, 0]);
    }

    #[test]
    fn additional_candidate_invalidation_retires_every_affected_group_budget() {
        let config = nested(Box::new(ResolvesTwo));
        let mut rng = MazeRng::seed_from_u64(3);
        let (result, commands) = DeadEndGroupSelectStrategy.apply(
            &issue(vec![(vec![0, 1], 2), (vec![1], 1)]),
            &maze(),
            &mut rng,
            &params(),
            &PresetState::empty(),
            &[config],
        );
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert_eq!(
            commands.len(),
            1,
            "the repair of node 1 resolves node 0 as well"
        );
    }

    #[test]
    fn one_way_destination_remains_live_for_a_later_repair() {
        let config = nested(Box::new(AddsOneWay));
        let mut rng = MazeRng::seed_from_u64(5);
        let (result, commands) = DeadEndGroupSelectStrategy.apply(
            &issue(vec![(vec![0, 1], 2), (vec![1], 1)]),
            &maze(),
            &mut rng,
            &params(),
            &PresetState::empty(),
            &[config],
        );
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert_eq!(
            commands.len(),
            2,
            "an incoming one-way edge does not repair the destination dead end"
        );
    }

    #[test]
    fn replacing_another_reported_dead_end_retires_its_budget() {
        let config = nested(Box::new(ReplacesOther));
        let mut rng = MazeRng::seed_from_u64(6);
        let (result, commands) = DeadEndGroupSelectStrategy.apply(
            &issue(vec![(vec![0, 1], 2)]),
            &maze(),
            &mut rng,
            &params(),
            &PresetState::empty(),
            &[config],
        );
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert_eq!(
            commands.len(),
            1,
            "replacing the other reported dead end resolves both candidates"
        );
    }
}
