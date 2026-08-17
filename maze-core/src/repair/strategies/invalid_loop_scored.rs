use std::collections::HashMap;
use rand::{Rng, RngCore};
use crate::Maze;
use crate::ids::EdgeId;
use crate::space::Tessellation;
use crate::quality_control::{InvalidLoopIssue, InvalidLoopRequirement};
use crate::generation::PresetState;
use crate::graph::cycles::{GF2Basis, set_bit};
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;
use super::cycle_cut_set::{
    edge_to_cycles_map, discard_cycles_with_edge, candidate_edges, apply_vertical_passage_priority,
    PARAM_VERTICAL_PASSAGE_PRIORITY, VERTICAL_PASSAGE_PRIORITY_OPTIONS, VERTICAL_PASSAGE_NEUTRAL,
};

pub const PARAM_INVALID_OVERLAP_WEIGHT: &str = "invalid_overlap_weight";
pub const PARAM_VALID_OVERLAP_WEIGHT: &str = "valid_overlap_weight";

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_INVALID_OVERLAP_WEIGHT,
        label: "Shared invalid-loop weight",
        kind: StrategyParamKind::Float { default: 5.0, min: 0.0, max: 100.0 },
    },
    StrategyParam {
        id: PARAM_VALID_OVERLAP_WEIGHT,
        label: "Shared valid-loop penalty",
        kind: StrategyParamKind::Float { default: 6.0, min: 0.0, max: 100.0 },
    },
    StrategyParam {
        id: PARAM_VERTICAL_PASSAGE_PRIORITY,
        label: "Vertical passage priority",
        kind: StrategyParamKind::Enum { options: VERTICAL_PASSAGE_PRIORITY_OPTIONS, default: VERTICAL_PASSAGE_NEUTRAL },
    },
];

/// Handles INVALID_LOOP like `InvalidLoopRandomStrategy`, but picks which edge to cut
/// from each short cycle by score instead of uniformly at random. The score is currently just
/// the cycle-overlap term below, but the strategy is meant to grow more scoring terms over
/// time (à la `ScoredEndpointsStrategy`) — keep new criteria additive into the same score
/// rather than introducing a separate strategy per criterion.
///
/// For a candidate edge within the cycle being cut, `invalid_overlap` counts how many *other*
/// invalid cycles (also in `invalid`) also contain that edge — raw, uncorrected: every
/// invalid-cycle intersection is a real win regardless of linear dependence between invalid
/// cycles, since `invalid` already names the concrete cycles that must be broken. `valid_overlap`
/// counts how many valid cycles a candidate edge would break, but — since GitHub issue #284 —
/// only against the GF(2) independent basis of the valid subset of `all`, not every valid cycle:
/// a naive raw count overstates an edge's real impact when several valid cycles sharing it are
/// linearly dependent (cutting it can never reduce the valid subset's independent-cycle count by
/// more than its basis membership implies). Score is
/// `invalid_overlap * invalid_overlap_weight - valid_overlap * valid_overlap_weight`; the
/// highest-scoring candidate is cut. This biases cuts toward edges that simultaneously break
/// several invalid loops (fewer total cuts needed) while avoiding edges that would also break a
/// cycle the maze is meant to keep.
pub struct InvalidLoopScoredStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidLoopIssue> for InvalidLoopScoredStrategy {
    fn strategy_id(&self) -> &'static str { "invalid_loop_scored" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    /// Needs every valid cycle, not just invalid ones — `apply` walks the full `all` to compute
    /// `valid_overlap` (how many valid cycles a candidate edge would also break), so
    /// `VALID_CYCLES` is required by the algorithm itself, not left set out of inertia.
    fn requirement(&self, _params: &StrategyParams) -> InvalidLoopRequirement {
        InvalidLoopRequirement::VALID_CYCLES
    }

    fn apply(
        &self,
        issue: &InvalidLoopIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let (all, invalid) = (&issue.all, &issue.invalid);

        let invalid_overlap_weight = params.get(PARAM_INVALID_OVERLAP_WEIGHT).and_then(|v| v.as_float()).unwrap_or(5.0);
        let valid_overlap_weight = params.get(PARAM_VALID_OVERLAP_WEIGHT).and_then(|v| v.as_float()).unwrap_or(6.0);
        let vertical_priority = match params.get(PARAM_VERTICAL_PASSAGE_PRIORITY) {
            Some(StrategyParamValue::Enum(s)) => s.as_str(),
            _ => VERTICAL_PASSAGE_NEUTRAL,
        };

        // edge -> (how many invalid cycles contain it, how many *basis* valid cycles contain it)
        let invalid_set: std::collections::HashSet<usize> = invalid.iter().copied().collect();
        let valid_basis_indices = valid_cycle_basis_indices(all, &invalid_set);
        let mut overlap: HashMap<EdgeId, (u32, u32)> = HashMap::new();
        for (idx, cycle) in all.iter().enumerate() {
            let is_invalid = invalid_set.contains(&idx);
            let is_valid_basis_member = !is_invalid && valid_basis_indices.contains(&idx);
            for &eid in cycle {
                let entry = overlap.entry(eid).or_insert((0, 0));
                if is_invalid { entry.0 += 1; }
                if is_valid_basis_member { entry.1 += 1; }
            }
        }

        let owners = edge_to_cycles_map(all);
        let mut pending: Vec<usize> = invalid.to_vec();
        let mut already_cut: std::collections::HashSet<EdgeId> = std::collections::HashSet::new();
        let mut commands = Vec::new();

        while let Some(idx) = pending.pop() {
            let Some(cycle) = all.get(idx) else { continue };
            if let Some((cut, reverse)) = apply_cut(cycle, &overlap, invalid_overlap_weight, valid_overlap_weight, maze, rng, preset_state, &already_cut, vertical_priority, &mut commands) {
                already_cut.insert(cut);
                discard_cycles_with_edge(&mut pending, &owners, cut);
                if let Some(reverse) = reverse {
                    already_cut.insert(reverse);
                    discard_cycles_with_edge(&mut pending, &owners, reverse);
                }
            }
        }

        let result = if invalid.is_empty() || !commands.is_empty() {
            RepairResult::Fixed { score: None }
        } else {
            RepairResult::Failed
        };
        (result, commands)
    }
}

crate::impl_erased_repair_strategy!(InvalidLoopScoredStrategy, InvalidLoopIssue);

/// GitHub issue #284: returns the indices (into `all`) of a GF(2) independent basis of the
/// valid subset of `all` (every index not in `invalid_set`) — used so `valid_overlap` reflects
/// real independent-cycle-count impact instead of raw (possibly linearly-dependent) overlap.
///
/// `EdgeId` is not a dense index (arbitrary values, not 0..N), so this builds its own local
/// dense remap (`EdgeId -> bit position`) over the `EdgeId`s actually appearing in the valid
/// subset, then runs each valid cycle through `GF2Basis::try_insert` as a bit-vector under that
/// remap. No canonical (forward/reverse) edge merging is applied here, unlike `cycles.rs`'s
/// nav-edge-index basis — this domain is base-`Graph` `EdgeId`s, where a forward and reverse
/// edge are already two distinct `EdgeId`s with no automatic pairing, and the penalty is about
/// concrete cut `EdgeId`s, not physical corridors, so no such merging is needed or wanted here.
fn valid_cycle_basis_indices(all: &[Vec<EdgeId>], invalid_set: &std::collections::HashSet<usize>) -> std::collections::HashSet<usize> {
    let mut remap: HashMap<EdgeId, usize> = HashMap::new();
    for (idx, cycle) in all.iter().enumerate() {
        if invalid_set.contains(&idx) {
            continue;
        }
        for &eid in cycle {
            let next = remap.len();
            remap.entry(eid).or_insert(next);
        }
    }

    let bit_count = remap.len().max(1);
    let words_per_row = bit_count.div_ceil(64).max(1);
    let mut gf2 = GF2Basis::new(bit_count);
    let mut basis_indices = std::collections::HashSet::new();
    for (idx, cycle) in all.iter().enumerate() {
        if invalid_set.contains(&idx) {
            continue;
        }
        let bits = set_bit(words_per_row, cycle.iter().map(|eid| remap[eid]));
        if gf2.try_insert(bits) {
            basis_indices.insert(idx);
        }
    }
    basis_indices
}

/// Pure scoring formula, kept standalone so new terms can be unit-tested in isolation as the
/// strategy grows (see the struct-level doc comment on why this is meant to be additive).
/// `invalid_overlap`/`valid_overlap` are the counts from the `overlap` map for one candidate edge.
fn score(invalid_overlap: u32, valid_overlap: u32, invalid_overlap_weight: f64, valid_overlap_weight: f64) -> f64 {
    invalid_overlap as f64 * invalid_overlap_weight - valid_overlap as f64 * valid_overlap_weight
}

/// Returns `(cut, reverse)` on success — `cut` is the removed edge's own id, `reverse` is its
/// opposite-direction id when that leg was also removed (`RemoveEdgeWithReverse`, GitHub issue
/// #185), `None` when only `cut` itself was removed (`RemoveEdge`). Both pushed onto `commands`.
/// The caller must drop any other pending cycle sharing *either* id (see
/// `discard_cycles_with_edge`) — a cycle that only traverses the reverse leg of the same physical
/// corridor is broken by this cut too. `None` (outer) means every candidate was protected.
/// Never mutates `maze` (GitHub issue #118, `Specs/repair.md`'s immutable-snapshot contract);
/// `already_cut` stands in for what an earlier real mutation would have made observable.
#[allow(clippy::too_many_arguments)]
fn apply_cut<T: Tessellation>(
    cycle: &[EdgeId],
    overlap: &HashMap<EdgeId, (u32, u32)>,
    invalid_overlap_weight: f64,
    valid_overlap_weight: f64,
    maze: &Maze<T>,
    rng: &mut dyn RngCore,
    preset_state: &PresetState,
    already_cut: &std::collections::HashSet<EdgeId>,
    vertical_priority: &str,
    commands: &mut Vec<MutationCommand>,
) -> Option<(EdgeId, Option<EdgeId>)> {
    // Drop preset-protected and already-cut edges upfront, same as InvalidLoopRandomStrategy.
    let candidates = candidate_edges(cycle, maze, preset_state, already_cut);
    let mut candidates = apply_vertical_passage_priority(candidates, maze, vertical_priority);

    while !candidates.is_empty() {
        // This cycle's own membership counts toward `invalid_overlap`/`valid_overlap` too — it's
        // always in `invalid`, so every candidate gets +1 invalid_overlap from itself. That's a
        // constant offset shared by every candidate in this cycle, so it doesn't affect which
        // one scores highest; left in rather than special-cased for simplicity.
        //
        // A bidirectional corridor is two distinct `EdgeId`s (forward and `edge_between`'s
        // reverse) — two cycles sharing that corridor but each traversing it in the opposite
        // direction land on different `EdgeId`s in `overlap`, so a raw per-id lookup would miss
        // that they actually share a cut. Cutting `id` always also cuts its reverse (see the
        // `RemoveEdgeWithReverse` dispatch below), so a candidate's real overlap is its own
        // entry's plus its reverse's.
        let scores: Vec<f64> = candidates.iter()
            .map(|&id| {
                let (invalid_overlap, valid_overlap) = overlap.get(&id).copied().unwrap_or((0, 0));
                let reverse_overlap = maze.graph.edge(id)
                    .and_then(|edge| maze.graph.edge_between(edge.to, edge.from))
                    .filter(|&rev| rev != id)
                    .and_then(|rev| overlap.get(&rev))
                    .copied()
                    .unwrap_or((0, 0));
                let invalid_overlap = invalid_overlap + reverse_overlap.0;
                let valid_overlap = valid_overlap + reverse_overlap.1;
                score(invalid_overlap, valid_overlap, invalid_overlap_weight, valid_overlap_weight)
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
        if !preset_state.is_preset_edge(from, to) {
            let reverse_id = maze.graph.edge_between(to, from).filter(|&rev| rev != cut);
            let reverse_actually_removed = match reverse_id {
                Some(reverse_id) if !already_cut.contains(&reverse_id) => {
                    commands.push(MutationCommand::RemoveEdgeWithReverse { id: cut });
                    Some(reverse_id)
                }
                _ => {
                    commands.push(MutationCommand::RemoveEdge { id: cut });
                    None
                }
            };
            return Some((cut, reverse_actually_removed));
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
    use crate::space::{SquareTessellation, square_rect, MultiLevelField};
    use crate::quality_control::check::Check;
    use crate::quality_control::checks::LoopLengthCheck;
    use crate::quality_control::Comparison;
    use crate::quality_control::CycleKind;
    use crate::repair::params::build_params;
    use crate::repair::strategies::test_utils::apply_and_commit;

    fn no_params() -> StrategyParams {
        build_params(<InvalidLoopScoredStrategy as RepairStrategy<SquareTessellation, InvalidLoopIssue>>::params(&InvalidLoopScoredStrategy), None)
    }

    // GitHub issue #284: `valid_cycle_basis_indices` unit tests — direct coverage of the
    // GF(2)-elimination adapter `valid_overlap` is built from, independent of the full
    // strategy/check pipeline above.
    mod valid_cycle_basis_indices_tests {
        use super::*;

        #[test]
        fn all_independent_valid_cycles_are_all_selected() {
            // Two disjoint triangles as EdgeId lists (arbitrary EdgeId values, not dense 0..N —
            // exercises the dense remap) — both independent, neither zero-invalid.
            let all: Vec<Vec<EdgeId>> = vec![vec![10, 11, 12], vec![20, 21, 22]];
            let invalid_set = std::collections::HashSet::new();
            let basis_indices = valid_cycle_basis_indices(&all, &invalid_set);
            assert_eq!(basis_indices, [0, 1].into_iter().collect());
        }

        #[test]
        fn a_composite_valid_cycle_dependent_on_two_others_is_excluded() {
            // Bowtie-shaped EdgeId sets: cycle 0 = {A,B,C}, cycle 1 = {B,D,E} (shares B with
            // cycle 0), cycle 2 = {A,C,D,E} — the symmetric difference of 0 and 1 (drop the
            // shared B, keep the rest) — linearly dependent on cycles 0 and 1.
            let all: Vec<Vec<EdgeId>> = vec![
                vec![1, 2, 3],       // A, B, C
                vec![2, 4, 5],       // B, D, E
                vec![1, 3, 4, 5],    // A, C, D, E (= cycle0 XOR cycle1)
            ];
            let invalid_set = std::collections::HashSet::new();
            let basis_indices = valid_cycle_basis_indices(&all, &invalid_set);
            assert_eq!(basis_indices.len(), 2, "rank-2 space: composite must never be selected once 0 and 1 already span it");
            assert!(!basis_indices.contains(&2), "the composite (index 2) is the one that should be excluded, since it's inserted last and 0/1 already span the space");
        }

        #[test]
        fn invalid_indices_are_never_considered() {
            let all: Vec<Vec<EdgeId>> = vec![vec![1, 2, 3], vec![1, 2, 3]];
            let invalid_set: std::collections::HashSet<usize> = [0, 1].into_iter().collect();
            let basis_indices = valid_cycle_basis_indices(&all, &invalid_set);
            assert!(basis_indices.is_empty(), "both indices are invalid, so neither is a candidate for the valid basis");
        }

        #[test]
        fn empty_valid_subset_yields_empty_basis() {
            let all: Vec<Vec<EdgeId>> = vec![];
            let invalid_set = std::collections::HashSet::new();
            assert!(valid_cycle_basis_indices(&all, &invalid_set).is_empty());
        }
    }

    /// Guards the `requirement()` override itself (see GitHub issue #105) — `apply` reads
    /// `valid_overlap` from every valid cycle in `all`, so a regression to `empty()` (or anything
    /// short of `VALID_CYCLES`) would silently break scoring without failing any behavioral test
    /// that always constructs its issue via `all()` directly.
    #[test]
    fn requirement_requests_valid_cycles() {
        let requirement = <InvalidLoopScoredStrategy as RepairStrategy<SquareTessellation, InvalidLoopIssue>>::requirement(&InvalidLoopScoredStrategy, &no_params());
        assert_eq!(requirement, InvalidLoopRequirement::VALID_CYCLES);
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
    fn shared_edge_triangle_nodes(field: &MultiLevelField<SquareTessellation>) -> Vec<crate::NodeId> {
        let level = field.single_level_id();
        field.field_of(level).unwrap().all_points().map(|p| field.node_at(level, p).unwrap()).collect()
    }

    fn maze_with_shared_edge_triangles() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes = shared_edge_triangle_nodes(&field);
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic); // A->B (shared)
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic); // B->C
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic); // C->A
        g.add_edge(nodes[1], nodes[3], EdgeKind::Basic); // B->D
        g.add_edge(nodes[3], nodes[0], EdgeKind::Basic); // D->A
        Maze::new(field, g)
    }

    fn check_finds_short_loop(maze: &Maze<SquareTessellation>) -> bool {
        let check = LoopLengthCheck { instance_id: "min_loop_length".to_string(), comparison: Comparison::Lt, length: 10, cycle_kind: CycleKind::Any };
        let mut issues = Vec::new();
        let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(maze, &mut issues, &mut check_rng, InvalidLoopRequirement::all());
        !issues.is_empty()
    }

    #[test]
    fn prefers_cutting_the_edge_shared_between_two_short_cycles() {
        let maze = maze_with_shared_edge_triangles();
        let check = LoopLengthCheck { instance_id: "min_loop_length".to_string(), comparison: Comparison::Lt, length: 10, cycle_kind: CycleKind::Any };
        let mut issues = Vec::new();
        let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut check_rng, InvalidLoopRequirement::all());
        let issue = issues.into_iter().next().unwrap();

        // Run from many seeds: the shared A->B edge should always be the one cut, since it
        // (uniquely) overlaps two short cycles, scoring strictly higher than any edge that
        // belongs to only one.
        for seed in 0..20 {
            let mut maze_try = maze_with_shared_edge_triangles();
            let mut rng = MazeRng::seed_from_u64(seed);
            let result = apply_and_commit(&InvalidLoopScoredStrategy, &issue, &mut maze_try, &mut rng, &no_params(), &PresetState::empty(), &[]);
            assert!(matches!(result, RepairResult::Fixed { score: None }));

            let nodes = shared_edge_triangle_nodes(&maze_try.field);
            assert!(maze_try.graph.edge_between(nodes[0], nodes[1]).is_none(), "seed {seed}: shared A->B edge must be cut");

            let fresh = Maze::<SquareTessellation>::new(maze_try.field, maze_try.graph);
            assert!(!check_finds_short_loop(&fresh), "seed {seed}: both triangles must be broken by one cut");
        }
    }

    /// Bowtie where the two triangles traverse the shared corridor in *opposite* directions:
    /// A->B->C->A (uses A->B, the forward leg) and A->D->B->A (uses B->A, the reverse leg — a
    /// distinct `EdgeId` from A->B, unlike `maze_with_shared_edge_triangles` where both triangles
    /// use the same forward id). Cutting either leg removes both via `RemoveEdgeWithReverse`, so
    /// the shared corridor must still score as overlapping two short cycles and be preferred over
    /// an edge unique to one triangle — this is the scenario a raw per-`EdgeId` overlap count
    /// misses. Built with only these two edges as `all`/`invalid` (no third, composite cycle) to
    /// isolate the mechanism under test from unrelated basis/composite behavior.
    fn opposite_direction_shared_triangles() -> (Maze<SquareTessellation>, InvalidLoopIssue) {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes = shared_edge_triangle_nodes(&field);
        let ab = g.add_edge(nodes[0], nodes[1], EdgeKind::Basic); // A->B (shared corridor, forward leg)
        let bc = g.add_edge(nodes[1], nodes[2], EdgeKind::Basic); // B->C
        let ca = g.add_edge(nodes[2], nodes[0], EdgeKind::Basic); // C->A
        let ad = g.add_edge(nodes[0], nodes[3], EdgeKind::Basic); // A->D
        let db = g.add_edge(nodes[3], nodes[1], EdgeKind::Basic); // D->B
        let ba = g.add_edge(nodes[1], nodes[0], EdgeKind::Basic); // B->A (shared corridor, reverse leg)
        let maze = Maze::new(field, g);

        let triangle_1 = vec![ab, bc, ca];
        let triangle_2 = vec![ad, db, ba];
        let issue = InvalidLoopIssue::new_from_check("min_loop_length", vec![triangle_1, triangle_2], vec![0, 1], Default::default());
        (maze, issue)
    }

    #[test]
    fn prefers_cutting_the_shared_corridor_even_when_cycles_traverse_it_in_opposite_directions() {
        let (maze, issue) = opposite_direction_shared_triangles();
        let nodes = shared_edge_triangle_nodes(&maze.field);

        for seed in 0..20 {
            let (mut maze_try, _) = opposite_direction_shared_triangles();
            let mut rng = MazeRng::seed_from_u64(seed);
            let result = apply_and_commit(&InvalidLoopScoredStrategy, &issue, &mut maze_try, &mut rng, &no_params(), &PresetState::empty(), &[]);
            assert!(matches!(result, RepairResult::Fixed { score: None }));

            // Exactly one *cut* (removing both directions of the corridor at once via
            // `RemoveEdgeWithReverse`, i.e. 2 of the graph's 6 edges) must happen — proves
            // `invalid_overlap` counted the corridor's two opposite-direction legs as one shared
            // cut, not zero (which would instead cut one edge per triangle separately, still
            // leaving 2 edges removed but from *different* physical corridors).
            let removed_count = 6 - maze_try.graph.edges().count();
            assert_eq!(removed_count, 2, "seed {seed}: cutting the corridor removes both its directions at once");

            let corridor_gone = maze_try.graph.edge_between(nodes[0], nodes[1]).is_none()
                && maze_try.graph.edge_between(nodes[1], nodes[0]).is_none();
            assert!(corridor_gone, "seed {seed}: the shared corridor (either direction) must be the one cut, breaking both triangles in a single cut");
        }
    }

    #[test]
    fn cutting_a_shared_edge_spares_the_other_cycle_from_a_second_cut() {
        // Same bowtie as above: node D has exactly two edges (B->D, D->A), both belonging only
        // to the second triangle. Cutting the shared A->B already breaks both triangles, so the
        // second triangle must be dropped from the pending set rather than also losing one of
        // D's two edges — that would leave D with degree 0, fully cut off from the graph.
        let maze = maze_with_shared_edge_triangles();
        let check = LoopLengthCheck { instance_id: "min_loop_length".to_string(), comparison: Comparison::Lt, length: 10, cycle_kind: CycleKind::Any };
        let mut issues = Vec::new();
        let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut check_rng, InvalidLoopRequirement::all());
        let issue = issues.into_iter().next().unwrap();

        let nodes = shared_edge_triangle_nodes(&maze.field);
        let d = nodes[3];

        for seed in 0..20 {
            let mut maze_try = maze_with_shared_edge_triangles();
            let mut rng = MazeRng::seed_from_u64(seed);
            let result = apply_and_commit(&InvalidLoopScoredStrategy, &issue, &mut maze_try, &mut rng, &no_params(), &PresetState::empty(), &[]);
            assert!(matches!(result, RepairResult::Fixed { score: None }));
            let d_degree = maze_try.graph.edges().filter(|e| e.from == d || e.to == d).count();
            assert!(d_degree > 0, "seed {seed}: D must keep at least one edge — it must not be fully cut off");
        }
    }

    #[test]
    fn apply_succeeds_on_empty_cycle_list() {
        let mut maze = maze_with_shared_edge_triangles();
        let issue = InvalidLoopIssue::new_from_check("min_loop_length", vec![], vec![], Default::default());
        let mut rng = MazeRng::seed_from_u64(7);
        let result = apply_and_commit(&InvalidLoopScoredStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }

    /// Triangle A->B->C->A (short, the cycle to break) where edge C->A also continues into a
    /// long valid loop C->A->E->F->G->H->I->J->C (>= 10 tile-hops, must NOT be broken). A->B
    /// and B->C are "plain" — they belong only to the short triangle, no other cycle. With
    /// default weights (invalid_overlap_weight=5, valid_overlap_weight=6), C->A's penalty alone
    /// (-6) already loses to a plain edge's score (0), with no shared-short-cycle bonus
    /// involved at all — this isolates the penalty term from the bonus term tested above.
    fn maze_with_plain_edge_and_penalized_edge() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(11, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
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
        let check = LoopLengthCheck { instance_id: "min_loop_length".to_string(), comparison: Comparison::Lt, length: 10, cycle_kind: CycleKind::Any };
        let mut issues = Vec::new();
        let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut check_rng, InvalidLoopRequirement::all());
        let issue = issues.into_iter().next().unwrap();
        assert_eq!(issue.invalid.len(), 1, "only the triangle should be invalid; the long loop must stay valid");

        let nodes: Vec<_> = maze.field.field_of(maze.field.single_level_id()).unwrap().all_points().map(|p| maze.field.node_at(maze.field.single_level_id(), p).unwrap()).collect();
        let (a, c) = (nodes[0], nodes[2]);

        for seed in 0..20 {
            let mut maze_try = maze_with_plain_edge_and_penalized_edge();
            let mut rng = MazeRng::seed_from_u64(seed);
            let result = apply_and_commit(&InvalidLoopScoredStrategy, &issue, &mut maze_try, &mut rng, &no_params(), &PresetState::empty(), &[]);
            assert!(matches!(result, RepairResult::Fixed { score: None }));
            assert!(maze_try.graph.edge_between(c, a).is_some(), "seed {seed}: C->A must survive, it's shared with a valid loop");

            let fresh = Maze::<SquareTessellation>::new(maze_try.field, maze_try.graph);
            assert!(!check_finds_short_loop(&fresh), "seed {seed}: the triangle must still be broken");
        }
    }

    #[test]
    fn does_not_cut_a_preset_protected_edge() {
        let maze = maze_with_shared_edge_triangles();
        let check = LoopLengthCheck { instance_id: "min_loop_length".to_string(), comparison: Comparison::Lt, length: 10, cycle_kind: CycleKind::Any };
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
        let result = apply_and_commit(&InvalidLoopScoredStrategy, &issue, &mut maze_try, &mut rng, &no_params(), &preset_state, &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze_try.graph.edge_between(a, b).is_some(), "protected edge must survive");
    }

    /// GitHub issue #230: a cycle entirely made of preset connections can never be broken — the
    /// strategy must report `Failed` (not `Fixed`) so the fixpoint loop stops retrying it forever.
    #[test]
    fn apply_reports_failed_when_the_whole_cycle_is_preset_protected() {
        fn maze_with_single_triangle() -> Maze<SquareTessellation> {
            let mut ids = IdGenerator::new();
            let field = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
            let field_level = field.single_level_id();
            let mut g = Graph::new();
            for node in field.all_node_ids() { g.add_node(node); }
            let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
            g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
            g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
            g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
            Maze::new(field, g)
        }

        let maze = maze_with_single_triangle();
        let check = LoopLengthCheck { instance_id: "min_loop_length".to_string(), comparison: Comparison::Lt, length: 10, cycle_kind: CycleKind::Any };
        let mut issues = Vec::new();
        let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut check_rng, InvalidLoopRequirement::all());
        let issue = issues.into_iter().next().unwrap();

        let cycle = issue.all[issue.invalid[0]].clone();
        let mut preset_state = PresetState::empty();
        for &edge_id in &cycle {
            let edge = maze.graph.edge(edge_id).unwrap();
            preset_state.preset_edges.insert((edge.from, edge.to));
        }

        let mut maze_try = maze_with_single_triangle();
        let mut rng = MazeRng::seed_from_u64(7);
        let edges_before: Vec<_> = maze_try.graph.edges().map(|e| e.id).collect();
        let result = apply_and_commit(&InvalidLoopScoredStrategy, &issue, &mut maze_try, &mut rng, &no_params(), &preset_state, &[]);
        assert!(matches!(result, RepairResult::Failed), "fully preset-protected loop must be reported as unfixable");
        let edges_after: Vec<_> = maze_try.graph.edges().map(|e| e.id).collect();
        assert_eq!(edges_before, edges_after, "no edge should be touched when the cycle can't be broken");
    }

    // GitHub issue #392 — `vertical_passage_priority` behavioral tests.

    fn params_with(overrides: &[(&str, &str)]) -> StrategyParams {
        let mut map = std::collections::HashMap::new();
        for &(k, v) in overrides {
            map.insert(k.to_string(), v.to_string());
        }
        build_params(<InvalidLoopScoredStrategy as RepairStrategy<SquareTessellation, InvalidLoopIssue>>::params(&InvalidLoopScoredStrategy), Some(&map))
    }

    /// Triangle where the highest-scoring edge (by the default overlap scoring, with no other
    /// cycles to create overlap — all candidates score equally, so the pick would otherwise be an
    /// arbitrary tie-break) is `Basic`, and a different edge is `VerticalPassage`.
    fn maze_with_triangle_one_vertical() -> (Maze<SquareTessellation>, EdgeId) {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let vertical = g.add_edge(nodes[1], nodes[2], EdgeKind::VerticalPassage);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        (Maze::new(field, g), vertical)
    }

    #[test]
    fn vertical_priority_prioritized_always_cuts_the_vertical_edge() {
        let (maze, vertical) = maze_with_triangle_one_vertical();
        let check = LoopLengthCheck { instance_id: "min_loop_length".to_string(), comparison: Comparison::Lt, length: 10, cycle_kind: CycleKind::Any };
        let mut issues = Vec::new();
        let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut check_rng, InvalidLoopRequirement::all());
        let issue = issues.into_iter().next().unwrap();

        for seed in 0..20 {
            let (mut maze_try, _) = maze_with_triangle_one_vertical();
            let mut rng = MazeRng::seed_from_u64(seed);
            let result = apply_and_commit(&InvalidLoopScoredStrategy, &issue, &mut maze_try, &mut rng, &params_with(&[("vertical_passage_priority", "prioritized")]), &PresetState::empty(), &[]);
            assert!(matches!(result, RepairResult::Fixed { score: None }));
            assert!(maze_try.graph.edge(vertical).is_none(), "seed {seed}: prioritized must always cut the vertical edge when present");
        }
    }

    #[test]
    fn vertical_priority_protected_never_cuts_the_vertical_edge() {
        let (maze, vertical) = maze_with_triangle_one_vertical();
        let check = LoopLengthCheck { instance_id: "min_loop_length".to_string(), comparison: Comparison::Lt, length: 10, cycle_kind: CycleKind::Any };
        let mut issues = Vec::new();
        let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut check_rng, InvalidLoopRequirement::all());
        let issue = issues.into_iter().next().unwrap();

        for seed in 0..20 {
            let (mut maze_try, _) = maze_with_triangle_one_vertical();
            let mut rng = MazeRng::seed_from_u64(seed);
            let result = apply_and_commit(&InvalidLoopScoredStrategy, &issue, &mut maze_try, &mut rng, &params_with(&[("vertical_passage_priority", "protected")]), &PresetState::empty(), &[]);
            assert!(matches!(result, RepairResult::Fixed { score: None }));
            assert!(maze_try.graph.edge(vertical).is_some(), "seed {seed}: protected must never cut the vertical edge");
        }
    }

    /// A cycle made entirely of vertical passages: `protected` must report `Failed` (GitHub issue
    /// #230's contract), since the candidate pool empties out entirely.
    #[test]
    fn vertical_priority_protected_reports_failed_when_the_whole_cycle_is_vertical() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::VerticalPassage);
        g.add_edge(nodes[1], nodes[2], EdgeKind::VerticalPassage);
        g.add_edge(nodes[2], nodes[0], EdgeKind::VerticalPassage);
        let maze = Maze::new(field, g);

        let check = LoopLengthCheck { instance_id: "min_loop_length".to_string(), comparison: Comparison::Lt, length: 10, cycle_kind: CycleKind::Any };
        let mut issues = Vec::new();
        let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut check_rng, InvalidLoopRequirement::all());
        let issue = issues.into_iter().next().unwrap();

        let mut maze_try = maze;
        let mut rng = MazeRng::seed_from_u64(1);
        let edges_before: Vec<_> = maze_try.graph.edges().map(|e| e.id).collect();
        let result = apply_and_commit(&InvalidLoopScoredStrategy, &issue, &mut maze_try, &mut rng, &params_with(&[("vertical_passage_priority", "protected")]), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed), "an all-vertical cycle under protected priority can never be broken");
        let edges_after: Vec<_> = maze_try.graph.edges().map(|e| e.id).collect();
        assert_eq!(edges_before, edges_after);
    }

    #[test]
    fn vertical_priority_neutral_matches_default_behavior() {
        let (maze, _) = maze_with_triangle_one_vertical();
        let check = LoopLengthCheck { instance_id: "min_loop_length".to_string(), comparison: Comparison::Lt, length: 10, cycle_kind: CycleKind::Any };
        let mut issues = Vec::new();
        let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut check_rng, InvalidLoopRequirement::all());
        let issue = issues.into_iter().next().unwrap();

        for seed in 0..10 {
            let (mut maze_default, _) = maze_with_triangle_one_vertical();
            let mut rng_default = MazeRng::seed_from_u64(seed);
            apply_and_commit(&InvalidLoopScoredStrategy, &issue, &mut maze_default, &mut rng_default, &no_params(), &PresetState::empty(), &[]);

            let (mut maze_neutral, _) = maze_with_triangle_one_vertical();
            let mut rng_neutral = MazeRng::seed_from_u64(seed);
            apply_and_commit(&InvalidLoopScoredStrategy, &issue, &mut maze_neutral, &mut rng_neutral, &params_with(&[("vertical_passage_priority", "neutral")]), &PresetState::empty(), &[]);

            let edges_default: Vec<_> = maze_default.graph.edges().map(|e| e.id).collect();
            let edges_neutral: Vec<_> = maze_neutral.graph.edges().map(|e| e.id).collect();
            assert_eq!(edges_default, edges_neutral, "seed {seed}: neutral must be identical to the (neutral-default) unparametrized run");
        }
    }

    /// Square cycle with two `VerticalPassage` edges and two `Basic` ones, all tied at the same
    /// score (no other cycles to create overlap): `prioritized` must narrow scoring to the
    /// vertical pair and pick between them by seed, not always the same one.
    #[test]
    fn vertical_priority_prioritized_picks_among_several_vertical_candidates_by_seed() {
        fn maze_with_two_vertical() -> (Maze<SquareTessellation>, EdgeId, EdgeId) {
            let mut ids = IdGenerator::new();
            let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(4, 1), &mut ids).unwrap();
            let field_level = field.single_level_id();
            let mut g = Graph::new();
            for node in field.all_node_ids() { g.add_node(node); }
            let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
            let v1 = g.add_edge(nodes[0], nodes[1], EdgeKind::VerticalPassage);
            let v2 = g.add_edge(nodes[1], nodes[2], EdgeKind::VerticalPassage);
            g.add_edge(nodes[2], nodes[3], EdgeKind::Basic);
            g.add_edge(nodes[3], nodes[0], EdgeKind::Basic);
            (Maze::new(field, g), v1, v2)
        }

        let (maze, _, _) = maze_with_two_vertical();
        let check = LoopLengthCheck { instance_id: "min_loop_length".to_string(), comparison: Comparison::Lt, length: 10, cycle_kind: CycleKind::Any };
        let mut issues = Vec::new();
        let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut check_rng, InvalidLoopRequirement::all());
        let issue = issues.into_iter().next().unwrap();

        let mut cut_v1 = false;
        let mut cut_v2 = false;
        for seed in 0..30 {
            let (mut maze_try, v1, v2) = maze_with_two_vertical();
            let mut rng = MazeRng::seed_from_u64(seed);
            let result = apply_and_commit(&InvalidLoopScoredStrategy, &issue, &mut maze_try, &mut rng, &params_with(&[("vertical_passage_priority", "prioritized")]), &PresetState::empty(), &[]);
            assert!(matches!(result, RepairResult::Fixed { score: None }));
            let v1_gone = maze_try.graph.edge(v1).is_none();
            let v2_gone = maze_try.graph.edge(v2).is_none();
            assert!(v1_gone || v2_gone, "seed {seed}: prioritized must cut a vertical edge, not a basic one");
            assert!(!(v1_gone && v2_gone), "seed {seed}: only one edge should be cut to fix a single invalid cycle");
            cut_v1 |= v1_gone;
            cut_v2 |= v2_gone;
        }
        assert!(cut_v1 && cut_v2, "across seeds, prioritized should pick each vertical candidate at least once, not always the same one");
    }
}
