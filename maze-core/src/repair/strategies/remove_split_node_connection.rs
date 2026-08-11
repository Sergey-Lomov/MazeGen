use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::InvalidSplitNodeConnectionIssue;
use crate::generation::PresetState;
use crate::repair::params::StrategyParams;
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;

/// Handles `INVALID_SPLIT_NODE_CONNECTION` — see GitHub issue #251, epic #246. The nested-slot
/// target `SplitNodeConnectionGroupSelectStrategy` delegates each candidate connection's removal
/// to. Removes every flagged edge **and its reverse direction, if any**
/// (`MutationCommand::RemoveEdgeWithReverse`, via `cmd_remove_edge_with_reverse`) — a split node's
/// "connection" to a neighbor is the whole physical passage, not one directed half of it, so a
/// bidirectional connection must be fully severed, not left as a dangling one-way.
///
/// `cmd_remove_edge_with_reverse` itself never checks preset feasibility upfront (unlike
/// `cmd_remove_edge_by_id`) — it always proposes the command and defers to
/// `try_remove_edge_with_reverse` at real apply time. Called directly through
/// `SplitNodeConnectionGroupSelectStrategy`'s nested wiring this is harmless (that strategy's own
/// `element_allowed` already excludes fully preset-blocked candidates upfront). But this strategy
/// is *also* independently registered (`strategy_factory.rs`/`strategies_catalog.rs`) and can be
/// assigned directly to a rule's `INVALID_SPLIT_NODE_CONNECTION`, bypassing that filter — so
/// `removal_feasible` re-derives the same upfront check here, at the point where a false `Fixed`
/// would otherwise be reported and the repair fixpoint loop would spin on an unfixable
/// preset-locked connection until `RepairLimitReached` (GitHub issue #251 bug report).
///
/// `invalid` on `InvalidSplitNodeConnectionIssue` is the caller's own single-element list (built
/// by `SplitNodeConnectionGroupSelectStrategy` per candidate, see that strategy's doc comment) —
/// there is no other channel to learn which edge to remove. No configurable parameters.
pub struct RemoveSplitNodeConnectionStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidSplitNodeConnectionIssue> for RemoveSplitNodeConnectionStrategy {
    fn strategy_id(&self) -> &'static str { "remove_split_node_connection" }

    fn apply(
        &self,
        issue: &InvalidSplitNodeConnectionIssue,
        maze: &Maze<T>,
        _rng: &mut dyn RngCore,
        _params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let removal_feasible = |id: &crate::ids::EdgeId| -> bool {
            let Some(e) = maze.graph.edge(*id) else { return false };
            let forward_ok = !preset_state.is_preset_edge(e.from, e.to);
            let reverse_exists = maze.graph.edge_between(e.to, e.from).is_some();
            let reverse_ok = reverse_exists && !preset_state.is_preset_edge(e.to, e.from);
            forward_ok || reverse_ok
        };
        let commands: Vec<MutationCommand> = issue.invalid.iter()
            .filter(|id| removal_feasible(id))
            .flat_map(|&id| crate::generation::cmd_remove_edge_with_reverse(&maze.graph, id, preset_state))
            .collect();
        // A preset-protected connection can never be removed -- if every flagged edge is such a
        // case, nothing can be fixed, so this must report Failed rather than Fixed with an empty
        // command list, same rationale as OneWayToWallStrategy (GitHub issue #230).
        let result = if issue.invalid.is_empty() || !commands.is_empty() {
            RepairResult::Fixed { score: None }
        } else {
            RepairResult::Failed
        };
        (result, commands)
    }
}

crate::impl_erased_repair_strategy!(RemoveSplitNodeConnectionStrategy, InvalidSplitNodeConnectionIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};
    use crate::repair::strategies::test_utils::apply_and_commit_default;

    #[test]
    fn apply_removes_the_flagged_edge() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let a = field.node_at(field_level, SquarePoint { x: 0, y: 0 }).unwrap();
        let b = field.node_at(field_level, SquarePoint { x: 1, y: 0 }).unwrap();
        let edge_id = g.add_edge(a, b, EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = InvalidSplitNodeConnectionIssue::new_from_check("test", vec![edge_id]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit_default(&RemoveSplitNodeConnectionStrategy, &issue, &mut maze, &mut rng, &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edge(edge_id).is_none());
    }

    #[test]
    fn apply_removes_both_directions_of_a_bidirectional_connection() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let a = field.node_at(field_level, SquarePoint { x: 0, y: 0 }).unwrap();
        let b = field.node_at(field_level, SquarePoint { x: 1, y: 0 }).unwrap();
        g.add_bidirectional_edge(a, b, EdgeKind::Basic);
        let forward_id = g.edge_between(a, b).unwrap();
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = InvalidSplitNodeConnectionIssue::new_from_check("test", vec![forward_id]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit_default(&RemoveSplitNodeConnectionStrategy, &issue, &mut maze, &mut rng, &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edge_between(a, b).is_none(), "forward direction must be removed");
        assert!(maze.graph.edge_between(b, a).is_none(), "reverse direction must also be removed");
    }

    #[test]
    fn apply_reports_failed_when_reached_standalone_against_a_preset_protected_edge() {
        // Regression: this strategy is independently registered (not only reachable through
        // SplitNodeConnectionGroupSelectStrategy's nested wiring), so it must catch a fully
        // preset-protected connection itself rather than trusting cmd_remove_edge_with_reverse's
        // always-propose behavior, or it would falsely report Fixed and loop the repair fixpoint
        // to its limit (GitHub issue #251 bug report).
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let a = field.node_at(field_level, SquarePoint { x: 0, y: 0 }).unwrap();
        let b = field.node_at(field_level, SquarePoint { x: 1, y: 0 }).unwrap();
        let edge_id = g.add_edge(a, b, EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((a, b));

        let issue = InvalidSplitNodeConnectionIssue::new_from_check("test", vec![edge_id]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit_default(&RemoveSplitNodeConnectionStrategy, &issue, &mut maze, &mut rng, &preset_state);
        assert!(matches!(result, RepairResult::Failed));
        assert!(maze.graph.edge(edge_id).is_some(), "preset-protected edge must survive");
    }

    #[test]
    fn apply_succeeds_on_empty_invalid_list() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = InvalidSplitNodeConnectionIssue::new_from_check("test", vec![]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit_default(&RemoveSplitNodeConnectionStrategy, &issue, &mut maze, &mut rng, &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }
}
