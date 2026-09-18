use crate::Maze;
use crate::generation::PresetState;
use crate::ids::NodeId;
use crate::quality_control::{
    ElevatorStopGroupKind, INVALID_ELEVATOR_STOP, InvalidElevatorStopGroupIssue,
    InvalidElevatorStopIssue,
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

/// Slot id for the nested strategy this strategy delegates a single picked stop's actual removal
/// to (`RemoveElevatorStopStrategy`) — mirrors `ElevatorGroupSelectStrategy::SLOT_FIX_TARGET`.
pub const SLOT_FIX_TARGET: &str = "fix_target";

static NESTED_SLOTS: &[NestedSlot] = &[NestedSlot {
    slot_id: SLOT_FIX_TARGET,
    kind: INVALID_ELEVATOR_STOP,
    min: 1,
    max: Some(1),
    dispatch_kind: NestedDispatchKind::Unordered,
}];

/// Handles `INVALID_ELEVATOR_STOP_GROUP` — see GitHub issue #399, extended by GitHub issue #400.
/// Produced by `MaxElevatorStopsCheck` (excess stops on a single elevator),
/// `MaxElevatorStopsPerFloorCheck` (excess elevator-stops on a single floor), and
/// `ElevatorStopsSkipCheck`/`ElevatorStopsSpanCheck` (a single flagged stop pair each). Mirrors
/// `ElevatorGroupSelectStrategy`'s shape, except `K::Element` is a bare `NodeId` (one stop), not a
/// whole `ElevatorNodes` — every fix removes one stop from whichever elevator it belongs to,
/// never the whole elevator. `apply()`'s own candidate-pass/budget/nested-delegation mechanics are
/// the shared `group_select::group_select_apply`, the same `PARAM_PRIORITY`
/// (`random`/`problematic`) selection every other group-select strategy in this crate uses. No
/// route protection here — an elevator-stop excess isn't gated by a `protect_route` param in this
/// issue's scope, so `element_allowed` always returns `true`.
pub struct ElevatorStopGroupSelectStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidElevatorStopGroupIssue>
    for ElevatorStopGroupSelectStrategy
{
    fn strategy_id(&self) -> &'static str {
        "elevator_stop_group_select"
    }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn expected_nested(&self) -> &'static [NestedSlot] {
        NESTED_SLOTS
    }

    fn apply(
        &self,
        issue: &InvalidElevatorStopGroupIssue,
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
            "ElevatorStopGroupSelectStrategy: expected_nested()'s max: Some(1) for slot \"{SLOT_FIX_TARGET}\" should prevent more than one nested strategy filling it"
        );
        let Some(&fix_target) = matching.first() else {
            if issue.groups.is_empty() {
                return (RepairResult::Fixed { score: None }, vec![]);
            }
            return (RepairResult::Failed, vec![]);
        };

        let build_nested_issue = |source_check: &str,
                                  target: &NodeId,
                                  _others: &[NodeId]|
         -> Box<dyn crate::quality_control::Issue> {
            Box::new(InvalidElevatorStopIssue::new_from_check(
                source_check,
                vec![*target],
            ))
        };
        // No other still-live candidate stop can ever be invalidated by resolving this one --
        // removing one stop only touches edges incident to that stop, never another stop's own
        // edges to the rest of the elevator (or to a different elevator entirely). Mirrors
        // `ElevatorGroupSelectStrategy`'s identical reasoning for whole elevators.
        let element_invalidated =
            |_stop: &NodeId, _nested_commands: &[MutationCommand], _maze: &Maze<T>| false;

        group_select_apply::<T, ElevatorStopGroupKind>(
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

crate::impl_erased_repair_strategy!(
    ElevatorStopGroupSelectStrategy,
    InvalidElevatorStopGroupIssue
);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::random::MazeRng;
    use crate::repair::params::build_params;
    use crate::repair::strategies::remove_elevator_stop::RemoveElevatorStopStrategy;
    use crate::repair::strategies::test_utils::apply_and_commit;
    use crate::repair::strategy::NestedSlot as NestedSlotType;
    use crate::space::{Field, MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;
    use std::collections::HashMap;

    fn three_stop_elevator() -> (Maze<SquareTessellation>, Vec<NodeId>) {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let floors: Vec<_> = (0..3)
            .map(|_| {
                mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap())
            })
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<NodeId> = floors
            .iter()
            .map(|&l| mf.node_at(l, SquarePoint { x: 0, y: 0 }).unwrap())
            .collect();
        for i in 0..nodes.len() {
            for j in (i + 1)..nodes.len() {
                g.add_edge(nodes[i], nodes[j], EdgeKind::Elevator);
                g.add_edge(nodes[j], nodes[i], EdgeKind::Elevator);
            }
        }
        (Maze::new(mf, g), nodes)
    }

    fn nested_config() -> NestedStrategyConfig<SquareTessellation> {
        NestedStrategyConfig {
            slot: &NestedSlotType {
                slot_id: SLOT_FIX_TARGET,
                kind: INVALID_ELEVATOR_STOP,
                min: 1,
                max: Some(1),
                dispatch_kind: NestedDispatchKind::Unordered,
            },
            strategy: Box::new(RemoveElevatorStopStrategy),
            param_overrides: HashMap::new(),
            nested: vec![],
        }
    }

    fn no_params() -> StrategyParams {
        build_params(
            <ElevatorStopGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                InvalidElevatorStopGroupIssue,
            >>::params(&ElevatorStopGroupSelectStrategy),
            None,
        )
    }

    #[test]
    fn apply_removes_one_stop_from_the_flagged_group() {
        let (mut maze, nodes) = three_stop_elevator();
        let issue = InvalidElevatorStopGroupIssue::new_from_check(
            "max_elevator_stops",
            vec![(nodes.clone(), 1)],
        );
        let params = no_params();
        let nested = nested_config();
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &ElevatorStopGroupSelectStrategy,
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
            "removing 1 stop from a 3-stop fan leaves 1 pair (2 directed edges)"
        );
    }

    #[test]
    fn apply_succeeds_on_empty_groups_without_a_nested_strategy() {
        let (mut maze, _nodes) = three_stop_elevator();
        let issue = InvalidElevatorStopGroupIssue::new_from_check("max_elevator_stops", vec![]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &ElevatorStopGroupSelectStrategy,
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
        let (mut maze, nodes) = three_stop_elevator();
        let issue =
            InvalidElevatorStopGroupIssue::new_from_check("max_elevator_stops", vec![(nodes, 1)]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &ElevatorStopGroupSelectStrategy,
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
    fn apply_removes_all_flagged_stops_when_to_remove_covers_them() {
        let (mut maze, nodes) = three_stop_elevator();
        let issue = InvalidElevatorStopGroupIssue::new_from_check(
            "max_elevator_stops",
            vec![(nodes.clone(), 2)],
        );
        let params = no_params();
        let nested = nested_config();
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &ElevatorStopGroupSelectStrategy,
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
            "removing 2 of 3 stops leaves nothing connected"
        );
    }
}
