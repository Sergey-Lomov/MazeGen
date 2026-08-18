use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::InvalidElevatorStopIssue;
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;
use super::elevator_utils::remove_stop_commands;

static PARAMS: &[StrategyParam] = &[];

/// Handles `INVALID_ELEVATOR_STOP` — see GitHub issue #399. Removes each flagged stop node from
/// its own elevator: every `EdgeKind::Elevator` edge between that stop and any of the elevator's
/// other stops, via `elevator_utils::remove_stop_commands`. The rest of the elevator (its
/// remaining stops' own fan) is left untouched — distinct from `RemoveElevatorStrategy`, which
/// removes the whole elevator. A flagged stop no longer part of any current elevator (e.g. an
/// earlier fixpoint iteration already removed it) is simply skipped.
pub struct RemoveElevatorStopStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidElevatorStopIssue> for RemoveElevatorStopStrategy {
    fn strategy_id(&self) -> &'static str { "remove_elevator_stop" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        issue: &InvalidElevatorStopIssue,
        maze: &Maze<T>,
        _rng: &mut dyn RngCore,
        _params: &StrategyParams,
        _preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let mut commands = Vec::new();
        for &stop in &issue.invalid {
            if let Some(stop_commands) = remove_stop_commands(maze, stop) {
                commands.extend(stop_commands);
            }
        }
        (RepairResult::Fixed { score: None }, commands)
    }
}

crate::impl_erased_repair_strategy!(RemoveElevatorStopStrategy, InvalidElevatorStopIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, MultiLevelField, SquareTessellation, SquarePoint, square_rect};
    use crate::repair::params::build_params;
    use crate::repair::strategies::test_utils::apply_and_commit;

    fn no_params() -> StrategyParams {
        build_params(<RemoveElevatorStopStrategy as RepairStrategy<SquareTessellation, InvalidElevatorStopIssue>>::params(&RemoveElevatorStopStrategy), None)
    }

    fn three_stop_elevator() -> (Maze<SquareTessellation>, Vec<crate::ids::NodeId>) {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let floors: Vec<_> = (0..3)
            .map(|_| mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap()))
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = floors.iter().map(|&l| mf.node_at(l, SquarePoint { x: 0, y: 0 }).unwrap()).collect();
        for i in 0..nodes.len() {
            for j in (i + 1)..nodes.len() {
                g.add_edge(nodes[i], nodes[j], EdgeKind::Elevator);
                g.add_edge(nodes[j], nodes[i], EdgeKind::Elevator);
            }
        }
        (Maze::new(mf, g), nodes)
    }

    #[test]
    fn apply_removes_only_the_flagged_stop_leaving_the_rest_of_the_elevator_intact() {
        let (mut maze, nodes) = three_stop_elevator();
        let issue = InvalidElevatorStopIssue::new_from_check("test", vec![nodes[0]]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&RemoveElevatorStopStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_none());
        assert!(maze.graph.edge_between(nodes[0], nodes[2]).is_none());
        assert!(maze.graph.edge_between(nodes[1], nodes[2]).is_some(), "the remaining two stops must still be connected");
    }

    #[test]
    fn apply_skips_a_flagged_stop_no_longer_part_of_any_elevator() {
        let (mut maze, nodes) = three_stop_elevator();
        let issue = InvalidElevatorStopIssue::new_from_check("test", vec![nodes[0], nodes[0]]);
        let mut rng = MazeRng::seed_from_u64(1);
        let _ = apply_and_commit(&RemoveElevatorStopStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        // Second application: nodes[0] is no longer part of any elevator, must not panic.
        let result = apply_and_commit(&RemoveElevatorStopStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }

    #[test]
    fn apply_succeeds_on_empty_invalid_list() {
        let (mut maze, _nodes) = three_stop_elevator();
        let issue = InvalidElevatorStopIssue::new_from_check("test", vec![]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&RemoveElevatorStopStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }
}
