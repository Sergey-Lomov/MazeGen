use rand::{Rng, RngCore};
use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::generation::{PresetState, SplitGenerationConfig};
use crate::graph::route_protection::is_node_on_route;
use crate::quality_control::MissingSplitTilesIssue;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;
use super::split_core::{pick_weighted_pattern, plan_unconstrained_split as core_plan_unconstrained_split, plan_pattern_split as core_plan_pattern_split};

pub const PARAM_ALLOW_LOSE_CONNECTIONS: &str = "allow_lose_connections";
pub const PARAM_ALLOW_ADD_CONNECTIONS: &str = "allow_add_connections";
pub const PARAM_MAX_ATTEMPTS: &str = "max_attempts";
pub const MAX_ATTEMPTS_DEFAULT: u32 = 50;

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_ALLOW_LOSE_CONNECTIONS,
        label: "Allow losing connections",
        kind: StrategyParamKind::Bool { default: true },
    },
    StrategyParam {
        id: PARAM_ALLOW_ADD_CONNECTIONS,
        label: "Allow adding connections",
        kind: StrategyParamKind::Bool { default: true },
    },
    StrategyParam {
        id: PARAM_MAX_ATTEMPTS,
        label: "Max failed attempts",
        kind: StrategyParamKind::Float { default: MAX_ATTEMPTS_DEFAULT as f64, min: 1.0, max: 10_000.0 },
    },
];

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
/// Has its own pattern-selection configuration, independent from the producing check's own
/// pattern-list filter (see GitHub issue #247's known limitation, tracked for a fix in #253):
/// `config` is a plain `generation::SplitGenerationConfig` (the same type generation's own
/// `split_generation` field carries), reused as-is rather than duplicating its
/// `pattern_mode`/`max_split_nodes`/`patterns` fields onto this strategy directly. Each candidate
/// mints every new node in one atomic `MutationCommand::ReplacePointNodes` (all new nodes share
/// the same all-or-nothing feasibility outcome).
///
/// **`pattern_mode` (via `patterns`, non-empty) — pattern-based candidate**: a candidate point is
/// picked at random, a pattern is picked honoring `SplitPattern::weight` (see `pick_weighted_pattern`
/// below — GitHub issue #275), and rotation/mirror are picked at random, then every one of the pattern's
/// `node_count` new nodes — including node 0, the new slot-0 — has its own faces resolved against
/// the point's actual neighbors (`try_pattern_adaptation` below — independent of generation's own
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
/// **Non-pattern (`patterns` empty) candidate**: `max_split_nodes` (at least 2) total nodes;
/// every one of the point's existing connections is reassigned, unchanged (same direction), to
/// one uniformly random node among all `max_split_nodes` new nodes (index 0 becoming the new
/// slot-0, on equal footing with every other index) — `allow_lose_connections`/
/// `allow_add_connections` don't apply here (no connection is ever lost or invented, only
/// reassigned).
///
/// `protect_route` (GitHub issue #253) is a rule-level parameter, resolved once by the factory
/// (`maze-runner`'s `build_rule_for!`) from `RuleParams` — not a `StrategyParam` anymore, so it
/// has no local override.
pub struct AddSplitStrategy {
    pub config: SplitGenerationConfig,
    pub protect_route: bool,
}

impl<T: Tessellation> RepairStrategy<T, MissingSplitTilesIssue> for AddSplitStrategy {
    fn strategy_id(&self) -> &'static str { "add_split" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
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
        let missing = issue.missing;
        if missing == 0 {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let allow_lose = matches!(params.get(PARAM_ALLOW_LOSE_CONNECTIONS), Some(StrategyParamValue::Bool(v)) if *v);
        let allow_add = matches!(params.get(PARAM_ALLOW_ADD_CONNECTIONS), Some(StrategyParamValue::Bool(v)) if *v);
        let max_attempts = params.get(PARAM_MAX_ATTEMPTS).and_then(|v| v.as_float())
            .map(|v| v.max(1.0) as u32)
            .unwrap_or(MAX_ATTEMPTS_DEFAULT);
        let protect_route = self.protect_route;

        let candidates: Vec<NodeId> = maze.field.all_node_ids()
            .filter(|&node| crate::generation::split_is_eligible(&maze.field, preset_state, node))
            .filter(|&node| !protect_route || !is_node_on_route(maze, node))
            .collect();

        let mut commands = Vec::new();
        let mut added = 0u32;
        let mut failed_attempts = 0u32;
        let mut pool = candidates;
        // Points already committed to a `ReplacePointNodes` command earlier in this same call —
        // their node ids won't exist by apply time, so no later command in this batch may plan a
        // new edge (existing-connection reuse or `allow_add`) pointing at one (see
        // `split_core::ExcludedTargets`).
        let mut committed: std::collections::HashSet<NodeId> = std::collections::HashSet::new();

        while added < missing && failed_attempts < max_attempts && !pool.is_empty() {
            let pick_idx = rng.random_range(0..pool.len());
            let at = pool[pick_idx];

            let outcome = if self.config.patterns.is_empty() {
                let node_count = self.config.max_split_nodes.max(2) as usize;
                core_plan_unconstrained_split(maze, at, node_count, None, &committed, rng)
            } else {
                let pattern_idx = pick_weighted_pattern(&self.config.patterns, rng);
                core_plan_pattern_split(maze, at, &self.config.patterns[pattern_idx], None, &committed, rng, allow_lose, allow_add)
            };

            match outcome {
                Some(nodes) => {
                    committed.insert(at);
                    commands.push(MutationCommand::ReplacePointNodes { at, nodes });
                    added += 1;
                    // Eligibility is per-point — once `at` has a command pending, it must not be
                    // picked again this call (the point would no longer be `split_is_eligible`
                    // after this command actually applies).
                    pool.swap_remove(pick_idx);
                }
                None => {
                    failed_attempts += 1;
                    pool.swap_remove(pick_idx);
                }
            }
        }

        if added == 0 {
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
    use crate::space::{SquareTessellation, SquarePoint, square_rect, Field};
    use crate::generation::{SplitPattern, SplitPatternFace, SplitFaceRequirement};
    use crate::repair::params::build_params;
    use crate::repair::strategies::test_utils::apply_and_commit;
    use crate::repair::strategies::split_core;

    fn no_params() -> StrategyParams {
        build_params(<AddSplitStrategy as RepairStrategy<SquareTessellation, MissingSplitTilesIssue>>::params(&strategy_unconstrained()), None)
    }

    fn maze_line(len: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(len, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        Maze::new(field, g)
    }

    fn maze_grid(width: usize, height: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(width, height), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        Maze::new(field, g)
    }

    fn missing_issue(missing: u32) -> MissingSplitTilesIssue {
        MissingSplitTilesIssue::new_from_check("split_count", missing)
    }

    fn strategy_unconstrained() -> AddSplitStrategy {
        AddSplitStrategy { config: SplitGenerationConfig { pattern_mode: false, max_split_nodes: 2, patterns: vec![] }, protect_route: true }
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
        let strategy = AddSplitStrategy { config: SplitGenerationConfig { pattern_mode: false, max_split_nodes: 4, patterns: vec![] }, protect_route: true };
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
        maze.field.nodes_at(point).iter()
            .flat_map(|&n| maze.graph.outgoing_neighbors(n).chain(maze.graph.incoming_neighbors(n)))
            .count()
    }

    #[test]
    fn apply_redistributes_every_existing_connection_without_losing_or_duplicating_it() {
        // Unconstrained mode: slot-0 is replaced along with any siblings, but the point's total
        // number of real connections must come out exactly the same as it went in — each one
        // lands on exactly one of the new nodes.
        let mut maze = maze_line(5);
        let nodes: Vec<NodeId> = (0..5).map(|x| maze.field.node_at(SquarePoint { x, y: 0 }).unwrap()).collect();
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
        let nodes: Vec<NodeId> = (0..len as i32).map(|x| maze.field.node_at(SquarePoint { x, y: 0 }).unwrap()).collect();
        for w in nodes.windows(2) {
            maze.graph.add_bidirectional_edge(w[0], w[1], EdgeKind::Basic);
        }
        maze.meta = crate::meta::MazeMeta { start: Some(nodes[0]), finish: Some(*nodes.last().unwrap()), route_score: None };
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
        let strategy = AddSplitStrategy { config: SplitGenerationConfig { pattern_mode: false, max_split_nodes: 2, patterns: vec![] }, protect_route: false };
        let nodes_before = maze.field.node_count();
        let result = apply_and_commit(&strategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.field.node_count(), nodes_before + 1);
    }

    #[test]
    fn apply_reports_failed_when_no_eligible_point_exists() {
        // A single-node field where the only point is locked — no eligible candidate at all.
        let mut maze = maze_line(1);
        let node = maze.field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let mut preset_state = PresetState::empty();
        preset_state.locked_out.insert(node);
        preset_state.locked_in.insert(node);

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&strategy_unconstrained(), &issue, &mut maze, &mut rng, &no_params(), &preset_state, &[]);
        assert!(matches!(result, RepairResult::Failed));
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

    fn two_node_passage_pattern() -> SplitPattern {
        // SquareFace order [N, S, E, W] — node 1 gets an East face (index 2), matching node 0's
        // real East neighbor.
        SplitPattern {
            node_count: 2,
            faces: vec![
                vec![],
                vec![SplitPatternFace { face_index: 2, requirement: SplitFaceRequirement::Passage, sibling_target: None }],
            ],
            weight: 1.0,
        }
    }

    #[test]
    fn pattern_mode_adds_a_split_tile_matching_the_configured_pattern() {
        // 3x3 field (not a bare 1-row line) so every candidate point has a real neighbor in every
        // direction — whichever rotation/mirror `plan_pattern_split` tries first, the pattern's
        // single East face (after transform) always lands on a real neighbor, never off-field
        // (a degenerate case `try_pattern_adaptation` accepts as "nothing to add" under
        // `allow_add`, unrelated to this fix, that would otherwise make this test's outcome
        // dependent on which rotation happens to be tried first). Every candidate point starts
        // fully isolated, so node 0's faces (empty, Wall on every side) match trivially and only
        // the claiming node's own face adds the new connection.
        let mut maze = maze_grid(3, 3);

        let strategy = AddSplitStrategy { config: SplitGenerationConfig { pattern_mode: true, max_split_nodes: 2, patterns: vec![two_node_passage_pattern()] }, protect_route: true };
        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(5);
        let nodes_before = maze.field.node_count();
        let result = apply_and_commit(&strategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.field.node_count(), nodes_before + 1);
        let split_point = (0..3).flat_map(|x| (0..3).map(move |y| SquarePoint { x, y }))
            .find(|&p| maze.field.nodes_at(p).len() > 1)
            .expect("exactly one point must have been split");
        let tile_nodes = maze.field.nodes_at(split_point);
        assert!(crate::quality_control::split_pattern_match::split_tile_matches_any(
            &maze.graph, &maze.field, tile_nodes, std::slice::from_ref(&two_node_passage_pattern()),
        ), "the resulting tile must structurally match the single configured pattern");
    }

    #[test]
    fn pick_weighted_pattern_respects_configured_weight_not_uniform() {
        // GitHub issue #275: `AddSplitStrategy` used to pick a pattern index uniformly, ignoring
        // `SplitPattern::weight` entirely. A near-zero-weight pattern must almost never be picked
        // against a heavily-weighted sibling.
        let low = SplitPattern { node_count: 2, faces: vec![vec![], vec![]], weight: 0.001 };
        let high = SplitPattern { node_count: 2, faces: vec![vec![], vec![]], weight: 999.0 };
        let patterns = vec![low, high];

        let mut low_picks = 0;
        for seed in 0..500 {
            let mut rng = MazeRng::seed_from_u64(seed);
            if pick_weighted_pattern(&patterns, &mut rng) == 0 {
                low_picks += 1;
            }
        }
        assert!(low_picks < 10, "low-weight pattern picked {low_picks}/500 times, expected near-zero under weighting");
    }

    #[test]
    fn pattern_mode_fails_when_no_pattern_can_ever_match_and_lose_is_forbidden() {
        // A fully-isolated point (no connections at all) can never satisfy a pattern requiring an
        // East passage without adding a new connection — with allow_add forbidden, every rotation
        // fails.
        let mut maze = maze_line(3);
        let strategy = AddSplitStrategy { config: SplitGenerationConfig { pattern_mode: true, max_split_nodes: 2, patterns: vec![two_node_passage_pattern()] }, protect_route: true };
        let mut overrides = std::collections::HashMap::new();
        overrides.insert(PARAM_ALLOW_ADD_CONNECTIONS.to_string(), "false".to_string());
        let params = build_params(<AddSplitStrategy as RepairStrategy<SquareTessellation, MissingSplitTilesIssue>>::params(&strategy), Some(&overrides));

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(9);
        let result = apply_and_commit(&strategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed), "no rotation of this pattern can match without adding a connection, which is forbidden here");
    }

    #[test]
    fn pattern_mode_never_produces_a_truncated_tile_when_a_required_face_points_off_field() {
        // A 1x1 field — every face of the only point points off-field, so a pattern requiring a
        // real Passage/OneWay connection can never structurally fit here no matter what
        // `allow_add_connections` says (there's nothing on the other side to connect to). The
        // strategy must fail this candidate outright rather than silently mint a tile missing the
        // required connection (the original bug: a pattern applied where it can't fit, producing
        // a truncated tile that doesn't match the pattern at all).
        let mut maze = maze_line(1);
        let strategy = AddSplitStrategy { config: SplitGenerationConfig { pattern_mode: true, max_split_nodes: 2, patterns: vec![two_node_passage_pattern()] }, protect_route: true };
        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&strategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed),
            "no rotation/mirror can satisfy an East-passage requirement on a field with no neighbors at all");
        assert_eq!(maze.field.node_count(), 1, "no split tile must be minted when the pattern can't structurally fit anywhere");
    }

    #[test]
    fn pattern_mode_rewires_slot0_itself_to_match_the_pattern_instead_of_leaving_it_untouched() {
        // 3x3 field (see `pattern_mode_adds_a_split_tile_matching_the_configured_pattern`'s own
        // comment for why a bare 1-row line risks a degenerate off-field candidate unrelated to
        // this fix). Every point along y=1 starts connected both West and East.
        // `two_node_passage_pattern`'s node 0 has empty faces (Wall on every side) — with slot-0
        // now resolved the same way as every other node, one of the two real connections is
        // dropped (allow_lose) rather than silently left in place on an untouched slot-0 (the
        // original bug: a resulting tile whose real slot-0 connections didn't match the pattern
        // at all).
        let mut maze = maze_grid(3, 3);
        let row: Vec<NodeId> = (0..3).map(|x| maze.field.node_at(SquarePoint { x, y: 1 }).unwrap()).collect();
        maze.graph.add_bidirectional_edge(row[0], row[1], EdgeKind::Basic);
        maze.graph.add_bidirectional_edge(row[1], row[2], EdgeKind::Basic);

        let strategy = AddSplitStrategy { config: SplitGenerationConfig { pattern_mode: true, max_split_nodes: 2, patterns: vec![two_node_passage_pattern()] }, protect_route: true };
        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(5);
        let result = apply_and_commit(&strategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        let split_point = (0..3).flat_map(|x| (0..3).map(move |y| SquarePoint { x, y }))
            .find(|&p| maze.field.nodes_at(p).len() > 1)
            .expect("exactly one point must have been split");
        let tile_nodes = maze.field.nodes_at(split_point);
        assert!(crate::quality_control::split_pattern_match::split_tile_matches_any(
            &maze.graph, &maze.field, tile_nodes, std::slice::from_ref(&two_node_passage_pattern()),
        ), "the resulting tile must structurally match the pattern, including its node-0/slot-0 requirements");
    }

    #[test]
    fn pattern_mode_never_leaves_a_stale_edge_referencing_the_old_slot0_id() {
        // Guards the neighbor-side edge cleanup specifically: after replacement, no edge anywhere
        // in the graph may still reference the old slot0 NodeId, in either direction.
        let mut maze = maze_grid(3, 3);
        let row: Vec<NodeId> = (0..3).map(|x| maze.field.node_at(SquarePoint { x, y: 1 }).unwrap()).collect();
        maze.graph.add_bidirectional_edge(row[0], row[1], EdgeKind::Basic);
        maze.graph.add_bidirectional_edge(row[1], row[2], EdgeKind::Basic);
        let all_nodes_before: Vec<NodeId> = maze.field.all_node_ids().collect();

        let strategy = AddSplitStrategy { config: SplitGenerationConfig { pattern_mode: true, max_split_nodes: 2, patterns: vec![two_node_passage_pattern()] }, protect_route: true };
        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(5);
        apply_and_commit(&strategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);

        let old_slot0 = *all_nodes_before.iter().find(|&&n| maze.field.point_of(n).is_none())
            .expect("exactly one pre-existing node must have been replaced");

        assert!(maze.field.point_of(old_slot0).is_none(), "old slot0 id must no longer resolve to a point");
        for other in maze.field.all_node_ids() {
            assert!(maze.graph.edge_between(old_slot0, other).is_none());
            assert!(maze.graph.edge_between(other, old_slot0).is_none());
        }
    }

    #[test]
    fn pattern_mode_reuses_a_neighbors_non_slot0_node_that_already_owns_the_connection() {
        // 3x3 field. The point at (0,1) is pre-split: its slot-0 has no connections, but its
        // second node (slot-1) already has a real East<->West edge to (1,1) — the candidate point.
        // Resolving `at`'s (1,1) West face (pattern index 3, rotation=0, no mirror) against this
        // neighbor must land on (0,1)'s slot-1 — the node that actually owns the connection in
        // that direction — not silently onto (0,1)'s unconnected slot-0.
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> = Field::new(square_rect(3, 3), &mut ids).unwrap();
        let west_point = SquarePoint { x: 0, y: 1 };
        let west_slot1 = field.add_node_at(west_point, &mut ids);
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let at = field.node_at(SquarePoint { x: 1, y: 1 }).unwrap();
        g.add_bidirectional_edge(west_slot1, at, EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let point = maze.field.point_of(at).unwrap();
        let pattern = SplitPattern {
            node_count: 2,
            faces: vec![
                vec![],
                vec![SplitPatternFace { face_index: 3, requirement: SplitFaceRequirement::Passage, sibling_target: None }],
            ],
            weight: 1.0,
        };
        let per_node = split_core::try_pattern_adaptation(&maze, at, point, &pattern, 0, None, true, true, None, &std::collections::HashSet::new())
            .expect("West face has a real neighbor, must resolve");

        let west_slot0 = maze.field.nodes_at(west_point)[0];
        assert!(!per_node[1].iter().any(|e| e.target == west_slot0),
            "must not wire the new node to the neighbor's unconnected slot-0");
        assert!(per_node[1].iter().any(|e| e.target == west_slot1),
            "must wire the new node to the neighbor's actual owning node (slot-1)");
    }
}
