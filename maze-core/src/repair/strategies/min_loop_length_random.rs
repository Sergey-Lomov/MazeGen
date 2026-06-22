use rand::{Rng, RngCore};
use crate::Maze;
use crate::ids::EdgeId;
use crate::space::Tessellation;
use crate::quality_control::{Issue, IssueData};
use crate::repair::params::StrategyParams;
use crate::repair::result::RepairResult;
use crate::repair::strategy::RepairStrategy;

pub struct MinLoopLengthRandomStrategy;

impl<T: Tessellation> RepairStrategy<T> for MinLoopLengthRandomStrategy {
    fn apply(
        &self,
        issue: &Issue,
        maze: &mut Maze<T>,
        rng: &mut dyn RngCore,
        _params: &StrategyParams,
    ) -> RepairResult {
        // MIN_LOOP_LENGTH always carries ShortLoops data in a well-formed pipeline run —
        // the check already did the (expensive) cycle search, so the data isn't optional
        // here the way it is for some other issue kinds. Missing/wrong-type data means
        // this was called outside the normal pipeline (malformed) — Failed, not "already
        // fixed". An empty cycle list, by contrast, means the check found nothing to break.
        let Some(IssueData::ShortLoops(cycles)) = &issue.data else {
            return RepairResult::Failed;
        };
        apply_cuts(cycles, maze, rng)
    }
}

fn apply_cuts<T: Tessellation>(cycles: &[Vec<EdgeId>], maze: &mut Maze<T>, rng: &mut dyn RngCore) -> RepairResult {
    for cycle in cycles {
        let candidates: Vec<EdgeId> = cycle.iter().copied()
            .filter(|&id| maze.graph.edge(id).is_some()) // already broken by an earlier cut in this apply?
            .collect();
        if candidates.is_empty() { continue; }
        let cut = candidates[rng.random_range(0..candidates.len())];
        let (from, to) = {
            let edge = maze.graph.edge(cut).expect("checked above");
            (edge.from, edge.to)
        };
        maze.graph.remove_edge(cut);
        if let Some(rev) = maze.graph.edge_between(to, from) {
            maze.graph.remove_edge(rev);
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
        let check = MinLoopLengthCheck { min_loop_length: 10 };
        let mut issues = Vec::new();
        check.check(maze, &mut issues);
        !issues.is_empty()
    }

    fn no_params() -> StrategyParams {
        build_params(<MinLoopLengthRandomStrategy as RepairStrategy<SquareTessellation>>::params(&MinLoopLengthRandomStrategy), None)
    }

    #[test]
    fn apply_breaks_the_cycle_data_driven() {
        let mut maze = maze_with_triangle();
        assert!(check_finds_short_loop(&maze));

        let check = MinLoopLengthCheck { min_loop_length: 10 };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues);
        let issue = issues.into_iter().next().unwrap();

        let mut rng = SmallRng::seed_from_u64(7);
        let result = MinLoopLengthRandomStrategy.apply(&issue, &mut maze, &mut rng, &no_params());
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(!check_finds_short_loop(&maze), "cycle must be broken after apply");
    }

    #[test]
    fn apply_fails_when_data_is_missing() {
        // MIN_LOOP_LENGTH always carries ShortLoops data in a well-formed pipeline run.
        // Missing data means a malformed call, not "nothing to fix" — Failed, not Fixed.
        let mut maze = maze_with_triangle();
        let issue = Issue::new(crate::quality_control::issue::MIN_LOOP_LENGTH); // no data attached
        let mut rng = SmallRng::seed_from_u64(7);
        let result = MinLoopLengthRandomStrategy.apply(&issue, &mut maze, &mut rng, &no_params());
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_succeeds_on_empty_cycle_list() {
        // An empty ShortLoops list means the check found nothing to break — already fixed.
        let mut maze = maze_with_triangle();
        let issue = Issue::with_data(crate::quality_control::issue::MIN_LOOP_LENGTH, IssueData::ShortLoops(vec![]));
        let mut rng = SmallRng::seed_from_u64(7);
        let result = MinLoopLengthRandomStrategy.apply(&issue, &mut maze, &mut rng, &no_params());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let issue = {
            let maze = maze_with_triangle();
            let check = MinLoopLengthCheck { min_loop_length: 10 };
            let mut issues = Vec::new();
            check.check(&maze, &mut issues);
            issues.into_iter().next().unwrap()
        };

        let mut maze_a = maze_with_triangle();
        let mut rng_a = SmallRng::seed_from_u64(123);
        MinLoopLengthRandomStrategy.apply(&issue, &mut maze_a, &mut rng_a, &no_params());

        let mut maze_b = maze_with_triangle();
        let mut rng_b = SmallRng::seed_from_u64(123);
        MinLoopLengthRandomStrategy.apply(&issue, &mut maze_b, &mut rng_b, &no_params());

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

        let check = MinLoopLengthCheck { min_loop_length: 10 };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues);
        let issue = issues.into_iter().next().unwrap();

        let mut rng = SmallRng::seed_from_u64(99);
        let result = MinLoopLengthRandomStrategy.apply(&issue, &mut maze, &mut rng, &no_params());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }
}
