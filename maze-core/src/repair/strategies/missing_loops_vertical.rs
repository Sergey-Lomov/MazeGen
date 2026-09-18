use super::dead_end_priority::apply_src_mode;
use super::remaining_deficits::RemainingDeficits;
use super::standard_add_params::{self, attempts_limit, reserve_target, src_mode};
use super::vertical_target::{DirectionConstraint, resolve_vertical_target};
use crate::Maze;
use crate::generation::PresetState;
use crate::ids::NodeId;
use crate::quality_control::{MissingLoopsIssue, RepairArea};
use crate::repair::command::MutationCommand;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::{Rng, RngCore};
use std::collections::HashSet;

pub const PARAM_ONE_WAY_CHANCE: &str = "vertical_loop_one_way_chance";
pub const PARAM_DIRECTION_BALANCE: &str = "vertical_direction_balance";

const ONE_WAY_CHANCE_PARAM: StrategyParam = StrategyParam {
    id: PARAM_ONE_WAY_CHANCE,
    label: "Loop one-way chance",
    kind: StrategyParamKind::Float {
        default: 0.0,
        min: 0.0,
        max: 100.0,
    },
};
const DIRECTION_BALANCE_PARAM: StrategyParam = StrategyParam {
    id: PARAM_DIRECTION_BALANCE,
    label: "Direction balance",
    kind: StrategyParamKind::Float {
        default: 0.5,
        min: 0.0,
        max: 1.0,
    },
};

static PARAMS: [StrategyParam; 5] =
    crate::add_strategy_params!(ONE_WAY_CHANCE_PARAM, DIRECTION_BALANCE_PARAM);

/// Handles `MISSING_LOOPS` via a `VerticalPassage` edge instead of an ordinary geometric/teleport
/// one — see GitHub issue #393. Mirrors `MissingLoopsRandomStrategy`'s own random-seed approach
/// (same params, same meaning) except the candidate pair is resolved through
/// `vertical_target::resolve_vertical_target` (shared with `AddVerticalPassageStrategy`), so the
/// second endpoint is always the same point on an adjacent floor rather than a same-floor
/// neighbor. `reserve_percent`/`src_mode`/`attempts_limit` are the shared standard add-strategy
/// params (GitHub issue #486) with the unified defaults (`reserve_percent` 0.0, `attempts_limit`
/// 25).
pub struct MissingLoopsVerticalStrategy;

impl<T: Tessellation> RepairStrategy<T, MissingLoopsIssue> for MissingLoopsVerticalStrategy {
    fn strategy_id(&self) -> &'static str {
        "missing_loops_vertical"
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

        let one_way_chance = params
            .get(PARAM_ONE_WAY_CHANCE)
            .and_then(|v| v.as_float())
            .unwrap_or(0.0)
            / 100.0;
        let direction_balance = params
            .get(PARAM_DIRECTION_BALANCE)
            .and_then(|v| v.as_float())
            .unwrap_or(0.5);
        let src_mode = src_mode(params);
        let max_failed_attempts = attempts_limit(params);

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

            let candidates: Vec<NodeId> = maze
                .field
                .all_node_ids()
                .filter(|&n| match area {
                    RepairArea::WholeMaze => true,
                    RepairArea::Level(level) => maze.field.level_of(n) == Some(level),
                })
                .collect();
            let mut pool: Vec<NodeId> = apply_src_mode(maze, candidates, src_mode, rng);
            let mut added: u32 = 0;
            let mut failed_attempts: usize = 0;

            while added < target && !pool.is_empty() && failed_attempts < max_failed_attempts {
                let src = pool
                    .pop()
                    .expect("pool.is_empty() already checked by the while condition");

                let Some((from, to)) = resolve_vertical_target(
                    maze,
                    src,
                    rng,
                    &DirectionConstraint::Either,
                    direction_balance,
                ) else {
                    failed_attempts += 1;
                    continue;
                };

                let already_connected = maze.graph.edge_between(from, to).is_some()
                    || maze.graph.edge_between(to, from).is_some()
                    || proposed_pairs.contains(&(from, to))
                    || proposed_pairs.contains(&(to, from));
                if already_connected {
                    failed_attempts += 1;
                    continue;
                }

                if rng.random::<f64>() < one_way_chance {
                    let forward = rng.random::<bool>();
                    let (edge_from, edge_to) = if forward { (from, to) } else { (to, from) };
                    if !crate::generation::directed_edge_feasible(preset_state, edge_from, edge_to)
                    {
                        failed_attempts += 1;
                        continue;
                    }
                    commands.push(MutationCommand::AddDirectedVerticalPassage {
                        from: edge_from,
                        to: edge_to,
                    });
                } else {
                    if !crate::generation::bidirectional_edge_feasible(preset_state, from, to) {
                        failed_attempts += 1;
                        continue;
                    }
                    commands
                        .push(MutationCommand::AddBidirectionalVerticalPassage { a: from, b: to });
                }
                proposed_pairs.insert((from, to));
                added += 1;

                let mut covered = vec![RepairArea::WholeMaze];
                if let Some(src_level) = maze.field.level_of(src) {
                    covered.push(RepairArea::Level(src_level));
                }
                deficits.consume(&covered);
            }
            total_added += added;
        }

        if total_added == 0 {
            return (RepairResult::Failed, vec![]);
        }
        (RepairResult::Fixed { score: None }, commands)
    }
}

crate::impl_erased_repair_strategy!(MissingLoopsVerticalStrategy, MissingLoopsIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::IdGenerator;
    use crate::graph::{EdgeKind, Graph};
    use crate::random::MazeRng;
    use crate::repair::params::build_params;
    use crate::repair::strategies::test_utils::apply_and_commit;
    use crate::space::{MultiLevelField, SquareTessellation, square_rect};
    use rand::SeedableRng;
    use std::collections::HashMap;

    fn no_params() -> StrategyParams {
        build_params(
            <MissingLoopsVerticalStrategy as RepairStrategy<
                SquareTessellation,
                MissingLoopsIssue,
            >>::params(&MissingLoopsVerticalStrategy),
            None,
        )
    }

    fn two_level_maze(side: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field_a = crate::space::Field::new(square_rect(side, side), &mut ids).unwrap();
        let field_b = crate::space::Field::new(square_rect(side, side), &mut ids).unwrap();
        let mf: MultiLevelField<SquareTessellation> = MultiLevelField::new([field_a, field_b]);
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        Maze::new(mf, g)
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
        let mut maze = two_level_maze(3);
        let issue = missing_issue(0);
        let mut rng = MazeRng::seed_from_u64(7);
        let result = apply_and_commit(
            &MissingLoopsVerticalStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.edges().count(), 0);
    }

    #[test]
    fn apply_adds_vertical_passage_edges() {
        let mut maze = two_level_maze(4);
        let issue = missing_issue(2);
        let mut rng = MazeRng::seed_from_u64(42);
        let result = apply_and_commit(
            &MissingLoopsVerticalStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edges().count() > 0);
        assert!(
            maze.graph
                .edges()
                .all(|e| e.kind == EdgeKind::VerticalPassage)
        );
        for edge in maze.graph.edges() {
            let from_level = maze.field.level_of(edge.from);
            let to_level = maze.field.level_of(edge.to);
            assert_ne!(
                from_level, to_level,
                "a vertical passage must connect two different floors"
            );
            assert_eq!(
                maze.field.point_of(edge.from),
                maze.field.point_of(edge.to),
                "a vertical passage must connect the same x-y point across floors"
            );
        }
    }

    #[test]
    fn apply_fails_on_single_level_field() {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(3, 3), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &MissingLoopsVerticalStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Failed));
        assert_eq!(maze.graph.edges().count(), 0);
    }

    #[test]
    fn reserve_percent_defaults_to_zero() {
        let mut maze = two_level_maze(4);
        let issue = missing_issue(2);
        let mut rng = MazeRng::seed_from_u64(42);
        let result = apply_and_commit(
            &MissingLoopsVerticalStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        // 2 missing * (1 + 0%) = 2 connections, each bidirectional => 4 edges.
        assert_eq!(maze.graph.edges().count(), 4);
    }

    #[test]
    fn reserve_percent_override_changes_target_connection_count() {
        let mut maze = two_level_maze(4);
        let issue = missing_issue(2);
        let mut overrides = HashMap::new();
        overrides.insert(
            crate::repair::strategies::standard_add_params::PARAM_RESERVE_PERCENT.to_string(),
            "50".to_string(),
        );
        let params = build_params(
            <MissingLoopsVerticalStrategy as RepairStrategy<
                SquareTessellation,
                MissingLoopsIssue,
            >>::params(&MissingLoopsVerticalStrategy),
            Some(&overrides),
        );
        let mut rng = MazeRng::seed_from_u64(42);
        let result = apply_and_commit(
            &MissingLoopsVerticalStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &params,
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        // 2 missing * (1 + 50%) = 3 connections => 6 edges.
        assert_eq!(maze.graph.edges().count(), 6);
    }

    #[test]
    fn one_way_chance_100_adds_only_directed_edges() {
        let mut maze = two_level_maze(4);
        let issue = missing_issue(2);
        let mut overrides = HashMap::new();
        overrides.insert(PARAM_ONE_WAY_CHANCE.to_string(), "100".to_string());
        let params = build_params(
            <MissingLoopsVerticalStrategy as RepairStrategy<
                SquareTessellation,
                MissingLoopsIssue,
            >>::params(&MissingLoopsVerticalStrategy),
            Some(&overrides),
        );
        let mut rng = MazeRng::seed_from_u64(42);
        let result = apply_and_commit(
            &MissingLoopsVerticalStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &params,
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.edges().count(), 2);
        for edge in maze.graph.edges() {
            assert!(
                maze.graph.edge_between(edge.to, edge.from).is_none(),
                "loop_one_way_chance: 100 must never add a reverse"
            );
        }
    }

    #[test]
    fn apply_does_not_duplicate_an_existing_edge() {
        let mut maze = two_level_maze(1);
        let bottom = maze.field.levels_ordered().next().unwrap();
        let top = maze.field.levels_ordered().last().unwrap();
        let b0 = maze
            .field
            .node_at(bottom, crate::space::SquarePoint { x: 0, y: 0 })
            .unwrap();
        let t0 = maze
            .field
            .node_at(top, crate::space::SquarePoint { x: 0, y: 0 })
            .unwrap();
        maze.graph
            .add_bidirectional_edge(b0, t0, EdgeKind::VerticalPassage);

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &MissingLoopsVerticalStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Failed));
        assert_eq!(maze.graph.edges().count(), 2);
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let issue = missing_issue(2);

        let mut maze_a = two_level_maze(4);
        let mut rng_a = MazeRng::seed_from_u64(123);
        apply_and_commit(
            &MissingLoopsVerticalStrategy,
            &issue,
            &mut maze_a,
            &mut rng_a,
            &no_params(),
            &PresetState::empty(),
            &[],
        );

        let mut maze_b = two_level_maze(4);
        let mut rng_b = MazeRng::seed_from_u64(123);
        apply_and_commit(
            &MissingLoopsVerticalStrategy,
            &issue,
            &mut maze_b,
            &mut rng_b,
            &no_params(),
            &PresetState::empty(),
            &[],
        );

        let edges_a: Vec<_> = maze_a.graph.edges().map(|e| (e.from, e.to)).collect();
        let edges_b: Vec<_> = maze_b.graph.edges().map(|e| (e.from, e.to)).collect();
        assert_eq!(edges_a, edges_b);
    }
}
