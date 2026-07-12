use rand::{Rng, RngCore};
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::{InvalidLoopIssue, InvalidLoopRequirement};
use crate::generation::{PresetState, try_remove_edge};
use crate::repair::params::StrategyParams;
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::snapshot::SnapshotStack;
use super::cycle_cut_set::candidate_edges;

pub struct InvalidLoopRandomStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidLoopIssue> for InvalidLoopRandomStrategy {
    fn strategy_id(&self) -> &'static str { "invalid_loop_random" }

    /// `apply` reads only `issue.cycle` — never `other_invalid`/`other_valid` — so neither layer
    /// is ever needed here (see GitHub issue #98/#105).
    fn requirement(&self, _params: &StrategyParams) -> InvalidLoopRequirement {
        InvalidLoopRequirement::empty()
    }

    fn apply(
        &self,
        issue: &InvalidLoopIssue,
        maze: &mut Maze<T>,
        _snapshots: &mut SnapshotStack,
        rng: &mut dyn RngCore,
        _params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> RepairResult {
        apply_cut(&issue.cycle, maze, rng, preset_state)
    }
}

crate::impl_erased_repair_strategy!(InvalidLoopRandomStrategy, InvalidLoopIssue);

/// One `apply()` call now breaks exactly one cycle (see GitHub issue #98 — no more batching
/// several invalid cycles into one strategy call) — an empty `cycle` (already fixed, or a
/// malformed call) is idempotently `Fixed`.
fn apply_cut<T: Tessellation>(
    cycle: &[crate::ids::EdgeId],
    maze: &mut Maze<T>,
    rng: &mut dyn RngCore,
    preset_state: &PresetState,
) -> RepairResult {
    // Drop preset-protected and already-cut edges upfront so the random pick never wastes a
    // sample on them.
    let mut candidates = candidate_edges(cycle, maze, preset_state);

    while !candidates.is_empty() {
        let pick = rng.random_range(0..candidates.len());
        let cut = candidates[pick];
        let (from, to) = {
            let edge = maze.graph.edge(cut).expect("checked above");
            (edge.from, edge.to)
        };
        if try_remove_edge(&mut maze.graph, from, to, preset_state) {
            try_remove_edge(&mut maze.graph, to, from, preset_state);
            return RepairResult::Fixed { score: None };
        }
        // Protected after all (shouldn't happen given the upfront filter, but stay defensive) — retry with another edge.
        candidates.swap_remove(pick);
    }
    RepairResult::Fixed { score: None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{SquareTessellation, square_rect};
    use crate::quality_control::check::Check;
    use crate::quality_control::checks::MinLoopLengthCheck;
    use crate::repair::params::{build_params, StrategyParams};
    use crate::generation::PresetState;

    fn maze_with_triangle() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = crate::space::Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        Maze::new(field, g)
    }

    fn check_finds_short_loop(maze: &Maze<SquareTessellation>) -> bool {
        let check = MinLoopLengthCheck { instance_id: "min_loop_length".to_string(), min_loop_length: 10 };
        let mut issues = Vec::new();
        let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(maze, &mut issues, &mut check_rng, InvalidLoopRequirement::all());
        !issues.is_empty()
    }

    fn no_params() -> StrategyParams {
        build_params(<InvalidLoopRandomStrategy as RepairStrategy<SquareTessellation, InvalidLoopIssue>>::params(&InvalidLoopRandomStrategy), None)
    }

    /// Guards the `requirement()` override itself (see GitHub issue #105) — a regression to
    /// `all()` wouldn't break correctness (this strategy tolerates extra data) but would silently
    /// reintroduce the wasted computation the mechanism exists to avoid.
    #[test]
    fn requirement_requests_no_layers() {
        let requirement = <InvalidLoopRandomStrategy as RepairStrategy<SquareTessellation, InvalidLoopIssue>>::requirement(&InvalidLoopRandomStrategy, &no_params());
        assert_eq!(requirement, InvalidLoopRequirement::empty());
    }

    #[test]
    fn apply_breaks_the_cycle_data_driven() {
        let mut maze = maze_with_triangle();
        assert!(check_finds_short_loop(&maze));

        let check = MinLoopLengthCheck { instance_id: "min_loop_length".to_string(), min_loop_length: 10 };
        let mut issues = Vec::new();
        let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut check_rng, InvalidLoopRequirement::all());
        let issue = issues.into_iter().next().unwrap();

        let mut rng = MazeRng::seed_from_u64(7);
        let result = RepairStrategy::apply(&InvalidLoopRandomStrategy, &issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        // Fresh Maze/MazeAnalysis: `maze`'s cached nav_graph (built by the check above,
        // before `apply` cut an edge) would otherwise be stale — analysis has no
        // invalidation on graph mutation by design (see analysis.md).
        let fresh_maze = Maze::<SquareTessellation>::new(maze.field, maze.graph);
        assert!(!check_finds_short_loop(&fresh_maze), "cycle must be broken after apply");
    }

    #[test]
    fn apply_succeeds_on_empty_cycle() {
        // An empty `cycle` means there's nothing to break -- already fixed.
        let mut maze = maze_with_triangle();
        let issue = InvalidLoopIssue::new_from_check("min_loop_length", 0, vec![], vec![], vec![]);
        let mut rng = MazeRng::seed_from_u64(7);
        let result = RepairStrategy::apply(&InvalidLoopRandomStrategy, &issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let issue = {
            let maze = maze_with_triangle();
            let check = MinLoopLengthCheck { instance_id: "min_loop_length".to_string(), min_loop_length: 10 };
            let mut issues = Vec::new();
            let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
            check.repair_check(&maze, &mut issues, &mut check_rng, InvalidLoopRequirement::all());
            issues.into_iter().next().unwrap()
        };

        let mut maze_a = maze_with_triangle();
        let mut rng_a = MazeRng::seed_from_u64(123);
        RepairStrategy::apply(&InvalidLoopRandomStrategy, &issue, &mut maze_a, &mut SnapshotStack::new(), &mut rng_a, &no_params(), &PresetState::empty(), &[]);

        let mut maze_b = maze_with_triangle();
        let mut rng_b = MazeRng::seed_from_u64(123);
        RepairStrategy::apply(&InvalidLoopRandomStrategy, &issue, &mut maze_b, &mut SnapshotStack::new(), &mut rng_b, &no_params(), &PresetState::empty(), &[]);

        let remaining_a: Vec<_> = maze_a.graph.edges().map(|e| e.id).collect();
        let remaining_b: Vec<_> = maze_b.graph.edges().map(|e| e.id).collect();
        assert_eq!(remaining_a, remaining_b);
    }

    #[test]
    fn apply_result_is_identical_for_full_and_empty_requirement() {
        // Triangle (invalid, 3 tile-hops) plus a separate valid 10-tile-hop loop sharing no
        // edges -- requirement only changes how much auxiliary data the check resolves, never
        // which edge apply() cuts for the same seed.
        fn build() -> Maze<SquareTessellation> {
            let mut ids = IdGenerator::new();
            let field = crate::space::Field::new(square_rect(13, 1), &mut ids).unwrap();
            let mut g = Graph::new();
            field.build_nodes(&mut g);
            let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
            g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
            g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
            g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
            for i in 3..12 {
                g.add_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
            }
            g.add_edge(nodes[12], nodes[3], EdgeKind::Basic);
            Maze::new(field, g)
        }

        let check = MinLoopLengthCheck { instance_id: "min_loop_length".to_string(), min_loop_length: 10 };

        let mut maze_full = build();
        let mut full_issues = Vec::new();
        let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze_full, &mut full_issues, &mut check_rng, InvalidLoopRequirement::all());
        let full_issue = full_issues.into_iter().next().unwrap();
        let mut rng_full = MazeRng::seed_from_u64(42);
        RepairStrategy::apply(&InvalidLoopRandomStrategy, &full_issue, &mut maze_full, &mut SnapshotStack::new(), &mut rng_full, &no_params(), &PresetState::empty(), &[]);

        let mut maze_empty = build();
        let mut empty_issues = Vec::new();
        let mut check_rng2 = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze_empty, &mut empty_issues, &mut check_rng2, InvalidLoopRequirement::empty());
        let empty_issue = empty_issues.into_iter().next().unwrap();
        let mut rng_empty = MazeRng::seed_from_u64(42);
        RepairStrategy::apply(&InvalidLoopRandomStrategy, &empty_issue, &mut maze_empty, &mut SnapshotStack::new(), &mut rng_empty, &no_params(), &PresetState::empty(), &[]);

        let remaining_full: std::collections::HashSet<_> = maze_full.graph.edges().map(|e| e.id).collect();
        let remaining_empty: std::collections::HashSet<_> = maze_empty.graph.edges().map(|e| e.id).collect();
        assert_eq!(remaining_full, remaining_empty, "same seed must cut the same edges regardless of requirement");
    }

    #[test]
    fn apply_does_not_cut_a_preset_protected_edge() {
        // Triangle where two of the three edges are preset-protected — only one
        // candidate remains, so the strategy must pick exactly that one deterministically.
        let maze = maze_with_triangle();

        let check = MinLoopLengthCheck { instance_id: "min_loop_length".to_string(), min_loop_length: 10 };
        let mut issues = Vec::new();
        let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut check_rng, InvalidLoopRequirement::all());
        let issue = issues.into_iter().next().unwrap();

        let cycle = issue.cycle.clone();
        // Protect all but the last edge in the cycle from removal.
        let mut preset_state = PresetState::empty();
        for &edge_id in &cycle[..cycle.len() - 1] {
            let edge = maze.graph.edge(edge_id).unwrap();
            preset_state.preset_edges.insert((edge.from, edge.to));
        }
        let unprotected = cycle[cycle.len() - 1];
        let (unprotected_from, unprotected_to) = {
            let e = maze.graph.edge(unprotected).unwrap();
            (e.from, e.to)
        };

        for seed in 0..20 {
            let mut maze_try = maze_with_triangle();
            // Re-fetch the issue per-maze since EdgeIds are stable across identical construction.
            let mut rng = MazeRng::seed_from_u64(seed);
            let result = RepairStrategy::apply(&InvalidLoopRandomStrategy, &issue, &mut maze_try, &mut SnapshotStack::new(), &mut rng, &no_params(), &preset_state, &[]);
            assert!(matches!(result, RepairResult::Fixed { score: None }));
            assert!(maze_try.graph.edge_between(unprotected_from, unprotected_to).is_none(),
                "the only unprotected edge must be cut regardless of seed {seed}");
        }
    }
}
