use crate::Maze;
use crate::generation::PresetState;
use crate::quality_control::{
    ElevatorGroupKind, ElevatorNodes, INVALID_ELEVATOR, InvalidElevatorGroupIssue,
    InvalidElevatorIssue,
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

/// Slot id for the nested strategy this strategy delegates a single picked elevator's actual
/// removal to (`RemoveElevatorStrategy`/`ReplaceElevatorWithPassagesStrategy`) — mirrors
/// `VerticalPassageGroupSelectStrategy::SLOT_FIX_TARGET`.
pub const SLOT_FIX_TARGET: &str = "fix_target";

static NESTED_SLOTS: &[NestedSlot] = &[NestedSlot {
    slot_id: SLOT_FIX_TARGET,
    kind: INVALID_ELEVATOR,
    min: 1,
    max: Some(1),
    dispatch_kind: NestedDispatchKind::Unordered,
}];

/// Handles `INVALID_ELEVATOR_GROUP` — see GitHub issue #398. Produced by
/// `MaxElevatorCountCheck`/`MaxElevatorDensityCheck` (whole-maze excess). Mirrors
/// `SplitGroupSelectStrategy`'s shape: every candidate is a whole `ElevatorNodes`, never any one of
/// its individual stops/edges, so a single fix always removes/converts one whole elevator — same
/// "whole entity is the unit" rationale as split tiles. `apply()`'s own candidate-pass/budget/
/// nested-delegation mechanics are the shared `group_select::group_select_apply`, the same
/// `PARAM_PRIORITY` (`random`/`problematic`) selection every other group-select strategy in this
/// crate uses. No route protection here — an elevator group excess isn't gated by a
/// `protect_route` param in this issue's scope, so `element_allowed` always returns `true`.
pub struct ElevatorGroupSelectStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidElevatorGroupIssue> for ElevatorGroupSelectStrategy {
    fn strategy_id(&self) -> &'static str {
        "elevator_group_select"
    }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn expected_nested(&self) -> &'static [NestedSlot] {
        NESTED_SLOTS
    }

    fn apply(
        &self,
        issue: &InvalidElevatorGroupIssue,
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
            "ElevatorGroupSelectStrategy: expected_nested()'s max: Some(1) for slot \"{SLOT_FIX_TARGET}\" should prevent more than one nested strategy filling it"
        );
        let Some(&fix_target) = matching.first() else {
            if issue.groups.is_empty() {
                return (RepairResult::Fixed { score: None }, vec![]);
            }
            return (RepairResult::Failed, vec![]);
        };

        let build_nested_issue = |source_check: &str,
                                  target: &ElevatorNodes,
                                  _others: &[ElevatorNodes]|
         -> Box<dyn crate::quality_control::Issue> {
            Box::new(InvalidElevatorIssue::new_from_check(
                source_check,
                vec![target.clone()],
            ))
        };
        // No other still-live candidate elevator can ever be invalidated by resolving this one --
        // distinct `ElevatorNodes` candidates are always different stop-node sets (elevators never
        // share a stop, since each is its own connected component of `Elevator` edges), so
        // removing/converting one never touches another's identity. `group_select_apply`'s own
        // "target always counts as invalidated" rule already retires this elevator's own budget --
        // this hook has nothing left to add, mirrors `SplitGroupSelectStrategy`'s identical case.
        let element_invalidated = |_elevator: &ElevatorNodes,
                                   _nested_commands: &[MutationCommand],
                                   _maze: &Maze<T>| false;

        group_select_apply::<T, ElevatorGroupKind>(
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

crate::impl_erased_repair_strategy!(ElevatorGroupSelectStrategy, InvalidElevatorGroupIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::random::MazeRng;
    use crate::repair::params::build_params;
    use crate::repair::strategies::remove_elevator::RemoveElevatorStrategy;
    use crate::repair::strategies::test_utils::apply_and_commit;
    use crate::repair::strategy::NestedSlot as NestedSlotType;
    use crate::space::{Field, MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;
    use std::collections::HashMap;

    fn maze_with_two_elevators() -> (Maze<SquareTessellation>, ElevatorNodes, ElevatorNodes) {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap());
        let top =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let a0 = mf.node_at(bottom, SquarePoint { x: 0, y: 0 }).unwrap();
        let a1 = mf.node_at(top, SquarePoint { x: 0, y: 0 }).unwrap();
        let b0 = mf.node_at(bottom, SquarePoint { x: 1, y: 0 }).unwrap();
        let b1 = mf.node_at(top, SquarePoint { x: 1, y: 0 }).unwrap();
        g.add_edge(a0, a1, EdgeKind::Elevator);
        g.add_edge(a1, a0, EdgeKind::Elevator);
        g.add_edge(b0, b1, EdgeKind::Elevator);
        g.add_edge(b1, b0, EdgeKind::Elevator);
        let maze = Maze::new(mf, g);
        (
            maze,
            ElevatorNodes::new(vec![a0, a1]),
            ElevatorNodes::new(vec![b0, b1]),
        )
    }

    fn nested_config() -> NestedStrategyConfig<SquareTessellation> {
        NestedStrategyConfig {
            slot: &NestedSlotType {
                slot_id: SLOT_FIX_TARGET,
                kind: INVALID_ELEVATOR,
                min: 1,
                max: Some(1),
                dispatch_kind: NestedDispatchKind::Unordered,
            },
            strategy: Box::new(RemoveElevatorStrategy),
            param_overrides: HashMap::new(),
            nested: vec![],
        }
    }

    fn no_params() -> StrategyParams {
        build_params(
            <ElevatorGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                InvalidElevatorGroupIssue,
            >>::params(&ElevatorGroupSelectStrategy),
            None,
        )
    }

    #[test]
    fn apply_removes_one_elevator_from_the_flagged_group() {
        let (mut maze, a, b) = maze_with_two_elevators();
        let issue =
            InvalidElevatorGroupIssue::new_from_check("max_elevator_count", vec![(vec![a, b], 1)]);
        let params = no_params();
        let nested = nested_config();
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &ElevatorGroupSelectStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &params,
            &PresetState::empty(),
            std::slice::from_ref(&nested),
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(
            maze.graph
                .edges()
                .filter(|e| e.kind == EdgeKind::Elevator)
                .count(),
            2,
            "exactly one elevator (2 edges) from the group of 2 must be removed"
        );
    }

    #[test]
    fn apply_succeeds_on_empty_groups_without_a_nested_strategy() {
        let (mut maze, _a, _b) = maze_with_two_elevators();
        let issue = InvalidElevatorGroupIssue::new_from_check("max_elevator_count", vec![]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &ElevatorGroupSelectStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }

    #[test]
    fn apply_fails_when_nested_is_empty_but_groups_are_not() {
        let (mut maze, a, b) = maze_with_two_elevators();
        let issue =
            InvalidElevatorGroupIssue::new_from_check("max_elevator_count", vec![(vec![a, b], 1)]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &ElevatorGroupSelectStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_removes_both_elevators_when_to_remove_covers_the_whole_group() {
        let (mut maze, a, b) = maze_with_two_elevators();
        let issue =
            InvalidElevatorGroupIssue::new_from_check("max_elevator_count", vec![(vec![a, b], 2)]);
        let params = no_params();
        let nested = nested_config();
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &ElevatorGroupSelectStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &params,
            &PresetState::empty(),
            std::slice::from_ref(&nested),
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(
            maze.graph
                .edges()
                .filter(|e| e.kind == EdgeKind::Elevator)
                .count(),
            0,
            "both elevators must be removed"
        );
    }
}
