use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::InvalidOneWayIssue;
use crate::generation::PresetState;
use crate::repair::params::StrategyParams;
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;

/// Handles `INVALID_ONE_WAY` — see GitHub issue #198. Converts every flagged one-way edge into a
/// full bidirectional passage by adding the missing reverse direction
/// (`MutationCommand::AddBidirectionalEdge`, completion-aware — a no-op for whichever direction
/// already exists). One of two strategies registered against `INVALID_ONE_WAY`; a rule picks
/// exactly one, same as every other kind with more than one registered strategy — see
/// `OneWayToWallStrategy` for the other ("remove entirely" instead of "complete into a passage").
pub struct OneWayToPassageStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidOneWayIssue> for OneWayToPassageStrategy {
    fn strategy_id(&self) -> &'static str { "one_way_to_passage" }

    fn apply(
        &self,
        issue: &InvalidOneWayIssue,
        maze: &Maze<T>,
        _rng: &mut dyn RngCore,
        _params: &StrategyParams,
        _preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let commands = issue.invalid.iter()
            .filter_map(|&id| maze.graph.edge(id))
            .map(|edge| MutationCommand::AddBidirectionalEdge { a: edge.from, b: edge.to })
            .collect();
        (RepairResult::Fixed { score: None }, commands)
    }
}

crate::impl_erased_repair_strategy!(OneWayToPassageStrategy, InvalidOneWayIssue);

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
    fn apply_completes_the_flagged_one_way_into_a_bidirectional_passage() {
        let mut ids = IdGenerator::new();
        let field = crate::space::Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        let one_way_id = g.add_edge(nodes[0], nodes[2], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = InvalidOneWayIssue::new_from_check("test", vec![one_way_id]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit_default(&OneWayToPassageStrategy, &issue, &mut maze, &mut rng, &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(maze.graph.edge_between(nodes[0], nodes[2]).is_some());
        assert!(maze.graph.edge_between(nodes[2], nodes[0]).is_some(), "reverse direction must be added");
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
        let result = apply_and_commit_default(&OneWayToPassageStrategy, &issue, &mut maze, &mut rng, &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }
}
