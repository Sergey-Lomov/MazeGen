use rand::{Rng, RngCore};
use crate::Maze;
use crate::ids::EdgeId;
use crate::space::Tessellation;
use crate::quality_control::{Issue, IssueData};
use crate::generation::{PresetState, try_remove_edge};
use crate::repair::params::StrategyParams;
use crate::repair::result::RepairResult;
use crate::repair::strategy::RepairStrategy;
use super::cycle_cut_set::{edge_to_cycles_map, discard_cycles_with_edge, candidate_edges};

pub struct InvalidLoopRandomStrategy;

impl<T: Tessellation> RepairStrategy<T> for InvalidLoopRandomStrategy {
    fn apply(
        &self,
        issue: &Issue,
        maze: &mut Maze<T>,
        rng: &mut dyn RngCore,
        _params: &StrategyParams,
        preset_state: &PresetState,
    ) -> RepairResult {
        // INVALID_LOOP always carries InvalidLoops data in a well-formed pipeline run —
        // the producing check already did the (expensive) cycle search, so the data isn't
        // optional here the way it is for some other issue kinds. Missing/wrong-type data
        // means this was called outside the normal pipeline (malformed) — Failed, not
        // "already fixed". An empty cycle list, by contrast, means the check found nothing
        // to break.
        let Some(IssueData::InvalidLoops { all, invalid, .. }) = &issue.data else {
            return RepairResult::Failed;
        };
        apply_cuts(all, invalid, maze, rng, preset_state)
    }
}

fn apply_cuts<T: Tessellation>(
    all: &[Vec<EdgeId>],
    short: &[usize],
    maze: &mut Maze<T>,
    rng: &mut dyn RngCore,
    preset_state: &PresetState,
) -> RepairResult {
    let owners = edge_to_cycles_map(all);
    let mut pending: Vec<usize> = short.to_vec();

    while let Some(idx) = pending.pop() {
        let Some(cycle) = all.get(idx) else { continue };
        // Drop preset-protected and already-cut edges upfront so the random pick never wastes a sample on them.
        let mut candidates = candidate_edges(cycle, maze, preset_state);

        while !candidates.is_empty() {
            let pick = rng.random_range(0..candidates.len());
            let cut = candidates[pick];
            let (from, to) = {
                let edge = maze.graph.edge(cut).expect("checked above");
                (edge.from, edge.to)
            };
            if try_remove_edge(&mut maze.graph, from, to, preset_state) {
                let reverse = maze.graph.edge_between(to, from);
                try_remove_edge(&mut maze.graph, to, from, preset_state);
                discard_cycles_with_edge(&mut pending, &owners, cut);
                if let Some(reverse_id) = reverse {
                    discard_cycles_with_edge(&mut pending, &owners, reverse_id);
                }
                break;
            }
            // Protected after all (shouldn't happen given the upfront filter, but stay defensive) — retry with another edge.
            candidates.swap_remove(pick);
        }
    }
    RepairResult::Fixed { score: None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use rand::rngs::SmallRng;
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
        let mut check_rng = rand::rngs::SmallRng::seed_from_u64(0);
        check.check(maze, &mut issues, &mut check_rng);
        !issues.is_empty()
    }

    fn no_params() -> StrategyParams {
        build_params(<InvalidLoopRandomStrategy as RepairStrategy<SquareTessellation>>::params(&InvalidLoopRandomStrategy), None)
    }

    #[test]
    fn apply_breaks_the_cycle_data_driven() {
        let mut maze = maze_with_triangle();
        assert!(check_finds_short_loop(&maze));

        let check = MinLoopLengthCheck { instance_id: "min_loop_length".to_string(), min_loop_length: 10 };
        let mut issues = Vec::new();
        let mut check_rng = rand::rngs::SmallRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut check_rng);
        let issue = issues.into_iter().next().unwrap();

        let mut rng = SmallRng::seed_from_u64(7);
        let result = InvalidLoopRandomStrategy.apply(&issue, &mut maze, &mut rng, &no_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        // Fresh Maze/MazeAnalysis: `maze`'s cached nav_graph (built by the check above,
        // before `apply` cut an edge) would otherwise be stale — analysis has no
        // invalidation on graph mutation by design (see analysis.md).
        let fresh_maze = Maze::<SquareTessellation>::new(maze.field, maze.graph);
        assert!(!check_finds_short_loop(&fresh_maze), "cycle must be broken after apply");
    }

    #[test]
    fn apply_fails_when_data_is_missing() {
        // INVALID_LOOP always carries InvalidLoops data in a well-formed pipeline run.
        // Missing data means a malformed call, not "nothing to fix" — Failed, not Fixed.
        let mut maze = maze_with_triangle();
        let issue = Issue::new(crate::quality_control::issue::INVALID_LOOP); // no data attached
        let mut rng = SmallRng::seed_from_u64(7);
        let result = InvalidLoopRandomStrategy.apply(&issue, &mut maze, &mut rng, &no_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_succeeds_on_empty_cycle_list() {
        // An empty InvalidLoops list means the check found nothing to break — already fixed.
        let mut maze = maze_with_triangle();
        let issue = Issue::with_data(crate::quality_control::issue::INVALID_LOOP, IssueData::InvalidLoops { all: vec![], invalid: vec![], invalid_sources: Default::default() });
        let mut rng = SmallRng::seed_from_u64(7);
        let result = InvalidLoopRandomStrategy.apply(&issue, &mut maze, &mut rng, &no_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let issue = {
            let maze = maze_with_triangle();
            let check = MinLoopLengthCheck { instance_id: "min_loop_length".to_string(), min_loop_length: 10 };
            let mut issues = Vec::new();
            let mut check_rng = rand::rngs::SmallRng::seed_from_u64(0);
            check.check(&maze, &mut issues, &mut check_rng);
            issues.into_iter().next().unwrap()
        };

        let mut maze_a = maze_with_triangle();
        let mut rng_a = SmallRng::seed_from_u64(123);
        InvalidLoopRandomStrategy.apply(&issue, &mut maze_a, &mut rng_a, &no_params(), &PresetState::empty());

        let mut maze_b = maze_with_triangle();
        let mut rng_b = SmallRng::seed_from_u64(123);
        InvalidLoopRandomStrategy.apply(&issue, &mut maze_b, &mut rng_b, &no_params(), &PresetState::empty());

        let remaining_a: Vec<_> = maze_a.graph.edges().map(|e| e.id).collect();
        let remaining_b: Vec<_> = maze_b.graph.edges().map(|e| e.id).collect();
        assert_eq!(remaining_a, remaining_b);
    }

    #[test]
    fn shared_edge_between_two_cycles_does_not_panic_on_second_cut() {
        // Bowtie graph: cutting one shared edge first must not panic when the
        // strategy later tries to cut the same already-removed edge in the other cycle.
        let mut ids = IdGenerator::new();
        let field = crate::space::Field::new(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic); // A->B
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic); // B->C
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic); // C->A
        g.add_edge(nodes[1], nodes[3], EdgeKind::Basic); // B->D
        g.add_edge(nodes[3], nodes[2], EdgeKind::Basic); // D->C
        g.add_edge(nodes[2], nodes[1], EdgeKind::Basic); // C->B
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MinLoopLengthCheck { instance_id: "min_loop_length".to_string(), min_loop_length: 10 };
        let mut issues = Vec::new();
        let mut check_rng = rand::rngs::SmallRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut check_rng);
        let issue = issues.into_iter().next().unwrap();

        let mut rng = SmallRng::seed_from_u64(99);
        let result = InvalidLoopRandomStrategy.apply(&issue, &mut maze, &mut rng, &no_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }

    #[test]
    fn cutting_a_shared_edge_spares_the_other_cycle_from_a_second_cut() {
        // Bowtie sharing edge A->B between two triangles: A->B->C->A and A->B->D->A. Node D has
        // exactly two edges total (B->D in, D->A out), both belonging only to the second
        // triangle. Without the fix, both triangles are processed independently and each cuts
        // one edge of its own cycle — if the first triangle's cut happens to land on A->B (shared)
        // and the second triangle is *also* processed (not yet discarded), it would cut one of
        // D's two edges too, even though A->B alone already broke both cycles. Two cuts touching
        // D's only two edges across both triangles would leave D with degree 0 — fully cut off
        // from the graph. The fix must ensure the second triangle is dropped from the pending set
        // once A->B is cut, so D keeps at least one of its two edges.
        fn build() -> Maze<SquareTessellation> {
            let mut ids = IdGenerator::new();
            let field = crate::space::Field::new(square_rect(4, 1), &mut ids).unwrap();
            let mut g = Graph::new();
            field.build_nodes(&mut g);
            let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
            g.add_edge(nodes[0], nodes[1], EdgeKind::Basic); // A->B (shared)
            g.add_edge(nodes[1], nodes[2], EdgeKind::Basic); // B->C
            g.add_edge(nodes[2], nodes[0], EdgeKind::Basic); // C->A
            g.add_edge(nodes[1], nodes[3], EdgeKind::Basic); // B->D
            g.add_edge(nodes[3], nodes[0], EdgeKind::Basic); // D->A
            Maze::new(field, g)
        }

        let maze = build();
        let check = MinLoopLengthCheck { instance_id: "min_loop_length".to_string(), min_loop_length: 10 };
        let mut issues = Vec::new();
        let mut check_rng = rand::rngs::SmallRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut check_rng);
        let issue = issues.into_iter().next().unwrap();

        let nodes: Vec<_> = maze.field.all_points().map(|p| maze.field.node_at(p).unwrap()).collect();
        let d = nodes[3];

        for seed in 0..20 {
            let mut maze_try = build();
            let mut rng = SmallRng::seed_from_u64(seed);
            let result = InvalidLoopRandomStrategy.apply(&issue, &mut maze_try, &mut rng, &no_params(), &PresetState::empty());
            assert!(matches!(result, RepairResult::Fixed { score: None }));
            let d_degree = maze_try.graph.edges().filter(|e| e.from == d || e.to == d).count();
            assert!(d_degree > 0, "seed {seed}: D must keep at least one edge — it must not be fully cut off");
        }
    }

    #[test]
    fn apply_does_not_cut_a_preset_protected_edge() {
        // Triangle where two of the three edges are preset-protected — only one
        // candidate remains, so the strategy must pick exactly that one deterministically.
        let maze = maze_with_triangle();

        let check = MinLoopLengthCheck { instance_id: "min_loop_length".to_string(), min_loop_length: 10 };
        let mut issues = Vec::new();
        let mut check_rng = rand::rngs::SmallRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut check_rng);
        let issue = issues.into_iter().next().unwrap();

        let IssueData::InvalidLoops { all, invalid, .. } = issue.data.as_ref().unwrap() else { panic!() };
        let cycle = all[invalid[0]].clone();
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
            let mut rng = SmallRng::seed_from_u64(seed);
            let result = InvalidLoopRandomStrategy.apply(&issue, &mut maze_try, &mut rng, &no_params(), &preset_state);
            assert!(matches!(result, RepairResult::Fixed { score: None }));
            assert!(maze_try.graph.edge_between(unprotected_from, unprotected_to).is_none(),
                "the only unprotected edge must be cut regardless of seed {seed}");
        }
    }
}
