use super::dead_end_priority::apply_src_mode;
use super::remaining_deficits::RemainingDeficits;
use super::split_core::{
    RequiredConnection, pick_weighted_pattern, plan_pattern_split, plan_unconstrained_split,
};
use super::standard_add_params::{self, attempts_limit, reserve_target, src_mode};
use crate::Maze;
use crate::generation::{PresetState, SplitGenerationConfig};
use crate::graph::route_protection::is_node_on_route;
use crate::ids::NodeId;
use crate::quality_control::{MissingLoopsIssue, RepairArea};
use crate::repair::command::{MutationCommand, SplitNodeEdgeDirection};
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::{Rng, RngCore};
use std::collections::HashSet;

pub const PARAM_PROTECT_ROUTE: &str = "protect_route";

const PROTECT_ROUTE_PARAM: StrategyParam = StrategyParam {
    id: PARAM_PROTECT_ROUTE,
    label: "Protect route",
    kind: StrategyParamKind::Bool { default: true },
};

static PARAMS: [StrategyParam; 4] = crate::add_strategy_params!(PROTECT_ROUTE_PARAM);

/// Handles `MISSING_LOOPS` — see GitHub issue #254, part of epic #246. Alternative to
/// `MissingLoopsRandomStrategy`'s plain new-edge seeding: instead of connecting a random
/// geometrically-adjacent pair directly, turns one side of the pair into a split tile, so the
/// bridge is carried by one of the tile's own nodes rather than being a bare new edge on an
/// otherwise-ordinary cell. As with `MissingLoopsRandomStrategy`, there is no attempt to verify the
/// new connection actually closes a cycle — it seeds a candidate bridge and expects a follow-up QC
/// pass to judge the result, same "seed and let QC re-check" contract.
///
/// Picks a random node (`src`) and a random geometric neighbor (`dst`) exactly like
/// `MissingLoopsRandomStrategy`, skipping a pair already connected (either direction) or already
/// attempted this call. `src` must additionally be split-eligible
/// (`generation::split_is_eligible` — not locked, not already multi-node) and, when
/// `protect_route` is enabled, not on the maze's current start->finish route
/// (`graph::route_protection::is_node_on_route`) — the same two gates `AddSplitStrategy` applies to
/// its own candidate points.
///
/// `src` is then replaced by a split tile (`MutationCommand::ReplacePointNodes`) built via the
/// shared `split_core` planner (see `Specs/repair.md`), always with `allow_lose`/`allow_add` both
/// forced `true` (unlike `AddSplitStrategy`, this strategy exposes no param for either choice) — it
/// freely rebuilds `src`'s other connections to fit the chosen pattern/rotation, dropping whichever
/// existing ones don't fit and adding whichever new ones do, rather than just dividing the
/// pre-existing connections between the new nodes as-is. On top of that, one hard constraint:
/// whichever new node ends up carrying the bridge to `dst` must have at least one more edge of its
/// own (a through-node, not a dead end) — drawn from `src`'s other connections if any land there,
/// otherwise a brand-new edge to any other free geometric neighbor of `src`. A candidate pair whose
/// split planning fails this way is simply abandoned in favor of a different pair — never retried
/// against the same `(src, dst)`.
///
/// Uses its own `SplitGenerationConfig` (pattern_mode/max_split_nodes/patterns), exactly like
/// `AddSplitStrategy` — independent of whichever check produced this issue.
///
/// `src_mode` (GitHub issue #254 follow-up, shared with `MissingLoopsRandomStrategy` via
/// `dead_end_priority`) — `dead_end_priority` orders the split-eligible/route-filtered candidate
/// pool so dead ends (nodes with exactly one distinct graph neighbor) are tried first, so a bridge
/// grows out from the maze's least-connected cells before an arbitrary one. Every other candidate
/// stays in the pool behind them (see GitHub issue #278's exhaustion-fallback audit — the original
/// version dropped them entirely, silently under-delivering once dead ends ran out), so exhausting
/// the dead ends falls through to the rest automatically. Default `random` reproduces the original
/// unconstrained-pool behavior exactly.
pub struct MissingLoopsSplitStrategy {
    pub config: SplitGenerationConfig,
}

impl<T: Tessellation> RepairStrategy<T, MissingLoopsIssue> for MissingLoopsSplitStrategy {
    fn strategy_id(&self) -> &'static str {
        "missing_loops_split"
    }

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

        let protect_route = match params.get(PARAM_PROTECT_ROUTE) {
            Some(StrategyParamValue::Bool(v)) => *v,
            _ => true,
        };
        let max_attempts = attempts_limit(params) as u32;
        let src_mode = src_mode(params);

        let mut attempted_pairs: HashSet<(NodeId, NodeId)> = HashSet::new();
        let mut commands = Vec::new();
        let mut split_points: HashSet<NodeId> = HashSet::new();
        let mut total_added = 0u32;

        let mut deficits = RemainingDeficits::new(&issue.missing);
        let areas: Vec<RepairArea> = deficits.areas().collect();
        for area in areas {
            let missing = deficits.live(area);
            if missing == 0 {
                continue;
            }
            let target = reserve_target(params, missing);

            let eligible: Vec<NodeId> = maze
                .field
                .all_node_ids()
                .filter(|&node| {
                    crate::generation::split_is_eligible(&maze.field, preset_state, node)
                })
                .filter(|&node| !protect_route || !is_node_on_route(maze, node))
                .filter(|&node| match area {
                    RepairArea::WholeMaze => true,
                    RepairArea::Level(level) => maze.field.level_of(node) == Some(level),
                })
                .collect();
            let mut pool = apply_src_mode(maze, eligible, src_mode, rng);

            let mut added = 0u32;
            let mut failed_attempts = 0u32;

            while added < target && failed_attempts < max_attempts && !pool.is_empty() {
                // Pop from the end, not a random index — `apply_src_mode` orders the pool so
                // dead-end candidates sit at this end when `dead_end_priority` is active (GitHub
                // issue #278's exhaustion-fallback fix); a random-index pick would destroy that
                // ordering. `src` always leaves the pool after this iteration regardless of outcome
                // (see the unconditional `swap_remove` below), so popping it up front changes nothing
                // about which candidates get tried, only the order.
                let src = pool
                    .pop()
                    .expect("pool.is_empty() already checked by the while condition");

                let mut neighbors = maze.field.neighbors(src);
                let mut planned = false;

                while !neighbors.is_empty() {
                    let n_pick = rng.random_range(0..neighbors.len());
                    let dst = neighbors.swap_remove(n_pick);

                    let already_connected = maze.graph.edge_between(src, dst).is_some()
                        || maze.graph.edge_between(dst, src).is_some()
                        || attempted_pairs.contains(&(src, dst));
                    // `dst` is a `SplitNodeEdge::target` in the command about to be proposed for
                    // `src` — resolved to this exact `NodeId` right now, not re-resolved at apply
                    // time. If `dst`'s own point already got a `ReplacePointNodes` command earlier in
                    // this same `apply()` call, that node no longer exists by the time commands are
                    // applied (`replace_point_nodes_feasible` requires `field.point_of(edge.target)`
                    // to still resolve) — the whole command would be silently declined. Skip any `dst`
                    // whose point is already split-committed this call, rather than propose a command
                    // guaranteed to be rejected.
                    let dst_already_split = maze
                        .field
                        .level_of(dst)
                        .zip(maze.field.point_of(dst))
                        .is_some_and(|(l, p)| {
                            maze.field
                                .nodes_at(l, p)
                                .iter()
                                .any(|n| split_points.contains(n))
                        });
                    if already_connected || dst_already_split {
                        continue;
                    }
                    attempted_pairs.insert((src, dst));

                    let required = RequiredConnection {
                        neighbor: dst,
                        direction: SplitNodeEdgeDirection::Passage,
                    };
                    if let Some(nodes) = self.plan_split(maze, src, &required, &split_points, rng) {
                        commands.push(MutationCommand::ReplacePointNodes { at: src, nodes });
                        split_points.insert(src);
                        added += 1;
                        deficits.consume(&[area, RepairArea::WholeMaze]);
                        planned = true;
                        break;
                    }
                }

                if !planned {
                    failed_attempts += 1;
                }
                // Either way `src` already left the pool via the `pop()` above — it's no longer
                // split-eligible once a successful command applies, and every one of its neighbors
                // was already tried this visit either way, mirroring `AddSplitStrategy`'s own
                // per-point once-only bookkeeping.
            }
            total_added += added;
        }

        if total_added == 0 {
            return (RepairResult::Failed, vec![]);
        }
        (RepairResult::Fixed { score: None }, commands)
    }
}

impl MissingLoopsSplitStrategy {
    /// Always plans with `allow_lose`/`allow_add` both `true` — unlike `AddSplitStrategy`, this
    /// strategy has no params exposing either choice: the whole point of the bridge is a *new*
    /// connection to `dst` (so `allow_add: false` would make every candidate fail outright), and a
    /// bridge tile freely dropping whichever of `at`'s other existing connections don't fit the
    /// chosen pattern/rotation is exactly the redistribution behavior wanted here.
    fn plan_split<T: Tessellation>(
        &self,
        maze: &Maze<T>,
        at: NodeId,
        required: &RequiredConnection,
        excluded: &HashSet<NodeId>,
        rng: &mut dyn RngCore,
    ) -> Option<Vec<Vec<crate::repair::command::SplitNodeEdge>>> {
        if self.config.patterns.is_empty() {
            let node_count = self.config.max_split_nodes.max(2) as usize;
            plan_unconstrained_split(maze, at, node_count, Some(required), excluded, rng)
        } else {
            let pattern_idx = pick_weighted_pattern(&self.config.patterns, rng);
            plan_pattern_split(
                maze,
                at,
                &self.config.patterns[pattern_idx],
                Some(required),
                excluded,
                rng,
                true,
                true,
            )
        }
    }
}

crate::impl_erased_repair_strategy!(MissingLoopsSplitStrategy, MissingLoopsIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::IdGenerator;
    use crate::graph::{EdgeKind, Graph};
    use crate::random::MazeRng;
    use crate::repair::params::build_params;
    use crate::repair::strategies::test_utils::apply_and_commit;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use rand::SeedableRng;

    fn no_params() -> StrategyParams {
        build_params(<MissingLoopsSplitStrategy as RepairStrategy<SquareTessellation, MissingLoopsIssue>>::params(&strategy_unconstrained()), None)
    }

    fn strategy_unconstrained() -> MissingLoopsSplitStrategy {
        MissingLoopsSplitStrategy {
            config: SplitGenerationConfig {
                pattern_mode: false,
                max_split_nodes: 2,
                patterns: vec![],
            },
        }
    }

    fn maze_grid(side: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(side, side), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        Maze::new(field, g)
    }

    fn missing_issue(missing: u32) -> MissingLoopsIssue {
        let entries = if missing == 0 {
            vec![]
        } else {
            vec![(RepairArea::WholeMaze, missing)]
        };
        MissingLoopsIssue::new_from_check("min_loops_count", entries)
    }

    #[test]
    fn apply_succeeds_immediately_when_nothing_missing() {
        let mut maze = maze_grid(3);
        let issue = missing_issue(0);
        let mut rng = MazeRng::seed_from_u64(7);
        let nodes_before = maze.field.node_count();
        let result = apply_and_commit(
            &strategy_unconstrained(),
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.field.node_count(), nodes_before);
    }

    #[test]
    fn apply_creates_a_split_tile_carrying_the_new_bridge() {
        let mut maze = maze_grid(4);
        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(3);
        let mut overrides = std::collections::HashMap::new();
        overrides.insert(
            crate::repair::strategies::standard_add_params::PARAM_RESERVE_PERCENT.to_string(),
            "0".to_string(),
        );
        let params =
            build_params(
                <MissingLoopsSplitStrategy as RepairStrategy<
                    SquareTessellation,
                    MissingLoopsIssue,
                >>::params(&strategy_unconstrained()),
                Some(&overrides),
            );
        let nodes_before = maze.field.node_count();
        let result = apply_and_commit(
            &strategy_unconstrained(),
            &issue,
            &mut maze,
            &mut rng,
            &params,
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(
            maze.field.node_count(),
            nodes_before + 1,
            "one split tile must be minted for the one missing loop"
        );
    }

    #[test]
    fn split_tile_bridge_node_has_at_least_two_edges() {
        // Every point starts fully isolated on a 4x4 grid, so the bridge-carrying node's second
        // edge must come from `pick_free_neighbor` (no pre-existing connections to redistribute).
        let mut maze = maze_grid(4);
        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(11);
        let mut overrides = std::collections::HashMap::new();
        overrides.insert(
            crate::repair::strategies::standard_add_params::PARAM_RESERVE_PERCENT.to_string(),
            "0".to_string(),
        );
        let params =
            build_params(
                <MissingLoopsSplitStrategy as RepairStrategy<
                    SquareTessellation,
                    MissingLoopsIssue,
                >>::params(&strategy_unconstrained()),
                Some(&overrides),
            );
        apply_and_commit(
            &strategy_unconstrained(),
            &issue,
            &mut maze,
            &mut rng,
            &params,
            &PresetState::empty(),
            &[],
        );

        let split_point = (0..4)
            .flat_map(|x| (0..4).map(move |y| SquarePoint { x, y }))
            .find(|&p| maze.field.nodes_at(maze.field.single_level_id(), p).len() > 1)
            .expect("exactly one point must have been split");
        let tile_nodes = maze
            .field
            .nodes_at(maze.field.single_level_id(), split_point);
        let bridge_node = tile_nodes
            .iter()
            .find(|&&n| {
                maze.graph
                    .outgoing_neighbors(n)
                    .chain(maze.graph.incoming_neighbors(n))
                    .any(|nb| maze.field.point_of(nb) != Some(split_point))
            })
            .expect("one node must carry the outside bridge");
        let degree = maze
            .graph
            .outgoing_neighbors(*bridge_node)
            .chain(maze.graph.incoming_neighbors(*bridge_node))
            .count();
        assert!(
            degree >= 2,
            "bridge-carrying node must not be a dead end, got degree {degree}"
        );
    }

    #[test]
    fn apply_never_targets_a_point_already_split_earlier_in_the_same_call() {
        // Dense 3x3 grid, several missing loops in one call: a candidate's `dst` must never be a
        // point that an earlier command in this same batch already turned into a split tile —
        // that node id would no longer exist by apply time (`ReplacePointNodes` is all-or-nothing
        // on stale edge targets), silently dropping the whole command instead of minting a tile.
        let mut maze = maze_grid(3);
        let issue = missing_issue(4);
        let mut rng = MazeRng::seed_from_u64(17);
        let mut overrides = std::collections::HashMap::new();
        overrides.insert(
            crate::repair::strategies::standard_add_params::PARAM_RESERVE_PERCENT.to_string(),
            "0".to_string(),
        );
        let params =
            build_params(
                <MissingLoopsSplitStrategy as RepairStrategy<
                    SquareTessellation,
                    MissingLoopsIssue,
                >>::params(&strategy_unconstrained()),
                Some(&overrides),
            );
        let nodes_before = maze.field.node_count();

        let (result, commands) = strategy_unconstrained().apply(
            &issue,
            &maze,
            &mut rng,
            &params,
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        crate::quality_control::apply_commands::apply_commands(
            &mut maze,
            &PresetState::empty(),
            commands.clone(),
            None,
            None,
        );

        let proposed = commands.len();
        let actually_split = maze.field.node_count() - nodes_before;
        assert_eq!(
            actually_split, proposed,
            "every proposed split must actually apply — none silently dropped for targeting an already-split neighbor"
        );
    }

    #[test]
    fn src_mode_dead_end_priority_only_splits_a_dead_end() {
        // 4x4 grid with a single bidirectional passage between two nodes (both dead ends, degree
        // 1) — every other point is fully isolated (degree 0, not a dead end). With
        // `dead_end_priority`, the split candidate (`at`) must always be one of the two passage
        // endpoints.
        let mut maze = maze_grid(4);
        let coords: Vec<SquarePoint> = (0..4)
            .flat_map(|x| (0..4).map(move |y| SquarePoint { x, y }))
            .collect();
        let nodes: Vec<NodeId> = coords
            .iter()
            .map(|&p| maze.field.node_at(maze.field.single_level_id(), p).unwrap())
            .collect();
        maze.graph
            .add_bidirectional_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let dead_end_points = [coords[0], coords[1]];

        let issue = missing_issue(1);
        let mut overrides = std::collections::HashMap::new();
        overrides.insert(
            crate::repair::strategies::standard_add_params::PARAM_RESERVE_PERCENT.to_string(),
            "0".to_string(),
        );
        overrides.insert("src_mode".to_string(), "dead_end_priority".to_string());
        let params =
            build_params(
                <MissingLoopsSplitStrategy as RepairStrategy<
                    SquareTessellation,
                    MissingLoopsIssue,
                >>::params(&strategy_unconstrained()),
                Some(&overrides),
            );
        let mut rng = MazeRng::seed_from_u64(2);
        let result = apply_and_commit(
            &strategy_unconstrained(),
            &issue,
            &mut maze,
            &mut rng,
            &params,
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        let split_point = coords
            .iter()
            .copied()
            .find(|&p| maze.field.nodes_at(maze.field.single_level_id(), p).len() > 1)
            .expect("exactly one point must have been split");
        assert!(
            dead_end_points.contains(&split_point),
            "split must land on one of the two dead-end points, got {split_point:?}"
        );
    }

    #[test]
    fn apply_creates_a_split_tile_matching_the_configured_pattern() {
        // Regression coverage for the pattern-mode `allow_lose`/`allow_add` bug fixed earlier in
        // this strategy's development: `plan_split` must actually pass `true, true` through to
        // `plan_pattern_split`, not silently read unregistered params as `None`/`false` and reject
        // every candidate outright.
        use crate::generation::{SplitFaceRequirement, SplitPattern, SplitPatternFace};
        let pattern = SplitPattern {
            node_count: 2,
            faces: vec![
                vec![],
                vec![
                    SplitPatternFace {
                        face_index: 2,
                        requirement: SplitFaceRequirement::Passage,
                        sibling_target: None,
                    },
                    SplitPatternFace {
                        face_index: 0,
                        requirement: SplitFaceRequirement::Passage,
                        sibling_target: None,
                    },
                ],
            ],
            weight: 1.0,
        };
        let strategy = MissingLoopsSplitStrategy {
            config: SplitGenerationConfig {
                pattern_mode: true,
                max_split_nodes: 2,
                patterns: vec![pattern],
            },
        };
        let mut maze = maze_grid(4);
        let issue = missing_issue(1);
        let mut overrides = std::collections::HashMap::new();
        overrides.insert(
            crate::repair::strategies::standard_add_params::PARAM_RESERVE_PERCENT.to_string(),
            "0".to_string(),
        );
        let params =
            build_params(
                <MissingLoopsSplitStrategy as RepairStrategy<
                    SquareTessellation,
                    MissingLoopsIssue,
                >>::params(&strategy),
                Some(&overrides),
            );
        let mut rng = MazeRng::seed_from_u64(5);
        let nodes_before = maze.field.node_count();
        let result = apply_and_commit(
            &strategy,
            &issue,
            &mut maze,
            &mut rng,
            &params,
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(
            maze.field.node_count(),
            nodes_before + 1,
            "pattern mode must actually mint the split tile, not fail every candidate"
        );
    }

    #[test]
    fn apply_fails_when_no_split_eligible_candidate_exists() {
        let mut maze = maze_grid(1);
        let node = maze
            .field
            .node_at(maze.field.single_level_id(), SquarePoint { x: 0, y: 0 })
            .unwrap();
        let mut preset_state = PresetState::empty();
        preset_state.locked_out.insert(node);
        preset_state.locked_in.insert(node);

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &strategy_unconstrained(),
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &preset_state,
            &[],
        );
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_restricts_candidates_to_the_named_level() {
        let mut ids = IdGenerator::new();
        let field_a = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
        let field_b = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new([field_a]);
        let level_b = mf.add_level(field_b);
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let mut maze: Maze<SquareTessellation> = Maze::new(mf, g);
        let nodes_before = maze.field.node_count();

        let issue = MissingLoopsIssue::new_from_check(
            "min_loops_count",
            vec![(RepairArea::Level(level_b), 1)],
        );
        let mut overrides = std::collections::HashMap::new();
        overrides.insert(
            crate::repair::strategies::standard_add_params::PARAM_RESERVE_PERCENT.to_string(),
            "0".to_string(),
        );
        let params =
            build_params(
                <MissingLoopsSplitStrategy as RepairStrategy<
                    SquareTessellation,
                    MissingLoopsIssue,
                >>::params(&strategy_unconstrained()),
                Some(&overrides),
            );
        let mut rng = MazeRng::seed_from_u64(11);
        let result = apply_and_commit(
            &strategy_unconstrained(),
            &issue,
            &mut maze,
            &mut rng,
            &params,
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.field.node_count(), nodes_before + 1);
        let split_points: std::collections::HashSet<_> = maze.field.split_points().collect();
        assert_eq!(split_points.len(), 1);
        assert_eq!(
            split_points.iter().next().unwrap().0,
            level_b,
            "the split tile must land on the reported level"
        );
    }

    #[test]
    fn apply_does_not_double_count_a_whole_maze_entry_already_satisfied_by_per_floor_entries() {
        // GitHub issue #369 follow-up: a per-floor deficit and a whole-maze deficit on the same
        // rule both land in one issue's `missing` — the whole-maze entry is the same requirement
        // measured differently, not independent on top. 1 per floor on 3 floors + 3 whole-maze
        // must add 3 split tiles total, not 6.
        let mut ids = IdGenerator::new();
        let field_a = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
        let field_b = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
        let field_c = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new([field_a]);
        let level_b = mf.add_level(field_b);
        let level_c = mf.add_level(field_c);
        let level_a = mf.levels_ordered().next().unwrap();
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let mut maze: Maze<SquareTessellation> = Maze::new(mf, g);
        let nodes_before = maze.field.node_count();

        let issue = MissingLoopsIssue::new_from_check(
            "min_loops_count",
            vec![
                (RepairArea::Level(level_a), 1),
                (RepairArea::Level(level_b), 1),
                (RepairArea::Level(level_c), 1),
                (RepairArea::WholeMaze, 3),
            ],
        );
        let mut overrides = std::collections::HashMap::new();
        overrides.insert(
            crate::repair::strategies::standard_add_params::PARAM_RESERVE_PERCENT.to_string(),
            "0".to_string(),
        );
        let params =
            build_params(
                <MissingLoopsSplitStrategy as RepairStrategy<
                    SquareTessellation,
                    MissingLoopsIssue,
                >>::params(&strategy_unconstrained()),
                Some(&overrides),
            );
        let mut rng = MazeRng::seed_from_u64(11);
        let result = apply_and_commit(
            &strategy_unconstrained(),
            &issue,
            &mut maze,
            &mut rng,
            &params,
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(
            maze.field.node_count(),
            nodes_before + 3,
            "3 split tiles total, not 6"
        );
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let issue = missing_issue(1);
        let mut overrides = std::collections::HashMap::new();
        overrides.insert(
            crate::repair::strategies::standard_add_params::PARAM_RESERVE_PERCENT.to_string(),
            "0".to_string(),
        );
        let params =
            build_params(
                <MissingLoopsSplitStrategy as RepairStrategy<
                    SquareTessellation,
                    MissingLoopsIssue,
                >>::params(&strategy_unconstrained()),
                Some(&overrides),
            );

        let mut maze_a = maze_grid(4);
        let mut rng_a = MazeRng::seed_from_u64(123);
        apply_and_commit(
            &strategy_unconstrained(),
            &issue,
            &mut maze_a,
            &mut rng_a,
            &params,
            &PresetState::empty(),
            &[],
        );

        let mut maze_b = maze_grid(4);
        let mut rng_b = MazeRng::seed_from_u64(123);
        apply_and_commit(
            &strategy_unconstrained(),
            &issue,
            &mut maze_b,
            &mut rng_b,
            &params,
            &PresetState::empty(),
            &[],
        );

        assert_eq!(maze_a.field.node_count(), maze_b.field.node_count());
    }
}
