use crate::Maze;
use crate::generation::PresetState;
use crate::quality_control::InvalidOneWayIssue;
use crate::repair::command::MutationCommand;
use crate::repair::params::StrategyParams;
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::RngCore;

/// Handles `INVALID_ONE_WAY` — see GitHub issue #198. Converts every flagged one-way edge into a
/// full bidirectional passage by adding the missing reverse direction
/// (`MutationCommand::AddBidirectionalEdge`, completion-aware — a no-op for whichever direction
/// already exists). One of two strategies registered against `INVALID_ONE_WAY`; a rule picks
/// exactly one, same as every other kind with more than one registered strategy — see
/// `OneWayToWallStrategy` for the other ("remove entirely" instead of "complete into a passage").
pub struct OneWayToPassageStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidOneWayIssue> for OneWayToPassageStrategy {
    fn strategy_id(&self) -> &'static str {
        "one_way_to_passage"
    }

    fn apply(
        &self,
        issue: &InvalidOneWayIssue,
        maze: &Maze<T>,
        _rng: &mut dyn RngCore,
        _params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let commands: Vec<MutationCommand> = issue
            .invalid
            .iter()
            .filter_map(|&id| maze.graph.edge(id))
            .flat_map(|edge| {
                crate::generation::cmd_add_bidirectional_edge(edge.from, edge.to, preset_state)
            })
            .collect();
        // A preset-blocked reverse direction can never be completed into a passage — if every
        // flagged edge is such a case, nothing can be fixed, so this must report `Failed` (GitHub
        // issue #230) rather than `Fixed` with an empty command list, or the fixpoint loop retries
        // it forever.
        let result = if issue.invalid.is_empty() || !commands.is_empty() {
            RepairResult::Fixed { score: None }
        } else {
            RepairResult::Failed
        };
        (result, commands)
    }
}

crate::impl_erased_repair_strategy!(OneWayToPassageStrategy, InvalidOneWayIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::random::MazeRng;
    use crate::repair::strategies::test_utils::apply_and_commit_default;
    use crate::space::{SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;

    #[test]
    fn apply_completes_the_flagged_one_way_into_a_bidirectional_passage() {
        let mut ids = IdGenerator::new();
        let field =
            crate::space::MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_points()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        let one_way_id = g.add_edge(nodes[0], nodes[2], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = InvalidOneWayIssue::new_from_check("test", vec![one_way_id]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit_default(
            &OneWayToPassageStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &PresetState::empty(),
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(maze.graph.edge_between(nodes[0], nodes[2]).is_some());
        assert!(
            maze.graph.edge_between(nodes[2], nodes[0]).is_some(),
            "reverse direction must be added"
        );
    }

    #[test]
    fn apply_reports_failed_when_the_reverse_direction_is_preset_blocked() {
        // GitHub issue #230: the reverse direction is blocked by preset state, so the one-way can
        // never be completed into a passage — must report Failed, not Fixed, or the fixpoint loop
        // retries it forever.
        let mut ids = IdGenerator::new();
        let field =
            crate::space::MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_points()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        let one_way_id = g.add_edge(nodes[0], nodes[2], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((nodes[2], nodes[0]));

        let issue = InvalidOneWayIssue::new_from_check("test", vec![one_way_id]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit_default(
            &OneWayToPassageStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &preset_state,
        );
        assert!(matches!(result, RepairResult::Failed));
        assert!(
            maze.graph.edge_between(nodes[2], nodes[0]).is_none(),
            "blocked reverse direction must not be added"
        );
    }

    #[test]
    fn apply_succeeds_on_empty_invalid_list() {
        let mut ids = IdGenerator::new();
        let field =
            crate::space::MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = InvalidOneWayIssue::new_from_check("test", vec![]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit_default(
            &OneWayToPassageStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &PresetState::empty(),
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }
}
