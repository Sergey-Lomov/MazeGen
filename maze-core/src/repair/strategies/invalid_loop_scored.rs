use std::collections::HashMap;
use rand::{Rng, RngCore};
use crate::Maze;
use crate::ids::EdgeId;
use crate::space::Tessellation;
use crate::quality_control::{Issue, IssueData};
use crate::generation::{PresetState, try_remove_edge};
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::RepairStrategy;
use super::cycle_cut_set::{edge_to_cycles_map, discard_cycles_with_edge, candidate_edges};

pub const PARAM_SHORT_OVERLAP_WEIGHT: &str = "short_overlap_weight";
pub const PARAM_OTHER_OVERLAP_WEIGHT: &str = "other_overlap_weight";

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_SHORT_OVERLAP_WEIGHT,
        label: "Shared short-loop weight",
        kind: StrategyParamKind::Float { default: 5.0, min: 0.0, max: 100.0 },
    },
    StrategyParam {
        id: PARAM_OTHER_OVERLAP_WEIGHT,
        label: "Shared valid-loop penalty",
        kind: StrategyParamKind::Float { default: 6.0, min: 0.0, max: 100.0 },
    },
];

/// Handles INVALID_LOOP like `InvalidLoopRandomStrategy`, but picks which edge to cut
/// from each short cycle by score instead of uniformly at random. The score is currently just
/// the cycle-overlap term below, but the strategy is meant to grow more scoring terms over
/// time (à la `ScoredEndpointsStrategy`) — keep new criteria additive into the same score
/// rather than introducing a separate strategy per criterion.
///
/// For a candidate edge within the cycle being cut, `short_overlap` counts how many *other*
/// short cycles (also in `short`) also contain that edge, and `other_overlap` counts how many
/// *non-short* (valid, long-enough) cycles in `all` contain it. Score is
/// `short_overlap * short_overlap_weight - other_overlap * other_overlap_weight`; the
/// highest-scoring candidate is cut. This biases cuts toward edges that simultaneously break
/// several short loops (fewer total cuts needed) while avoiding edges that would also break a
/// cycle the maze is meant to keep.
pub struct InvalidLoopScoredStrategy;

impl<T: Tessellation> RepairStrategy<T> for InvalidLoopScoredStrategy {
    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        issue: &Issue,
        maze: &mut Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
    ) -> RepairResult {
        // Same per-kind contract as InvalidLoopRandomStrategy: InvalidLoops data is mandatory,
        // not an optional optimization — see that strategy's doc comment for the rationale.
        let Some(IssueData::InvalidLoops { all, invalid }) = &issue.data else {
            return RepairResult::Failed;
        };

        let short_overlap_weight = params.get(PARAM_SHORT_OVERLAP_WEIGHT).and_then(|v| v.as_float()).unwrap_or(5.0);
        let other_overlap_weight = params.get(PARAM_OTHER_OVERLAP_WEIGHT).and_then(|v| v.as_float()).unwrap_or(6.0);

        // edge -> (how many invalid cycles contain it, how many valid cycles contain it)
        let invalid_set: std::collections::HashSet<usize> = invalid.iter().copied().collect();
        let mut overlap: HashMap<EdgeId, (u32, u32)> = HashMap::new();
        for (idx, cycle) in all.iter().enumerate() {
            let is_invalid = invalid_set.contains(&idx);
            for &eid in cycle {
                let entry = overlap.entry(eid).or_insert((0, 0));
                if is_invalid { entry.0 += 1; } else { entry.1 += 1; }
            }
        }

        let owners = edge_to_cycles_map(all);
        let mut pending: Vec<usize> = invalid.to_vec();

        while let Some(idx) = pending.pop() {
            let Some(cycle) = all.get(idx) else { continue };
            if let Some(cut) = apply_cut(cycle, &overlap, short_overlap_weight, other_overlap_weight, maze, rng, preset_state) {
                discard_cycles_with_edge(&mut pending, &owners, cut);
            }
        }

        RepairResult::Fixed { score: None }
    }
}

/// Pure scoring formula, kept standalone so new terms can be unit-tested in isolation as the
/// strategy grows (see the struct-level doc comment on why this is meant to be additive).
/// `short_overlap`/`other_overlap` are the counts from the `overlap` map for one candidate edge.
fn score(short_overlap: u32, other_overlap: u32, short_overlap_weight: f64, other_overlap_weight: f64) -> f64 {
    short_overlap as f64 * short_overlap_weight - other_overlap as f64 * other_overlap_weight
}

/// Returns the cut edge's id on success, so the caller can drop any other pending cycle that
/// shares it (see `discard_cycles_with_edge`) — `None` means every candidate was protected.
fn apply_cut<T: Tessellation>(
    cycle: &[EdgeId],
    overlap: &HashMap<EdgeId, (u32, u32)>,
    short_overlap_weight: f64,
    other_overlap_weight: f64,
    maze: &mut Maze<T>,
    rng: &mut dyn RngCore,
    preset_state: &PresetState,
) -> Option<EdgeId> {
    // Drop preset-protected and already-cut edges upfront, same as InvalidLoopRandomStrategy.
    let mut candidates = candidate_edges(cycle, maze, preset_state);

    while !candidates.is_empty() {
        // This cycle's own membership counts toward `short_overlap`/`other_overlap` too — it's
        // always in `short`, so every candidate gets +1 short_overlap from itself. That's a
        // constant offset shared by every candidate in this cycle, so it doesn't affect which
        // one scores highest; left in rather than special-cased for simplicity.
        let scores: Vec<f64> = candidates.iter()
            .map(|&id| {
                let (short_overlap, other_overlap) = overlap.get(&id).copied().unwrap_or((0, 0));
                score(short_overlap, other_overlap, short_overlap_weight, other_overlap_weight)
            })
            .collect();
        let best_score = scores.iter().copied().fold(f64::NEG_INFINITY, f64::max);

        let best_indices: Vec<usize> = scores.iter().enumerate()
            .filter(|&(_, &s)| s == best_score)
            .map(|(i, _)| i)
            .collect();

        let pick = best_indices[rng.random_range(0..best_indices.len())];
        let cut = candidates[pick];
        let (from, to) = {
            let edge = maze.graph.edge(cut).expect("checked above");
            (edge.from, edge.to)
        };
        if try_remove_edge(&mut maze.graph, from, to, preset_state) {
            try_remove_edge(&mut maze.graph, to, from, preset_state);
            return Some(cut);
        }
        // Protected after all (shouldn't happen given the upfront filter, but stay defensive).
        candidates.swap_remove(pick);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use rand::rngs::SmallRng;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{SquareTessellation, square_rect, Field};
    use crate::quality_control::check::Check;
    use crate::quality_control::checks::MinLoopLengthCheck;
    use crate::repair::params::build_params;

    fn no_params() -> StrategyParams {
        build_params(<InvalidLoopScoredStrategy as RepairStrategy<SquareTessellation>>::params(&InvalidLoopScoredStrategy), None)
    }

    #[test]
    fn score_is_bonus_minus_penalty() {
        assert_eq!(score(0, 0, 5.0, 6.0), 0.0);
        assert_eq!(score(2, 0, 5.0, 6.0), 10.0);
        assert_eq!(score(0, 1, 5.0, 6.0), -6.0);
        assert_eq!(score(1, 1, 5.0, 6.0), -1.0);
    }

    /// Two triangles A->B->C->A and A->B->D->A sharing the directed edge A->B. Both are short
    /// cycles (under threshold 10) and both actually use the *same* EdgeId for A->B (unlike a
    /// bowtie's two opposite-direction edges between a shared pair, which are distinct
    /// EdgeIds). Cutting A->B breaks both triangles at once, so it must score higher than any
    /// edge unique to a single triangle.
    fn shared_edge_triangle_nodes(field: &Field<SquareTessellation>) -> Vec<crate::NodeId> {
        field.all_points().map(|p| field.node_at(p).unwrap()).collect()
    }

    fn maze_with_shared_edge_triangles() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes = shared_edge_triangle_nodes(&field);
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic); // A->B (shared)
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic); // B->C
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic); // C->A
        g.add_edge(nodes[1], nodes[3], EdgeKind::Basic); // B->D
        g.add_edge(nodes[3], nodes[0], EdgeKind::Basic); // D->A
        Maze::new(field, g)
    }

    fn check_finds_short_loop(maze: &Maze<SquareTessellation>) -> bool {
        let check = MinLoopLengthCheck { min_loop_length: 10 };
        let mut issues = Vec::new();
        check.check(maze, &mut issues);
        !issues.is_empty()
    }

    #[test]
    fn prefers_cutting_the_edge_shared_between_two_short_cycles() {
        let maze = maze_with_shared_edge_triangles();
        let check = MinLoopLengthCheck { min_loop_length: 10 };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues);
        let issue = issues.into_iter().next().unwrap();

        // Run from many seeds: the shared A->B edge should always be the one cut, since it
        // (uniquely) overlaps two short cycles, scoring strictly higher than any edge that
        // belongs to only one.
        for seed in 0..20 {
            let mut maze_try = maze_with_shared_edge_triangles();
            let mut rng = SmallRng::seed_from_u64(seed);
            let result = InvalidLoopScoredStrategy.apply(&issue, &mut maze_try, &mut rng, &no_params(), &PresetState::empty());
            assert!(matches!(result, RepairResult::Fixed { score: None }));

            let nodes = shared_edge_triangle_nodes(&maze_try.field);
            assert!(maze_try.graph.edge_between(nodes[0], nodes[1]).is_none(), "seed {seed}: shared A->B edge must be cut");

            let fresh = Maze::<SquareTessellation>::new(maze_try.field, maze_try.graph);
            assert!(!check_finds_short_loop(&fresh), "seed {seed}: both triangles must be broken by one cut");
        }
    }

    #[test]
    fn cutting_a_shared_edge_spares_the_other_cycle_from_a_second_cut() {
        // Same bowtie as above: node D has exactly two edges (B->D, D->A), both belonging only
        // to the second triangle. Cutting the shared A->B already breaks both triangles, so the
        // second triangle must be dropped from the pending set rather than also losing one of
        // D's two edges — that would leave D with degree 0, fully cut off from the graph.
        let maze = maze_with_shared_edge_triangles();
        let check = MinLoopLengthCheck { min_loop_length: 10 };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues);
        let issue = issues.into_iter().next().unwrap();

        let nodes = shared_edge_triangle_nodes(&maze.field);
        let d = nodes[3];

        for seed in 0..20 {
            let mut maze_try = maze_with_shared_edge_triangles();
            let mut rng = SmallRng::seed_from_u64(seed);
            let result = InvalidLoopScoredStrategy.apply(&issue, &mut maze_try, &mut rng, &no_params(), &PresetState::empty());
            assert!(matches!(result, RepairResult::Fixed { score: None }));
            let d_degree = maze_try.graph.edges().filter(|e| e.from == d || e.to == d).count();
            assert!(d_degree > 0, "seed {seed}: D must keep at least one edge — it must not be fully cut off");
        }
    }

    #[test]
    fn apply_fails_when_data_is_missing() {
        let mut maze = maze_with_shared_edge_triangles();
        let issue = Issue::new(crate::quality_control::issue::INVALID_LOOP);
        let mut rng = SmallRng::seed_from_u64(7);
        let result = InvalidLoopScoredStrategy.apply(&issue, &mut maze, &mut rng, &no_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_succeeds_on_empty_cycle_list() {
        let mut maze = maze_with_shared_edge_triangles();
        let issue = Issue::with_data(crate::quality_control::issue::INVALID_LOOP, IssueData::InvalidLoops { all: vec![], invalid: vec![] });
        let mut rng = SmallRng::seed_from_u64(7);
        let result = InvalidLoopScoredStrategy.apply(&issue, &mut maze, &mut rng, &no_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }

    /// Triangle A->B->C->A (short, the cycle to break) where edge C->A also continues into a
    /// long valid loop C->A->E->F->G->H->I->J->C (>= 10 tile-hops, must NOT be broken). A->B
    /// and B->C are "plain" — they belong only to the short triangle, no other cycle. With
    /// default weights (short_overlap_weight=5, other_overlap_weight=6), C->A's penalty alone
    /// (-6) already loses to a plain edge's score (0), with no shared-short-cycle bonus
    /// involved at all — this isolates the penalty term from the bonus term tested above.
    fn maze_with_plain_edge_and_penalized_edge() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(11, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic); // A->B (plain)
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic); // B->C (plain)
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic); // C->A (shared with the long loop)
        // Long loop: C->A->3->4->5->6->7->8->9->10->C, 10 tile-hops — not short (>= 10).
        g.add_edge(nodes[0], nodes[3], EdgeKind::Basic);
        g.add_edge(nodes[3], nodes[4], EdgeKind::Basic);
        g.add_edge(nodes[4], nodes[5], EdgeKind::Basic);
        g.add_edge(nodes[5], nodes[6], EdgeKind::Basic);
        g.add_edge(nodes[6], nodes[7], EdgeKind::Basic);
        g.add_edge(nodes[7], nodes[8], EdgeKind::Basic);
        g.add_edge(nodes[8], nodes[9], EdgeKind::Basic);
        g.add_edge(nodes[9], nodes[10], EdgeKind::Basic);
        g.add_edge(nodes[10], nodes[2], EdgeKind::Basic);
        Maze::new(field, g)
    }

    #[test]
    fn avoids_cutting_an_edge_shared_with_a_long_valid_loop_in_favor_of_a_plain_edge() {
        let maze = maze_with_plain_edge_and_penalized_edge();
        let check = MinLoopLengthCheck { min_loop_length: 10 };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues);
        let issue = issues.into_iter().next().unwrap();
        let Some(IssueData::InvalidLoops { invalid, .. }) = &issue.data else { panic!("expected InvalidLoops") };
        assert_eq!(invalid.len(), 1, "only the triangle should be invalid; the long loop must stay valid");

        let nodes: Vec<_> = maze.field.all_points().map(|p| maze.field.node_at(p).unwrap()).collect();
        let (a, c) = (nodes[0], nodes[2]);

        for seed in 0..20 {
            let mut maze_try = maze_with_plain_edge_and_penalized_edge();
            let mut rng = SmallRng::seed_from_u64(seed);
            let result = InvalidLoopScoredStrategy.apply(&issue, &mut maze_try, &mut rng, &no_params(), &PresetState::empty());
            assert!(matches!(result, RepairResult::Fixed { score: None }));
            assert!(maze_try.graph.edge_between(c, a).is_some(), "seed {seed}: C->A must survive, it's shared with a valid loop");

            let fresh = Maze::<SquareTessellation>::new(maze_try.field, maze_try.graph);
            assert!(!check_finds_short_loop(&fresh), "seed {seed}: the triangle must still be broken");
        }
    }

    #[test]
    fn does_not_cut_a_preset_protected_edge() {
        let maze = maze_with_shared_edge_triangles();
        let check = MinLoopLengthCheck { min_loop_length: 10 };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues);
        let issue = issues.into_iter().next().unwrap();

        // Protect the shared A->B edge — the strategy must fall back to cutting something else.
        let nodes = shared_edge_triangle_nodes(&maze.field);
        let (a, b) = (nodes[0], nodes[1]);
        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((a, b));

        let mut rng = SmallRng::seed_from_u64(1);
        let mut maze_try = maze_with_shared_edge_triangles();
        let result = InvalidLoopScoredStrategy.apply(&issue, &mut maze_try, &mut rng, &no_params(), &preset_state);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze_try.graph.edge_between(a, b).is_some(), "protected edge must survive");
    }
}
