use rand::{Rng, RngCore};
use std::collections::HashSet;
use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::quality_control::{MissingLoopsIssue, RepairArea};
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;
use super::dead_end_priority::apply_src_mode;
use super::standard_add_params::{self, reserve_target, attempts_limit, src_mode};
use super::remaining_deficits::RemainingDeficits;

pub const PARAM_ONE_WAY_CHANCE: &str = "loop_one_way_chance";

const ONE_WAY_CHANCE_PARAM: StrategyParam = StrategyParam {
    id: PARAM_ONE_WAY_CHANCE,
    label: "Loop one-way chance",
    kind: StrategyParamKind::Float { default: 0.0, min: 0.0, max: 100.0 },
};

static PARAMS: [StrategyParam; 4] = crate::add_strategy_params!(ONE_WAY_CHANCE_PARAM);

/// Handles `MISSING_LOOPS` — opposite approach from `InvalidLoopRandomStrategy`/
/// `InvalidLoopScoredStrategy`, which cut edges from existing bad loops. This strategy instead
/// seeds new connections at random, expecting a follow-up QC pass to discard whichever of them
/// don't end up forming a valid loop.
///
/// **`issue.data` is mandatory for this kind**: `missing` (how many loops short of the
/// requirement) has no other channel — the producing check (`MinLoopsCheck`, either `Absolute` or
/// `Ratio` mode) already computed it.
///
/// `loop_one_way_chance` (GitHub issue #217 follow-up) mirrors base-generation's own
/// `ElementsConfig::one_way_chance` coin-flip contract (`generation::edge_ops::add_edge_kind`) —
/// named distinctly from that field (and from `MissingTeleportsStrategy`'s own `one_way_chance`
/// param) since a `StrategyParam::id` is looked up by web i18n as a flat key with no
/// strategy-scoping, and a shared id would resolve to whichever strategy's label was registered,
/// not necessarily this one's. Per candidate pair, a `[0, 100)` roll below `loop_one_way_chance`
/// adds a single directed edge in a random direction instead of a full bidirectional passage — letting this strategy seed one-way
/// shortcuts (which QC's `CycleKind::OneWay` filter, see #217, can then evaluate) rather than
/// always producing fully bidirectional loops. Default `0.0` reproduces the pre-#217-follow-up
/// always-bidirectional behavior exactly.
///
/// `src_mode` (GitHub issue #254 follow-up, shared with `MissingLoopsSplitStrategy` via
/// `dead_end_priority`) — `dead_end_priority` orders the candidate pool so dead ends (nodes with
/// exactly one distinct graph neighbor) are tried first, so a fix grows out from the maze's
/// least-connected cells before an arbitrary one. Every other candidate stays in the pool behind
/// them (see GitHub issue #278's exhaustion-fallback audit — the original version dropped them
/// entirely, silently under-delivering once dead ends ran out), so exhausting the dead ends falls
/// through to the rest automatically. `src` is popped from the pool's end each iteration (not a
/// random index) specifically to preserve this ordering. Default `random` shuffles the whole pool
/// with no partition.
pub struct MissingLoopsRandomStrategy;

impl<T: Tessellation> RepairStrategy<T, MissingLoopsIssue> for MissingLoopsRandomStrategy {
    fn strategy_id(&self) -> &'static str { "missing_loops_random" }

    fn params(&self) -> &'static [StrategyParam] {
        &PARAMS
    }

    fn nested_suppressed_params(&self) -> &'static [&'static str] {
        standard_add_params::NESTED_SUPPRESSED_ADD_PARAMS
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
        if issue.missing.is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let one_way_chance = params.get(PARAM_ONE_WAY_CHANCE).and_then(|v| v.as_float()).unwrap_or(0.0) / 100.0;
        let src_mode = src_mode(params);
        let max_failed_attempts = attempts_limit(params);

        // Pairs proposed as a bidirectional-edge command so far this call — stands in for what
        // an earlier real mutation would have made observable via `edge_between` under the old
        // in-place contract (GitHub issue #118, `Specs/repair.md`'s immutable-snapshot contract).
        let mut proposed_pairs: HashSet<(NodeId, NodeId)> = HashSet::new();
        let mut commands = Vec::new();
        let mut total_added: u32 = 0;

        let mut deficits = RemainingDeficits::new(&issue.missing);
        let areas: Vec<RepairArea> = deficits.areas().collect();
        for area in areas {
            let missing = deficits.live(area);
            if missing == 0 {
                continue;
            }
            let target = reserve_target(params, missing);

            let candidates: Vec<NodeId> = maze.field.all_node_ids()
                .filter(|&n| match area {
                    RepairArea::WholeMaze => true,
                    RepairArea::Level(level) => maze.field.level_of(n) == Some(level),
                })
                .collect();
            let mut pool: Vec<NodeId> = apply_src_mode(maze, candidates, src_mode, rng);
            let mut added: u32 = 0;
            // A popped `src` that yields no new edge counts against the budget; a successful one
            // does not (`attempts_limit`, GitHub issue #486).
            let mut failed_attempts: usize = 0;

            while added < target && !pool.is_empty() && failed_attempts < max_failed_attempts {
                // Pop from the end, not a random index — `apply_src_mode` orders the pool so
                // dead-end candidates sit at this end when `dead_end_priority` is active (GitHub
                // issue #278's exhaustion-fallback fix); a random-index pick would destroy that
                // ordering and re-introduce the original bug (falling through to the rest of the
                // pool only by accident, not by design). Every one of `src`'s neighbors is tried in
                // the inner loop below regardless of outcome, so `src` is never worth revisiting this
                // same call either way — popping it (success or failure) is correct, not just
                // convenient.
                let src = pool.pop().expect("pool.is_empty() already checked by the while condition");
                let added_before = added;

                let mut neighbors = maze.field.neighbors(src);

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
                    // Same RNG sample-consumption contract as `generation::edge_ops::add_edge_kind`:
                    // a one-way pair rolls the chance check then the direction (two samples), a
                    // bidirectional pair rolls only the chance check (one sample) — always rolled,
                    // regardless of which branch preset_state ends up permitting, so a later param
                    // change doesn't reorder RNG draws relative to earlier iterations of this loop.
                    if rng.random::<f64>() < one_way_chance {
                        let forward = rng.random::<bool>();
                        let (from, to) = if forward { (src, dst) } else { (dst, src) };
                        if !crate::generation::directed_edge_feasible(preset_state, from, to) {
                            continue;
                        }
                        commands.push(MutationCommand::AddDirectedEdge { from, to });
                    } else {
                        // Strictly bidirectional: skip the pair unless both directions are
                        // unblocked, rather than `can_connect`'s "at least one direction" contract.
                        if !crate::generation::bidirectional_edge_feasible(preset_state, src, dst) {
                            continue;
                        }
                        commands.push(MutationCommand::AddBidirectionalEdge { a: src, b: dst });
                    }
                    proposed_pairs.insert((src, dst));
                    added += 1;
                    deficits.consume(&[area, RepairArea::WholeMaze]);
                    break;
                }
                if added == added_before {
                    failed_attempts += 1;
                }
            }
            total_added += added;
        }

        if total_added == 0 {
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
    use crate::space::{SquareTessellation, square_rect, MultiLevelField};
    use crate::repair::params::build_params;
    use crate::repair::strategies::test_utils::apply_and_commit;

    fn no_params() -> StrategyParams {
        build_params(<MissingLoopsRandomStrategy as RepairStrategy<SquareTessellation, MissingLoopsIssue>>::params(&MissingLoopsRandomStrategy), None)
    }

    fn maze_grid(side: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(side, side), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        Maze::new(field, g)
    }

    fn missing_issue(missing: u32) -> MissingLoopsIssue {
        let entries = if missing == 0 { vec![] } else { vec![(RepairArea::WholeMaze, missing)] };
        MissingLoopsIssue::new_from_check("min_loops_count", entries)
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
        // 2 missing * (1 + 0%) = 2 connections, each bidirectional => 4 edges (reserve_percent
        // default unified to 0 in issue #486).
        assert_eq!(maze.graph.edges().count(), 4);
        for edge in maze.graph.edges() {
            assert!(maze.graph.edge_between(edge.to, edge.from).is_some(), "every added edge must have its reverse");
        }
    }

    #[test]
    fn apply_does_not_add_connection_blocked_by_preset_state() {
        // 1x2 field: only one possible neighbor pair, fully blocked both ways.
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
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
    fn apply_does_not_add_a_one_way_edge_infeasible_in_the_rolled_direction() {
        // 1x2 field, both directions blocked, one_way_chance forced to 100 — every candidate
        // direction rolled for the single one-way edge must fail `directed_edge_feasible`,
        // exercising the "skip this pair, try the next neighbor" branch distinct from the
        // strictly-bidirectional infeasibility check covered above.
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((nodes[0], nodes[1]));
        preset_state.blocked.insert((nodes[1], nodes[0]));

        let issue = missing_issue(1);
        let mut overrides = HashMap::new();
        overrides.insert("loop_one_way_chance".to_string(), "100".to_string());
        let params = build_params(
            <MissingLoopsRandomStrategy as RepairStrategy<SquareTessellation, MissingLoopsIssue>>::params(&MissingLoopsRandomStrategy),
            Some(&overrides),
        );
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&MissingLoopsRandomStrategy, &issue, &mut maze, &mut rng, &params, &preset_state, &[]);
        assert!(matches!(result, RepairResult::Failed));
        assert_eq!(maze.graph.edges().count(), 0);
    }

    #[test]
    fn apply_does_not_add_connection_partially_blocked_by_preset_state() {
        // 1x2 field: only one possible neighbor pair, blocked in one direction only.
        // A strictly-bidirectional strategy must skip this pair entirely, not add
        // a full bidirectional edge that overwrites the protected direction.
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
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
        let field = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
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
        let field = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
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
        overrides.insert("reserve_percent".to_string(), "50".to_string());
        let params = build_params(
            <MissingLoopsRandomStrategy as RepairStrategy<SquareTessellation, MissingLoopsIssue>>::params(&MissingLoopsRandomStrategy),
            Some(&overrides),
        );
        let mut rng = MazeRng::seed_from_u64(42);
        let result = apply_and_commit(&MissingLoopsRandomStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        // 2 missing * (1 + 50%) = 3 connections => 6 directed edges, vs 4 with the unified 0 default.
        assert_eq!(maze.graph.edges().count(), 6);
    }

    #[test]
    fn one_way_chance_100_adds_only_directed_edges() {
        let mut maze = maze_grid(4);
        let issue = missing_issue(2);
        let mut overrides = HashMap::new();
        overrides.insert("loop_one_way_chance".to_string(), "100".to_string());
        let params = build_params(
            <MissingLoopsRandomStrategy as RepairStrategy<SquareTessellation, MissingLoopsIssue>>::params(&MissingLoopsRandomStrategy),
            Some(&overrides),
        );
        let mut rng = MazeRng::seed_from_u64(42);
        let result = apply_and_commit(&MissingLoopsRandomStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        // 2 missing * (1 + 0%) = 2 connections, each single-directed => 2 edges, none reversed.
        assert_eq!(maze.graph.edges().count(), 2);
        for edge in maze.graph.edges() {
            assert!(maze.graph.edge_between(edge.to, edge.from).is_none(), "loop_one_way_chance: 100 must never add a reverse");
        }
    }

    #[test]
    fn one_way_chance_0_reproduces_pre_existing_always_bidirectional_behavior() {
        let mut maze = maze_grid(4);
        let issue = missing_issue(2);
        let mut overrides = HashMap::new();
        overrides.insert("loop_one_way_chance".to_string(), "0".to_string());
        overrides.insert("reserve_percent".to_string(), "50".to_string());
        let params = build_params(
            <MissingLoopsRandomStrategy as RepairStrategy<SquareTessellation, MissingLoopsIssue>>::params(&MissingLoopsRandomStrategy),
            Some(&overrides),
        );
        let mut rng = MazeRng::seed_from_u64(42);
        let result = apply_and_commit(&MissingLoopsRandomStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.edges().count(), 6);
        for edge in maze.graph.edges() {
            assert!(maze.graph.edge_between(edge.to, edge.from).is_some(), "every added edge must have its reverse");
        }
    }

    #[test]
    fn apply_does_not_duplicate_an_existing_edge() {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
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
    fn src_mode_dead_end_priority_only_picks_dead_ends_as_src() {
        // 4x4 grid, a single existing bidirectional passage between two nodes (both dead ends,
        // degree 1) — every other node is fully isolated (degree 0, not a dead end). With
        // `dead_end_priority`, `src` must always be one of the two passage endpoints.
        let mut maze = maze_grid(4);
        let nodes: Vec<NodeId> = (0..4).flat_map(|x| (0..4).map(move |y| (x, y)))
            .map(|(x, y)| maze.field.node_at(maze.field.single_level_id(), crate::space::SquarePoint { x, y }).unwrap())
            .collect();
        maze.graph.add_bidirectional_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let dead_ends = [nodes[0], nodes[1]];

        let issue = missing_issue(1);
        let mut overrides = HashMap::new();
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        overrides.insert("src_mode".to_string(), "dead_end_priority".to_string());
        let params = build_params(
            <MissingLoopsRandomStrategy as RepairStrategy<SquareTessellation, MissingLoopsIssue>>::params(&MissingLoopsRandomStrategy),
            Some(&overrides),
        );
        let mut rng = MazeRng::seed_from_u64(5);
        let result = apply_and_commit(&MissingLoopsRandomStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        let new_edges: Vec<_> = maze.graph.edges().filter(|e| {
            !(dead_ends.contains(&e.from) && dead_ends.contains(&e.to))
        }).collect();
        assert!(!new_edges.is_empty(), "a new connection must have been added");
        for edge in &new_edges {
            assert!(dead_ends.contains(&edge.from) || dead_ends.contains(&edge.to),
                "every new edge must touch one of the two dead-end nodes as its src");
        }
    }

    #[test]
    fn apply_restricts_candidates_to_the_named_level() {
        // Two 4x4 levels. The issue reports a deficit only on level_b, so every added edge must
        // land there, even though level_a's nodes are just as available in the field overall.
        let mut ids = IdGenerator::new();
        let field_a = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
        let field_b = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new([field_a]);
        let level_a = mf.single_level_id();
        let level_b = mf.add_level(field_b);
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let mut maze: Maze<SquareTessellation> = Maze::new(mf, g);

        let issue = MissingLoopsIssue::new_from_check("min_loops_count", vec![(RepairArea::Level(level_b), 2)]);
        let mut rng = MazeRng::seed_from_u64(42);
        let result = apply_and_commit(&MissingLoopsRandomStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edges().count() > 0, "at least one connection must have been added");
        for edge in maze.graph.edges() {
            assert_eq!(maze.field.level_of(edge.from), Some(level_b), "every added edge must be on the reported level");
            assert_eq!(maze.field.level_of(edge.to), Some(level_b), "every added edge must be on the reported level");
        }
        let _ = level_a;
    }

    #[test]
    fn apply_does_not_double_count_a_whole_maze_entry_already_satisfied_by_per_floor_entries() {
        // Merging a PerFloor check ("3 per floor") with a WholeMaze check ("12 whole-maze") on the
        // same 3-floor rule must not add 3+3+3+12 = 21 connections -- the whole-maze entry is the
        // *same* requirement as the three per-floor entries, not an independent one, so satisfying
        // every per-floor entry (9 total) must leave only 3 more needed to reach 12 whole-maze.
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new([]);
        let level_a = mf.add_level(crate::space::Field::new(square_rect(6, 6), &mut ids).unwrap());
        let level_b = mf.add_level(crate::space::Field::new(square_rect(6, 6), &mut ids).unwrap());
        let level_c = mf.add_level(crate::space::Field::new(square_rect(6, 6), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let mut maze: Maze<SquareTessellation> = Maze::new(mf, g);

        let issue = MissingLoopsIssue::new_from_check("min_loops_count", vec![
            (RepairArea::Level(level_a), 3),
            (RepairArea::Level(level_b), 3),
            (RepairArea::Level(level_c), 3),
            (RepairArea::WholeMaze, 12),
        ]);
        let mut overrides = HashMap::new();
        overrides.insert("reserve_percent".to_string(), "0".to_string());
        let params = build_params(
            <MissingLoopsRandomStrategy as RepairStrategy<SquareTessellation, MissingLoopsIssue>>::params(&MissingLoopsRandomStrategy),
            Some(&overrides),
        );
        let mut rng = MazeRng::seed_from_u64(42);
        let result = apply_and_commit(&MissingLoopsRandomStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        // 12 connections total, each bidirectional => 24 edges, not 21*2 = 42.
        assert_eq!(maze.graph.edges().count(), 24, "whole-maze entry must be satisfied by the per-floor work already done, not stacked on top of it");
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
