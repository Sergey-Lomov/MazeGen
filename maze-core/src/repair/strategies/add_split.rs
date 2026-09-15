use rand::RngCore;
use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::generation::{PresetState, SplitPattern};
use crate::graph::route_protection::is_node_on_route;
use crate::quality_control::{MissingSplitTilesIssue, RepairArea};
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;
use super::split_core::{pick_weighted_pattern, plan_unconstrained_split as core_plan_unconstrained_split, plan_pattern_split as core_plan_pattern_split};
use super::pool::Pool;
use super::standard_add_params::{self, reserve_target, attempts_limit, src_mode};
use super::remaining_deficits::RemainingDeficits;

pub const PARAM_ALLOW_LOSE_CONNECTIONS: &str = "allow_lose_connections";
pub const PARAM_ALLOW_ADD_CONNECTIONS: &str = "allow_add_connections";

const ALLOW_LOSE_CONNECTIONS_PARAM: StrategyParam = StrategyParam {
    id: PARAM_ALLOW_LOSE_CONNECTIONS,
    label: "Allow losing connections",
    kind: StrategyParamKind::Bool { default: true },
};
const ALLOW_ADD_CONNECTIONS_PARAM: StrategyParam = StrategyParam {
    id: PARAM_ALLOW_ADD_CONNECTIONS,
    label: "Allow adding connections",
    kind: StrategyParamKind::Bool { default: true },
};

static PARAMS: [StrategyParam; 5] = crate::add_strategy_params!(ALLOW_LOSE_CONNECTIONS_PARAM, ALLOW_ADD_CONNECTIONS_PARAM);

/// Handles `MISSING_SPLIT_TILES` — see GitHub issue #247, epic #246. Mints new split tiles at
/// randomly chosen eligible points (`generation::split_is_eligible` — not locked, point not
/// already multi-node — **and**, when `protect_route` is enabled, not on the maze's current
/// start->finish route, via `graph::route_protection::is_node_on_route`) until `issue.missing` is
/// satisfied or `max_attempts` **failed** attempts have been spent (successful attempts don't
/// count against the budget). Every node at the chosen
/// point — slot-0 included — is replaced by the new tile's nodes in one atomic step (see
/// `MutationCommand::ReplacePointNodes`); slot-0 is not special-cased (split creation has no
/// removal-eligibility rule to apply here, fixed here after a real bug: an earlier version left slot-0's real connections
/// untouched regardless of what the configured pattern required, so a pattern-mode split could end
/// up structurally not matching the only configured pattern at all).
///
/// **Pattern topology is a rule-level parameter** (`RuleParams::split_patterns`, GitHub issue
/// #389) — shared with the producing `split_count`/`split_density` check's own membership filter,
/// so a repaired tile is always one the check itself would have counted, closing the gap #247/
/// #253 left open. When `rule_params.split_patterns` is non-empty, this strategy only picks among
/// those patterns, honoring its own `pattern_weights` override (falling back to a pattern's own
/// `SplitPattern::weight` for any index `pattern_weights` doesn't cover). When empty, it falls
/// back to unconstrained mode using `max_split_nodes`. Each candidate mints every new node in one
/// atomic `MutationCommand::ReplacePointNodes` (all new nodes share the same all-or-nothing
/// feasibility outcome).
///
/// **Pattern-based candidate** (rule-level `split_patterns` non-empty): a candidate point is
/// picked at random, a pattern is picked honoring its resolved weight (see `resolved_patterns`
/// below), and rotation/mirror are picked at random, then every one of the pattern's `node_count`
/// new nodes — including node 0, the new slot-0 — has its own faces resolved against the point's
/// actual neighbors (`try_pattern_adaptation` — independent of generation's own
/// `enumerate_adaptations`, since there is no frontier/visited state here; every neighbor is
/// already part of the built maze). Each of the point's existing connections is matched against
/// whichever new node's face points that direction:
/// - A direction with an existing connection but **no** new node claiming it: dropped if
///   `allow_lose_connections` is `true`, otherwise the whole candidate fails.
/// - A direction with **no** existing connection but a new node's face requires one (Passage/
///   OneWay): added if `allow_add_connections` is `true`, otherwise the whole candidate fails.
/// - A direction with an existing connection matched by one or more new nodes' faces: the
///   connection is preserved onto every claiming node (GitHub issue #247's design — the original
///   neighbor is never itself split, it simply gains one edge per claiming node).
///
/// **Non-pattern candidate** (rule-level `split_patterns` empty): `max_split_nodes` (at least 2)
/// total nodes; every one of the point's existing connections is reassigned, unchanged (same
/// direction), to one uniformly random node among all `max_split_nodes` new nodes (index 0
/// becoming the new slot-0, on equal footing with every other index) — `allow_lose_connections`/
/// `allow_add_connections` don't apply here (no connection is ever lost or invented, only
/// reassigned).
///
/// `protect_route` (GitHub issue #253) is a rule-level parameter, resolved once by the factory
/// (`maze-runner`'s `build_rule_for!`) from `RuleParams` — not a `StrategyParam` anymore, so it
/// has no local override.
pub struct AddSplitStrategy {
    /// Rule-level pattern topology (`RuleParams::split_patterns`, GitHub issue #389), resolved
    /// once by the factory at construction time — same convention as `protect_route` below. Empty
    /// means non-pattern mode (`max_split_nodes` applies); non-empty means pattern mode, with each
    /// pattern's `weight` overridden by `pattern_weights[i]` when present.
    pub split_patterns: Vec<SplitPattern>,
    /// Non-pattern mode only (`split_patterns` empty) — the **total** node count on a split tile,
    /// including the pre-existing `src` node itself. Mirrors
    /// `generation::SplitGenerationConfig::max_split_nodes`.
    pub max_split_nodes: u32,
    /// Pattern mode only (`split_patterns` non-empty) — per-pattern weight override, matched to
    /// `split_patterns` by index. An index with no override, or beyond this vec's length, falls
    /// back to that pattern's own `SplitPattern::weight`.
    pub pattern_weights: Vec<f64>,
    pub protect_route: bool,
}

impl AddSplitStrategy {
    /// Resolves the effective pattern pool for one `apply()` call: `split_patterns` with each
    /// pattern's `weight` overridden by `pattern_weights[i]` when present (falls back to the
    /// pattern's own weight otherwise).
    fn resolved_patterns(&self) -> Vec<SplitPattern> {
        self.split_patterns.iter().enumerate().map(|(i, p)| {
            let weight = self.pattern_weights.get(i).copied().unwrap_or(p.weight);
            SplitPattern { weight, ..p.clone() }
        }).collect()
    }
}

impl<T: Tessellation> RepairStrategy<T, MissingSplitTilesIssue> for AddSplitStrategy {
    fn strategy_id(&self) -> &'static str { "add_split" }

    fn params(&self) -> &'static [StrategyParam] {
        &PARAMS
    }

    fn nested_suppressed_params(&self) -> &'static [&'static str] {
        standard_add_params::NESTED_SUPPRESSED_ADD_PARAMS
    }

    fn apply(
        &self,
        issue: &MissingSplitTilesIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        if issue.missing.is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let allow_lose = matches!(params.get(PARAM_ALLOW_LOSE_CONNECTIONS), Some(StrategyParamValue::Bool(v)) if *v);
        let allow_add = matches!(params.get(PARAM_ALLOW_ADD_CONNECTIONS), Some(StrategyParamValue::Bool(v)) if *v);
        let max_attempts = attempts_limit(params) as u32;
        let src_mode = src_mode(params);
        let protect_route = self.protect_route;
        let resolved_patterns = self.resolved_patterns();

        let mut commands = Vec::new();
        let mut total_added = 0u32;
        // Points already committed to a `ReplacePointNodes` command earlier in this same call —
        // their node ids won't exist by apply time, so no later command in this batch may plan a
        // new edge (existing-connection reuse or `allow_add`) pointing at one (see
        // `split_core::ExcludedTargets`).
        let mut committed: std::collections::HashSet<NodeId> = std::collections::HashSet::new();

        let mut deficits = RemainingDeficits::new(&issue.missing);
        let areas: Vec<RepairArea> = deficits.areas().collect();
        for area in areas {
            let missing = deficits.live(area);
            if missing == 0 {
                continue;
            }
            let target = reserve_target(params, missing);

            // A split tile belongs to exactly one floor (GitHub issue #369's floor-scope
            // follow-up), so restricting by area is a plain point-set filter — no cross-floor
            // double-counting concern like a teleport's exit side.
            let eligible: Vec<NodeId> = maze.field.all_node_ids()
                .filter(|&node| crate::generation::split_is_eligible(&maze.field, preset_state, node))
                .filter(|&node| !protect_route || !is_node_on_route(maze, node))
                .filter(|&node| match area {
                    RepairArea::WholeMaze => true,
                    RepairArea::Level(level) => maze.field.level_of(node) == Some(level),
                })
                .collect();
            // `src_mode` orders the candidate pool for `pop`-from-end consumption — dead ends last
            // (poppable first) under `dead_end_priority` (GitHub issue #486).
            let mut pool = Pool::new(eligible, src_mode, maze, rng);

            let mut added = 0u32;
            let mut failed_attempts = 0u32;

            while added < target && failed_attempts < max_attempts {
                let Some(at) = pool.take() else { break };

                let outcome = if resolved_patterns.is_empty() {
                    let node_count = self.max_split_nodes.max(2) as usize;
                    core_plan_unconstrained_split(maze, at, node_count, None, &committed, rng)
                } else {
                    let pattern_idx = pick_weighted_pattern(&resolved_patterns, rng);
                    core_plan_pattern_split(maze, at, &resolved_patterns[pattern_idx], None, &committed, rng, allow_lose, allow_add)
                };

                match outcome {
                    Some(nodes) => {
                        committed.insert(at);
                        commands.push(MutationCommand::ReplacePointNodes { at, nodes });
                        added += 1;
                        deficits.consume(&[area, RepairArea::WholeMaze]);
                    }
                    None => {
                        failed_attempts += 1;
                    }
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

crate::impl_erased_repair_strategy!(AddSplitStrategy, MissingSplitTilesIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::graph::{Graph, EdgeKind};
    use crate::IdGenerator;
    use crate::space::{SquareTessellation, SquarePoint, square_rect, MultiLevelField};
    use crate::repair::params::build_params;
    use crate::repair::strategies::test_utils::apply_and_commit;

    fn no_params() -> StrategyParams {
        build_params(<AddSplitStrategy as RepairStrategy<SquareTessellation, MissingSplitTilesIssue>>::params(&strategy_unconstrained()), None)
    }

    fn maze_line(len: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(len, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        Maze::new(field, g)
    }

    fn maze_grid(width: usize, height: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(width, height), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        Maze::new(field, g)
    }

    fn missing_issue(missing: u32) -> MissingSplitTilesIssue {
        let entries = if missing == 0 { vec![] } else { vec![(RepairArea::WholeMaze, missing)] };
        MissingSplitTilesIssue::new_from_check("split_count", entries)
    }

    fn strategy_unconstrained() -> AddSplitStrategy {
        AddSplitStrategy { split_patterns: vec![], max_split_nodes: 2, pattern_weights: vec![], protect_route: true }
    }

    #[test]
    fn apply_succeeds_immediately_when_nothing_missing() {
        let mut maze = maze_line(3);
        let issue = missing_issue(0);
        let mut rng = MazeRng::seed_from_u64(1);
        let nodes_before = maze.field.node_count();
        let result = apply_and_commit(&strategy_unconstrained(), &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.field.node_count(), nodes_before);
    }

    #[test]
    fn apply_adds_split_tiles_in_unconstrained_mode() {
        let mut maze = maze_line(5);
        let issue = missing_issue(2);
        let mut rng = MazeRng::seed_from_u64(7);
        let nodes_before = maze.field.node_count();
        let result = apply_and_commit(&strategy_unconstrained(), &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.field.node_count(), nodes_before + 2, "2 split tiles must each mint exactly one new node (max_split_nodes=2)");
    }

    #[test]
    fn apply_mints_configured_sibling_count_per_tile() {
        let mut maze = maze_line(3);
        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(3);
        let strategy = AddSplitStrategy { split_patterns: vec![], max_split_nodes: 4, pattern_weights: vec![], protect_route: true };
        let nodes_before = maze.field.node_count();
        let result = apply_and_commit(&strategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.field.node_count(), nodes_before + 3, "max_split_nodes=4 must mint 3 new siblings for the one tile");
    }

    /// Total real edges touching any node currently at `point` — used to check that
    /// `plan_unconstrained_split`'s redistribution neither drops nor invents connections, only
    /// reassigns them across the new node set (epic #246: slot-0 is on equal footing with every
    /// other new node, so nothing about it is specifically preserved anymore — only the point's
    /// total edge count is invariant).
    fn edges_touching_point(maze: &Maze<SquareTessellation>, point: SquarePoint) -> usize {
        maze.field.nodes_at(maze.field.single_level_id(), point).iter()
            .flat_map(|&n| maze.graph.outgoing_neighbors(n).chain(maze.graph.incoming_neighbors(n)))
            .count()
    }

    #[test]
    fn apply_redistributes_every_existing_connection_without_losing_or_duplicating_it() {
        // Unconstrained mode: slot-0 is replaced along with any siblings, but the point's total
        // number of real connections must come out exactly the same as it went in — each one
        // lands on exactly one of the new nodes.
        let mut maze = maze_line(5);
        let nodes: Vec<NodeId> = (0..5).map(|x| maze.field.node_at(maze.field.single_level_id(), SquarePoint { x, y: 0 }).unwrap()).collect();
        for w in nodes.windows(2) {
            maze.graph.add_bidirectional_edge(w[0], w[1], EdgeKind::Basic);
        }
        let points: Vec<SquarePoint> = (0..5).map(|x| SquarePoint { x, y: 0 }).collect();
        let edges_before: Vec<usize> = points.iter().map(|&p| edges_touching_point(&maze, p)).collect();

        let issue = missing_issue(3);
        let mut rng = MazeRng::seed_from_u64(42);
        apply_and_commit(&strategy_unconstrained(), &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);

        for (i, &point) in points.iter().enumerate() {
            assert_eq!(edges_touching_point(&maze, point), edges_before[i],
                "point at x={i} must keep the same total edge count after redistribution, split or not");
        }
    }

    /// 1x3 line with a start->finish route through all 3 nodes (mirrors
    /// `route_protection::tests::maze_with_corridor_route`), needed for `protect_route` tests.
    fn maze_line_with_route(len: usize) -> Maze<SquareTessellation> {
        let mut maze = maze_line(len);
        let nodes: Vec<NodeId> = (0..len as i32).map(|x| maze.field.node_at(maze.field.single_level_id(), SquarePoint { x, y: 0 }).unwrap()).collect();
        for w in nodes.windows(2) {
            maze.graph.add_bidirectional_edge(w[0], w[1], EdgeKind::Basic);
        }
        maze.meta = crate::meta::MazeMeta { start: Some(nodes[0]), finish: Some(*nodes.last().unwrap()) };
        maze
    }

    #[test]
    fn apply_refuses_a_route_node_as_a_split_candidate_by_default() {
        // Every node in a 1x3 line sits on the start->finish route — with protect_route defaulted
        // to true, there is no eligible candidate at all.
        let mut maze = maze_line_with_route(3);
        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&strategy_unconstrained(), &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed), "every candidate point sits on the route, protect_route defaults to true");
    }

    #[test]
    fn apply_splits_a_route_node_when_protect_route_is_disabled() {
        let mut maze = maze_line_with_route(3);
        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let strategy = AddSplitStrategy { split_patterns: vec![], max_split_nodes: 2, pattern_weights: vec![], protect_route: false };
        let nodes_before = maze.field.node_count();
        let result = apply_and_commit(&strategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.field.node_count(), nodes_before + 1);
    }

    #[test]
    fn apply_reports_failed_when_no_eligible_point_exists() {
        // A single-node field where the only point is locked — no eligible candidate at all.
        let mut maze = maze_line(1);
        let node = maze.field.node_at(maze.field.single_level_id(), SquarePoint { x: 0, y: 0 }).unwrap();
        let mut preset_state = PresetState::empty();
        preset_state.locked_out.insert(node);
        preset_state.locked_in.insert(node);

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&strategy_unconstrained(), &issue, &mut maze, &mut rng, &no_params(), &preset_state, &[]);
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_restricts_candidates_to_the_named_level() {
        let mut ids = IdGenerator::new();
        let field_a = crate::space::Field::new(square_rect(5, 1), &mut ids).unwrap();
        let field_b = crate::space::Field::new(square_rect(5, 1), &mut ids).unwrap();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new([field_a]);
        let level_b = mf.add_level(field_b);
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let mut maze: Maze<SquareTessellation> = Maze::new(mf, g);
        let nodes_before = maze.field.node_count();

        let issue = MissingSplitTilesIssue::new_from_check("split_count", vec![(RepairArea::Level(level_b), 2)]);
        let mut rng = MazeRng::seed_from_u64(7);
        let result = apply_and_commit(&strategy_unconstrained(), &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.field.node_count(), nodes_before + 2);
        let split_points: std::collections::HashSet<_> = maze.field.all_points_with_level()
            .filter(|&(level, point)| maze.field.nodes_at(level, point).len() > 1)
            .collect();
        assert_eq!(split_points.len(), 2);
        for (level, _) in split_points {
            assert_eq!(level, level_b, "every new split tile must be on the reported level");
        }
    }

    #[test]
    fn apply_does_not_double_count_a_whole_maze_entry_already_satisfied_by_per_floor_entries() {
        // GitHub issue #369 follow-up: a per-floor deficit ("3 per floor" on 3 floors) and a
        // whole-maze deficit on the same rule ("12 whole-maze") both land in one issue's
        // `missing` — the whole-maze entry is the same requirement measured differently, not an
        // independent 12 on top. Total added must be 12 (3+3+3, whole-maze already satisfied by
        // then), not 21.
        let mut ids = IdGenerator::new();
        let field_a = crate::space::Field::new(square_rect(6, 6), &mut ids).unwrap();
        let field_b = crate::space::Field::new(square_rect(6, 6), &mut ids).unwrap();
        let field_c = crate::space::Field::new(square_rect(6, 6), &mut ids).unwrap();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new([field_a]);
        let level_b = mf.add_level(field_b);
        let level_c = mf.add_level(field_c);
        let level_a = mf.levels_ordered().next().unwrap();
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let mut maze: Maze<SquareTessellation> = Maze::new(mf, g);
        let nodes_before = maze.field.node_count();

        let issue = MissingSplitTilesIssue::new_from_check("split_count", vec![
            (RepairArea::Level(level_a), 3),
            (RepairArea::Level(level_b), 3),
            (RepairArea::Level(level_c), 3),
            (RepairArea::WholeMaze, 12),
        ]);
        let mut rng = MazeRng::seed_from_u64(11);
        let result = apply_and_commit(&strategy_unconstrained(), &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.field.node_count(), nodes_before + 12, "12 split tiles total, not 21");
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let issue = missing_issue(2);

        let mut maze_a = maze_line(5);
        let mut rng_a = MazeRng::seed_from_u64(123);
        apply_and_commit(&strategy_unconstrained(), &issue, &mut maze_a, &mut rng_a, &no_params(), &PresetState::empty(), &[]);

        let mut maze_b = maze_line(5);
        let mut rng_b = MazeRng::seed_from_u64(123);
        apply_and_commit(&strategy_unconstrained(), &issue, &mut maze_b, &mut rng_b, &no_params(), &PresetState::empty(), &[]);

        assert_eq!(maze_a.field.node_count(), maze_b.field.node_count());
    }

    #[path = "../../add_split_pattern_tests.rs"]
    mod add_split_pattern_tests;
}
