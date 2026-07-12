use rand::{Rng, RngCore};
use std::collections::HashSet;
use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::quality_control::MissingLoopsIssue;
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;

pub const PARAM_RESERVE_PERCENT: &str = "reserve_percent";

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_RESERVE_PERCENT,
        label: "Reserve percent",
        kind: StrategyParamKind::Float { default: 50.0, min: 0.0, max: 500.0 },
    },
];

/// Handles `MISSING_LOOPS` — opposite approach from `InvalidLoopRandomStrategy`/
/// `InvalidLoopScoredStrategy`, which cut edges from existing bad loops. This strategy instead
/// seeds new bidirectional connections at random, expecting a follow-up QC pass to discard
/// whichever of them don't end up forming a valid loop.
///
/// **`issue.data` is mandatory for this kind**: `missing` (how many loops short of the
/// requirement) has no other channel — the producing check (`MinLoopsCountCheck` or
/// `MinLoopDensityCheck`) already computed it.
pub struct MissingLoopsRandomStrategy;

impl<T: Tessellation> RepairStrategy<T, MissingLoopsIssue> for MissingLoopsRandomStrategy {
    fn strategy_id(&self) -> &'static str { "missing_loops_random" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        issue: &MissingLoopsIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let missing = issue.missing;
        if missing == 0 {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let reserve_percent = params.get(PARAM_RESERVE_PERCENT).and_then(|v| v.as_float()).unwrap_or(50.0);
        let target = (missing as f64 * (1.0 + reserve_percent / 100.0)).ceil() as u32;
        let target = target.max(1);

        let mut pool: Vec<NodeId> = maze.field.all_points().filter_map(|p| maze.field.node_at(p)).collect();
        let mut failed: HashSet<NodeId> = HashSet::new();
        let mut added: u32 = 0;
        // Pairs proposed as a bidirectional-edge command so far this call — stands in for what
        // an earlier real mutation would have made observable via `edge_between` under the old
        // in-place contract (GitHub issue #118, `Specs/repair.md`'s immutable-snapshot contract).
        let mut proposed_pairs: HashSet<(NodeId, NodeId)> = HashSet::new();
        let mut commands = Vec::new();

        while added < target && !pool.is_empty() {
            let pick = rng.random_range(0..pool.len());
            let src = pool[pick];

            let mut neighbors = maze.field.neighbors(src);
            let mut connected = false;

            while !neighbors.is_empty() {
                let n_pick = rng.random_range(0..neighbors.len());
                let dst = neighbors.swap_remove(n_pick);

                let already_connected = maze.graph.edge_between(src, dst).is_some()
                    || maze.graph.edge_between(dst, src).is_some()
                    || proposed_pairs.contains(&(src, dst))
                    || proposed_pairs.contains(&(dst, src));
                if already_connected {
                    continue;
                }
                // Strictly bidirectional: skip the pair unless both directions are
                // unblocked, rather than `can_connect`'s "at least one direction" contract.
                if !crate::generation::bidirectional_edge_feasible(preset_state, src, dst) {
                    continue;
                }

                commands.push(MutationCommand::AddBidirectionalEdge { a: src, b: dst });
                proposed_pairs.insert((src, dst));
                added += 1;
                connected = true;
                break;
            }

            if !connected {
                failed.insert(src);
                pool.swap_remove(pick);
            }
        }

        if added == 0 {
            return (RepairResult::Failed, vec![]);
        }
        (RepairResult::Fixed { score: None }, commands)
    }
}

crate::impl_erased_repair_strategy!(MissingLoopsRandomStrategy, MissingLoopsIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::graph::{Graph, EdgeKind};
    use crate::IdGenerator;
    use crate::space::{SquareTessellation, square_rect, Field};
    use crate::repair::params::build_params;
    use crate::quality_control::rule::apply_commands;

    fn apply_and_commit<T: Tessellation>(
        strategy: &impl RepairStrategy<T, MissingLoopsIssue>,
        issue: &MissingLoopsIssue,
        maze: &mut Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> RepairResult {
        let (result, commands) = strategy.apply(issue, maze, rng, params, preset_state, nested);
        apply_commands(maze, preset_state, commands);
        result
    }

    fn no_params() -> StrategyParams {
        build_params(<MissingLoopsRandomStrategy as RepairStrategy<SquareTessellation, MissingLoopsIssue>>::params(&MissingLoopsRandomStrategy), None)
    }

    fn maze_grid(side: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(side, side), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        Maze::new(field, g)
    }

    fn missing_issue(missing: u32) -> MissingLoopsIssue {
        MissingLoopsIssue::new_from_check("min_loops_count", missing)
    }

    #[test]
    fn apply_succeeds_immediately_when_nothing_missing() {
        let mut maze = maze_grid(3);
        let issue = missing_issue(0);
        let mut rng = MazeRng::seed_from_u64(7);
        let edges_before: Vec<_> = maze.graph.edges().map(|e| e.id).collect();
        let result = apply_and_commit(&MissingLoopsRandomStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let edges_after: Vec<_> = maze.graph.edges().map(|e| e.id).collect();
        assert_eq!(edges_before, edges_after);
    }

    #[test]
    fn apply_adds_bidirectional_connections_on_a_grid() {
        let mut maze = maze_grid(4);
        let issue = missing_issue(2);
        let mut rng = MazeRng::seed_from_u64(42);
        let result = apply_and_commit(&MissingLoopsRandomStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        // 2 missing * (1 + 50%) = 3 connections, each bidirectional => 6 edges.
        assert_eq!(maze.graph.edges().count(), 6);
        for edge in maze.graph.edges() {
            assert!(maze.graph.edge_between(edge.to, edge.from).is_some(), "every added edge must have its reverse");
        }
    }

    #[test]
    fn apply_does_not_add_connection_blocked_by_preset_state() {
        // 1x2 field: only one possible neighbor pair, fully blocked both ways.
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((nodes[0], nodes[1]));
        preset_state.blocked.insert((nodes[1], nodes[0]));

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&MissingLoopsRandomStrategy, &issue, &mut maze, &mut rng, &no_params(), &preset_state, &[]);
        assert!(matches!(result, RepairResult::Failed));
        assert_eq!(maze.graph.edges().count(), 0);
    }

    #[test]
    fn apply_does_not_add_connection_partially_blocked_by_preset_state() {
        // 1x2 field: only one possible neighbor pair, blocked in one direction only.
        // A strictly-bidirectional strategy must skip this pair entirely, not add
        // a full bidirectional edge that overwrites the protected direction.
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((nodes[0], nodes[1]));

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&MissingLoopsRandomStrategy, &issue, &mut maze, &mut rng, &no_params(), &preset_state, &[]);
        assert!(matches!(result, RepairResult::Failed));
        assert_eq!(maze.graph.edges().count(), 0);
    }

    #[test]
    fn apply_does_not_add_connection_when_src_locked_out() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut preset_state = PresetState::empty();
        preset_state.locked_out.insert(nodes[0]);

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&MissingLoopsRandomStrategy, &issue, &mut maze, &mut rng, &no_params(), &preset_state, &[]);
        assert!(matches!(result, RepairResult::Failed));
        assert_eq!(maze.graph.edges().count(), 0);
    }

    #[test]
    fn apply_does_not_add_connection_when_dst_locked_in() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut preset_state = PresetState::empty();
        preset_state.locked_in.insert(nodes[1]);

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&MissingLoopsRandomStrategy, &issue, &mut maze, &mut rng, &no_params(), &preset_state, &[]);
        assert!(matches!(result, RepairResult::Failed));
        assert_eq!(maze.graph.edges().count(), 0);
    }

    #[test]
    fn reserve_percent_override_changes_target_connection_count() {
        let mut maze = maze_grid(4);
        let issue = missing_issue(2);
        let mut overrides = HashMap::new();
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        let params = build_params(
            <MissingLoopsRandomStrategy as RepairStrategy<SquareTessellation, MissingLoopsIssue>>::params(&MissingLoopsRandomStrategy),
            Some(&overrides),
        );
        let mut rng = MazeRng::seed_from_u64(42);
        let result = apply_and_commit(&MissingLoopsRandomStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        // 2 missing * (1 + 0%) = 2 connections => 4 directed edges, vs 6 with the 50% default.
        assert_eq!(maze.graph.edges().count(), 4);
    }

    #[test]
    fn apply_does_not_duplicate_an_existing_edge() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_bidirectional_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&MissingLoopsRandomStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        // Only existing pair on a 1x2 field is already connected — nothing new can be added.
        assert!(matches!(result, RepairResult::Failed));
        assert_eq!(maze.graph.edges().count(), 2);
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let issue = missing_issue(2);

        let mut maze_a = maze_grid(4);
        let mut rng_a = MazeRng::seed_from_u64(123);
        apply_and_commit(&MissingLoopsRandomStrategy, &issue, &mut maze_a, &mut rng_a, &no_params(), &PresetState::empty(), &[]);

        let mut maze_b = maze_grid(4);
        let mut rng_b = MazeRng::seed_from_u64(123);
        apply_and_commit(&MissingLoopsRandomStrategy, &issue, &mut maze_b, &mut rng_b, &no_params(), &PresetState::empty(), &[]);

        let edges_a: Vec<_> = maze_a.graph.edges().map(|e| (e.from, e.to)).collect();
        let edges_b: Vec<_> = maze_b.graph.edges().map(|e| (e.from, e.to)).collect();
        assert_eq!(edges_a, edges_b);
    }
}
