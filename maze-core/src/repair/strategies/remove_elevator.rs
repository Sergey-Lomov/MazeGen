use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::InvalidElevatorIssue;
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;
use crate::quality_control::checks::elevator_core::elevator_groups;

static PARAMS: &[StrategyParam] = &[];

/// Handles `INVALID_ELEVATOR` — see GitHub issue #397. Fully removes each flagged elevator: every
/// `EdgeKind::Elevator` edge among its stops. `issue.invalid` names each elevator by its stop-node
/// set, not by edge id (mirrors `RemoveSplitStrategy`'s "whole entity, not a saved edge list"
/// approach) — the current fan of edges between those stops is re-resolved against `maze` at
/// apply time via `elevator_groups`, so a stale issue (an elevator already partially repaired by
/// an earlier fixpoint iteration) still removes whatever of its own edges remain, rather than
/// replaying a possibly-stale edge list.
pub struct RemoveElevatorStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidElevatorIssue> for RemoveElevatorStrategy {
    fn strategy_id(&self) -> &'static str { "remove_elevator" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        issue: &InvalidElevatorIssue,
        maze: &Maze<T>,
        _rng: &mut dyn RngCore,
        _params: &StrategyParams,
        _preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let current = elevator_groups(maze);
        let mut commands = Vec::new();
        for flagged in &issue.invalid {
            let mut stops = flagged.0.clone();
            stops.sort_unstable();
            let Some(elevator) = current.iter().find(|e| {
                let mut current_stops = e.stops.clone();
                current_stops.sort_unstable();
                current_stops == stops
            }) else {
                continue;
            };
            for &id in &elevator.edges {
                commands.push(MutationCommand::RemoveEdgeWithReverse { id });
            }
        }
        (RepairResult::Fixed { score: None }, commands)
    }
}

crate::impl_erased_repair_strategy!(RemoveElevatorStrategy, InvalidElevatorIssue);

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
    use crate::quality_control::issue_kinds::ElevatorNodes;

    fn no_params() -> StrategyParams {
        build_params(<RemoveElevatorStrategy as RepairStrategy<SquareTessellation, InvalidElevatorIssue>>::params(&RemoveElevatorStrategy), None)
    }

    fn three_floor_maze() -> (Maze<SquareTessellation>, Vec<crate::ids::NodeId>) {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let floors: Vec<_> = (0..3)
            .map(|_| mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap()))
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = floors.iter().map(|&l| mf.node_at(l, SquarePoint { x: 0, y: 0 }).unwrap()).collect();
        (Maze::new(mf, g), nodes)
    }

    #[test]
    fn apply_removes_every_edge_of_the_flagged_elevator() {
        let (mut maze, nodes) = three_floor_maze();
        for i in 0..nodes.len() {
            for j in (i + 1)..nodes.len() {
                maze.graph.add_edge(nodes[i], nodes[j], EdgeKind::Elevator);
                maze.graph.add_edge(nodes[j], nodes[i], EdgeKind::Elevator);
            }
        }
        let issue = InvalidElevatorIssue::new_from_check("test", vec![ElevatorNodes::new(nodes.clone())]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&RemoveElevatorStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(!maze.graph.edges().any(|e| e.kind == EdgeKind::Elevator));
    }

    #[test]
    fn apply_leaves_other_elevators_untouched() {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let floors: Vec<_> = (0..2)
            .map(|_| mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap()))
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let a: Vec<_> = floors.iter().map(|&l| mf.node_at(l, SquarePoint { x: 0, y: 0 }).unwrap()).collect();
        let b: Vec<_> = floors.iter().map(|&l| mf.node_at(l, SquarePoint { x: 1, y: 0 }).unwrap()).collect();
        let mut maze: Maze<SquareTessellation> = Maze::new(mf, g);
        maze.graph.add_edge(a[0], a[1], EdgeKind::Elevator);
        maze.graph.add_edge(a[1], a[0], EdgeKind::Elevator);
        maze.graph.add_edge(b[0], b[1], EdgeKind::Elevator);
        maze.graph.add_edge(b[1], b[0], EdgeKind::Elevator);

        let issue = InvalidElevatorIssue::new_from_check("test", vec![ElevatorNodes::new(a.clone())]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&RemoveElevatorStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edge_between(a[0], a[1]).is_none());
        assert!(maze.graph.edge_between(b[0], b[1]).is_some(), "the other elevator must survive");
    }

    #[test]
    fn apply_skips_a_flagged_elevator_no_longer_present_but_still_removes_others() {
        // The flagged stop set for `a` no longer forms an elevator (e.g. an earlier fixpoint
        // iteration already removed it) -- must be skipped without panicking, while `b` (still
        // flagged and still present) is removed normally.
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let floors: Vec<_> = (0..2)
            .map(|_| mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap()))
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let a: Vec<_> = floors.iter().map(|&l| mf.node_at(l, SquarePoint { x: 0, y: 0 }).unwrap()).collect();
        let b: Vec<_> = floors.iter().map(|&l| mf.node_at(l, SquarePoint { x: 1, y: 0 }).unwrap()).collect();
        let mut maze: Maze<SquareTessellation> = Maze::new(mf, g);
        // Only b is actually wired as an elevator; a is flagged but was never (or no longer) one.
        maze.graph.add_edge(b[0], b[1], EdgeKind::Elevator);
        maze.graph.add_edge(b[1], b[0], EdgeKind::Elevator);

        let issue = InvalidElevatorIssue::new_from_check("test", vec![ElevatorNodes::new(a.clone()), ElevatorNodes::new(b.clone())]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&RemoveElevatorStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edge_between(b[0], b[1]).is_none());
    }

    #[test]
    fn apply_succeeds_on_empty_invalid_list() {
        let (mut maze, _nodes) = three_floor_maze();
        let issue = InvalidElevatorIssue::new_from_check("test", vec![]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&RemoveElevatorStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }
}
