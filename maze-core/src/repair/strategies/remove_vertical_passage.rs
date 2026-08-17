use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::InvalidVerticalPassageIssue;
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;

static PARAMS: &[StrategyParam] = &[];

/// Handles `INVALID_VERTICAL_PASSAGE` — see GitHub issue #343. The fix strategy for every
/// per-vertical-passage validation check: removes each flagged edge (and its reverse, if it's one
/// direction of a two-way vertical passage — `RemoveVerticalPassageWithReverse` mirrors
/// `RemoveTeleportWithReverse`, so a two-way vertical passage is never left silently downgraded to
/// one-way just because a check's edge selector only inspected one direction). No configurable
/// parameters — unlike `RemoveTeleportStrategy`'s `allow_reverse`, downgrading to one-way was not
/// requested for this kind.
pub struct RemoveVerticalPassageStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidVerticalPassageIssue> for RemoveVerticalPassageStrategy {
    fn strategy_id(&self) -> &'static str { "remove_vertical_passage" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        issue: &InvalidVerticalPassageIssue,
        _maze: &Maze<T>,
        _rng: &mut dyn RngCore,
        _params: &StrategyParams,
        _preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let commands = issue.invalid.iter()
            .map(|&id| MutationCommand::RemoveVerticalPassageWithReverse { id })
            .collect();
        (RepairResult::Fixed { score: None }, commands)
    }
}

crate::impl_erased_repair_strategy!(RemoveVerticalPassageStrategy, InvalidVerticalPassageIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{SquareTessellation, square_rect};
    use crate::repair::params::build_params;
    use crate::repair::strategies::test_utils::apply_and_commit;

    fn no_params() -> StrategyParams {
        build_params(<RemoveVerticalPassageStrategy as RepairStrategy<SquareTessellation, InvalidVerticalPassageIssue>>::params(&RemoveVerticalPassageStrategy), None)
    }

    #[test]
    fn apply_removes_flagged_vertical_passage() {
        let mut ids = IdGenerator::new();
        let field = crate::space::MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
        let id = g.add_edge(nodes[0], nodes[2], EdgeKind::VerticalPassage);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = InvalidVerticalPassageIssue::new_from_check("test", vec![id]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&RemoveVerticalPassageStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(!maze.graph.edges().any(|e| e.kind == EdgeKind::VerticalPassage));
    }

    #[test]
    fn apply_removes_both_directions_of_a_two_way_vertical_passage() {
        let mut ids = IdGenerator::new();
        let field = crate::space::MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
        let forward_id = g.add_edge(nodes[0], nodes[2], EdgeKind::VerticalPassage);
        let backward_id = g.add_edge(nodes[2], nodes[0], EdgeKind::VerticalPassage);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = InvalidVerticalPassageIssue::new_from_check("test", vec![forward_id]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&RemoveVerticalPassageStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edge(forward_id).is_none());
        assert!(maze.graph.edge(backward_id).is_none(), "the unflagged backward direction must also be removed");
    }

    #[test]
    fn apply_does_not_remove_a_reverse_basic_edge_mistaken_for_a_vertical_passage_reverse() {
        let mut ids = IdGenerator::new();
        let field = crate::space::MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
        let vp_id = g.add_edge(nodes[0], nodes[2], EdgeKind::VerticalPassage);
        let reverse_basic_id = g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = InvalidVerticalPassageIssue::new_from_check("test", vec![vp_id]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&RemoveVerticalPassageStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edge(vp_id).is_none());
        assert!(maze.graph.edge(reverse_basic_id).is_some(), "a reverse Basic edge must survive -- it is not a vertical passage reverse");
    }

    #[test]
    fn apply_succeeds_on_empty_invalid_list() {
        let mut ids = IdGenerator::new();
        let field = crate::space::MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        let issue = InvalidVerticalPassageIssue::new_from_check("test", vec![]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&RemoveVerticalPassageStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }
}
