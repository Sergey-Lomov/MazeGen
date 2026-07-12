use std::collections::HashMap;
use rand::{Rng, RngCore};
use crate::Maze;
use crate::ids::EdgeId;
use crate::space::Tessellation;
use crate::graph::cycles::resolve_to_edge_ids;
use crate::quality_control::{InvalidLoopIssue, InvalidLoopRequirement};
use crate::generation::{PresetState, try_remove_edge};
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::snapshot::SnapshotStack;
use super::cycle_cut_set::candidate_edges;

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

/// Handles INVALID_LOOP like `InvalidLoopRandomStrategy`, but picks which edge to cut from the
/// issue's main cycle by score instead of uniformly at random. The score is currently just the
/// cycle-overlap term below, but the strategy is meant to grow more scoring terms over time (à la
/// `ScoredEndpointsStrategy`) — keep new criteria additive into the same score rather than
/// introducing a separate strategy per criterion.
///
/// For a candidate edge within `issue.cycle`, `short_overlap` counts how many cycles in
/// `issue.other_invalid` also contain that edge (plus one for `issue.cycle`'s own membership —
/// a constant offset across every candidate, left in rather than special-cased), and
/// `other_overlap` counts how many cycles in `issue.other_valid` contain it. Score is
/// `short_overlap * short_overlap_weight - other_overlap * other_overlap_weight`; the
/// highest-scoring candidate is cut. This biases cuts toward edges that simultaneously break
/// several invalid loops at once (fewer total repair iterations needed) while avoiding edges that
/// would also break a cycle the maze is meant to keep.
pub struct InvalidLoopScoredStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidLoopIssue> for InvalidLoopScoredStrategy {
    fn strategy_id(&self) -> &'static str { "invalid_loop_scored" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    /// Needs both auxiliary layers — `apply` walks `other_invalid`/`other_valid` to compute
    /// `short_overlap`/`other_overlap`, so both are required by the algorithm itself (see GitHub
    /// issue #98/#105).
    fn requirement(&self, _params: &StrategyParams) -> InvalidLoopRequirement {
        InvalidLoopRequirement::OTHER_INVALID | InvalidLoopRequirement::OTHER_VALID
    }

    fn apply(
        &self,
        issue: &InvalidLoopIssue,
        maze: &mut Maze<T>,
        _snapshots: &mut SnapshotStack,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> RepairResult {
        let short_overlap_weight = params.get(PARAM_SHORT_OVERLAP_WEIGHT).and_then(|v| v.as_float()).unwrap_or(5.0);
        let other_overlap_weight = params.get(PARAM_OTHER_OVERLAP_WEIGHT).and_then(|v| v.as_float()).unwrap_or(6.0);

        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        let all_cycles = maze.analysis.cycles(&maze.graph, &maze.meta);

        // edge -> (how many other_invalid cycles contain it, how many other_valid cycles contain it)
        let mut overlap: HashMap<EdgeId, (u32, u32)> = HashMap::new();
        for &eid in &issue.cycle {
            overlap.entry(eid).or_insert((0, 0)).0 += 1;
        }
        if let Some(cycles) = &all_cycles {
            for &idx in &issue.other_invalid {
                let Some(nav_cycle) = cycles.get(idx) else { continue };
                let resolved = resolve_to_edge_ids(&nav, std::slice::from_ref(nav_cycle), &maze.graph);
                for &eid in resolved.iter().flatten() {
                    overlap.entry(eid).or_insert((0, 0)).0 += 1;
                }
            }
            for &idx in &issue.other_valid {
                let Some(nav_cycle) = cycles.get(idx) else { continue };
                let resolved = resolve_to_edge_ids(&nav, std::slice::from_ref(nav_cycle), &maze.graph);
                for &eid in resolved.iter().flatten() {
                    overlap.entry(eid).or_insert((0, 0)).1 += 1;
                }
            }
        }

        apply_cut(&issue.cycle, &overlap, short_overlap_weight, other_overlap_weight, maze, rng, preset_state);
        RepairResult::Fixed { score: None }
    }
}

crate::impl_erased_repair_strategy!(InvalidLoopScoredStrategy, InvalidLoopIssue);

/// Pure scoring formula, kept standalone so new terms can be unit-tested in isolation as the
/// strategy grows (see the struct-level doc comment on why this is meant to be additive).
/// `short_overlap`/`other_overlap` are the counts from the `overlap` map for one candidate edge.
fn score(short_overlap: u32, other_overlap: u32, short_overlap_weight: f64, other_overlap_weight: f64) -> f64 {
    short_overlap as f64 * short_overlap_weight - other_overlap as f64 * other_overlap_weight
}

/// One `apply()` call now breaks exactly one cycle (see GitHub issue #98 — no more pending-set
/// batching across several invalid cycles in one strategy call). Returns the cut edge's id, or
/// `None` if `cycle` is empty or every candidate was protected.
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
    use crate::random::MazeRng;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{SquareTessellation, square_rect, Field};
    use crate::quality_control::check::Check;
    use crate::quality_control::checks::MinLoopLengthCheck;
    use crate::repair::params::build_params;

    fn no_params() -> StrategyParams {
        build_params(<InvalidLoopScoredStrategy as RepairStrategy<SquareTessellation, InvalidLoopIssue>>::params(&InvalidLoopScoredStrategy), None)
    }

    /// Guards the `requirement()` override itself (see GitHub issue #105) — `apply` reads
    /// `other_overlap`/`short_overlap` from `other_valid`/`other_invalid`, so a regression to
    /// `empty()` (or anything short of both flags) would silently break scoring without failing
    /// any behavioral test that always constructs its issue via `all()` directly.
    #[test]
    fn requirement_requests_both_other_layers() {
        let requirement = <InvalidLoopScoredStrategy as RepairStrategy<SquareTessellation, InvalidLoopIssue>>::requirement(&InvalidLoopScoredStrategy, &no_params());
        assert_eq!(requirement, InvalidLoopRequirement::OTHER_INVALID | InvalidLoopRequirement::OTHER_VALID);
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
        let check = MinLoopLengthCheck { instance_id: "min_loop_length".to_string(), min_loop_length: 10 };
        let mut issues = Vec::new();
        let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(maze, &mut issues, &mut check_rng, InvalidLoopRequirement::all());
        !issues.is_empty()
    }

    #[test]
    fn prefers_cutting_the_edge_shared_between_two_short_cycles() {
        let maze = maze_with_shared_edge_triangles();
        let check = MinLoopLengthCheck { instance_id: "min_loop_length".to_string(), min_loop_length: 10 };
        let mut issues = Vec::new();
        let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut check_rng, InvalidLoopRequirement::all());
        let issue = issues.into_iter().next().unwrap();
        assert_eq!(issue.other_invalid.len(), 1, "both triangles are invalid -- one is the issue's main cycle, the other lands in other_invalid");

        // Run from many seeds: the shared A->B edge should always be the one cut, since it
        // (uniquely) overlaps two short cycles, scoring strictly higher than any edge that
        // belongs to only one.
        for seed in 0..20 {
            let mut maze_try = maze_with_shared_edge_triangles();
            let mut rng = MazeRng::seed_from_u64(seed);
            let result = RepairStrategy::apply(&InvalidLoopScoredStrategy, &issue, &mut maze_try, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &[]);
            assert!(matches!(result, RepairResult::Fixed { score: None }));

            let nodes = shared_edge_triangle_nodes(&maze_try.field);
            assert!(maze_try.graph.edge_between(nodes[0], nodes[1]).is_none(), "seed {seed}: shared A->B edge must be cut");

            let fresh = Maze::<SquareTessellation>::new(maze_try.field, maze_try.graph);
            assert!(!check_finds_short_loop(&fresh), "seed {seed}: both triangles must be broken by one cut, since they share the cut edge");
        }
    }

    #[test]
    fn apply_succeeds_on_empty_cycle() {
        let mut maze = maze_with_shared_edge_triangles();
        let issue = InvalidLoopIssue::new_from_check("min_loop_length", 0, vec![], vec![], vec![]);
        let mut rng = MazeRng::seed_from_u64(7);
        let result = RepairStrategy::apply(&InvalidLoopScoredStrategy, &issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }

    /// `other_invalid`/`other_valid` carrying an index past the end of `maze.analysis.cycles()`
    /// (stale/malformed input — shouldn't happen given the constructor's normalization, but
    /// `apply` defensively skips via `cycles.get(idx) else { continue }` rather than panicking).
    #[test]
    fn apply_skips_out_of_range_other_indices_without_panicking() {
        let mut maze = maze_with_shared_edge_triangles();
        // Only one real cycle set exists at index 0 (or a small number); 9999 is guaranteed to
        // be out of range for `maze.analysis.cycles()`.
        let issue = InvalidLoopIssue::new_from_check(
            "min_loop_length", 0, vec![], vec![9999], vec![9999],
        );
        let mut rng = MazeRng::seed_from_u64(7);
        let result = RepairStrategy::apply(&InvalidLoopScoredStrategy, &issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }), "out-of-range indices must be skipped, not panic");
    }

    /// When `maze.analysis.cycles()` overflows (see `CycleSearchResult::TooManyCycles`), `apply`
    /// must fall back to scoring using only `issue.cycle`'s own membership (the `overlap` map
    /// built before the `if let Some(cycles)` branch) rather than panicking on the `None`.
    #[test]
    fn apply_degrades_gracefully_when_cycle_enumeration_overflows() {
        const SIDE: i32 = 6;
        let mut ids = IdGenerator::new();
        let field = crate::space::Field::new(square_rect(SIDE as usize, SIDE as usize), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        use crate::space::SquarePoint;
        for y in 0..SIDE {
            for x in 0..SIDE {
                let here = field.node_at(SquarePoint { x, y }).unwrap();
                if x + 1 < SIDE {
                    let right = field.node_at(SquarePoint { x: x + 1, y }).unwrap();
                    g.add_bidirectional_edge(here, right, EdgeKind::Basic);
                }
                if y + 1 < SIDE {
                    let up = field.node_at(SquarePoint { x, y: y + 1 }).unwrap();
                    g.add_bidirectional_edge(here, up, EdgeKind::Basic);
                }
            }
        }
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        assert!(maze.analysis.cycles(&maze.graph, &maze.meta).is_none(), "precondition: this grid overflows enumeration");

        // A manually-built 3-edge cycle from real edges in this grid, independent of enumeration.
        let a = maze.field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let b = maze.field.node_at(SquarePoint { x: 1, y: 0 }).unwrap();
        let e0 = maze.graph.edge_between(a, b).unwrap();
        let e1 = maze.graph.edge_between(b, a).unwrap();
        let issue = InvalidLoopIssue::new_from_check("min_loop_length", 0, vec![e0, e1], vec![1], vec![2]);

        let mut rng = MazeRng::seed_from_u64(7);
        let result = RepairStrategy::apply(&InvalidLoopScoredStrategy, &issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }), "overflow must not panic; apply degrades to scoring by issue.cycle membership only");
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
        let check = MinLoopLengthCheck { instance_id: "min_loop_length".to_string(), min_loop_length: 10 };
        let mut issues = Vec::new();
        let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut check_rng, InvalidLoopRequirement::all());
        let issue = issues.into_iter().next().unwrap();
        assert_eq!(issue.other_valid.len(), 1, "only the triangle is invalid; the long loop must stay valid, resolved into other_valid");

        let nodes: Vec<_> = maze.field.all_points().map(|p| maze.field.node_at(p).unwrap()).collect();
        let (a, c) = (nodes[0], nodes[2]);

        for seed in 0..20 {
            let mut maze_try = maze_with_plain_edge_and_penalized_edge();
            let mut rng = MazeRng::seed_from_u64(seed);
            let result = RepairStrategy::apply(&InvalidLoopScoredStrategy, &issue, &mut maze_try, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &[]);
            assert!(matches!(result, RepairResult::Fixed { score: None }));
            assert!(maze_try.graph.edge_between(c, a).is_some(), "seed {seed}: C->A must survive, it's shared with a valid loop");

            let fresh = Maze::<SquareTessellation>::new(maze_try.field, maze_try.graph);
            assert!(!check_finds_short_loop(&fresh), "seed {seed}: the triangle must still be broken");
        }
    }

    #[test]
    fn does_not_cut_a_preset_protected_edge() {
        let maze = maze_with_shared_edge_triangles();
        let check = MinLoopLengthCheck { instance_id: "min_loop_length".to_string(), min_loop_length: 10 };
        let mut issues = Vec::new();
        let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut check_rng, InvalidLoopRequirement::all());
        let issue = issues.into_iter().next().unwrap();

        // Protect the shared A->B edge — the strategy must fall back to cutting something else.
        let nodes = shared_edge_triangle_nodes(&maze.field);
        let (a, b) = (nodes[0], nodes[1]);
        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((a, b));

        let mut rng = MazeRng::seed_from_u64(1);
        let mut maze_try = maze_with_shared_edge_triangles();
        let result = RepairStrategy::apply(&InvalidLoopScoredStrategy, &issue, &mut maze_try, &mut SnapshotStack::new(), &mut rng, &no_params(), &preset_state, &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze_try.graph.edge_between(a, b).is_some(), "protected edge must survive");
    }
}
