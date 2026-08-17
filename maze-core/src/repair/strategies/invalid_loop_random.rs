use std::collections::HashSet;
use rand::{Rng, RngCore};
use crate::Maze;
use crate::ids::EdgeId;
use crate::space::Tessellation;
use crate::quality_control::{InvalidLoopIssue, InvalidLoopRequirement};
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;
use super::cycle_cut_set::{
    edge_to_cycles_map, discard_cycles_with_edge, candidate_edges, apply_vertical_passage_priority,
    PARAM_VERTICAL_PASSAGE_PRIORITY, VERTICAL_PASSAGE_PRIORITY_OPTIONS, VERTICAL_PASSAGE_NEUTRAL,
};

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_VERTICAL_PASSAGE_PRIORITY,
        label: "Vertical passage priority",
        kind: StrategyParamKind::Enum { options: VERTICAL_PASSAGE_PRIORITY_OPTIONS, default: VERTICAL_PASSAGE_NEUTRAL },
    },
];

pub struct InvalidLoopRandomStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidLoopIssue> for InvalidLoopRandomStrategy {
    fn strategy_id(&self) -> &'static str { "invalid_loop_random" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    /// Proof this is safe (see GitHub issue #105): `apply` reads `issue.all`/`issue.invalid`
    /// only through `apply_cuts`, which builds `owners = edge_to_cycles_map(all)` and seeds
    /// `pending` with exactly `invalid`'s indices. `discard_cycles_with_edge` only ever shrinks
    /// `pending` via `retain` — it never adds an index outside what `pending` already holds — so
    /// no valid-cycle entry in `owners` is ever read. `invalid_sources` isn't read at all. A
    /// re-indexed `all` containing only the invalid cycles produces the identical result — so the
    /// `VALID_CYCLES` layer is never needed.
    fn requirement(&self, _params: &StrategyParams) -> InvalidLoopRequirement {
        InvalidLoopRequirement::empty()
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
        let vertical_priority = match params.get(PARAM_VERTICAL_PASSAGE_PRIORITY) {
            Some(StrategyParamValue::Enum(s)) => s.as_str(),
            _ => VERTICAL_PASSAGE_NEUTRAL,
        };
        let commands = apply_cuts(&issue.all, &issue.invalid, maze, rng, preset_state, vertical_priority);
        let result = if issue.invalid.is_empty() || !commands.is_empty() {
            RepairResult::Fixed { score: None }
        } else {
            RepairResult::Failed
        };
        (result, commands)
    }
}

crate::impl_erased_repair_strategy!(InvalidLoopRandomStrategy, InvalidLoopIssue);

/// Builds the list of edge-removal commands for every pending cycle — never mutates `maze`
/// (GitHub issue #118, `Specs/repair.md`'s immutable-snapshot contract). `already_cut` tracks,
/// locally to this call, every edge already proposed for removal so far (own direction and
/// reverse), standing in for what an earlier cut's real mutation would otherwise have made
/// observable through `maze.graph.edge`/`edge_between` under the old in-place contract.
fn apply_cuts<T: Tessellation>(
    all: &[Vec<EdgeId>],
    short: &[usize],
    maze: &Maze<T>,
    rng: &mut dyn RngCore,
    preset_state: &PresetState,
    vertical_priority: &str,
) -> Vec<MutationCommand> {
    let owners = edge_to_cycles_map(all);
    let mut pending: Vec<usize> = short.to_vec();
    let mut already_cut: HashSet<EdgeId> = HashSet::new();
    let mut commands = Vec::new();

    while let Some(idx) = pending.pop() {
        let Some(cycle) = all.get(idx) else { continue };
        // Drop preset-protected and already-cut edges upfront so the random pick never wastes a sample on them.
        let candidates = candidate_edges(cycle, maze, preset_state, &already_cut);
        let mut candidates = apply_vertical_passage_priority(candidates, maze, vertical_priority);

        while !candidates.is_empty() {
            let pick = rng.random_range(0..candidates.len());
            let cut = candidates[pick];
            let (from, to) = {
                let edge = maze.graph.edge(cut).expect("checked above");
                (edge.from, edge.to)
            };
            if !preset_state.is_preset_edge(from, to) {
                let reverse_id = maze.graph.edge_between(to, from);
                match reverse_id {
                    Some(reverse_id) if !already_cut.contains(&reverse_id) => {
                        commands.push(MutationCommand::RemoveEdgeWithReverse { id: cut });
                        already_cut.insert(reverse_id);
                        discard_cycles_with_edge(&mut pending, &owners, reverse_id);
                    }
                    _ => commands.push(MutationCommand::RemoveEdge { id: cut }),
                }
                already_cut.insert(cut);
                discard_cycles_with_edge(&mut pending, &owners, cut);
                break;
            }
            // Protected after all (shouldn't happen given the upfront filter, but stay defensive) — retry with another edge.
            candidates.swap_remove(pick);
        }
    }
    commands
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
    use crate::quality_control::checks::LoopLengthCheck;
    use crate::quality_control::Comparison;
    use crate::quality_control::CycleKind;
    use crate::repair::params::{build_params, StrategyParams};
    use crate::generation::PresetState;
    use crate::repair::strategies::test_utils::apply_and_commit;

    fn maze_with_triangle() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = crate::space::MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        Maze::new(field, g)
    }

    fn check_finds_short_loop(maze: &Maze<SquareTessellation>) -> bool {
        let check = LoopLengthCheck { instance_id: "min_loop_length".to_string(), comparison: Comparison::Lt, length: 10, cycle_kind: CycleKind::Any };
        let mut issues = Vec::new();
        let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(maze, &mut issues, &mut check_rng, InvalidLoopRequirement::all());
        !issues.is_empty()
    }

    fn no_params() -> StrategyParams {
        build_params(<InvalidLoopRandomStrategy as RepairStrategy<SquareTessellation, InvalidLoopIssue>>::params(&InvalidLoopRandomStrategy), None)
    }

    /// Guards the `requirement()` override itself (see GitHub issue #105) — a regression to
    /// `VALID_CYCLES`/`all()` wouldn't break correctness (this strategy tolerates extra data) but
    /// would silently reintroduce the wasted computation the mechanism exists to avoid, without
    /// failing any behavioral test that already passes `all()` explicitly.
    #[test]
    fn requirement_requests_no_layers() {
        let requirement = <InvalidLoopRandomStrategy as RepairStrategy<SquareTessellation, InvalidLoopIssue>>::requirement(&InvalidLoopRandomStrategy, &no_params());
        assert_eq!(requirement, InvalidLoopRequirement::empty());
    }

    #[test]
    fn apply_breaks_the_cycle_data_driven() {
        let mut maze = maze_with_triangle();
        assert!(check_finds_short_loop(&maze));

        let check = LoopLengthCheck { instance_id: "min_loop_length".to_string(), comparison: Comparison::Lt, length: 10, cycle_kind: CycleKind::Any };
        let mut issues = Vec::new();
        let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut check_rng, InvalidLoopRequirement::all());
        let issue = issues.into_iter().next().unwrap();

        let mut rng = MazeRng::seed_from_u64(7);
        let result = apply_and_commit(&InvalidLoopRandomStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        // Fresh Maze/MazeAnalysis: `maze`'s cached nav_graph (built by the check above,
        // before `apply` cut an edge) would otherwise be stale — analysis has no
        // invalidation on graph mutation by design (see analysis.md).
        let fresh_maze = Maze::<SquareTessellation>::new(maze.field, maze.graph);
        assert!(!check_finds_short_loop(&fresh_maze), "cycle must be broken after apply");
    }

    #[test]
    fn apply_succeeds_on_empty_cycle_list() {
        // An empty InvalidLoops list means the check found nothing to break — already fixed.
        let mut maze = maze_with_triangle();
        let issue = InvalidLoopIssue::new_from_check("min_loop_length", vec![], vec![], Default::default());
        let mut rng = MazeRng::seed_from_u64(7);
        let result = apply_and_commit(&InvalidLoopRandomStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let issue = {
            let maze = maze_with_triangle();
            let check = LoopLengthCheck { instance_id: "min_loop_length".to_string(), comparison: Comparison::Lt, length: 10, cycle_kind: CycleKind::Any };
            let mut issues = Vec::new();
            let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
            check.repair_check(&maze, &mut issues, &mut check_rng, InvalidLoopRequirement::all());
            issues.into_iter().next().unwrap()
        };

        let mut maze_a = maze_with_triangle();
        let mut rng_a = MazeRng::seed_from_u64(123);
        apply_and_commit(&InvalidLoopRandomStrategy, &issue, &mut maze_a, &mut rng_a, &no_params(), &PresetState::empty(), &[]);

        let mut maze_b = maze_with_triangle();
        let mut rng_b = MazeRng::seed_from_u64(123);
        apply_and_commit(&InvalidLoopRandomStrategy, &issue, &mut maze_b, &mut rng_b, &no_params(), &PresetState::empty(), &[]);

        let remaining_a: Vec<_> = maze_a.graph.edges().map(|e| e.id).collect();
        let remaining_b: Vec<_> = maze_b.graph.edges().map(|e| e.id).collect();
        assert_eq!(remaining_a, remaining_b);
    }

    #[test]
    fn shared_edge_between_two_cycles_does_not_panic_on_second_cut() {
        // Bowtie graph: cutting one shared edge first must not panic when the
        // strategy later tries to cut the same already-removed edge in the other cycle.
        let mut ids = IdGenerator::new();
        let field = crate::space::MultiLevelField::single_level(square_rect(4, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic); // A->B
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic); // B->C
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic); // C->A
        g.add_edge(nodes[1], nodes[3], EdgeKind::Basic); // B->D
        g.add_edge(nodes[3], nodes[2], EdgeKind::Basic); // D->C
        g.add_edge(nodes[2], nodes[1], EdgeKind::Basic); // C->B
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = LoopLengthCheck { instance_id: "min_loop_length".to_string(), comparison: Comparison::Lt, length: 10, cycle_kind: CycleKind::Any };
        let mut issues = Vec::new();
        let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut check_rng, InvalidLoopRequirement::all());
        let issue = issues.into_iter().next().unwrap();

        let mut rng = MazeRng::seed_from_u64(99);
        let result = apply_and_commit(&InvalidLoopRandomStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
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
            let field = crate::space::MultiLevelField::single_level(square_rect(4, 1), &mut ids).unwrap();
            let field_level = field.single_level_id();
            let mut g = Graph::new();
            for node in field.all_node_ids() { g.add_node(node); }
            let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
            g.add_edge(nodes[0], nodes[1], EdgeKind::Basic); // A->B (shared)
            g.add_edge(nodes[1], nodes[2], EdgeKind::Basic); // B->C
            g.add_edge(nodes[2], nodes[0], EdgeKind::Basic); // C->A
            g.add_edge(nodes[1], nodes[3], EdgeKind::Basic); // B->D
            g.add_edge(nodes[3], nodes[0], EdgeKind::Basic); // D->A
            Maze::new(field, g)
        }

        let maze = build();
        let check = LoopLengthCheck { instance_id: "min_loop_length".to_string(), comparison: Comparison::Lt, length: 10, cycle_kind: CycleKind::Any };
        let mut issues = Vec::new();
        let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut check_rng, InvalidLoopRequirement::all());
        let issue = issues.into_iter().next().unwrap();

        let nodes: Vec<_> = maze.field.field_of(maze.field.single_level_id()).unwrap().all_points().map(|p| maze.field.node_at(maze.field.single_level_id(), p).unwrap()).collect();
        let d = nodes[3];

        for seed in 0..20 {
            let mut maze_try = build();
            let mut rng = MazeRng::seed_from_u64(seed);
            let result = apply_and_commit(&InvalidLoopRandomStrategy, &issue, &mut maze_try, &mut rng, &no_params(), &PresetState::empty(), &[]);
            assert!(matches!(result, RepairResult::Fixed { score: None }));
            let d_degree = maze_try.graph.edges().filter(|e| e.from == d || e.to == d).count();
            assert!(d_degree > 0, "seed {seed}: D must keep at least one edge — it must not be fully cut off");
        }
    }

    /// See GitHub issue #105 — `InvalidLoopRandomStrategy::requirement()` requests `empty()`;
    /// this proves the optimization doesn't change observable behavior: the same seed cuts the
    /// exact same edges whether the check computed `all()` (with the valid loop resolved too) or
    /// `empty()` (valid loop skipped entirely).
    #[test]
    fn apply_result_is_identical_for_full_and_invalid_only_requirement() {
        // Triangle (invalid, 3 tile-hops) plus a separate valid 10-tile-hop loop sharing no edges.
        fn build() -> Maze<SquareTessellation> {
            let mut ids = IdGenerator::new();
            let field = crate::space::MultiLevelField::single_level(square_rect(13, 1), &mut ids).unwrap();
            let field_level = field.single_level_id();
            let mut g = Graph::new();
            for node in field.all_node_ids() { g.add_node(node); }
            let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
            g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
            g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
            g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
            for i in 3..12 {
                g.add_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
            }
            g.add_edge(nodes[12], nodes[3], EdgeKind::Basic);
            Maze::new(field, g)
        }

        let check = LoopLengthCheck { instance_id: "min_loop_length".to_string(), comparison: Comparison::Lt, length: 10, cycle_kind: CycleKind::Any };

        let mut maze_full = build();
        let mut full_issues = Vec::new();
        let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze_full, &mut full_issues, &mut check_rng, InvalidLoopRequirement::all());
        let full_issue = full_issues.into_iter().next().unwrap();
        let mut rng_full = MazeRng::seed_from_u64(42);
        apply_and_commit(&InvalidLoopRandomStrategy, &full_issue, &mut maze_full, &mut rng_full, &no_params(), &PresetState::empty(), &[]);

        let mut maze_invalid_only = build();
        let mut invalid_only_issues = Vec::new();
        let mut check_rng2 = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze_invalid_only, &mut invalid_only_issues, &mut check_rng2, InvalidLoopRequirement::empty());
        let invalid_only_issue = invalid_only_issues.into_iter().next().unwrap();
        let mut rng_invalid_only = MazeRng::seed_from_u64(42);
        apply_and_commit(&InvalidLoopRandomStrategy, &invalid_only_issue, &mut maze_invalid_only, &mut rng_invalid_only, &no_params(), &PresetState::empty(), &[]);

        let remaining_full: std::collections::HashSet<_> = maze_full.graph.edges().map(|e| e.id).collect();
        let remaining_invalid_only: std::collections::HashSet<_> = maze_invalid_only.graph.edges().map(|e| e.id).collect();
        assert_eq!(remaining_full, remaining_invalid_only, "same seed must cut the same edges regardless of requirement");
    }

    #[test]
    fn apply_does_not_cut_a_preset_protected_edge() {
        // Triangle where two of the three edges are preset-protected — only one
        // candidate remains, so the strategy must pick exactly that one deterministically.
        let maze = maze_with_triangle();

        let check = LoopLengthCheck { instance_id: "min_loop_length".to_string(), comparison: Comparison::Lt, length: 10, cycle_kind: CycleKind::Any };
        let mut issues = Vec::new();
        let mut check_rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut check_rng, InvalidLoopRequirement::all());
        let issue = issues.into_iter().next().unwrap();

        let cycle = issue.all[issue.invalid[0]].clone();
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
            let result = apply_and_commit(&InvalidLoopRandomStrategy, &issue, &mut maze_try, &mut rng, &no_params(), &preset_state, &[]);
            assert!(matches!(result, RepairResult::Fixed { score: None }));
            assert!(maze_try.graph.edge_between(unprotected_from, unprotected_to).is_none(),
                "the only unprotected edge must be cut regardless of seed {seed}");
        }
    }

    /// GitHub issue #230: a cycle entirely made of preset connections can never be broken — the
    /// strategy must report `Failed` (not `Fixed`) so the fixpoint loop stops retrying it forever,
    /// instead of looping until the repair budget is exhausted.
    #[test]
    fn apply_reports_failed_when_the_whole_cycle_is_preset_protected() {
        let maze = maze_with_triangle();

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

        let mut maze_try = maze_with_triangle();
        let mut rng = MazeRng::seed_from_u64(7);
        let edges_before: Vec<_> = maze_try.graph.edges().map(|e| e.id).collect();
        let result = apply_and_commit(&InvalidLoopRandomStrategy, &issue, &mut maze_try, &mut rng, &no_params(), &preset_state, &[]);
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
        build_params(<InvalidLoopRandomStrategy as RepairStrategy<SquareTessellation, InvalidLoopIssue>>::params(&InvalidLoopRandomStrategy), Some(&map))
    }

    /// Triangle where exactly one edge is `VerticalPassage`, the other two `Basic`.
    fn maze_with_triangle_one_vertical() -> (Maze<SquareTessellation>, EdgeId) {
        let mut ids = IdGenerator::new();
        let field = crate::space::MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
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
            let result = apply_and_commit(&InvalidLoopRandomStrategy, &issue, &mut maze_try, &mut rng, &params_with(&[("vertical_passage_priority", "prioritized")]), &PresetState::empty(), &[]);
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
            let result = apply_and_commit(&InvalidLoopRandomStrategy, &issue, &mut maze_try, &mut rng, &params_with(&[("vertical_passage_priority", "protected")]), &PresetState::empty(), &[]);
            assert!(matches!(result, RepairResult::Fixed { score: None }));
            assert!(maze_try.graph.edge(vertical).is_some(), "seed {seed}: protected must never cut the vertical edge");
        }
    }

    /// A cycle made entirely of vertical passages: `protected` must report `Failed`, same as a
    /// fully preset-protected cycle (GitHub issue #230's contract), since the pool empties out.
    #[test]
    fn vertical_priority_protected_reports_failed_when_the_whole_cycle_is_vertical() {
        let mut ids = IdGenerator::new();
        let field: crate::space::MultiLevelField<SquareTessellation> = crate::space::MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
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
        let result = apply_and_commit(&InvalidLoopRandomStrategy, &issue, &mut maze_try, &mut rng, &params_with(&[("vertical_passage_priority", "protected")]), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed), "an all-vertical cycle under protected priority can never be broken");
        let edges_after: Vec<_> = maze_try.graph.edges().map(|e| e.id).collect();
        assert_eq!(edges_before, edges_after);
    }

    /// Square cycle with two `VerticalPassage` edges and two `Basic` ones: `prioritized` must
    /// narrow to the vertical pair and pick between them by seed, not always the same one.
    #[test]
    fn vertical_priority_prioritized_picks_among_several_vertical_candidates_by_seed() {
        fn maze_with_two_vertical() -> (Maze<SquareTessellation>, EdgeId, EdgeId) {
            let mut ids = IdGenerator::new();
            let field: crate::space::MultiLevelField<SquareTessellation> = crate::space::MultiLevelField::single_level(square_rect(4, 1), &mut ids).unwrap();
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
            let result = apply_and_commit(&InvalidLoopRandomStrategy, &issue, &mut maze_try, &mut rng, &params_with(&[("vertical_passage_priority", "prioritized")]), &PresetState::empty(), &[]);
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
            apply_and_commit(&InvalidLoopRandomStrategy, &issue, &mut maze_default, &mut rng_default, &no_params(), &PresetState::empty(), &[]);

            let (mut maze_neutral, _) = maze_with_triangle_one_vertical();
            let mut rng_neutral = MazeRng::seed_from_u64(seed);
            apply_and_commit(&InvalidLoopRandomStrategy, &issue, &mut maze_neutral, &mut rng_neutral, &params_with(&[("vertical_passage_priority", "neutral")]), &PresetState::empty(), &[]);

            let edges_default: Vec<_> = maze_default.graph.edges().map(|e| e.id).collect();
            let edges_neutral: Vec<_> = maze_neutral.graph.edges().map(|e| e.id).collect();
            assert_eq!(edges_default, edges_neutral, "seed {seed}: neutral must be identical to the (neutral-default) unparametrized run");
        }
    }
}
