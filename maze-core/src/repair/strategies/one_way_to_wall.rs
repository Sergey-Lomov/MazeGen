use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::InvalidOneWayIssue;
use crate::generation::PresetState;
use crate::repair::params::StrategyParams;
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;

/// Handles `INVALID_ONE_WAY` — see GitHub issue #198. Removes every flagged one-way edge entirely
/// (full wall). The other of the two strategies registered against `INVALID_ONE_WAY` — see
/// `OneWayToPassageStrategy` for the "complete into a bidirectional passage" alternative.
pub struct OneWayToWallStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidOneWayIssue> for OneWayToWallStrategy {
    fn strategy_id(&self) -> &'static str { "one_way_to_wall" }

    fn apply(
        &self,
        issue: &InvalidOneWayIssue,
        _maze: &Maze<T>,
        _rng: &mut dyn RngCore,
        _params: &StrategyParams,
        _preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let commands = issue.invalid.iter()
            .map(|&id| MutationCommand::RemoveEdge { id })
            .collect();
        (RepairResult::Fixed { score: None }, commands)
    }
}

crate::impl_erased_repair_strategy!(OneWayToWallStrategy, InvalidOneWayIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{SquareTessellation, square_rect};
    use crate::repair::strategies::test_utils::apply_and_commit_default;

    #[test]
    fn apply_removes_the_flagged_one_way() {
        let mut ids = IdGenerator::new();
        let field = crate::space::Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        let one_way_id = g.add_edge(nodes[0], nodes[2], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = InvalidOneWayIssue::new_from_check("test", vec![one_way_id]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit_default(&OneWayToWallStrategy, &issue, &mut maze, &mut rng, &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(maze.graph.edge(one_way_id).is_none());
    }

    #[test]
    fn apply_does_not_remove_a_preset_protected_one_way() {
        let mut ids = IdGenerator::new();
        let field = crate::space::Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        let one_way_id = g.add_edge(nodes[0], nodes[2], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = InvalidOneWayIssue::new_from_check("test", vec![one_way_id]);
        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((nodes[0], nodes[2]));

        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit_default(&OneWayToWallStrategy, &issue, &mut maze, &mut rng, &preset_state);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(maze.graph.edge(one_way_id).is_some(), "a preset-protected one-way must survive removal");
    }

    #[test]
    fn apply_succeeds_on_empty_invalid_list() {
        let mut ids = IdGenerator::new();
        let field = crate::space::Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = InvalidOneWayIssue::new_from_check("test", vec![]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit_default(&OneWayToWallStrategy, &issue, &mut maze, &mut rng, &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }
}
