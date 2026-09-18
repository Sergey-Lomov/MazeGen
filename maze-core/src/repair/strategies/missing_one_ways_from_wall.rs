use super::missing_one_ways_shared::{ProposedPairs, canonical_pair, pick_random_pairs};
use super::remaining_deficits::RemainingDeficits;
use super::standard_add_params::{attempts_limit, reserve_target, src_mode};
use crate::Maze;
use crate::generation::PresetState;
use crate::generation::cmd_add_directed_edge;
use crate::quality_control::MissingOneWaysIssue;
use crate::quality_control::RepairArea;
use crate::repair::command::MutationCommand;
use crate::repair::params::{StrategyParam, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::{Rng, RngCore};

static PARAMS: [StrategyParam; 3] = crate::add_strategy_params!();

/// Handles `MISSING_ONE_WAYS` — one of the two registered strategies (see
/// `MissingOneWaysFromPassageStrategy` for the other) — see GitHub issue #201. Picks random pairs
/// of adjacent field cells that are entirely disconnected (a wall) and adds a single directed
/// `Basic` edge between them at random, turning the wall into a one-way. No route protection
/// needed — unlike an existing passage, a wall was never part of any start->finish route.
pub struct MissingOneWaysFromWallStrategy;

impl<T: Tessellation> RepairStrategy<T, MissingOneWaysIssue> for MissingOneWaysFromWallStrategy {
    fn strategy_id(&self) -> &'static str {
        "missing_one_ways_from_wall"
    }

    fn params(&self) -> &'static [StrategyParam] {
        &PARAMS
    }

    fn nested_suppressed_params(&self) -> &'static [&'static str] {
        super::standard_add_params::NESTED_SUPPRESSED_ADD_PARAMS
    }

    fn apply(
        &self,
        issue: &MissingOneWaysIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        if issue.missing.is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let src_mode = src_mode(params);
        let max_failed_attempts = attempts_limit(params);

        let mut proposed: ProposedPairs = ProposedPairs::default();
        let mut commands = Vec::new();
        let mut total_found: u32 = 0;

        let mut deficits = RemainingDeficits::new(&issue.missing);
        let areas: Vec<RepairArea> = deficits.areas().collect();
        for area in areas {
            let missing = deficits.live(area);
            if missing == 0 {
                continue;
            }
            let target = reserve_target(params, missing);
            let found = pick_random_pairs(
                maze,
                rng,
                target,
                area,
                src_mode,
                max_failed_attempts,
                |src, dst, rng| {
                    if proposed.contains(&canonical_pair(src, dst)) {
                        return false;
                    }
                    // A wall: no edge of any kind in either direction between the pair.
                    if maze.graph.edge_between(src, dst).is_some()
                        || maze.graph.edge_between(dst, src).is_some()
                    {
                        return false;
                    }

                    proposed.insert(canonical_pair(src, dst));
                    let fwd_cmds = cmd_add_directed_edge(src, dst, preset_state);
                    let bwd_cmds = cmd_add_directed_edge(dst, src, preset_state);
                    let cmds = if !fwd_cmds.is_empty() && !bwd_cmds.is_empty() {
                        if rng.random::<bool>() {
                            fwd_cmds
                        } else {
                            bwd_cmds
                        }
                    } else if !fwd_cmds.is_empty() {
                        fwd_cmds
                    } else if !bwd_cmds.is_empty() {
                        bwd_cmds
                    } else {
                        return false;
                    };
                    commands.extend(cmds);
                    true
                },
            );
            deficits.consume_many(area, found);
            total_found += found;
        }

        if total_found == 0 {
            return (RepairResult::Failed, vec![]);
        }
        (RepairResult::Fixed { score: None }, commands)
    }
}

crate::impl_erased_repair_strategy!(MissingOneWaysFromWallStrategy, MissingOneWaysIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::IdGenerator;
    use crate::graph::{EdgeKind, Graph};
    use crate::quality_control::RepairArea;
    use crate::random::MazeRng;
    use crate::repair::strategies::test_utils::{apply_and_commit, apply_and_commit_default};
    use crate::space::{MultiLevelField, SquareTessellation, square_rect};
    use rand::SeedableRng;

    fn missing_issue(missing: u32) -> MissingOneWaysIssue {
        let entries = if missing == 0 {
            vec![]
        } else {
            vec![(RepairArea::WholeMaze, missing)]
        };
        MissingOneWaysIssue::new_from_check("min_one_way_count", entries)
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

    #[test]
    fn apply_succeeds_immediately_when_nothing_missing() {
        let mut maze = maze_grid(3);
        let issue = missing_issue(0);
        let mut rng = MazeRng::seed_from_u64(7);
        let result = apply_and_commit_default(
            &MissingOneWaysFromWallStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &PresetState::empty(),
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.edges().count(), 0);
    }

    #[test]
    fn apply_adds_one_way_edges_between_walled_pairs() {
        let mut maze = maze_grid(4);
        let issue = missing_issue(2);
        let mut rng = MazeRng::seed_from_u64(42);
        let result = apply_and_commit_default(
            &MissingOneWaysFromWallStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &PresetState::empty(),
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.edges().count(), 2);
        for edge in maze.graph.edges() {
            assert_eq!(edge.kind, EdgeKind::Basic);
            assert!(
                maze.graph.edge_between(edge.to, edge.from).is_none(),
                "each added edge must be one-way"
            );
        }
    }

    #[test]
    fn apply_does_not_pick_an_already_connected_pair() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_points()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        g.add_bidirectional_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit_default(
            &MissingOneWaysFromWallStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &PresetState::empty(),
        );
        assert!(
            matches!(result, RepairResult::Failed),
            "only pair on the field is already connected"
        );
        assert_eq!(maze.graph.edges().count(), 2);
    }

    #[test]
    fn apply_does_not_add_when_both_directions_locked() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_points()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((nodes[0], nodes[1]));
        preset_state.blocked.insert((nodes[1], nodes[0]));

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit_default(
            &MissingOneWaysFromWallStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &preset_state,
        );
        assert!(matches!(result, RepairResult::Failed));
        assert_eq!(maze.graph.edges().count(), 0);
    }

    #[test]
    fn apply_uses_the_only_free_direction_when_one_is_locked() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_points()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((nodes[0], nodes[1]));

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit_default(
            &MissingOneWaysFromWallStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &preset_state,
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(
            maze.graph.edge_between(nodes[1], nodes[0]).is_some(),
            "must use the only unblocked direction"
        );
        assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_none());
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

        let issue = MissingOneWaysIssue::new_from_check(
            "min_one_way_count",
            vec![(RepairArea::Level(level_b), 2)],
        );
        let mut rng = MazeRng::seed_from_u64(42);
        let result = apply_and_commit_default(
            &MissingOneWaysFromWallStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &PresetState::empty(),
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edges().count() > 0);
        for edge in maze.graph.edges() {
            assert_eq!(maze.field.level_of(edge.from), Some(level_b));
            assert_eq!(maze.field.level_of(edge.to), Some(level_b));
        }
    }

    #[test]
    fn apply_does_not_double_count_a_whole_maze_entry_already_satisfied_by_per_floor_entries() {
        // GitHub issue #369 follow-up: per-floor + whole-maze entries on the same rule must not
        // stack — 1 per floor on 3 floors + 3 whole-maze must add 3 edges total, not 6.
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

        let issue = MissingOneWaysIssue::new_from_check(
            "min_one_way_count",
            vec![
                (RepairArea::Level(level_a), 1),
                (RepairArea::Level(level_b), 1),
                (RepairArea::Level(level_c), 1),
                (RepairArea::WholeMaze, 3),
            ],
        );
        let mut rng = MazeRng::seed_from_u64(11);
        let result = apply_and_commit_default(
            &MissingOneWaysFromWallStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &PresetState::empty(),
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.edges().count(), 3, "3 edges total, not 6");
    }

    #[test]
    fn reserve_percent_override_increases_the_target() {
        use crate::repair::params::build_params;
        use std::collections::HashMap;
        let mut maze = maze_grid(4);
        let issue = missing_issue(2);
        let overrides = HashMap::from([("reserve_percent".to_string(), "100".to_string())]);
        let params = build_params(
            <MissingOneWaysFromWallStrategy as RepairStrategy<
                SquareTessellation,
                MissingOneWaysIssue,
            >>::params(&MissingOneWaysFromWallStrategy),
            Some(&overrides),
        );
        let mut rng = MazeRng::seed_from_u64(42);
        let result = apply_and_commit(
            &MissingOneWaysFromWallStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &params,
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        // 2 * (1 + 100%) = 4 one-way edges, vs 2 with the unified 0 default.
        assert_eq!(maze.graph.edges().count(), 4);
    }

    #[test]
    fn src_mode_dead_end_priority_prefers_dead_end_sources() {
        use crate::repair::params::build_params;
        use crate::space::SquarePoint;
        use std::collections::HashMap;
        // 4x4 grid, one existing bidirectional passage: its two endpoints are the only dead ends.
        let mut maze = maze_grid(4);
        let n = |x: i32, y: i32| {
            maze.field
                .node_at(maze.field.single_level_id(), SquarePoint { x, y })
                .unwrap()
        };
        let (d0, d1) = (n(0, 0), n(1, 0));
        maze.graph.add_bidirectional_edge(d0, d1, EdgeKind::Basic);
        let dead_ends = [d0, d1];

        let issue = missing_issue(1);
        let overrides = HashMap::from([("src_mode".to_string(), "dead_end_priority".to_string())]);
        let params = build_params(
            <MissingOneWaysFromWallStrategy as RepairStrategy<
                SquareTessellation,
                MissingOneWaysIssue,
            >>::params(&MissingOneWaysFromWallStrategy),
            Some(&overrides),
        );
        let mut rng = MazeRng::seed_from_u64(5);
        let result = apply_and_commit(
            &MissingOneWaysFromWallStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &params,
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let new_edges: Vec<_> = maze
            .graph
            .edges()
            .filter(|e| !(dead_ends.contains(&e.from) && dead_ends.contains(&e.to)))
            .collect();
        assert!(!new_edges.is_empty());
        for e in &new_edges {
            assert!(
                dead_ends.contains(&e.from) || dead_ends.contains(&e.to),
                "new one-way must grow from a dead end"
            );
        }
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let issue = missing_issue(2);

        let mut maze_a = maze_grid(4);
        let mut rng_a = MazeRng::seed_from_u64(123);
        apply_and_commit_default(
            &MissingOneWaysFromWallStrategy,
            &issue,
            &mut maze_a,
            &mut rng_a,
            &PresetState::empty(),
        );

        let mut maze_b = maze_grid(4);
        let mut rng_b = MazeRng::seed_from_u64(123);
        apply_and_commit_default(
            &MissingOneWaysFromWallStrategy,
            &issue,
            &mut maze_b,
            &mut rng_b,
            &PresetState::empty(),
        );

        let edges_a: Vec<_> = maze_a.graph.edges().map(|e| (e.from, e.to)).collect();
        let edges_b: Vec<_> = maze_b.graph.edges().map(|e| (e.from, e.to)).collect();
        assert_eq!(edges_a, edges_b);
    }
}
