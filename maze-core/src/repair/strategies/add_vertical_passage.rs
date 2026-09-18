use super::pool::Pool;
use super::remaining_deficits::RemainingDeficits;
use super::standard_add_params::{self, attempts_limit, reserve_target, src_mode};
use super::vertical_target::{DirectionConstraint, resolve_vertical_target};
use crate::Maze;
use crate::generation::PresetState;
use crate::ids::NodeId;
use crate::quality_control::{MissingVerticalPassagesIssue, RepairArea, VerticalPassageType};
use crate::repair::command::MutationCommand;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::{Rng, RngCore};

pub const PARAM_ONE_WAY_BALANCE: &str = "one_way_balance";
pub const PARAM_DIRECTION_BALANCE: &str = "direction_balance";

const ONE_WAY_BALANCE_PARAM: StrategyParam = StrategyParam {
    id: PARAM_ONE_WAY_BALANCE,
    label: "One-way passage balance",
    kind: StrategyParamKind::Float {
        default: 0.5,
        min: 0.0,
        max: 1.0,
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

// Node-based source pool (a random field node whose adjacent floor resolves a target) -> gets src_mode.
static PARAMS: [StrategyParam; 5] =
    crate::add_strategy_params!(ONE_WAY_BALANCE_PARAM, DIRECTION_BALANCE_PARAM);

/// Handles `MISSING_VERTICAL_PASSAGES` — see GitHub issue #343 and its follow-up. For each missing
/// slot, picks a random node whose adjacent floor (up or down, whichever exists — chosen per
/// `PARAM_DIRECTION_BALANCE` when both do) resolves a target node at the same point
/// (`resolve_vertical_target`, mirrors `generation::vertex_based`'s own adjacency resolution), then
/// adds a `VerticalPassage` edge between them.
///
/// `passage_type` (rule-level, see `RuleParams::vertical_passage_type`) constrains what gets added
/// so the strategy always adds exactly what the rule's own `min_vertical_passage_count`/
/// `min_vertical_passage_ratio` checks are counting — a check scoped to e.g. `OneWayUp` would
/// otherwise never see its own deficit close, since a randomly-rolled two-way or one-way-down
/// passage doesn't count toward it. `Any`/`OneWay` still roll probabilistically
/// (`PARAM_ONE_WAY_BALANCE` for one-way-vs-two-way, `PARAM_DIRECTION_BALANCE` for up-vs-down when
/// both apply); `TwoWay`/`OneWayDown`/`OneWayUp` are fully determined by `passage_type` and both
/// params are ignored.
pub struct AddVerticalPassageStrategy {
    pub passage_type: VerticalPassageType,
}

impl<T: Tessellation> RepairStrategy<T, MissingVerticalPassagesIssue>
    for AddVerticalPassageStrategy
{
    fn strategy_id(&self) -> &'static str {
        "add_vertical_passage"
    }

    fn params(&self) -> &'static [StrategyParam] {
        &PARAMS
    }

    fn nested_suppressed_params(&self) -> &'static [&'static str] {
        standard_add_params::NESTED_SUPPRESSED_ADD_PARAMS
    }

    fn apply(
        &self,
        issue: &MissingVerticalPassagesIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        if issue.missing.is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let one_way_balance = params
            .get(PARAM_ONE_WAY_BALANCE)
            .and_then(|v| v.as_float())
            .unwrap_or(0.5);
        let direction_balance = params
            .get(PARAM_DIRECTION_BALANCE)
            .and_then(|v| v.as_float())
            .unwrap_or(0.5);
        let src_mode = src_mode(params);
        let max_failed_attempts = attempts_limit(params);

        let (forced_one_way, constraint) = match self.passage_type {
            VerticalPassageType::Any => (None, DirectionConstraint::Either),
            VerticalPassageType::TwoWay => (Some(false), DirectionConstraint::Either),
            VerticalPassageType::OneWay => (Some(true), DirectionConstraint::Either),
            VerticalPassageType::OneWayDown => (Some(true), DirectionConstraint::RequireDown),
            VerticalPassageType::OneWayUp => (Some(true), DirectionConstraint::RequireUp),
        };

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

            let eligible: Vec<NodeId> = maze
                .field
                .all_node_ids()
                .filter(|&n| match area {
                    RepairArea::WholeMaze => true,
                    RepairArea::Level(level) => maze.field.level_of(n) == Some(level),
                })
                .collect();
            let mut pool = Pool::new(eligible, src_mode, maze, rng);
            let mut added: u32 = 0;
            // A popped `src` that adds nothing counts against the budget (running total).
            let mut failed_attempts: usize = 0;

            while added < target && failed_attempts < max_failed_attempts {
                let Some(src) = pool.take() else { break };

                let Some((from, to)) =
                    resolve_vertical_target(maze, src, rng, &constraint, direction_balance)
                else {
                    failed_attempts += 1;
                    continue;
                };
                if maze.graph.edge_between(from, to).is_some()
                    || maze.graph.edge_between(to, from).is_some()
                {
                    failed_attempts += 1;
                    continue;
                }

                let one_way = forced_one_way
                    .unwrap_or_else(|| rng.random_bool(one_way_balance.clamp(0.0, 1.0)));
                if one_way {
                    if !crate::generation::directed_edge_feasible(preset_state, from, to) {
                        failed_attempts += 1;
                        continue;
                    }
                    commands.push(MutationCommand::AddDirectedVerticalPassage { from, to });
                } else {
                    commands
                        .push(MutationCommand::AddBidirectionalVerticalPassage { a: from, b: to });
                }
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

crate::impl_erased_repair_strategy!(AddVerticalPassageStrategy, MissingVerticalPassagesIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::random::MazeRng;
    use crate::repair::params::build_params;
    use crate::repair::strategies::test_utils::apply_and_commit;
    use crate::space::{MultiLevelField, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;
    use std::collections::HashMap;

    fn any_strategy() -> AddVerticalPassageStrategy {
        AddVerticalPassageStrategy {
            passage_type: VerticalPassageType::Any,
        }
    }

    fn no_params() -> StrategyParams {
        build_params(
            <AddVerticalPassageStrategy as RepairStrategy<
                SquareTessellation,
                MissingVerticalPassagesIssue,
            >>::params(&any_strategy()),
            None,
        )
    }

    fn params_with(overrides: &[(&str, &str)]) -> StrategyParams {
        let mut map = HashMap::new();
        for &(k, v) in overrides {
            map.insert(k.to_string(), v.to_string());
        }
        build_params(
            <AddVerticalPassageStrategy as RepairStrategy<
                SquareTessellation,
                MissingVerticalPassagesIssue,
            >>::params(&any_strategy()),
            Some(&map),
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

    fn missing_issue(missing: u32) -> MissingVerticalPassagesIssue {
        let entries = if missing == 0 {
            vec![]
        } else {
            vec![(RepairArea::WholeMaze, missing)]
        };
        MissingVerticalPassagesIssue::new_from_check("min_vertical_passage_count", entries)
    }

    #[test]
    fn apply_succeeds_immediately_when_nothing_missing() {
        let mut maze = two_level_maze(3);
        let issue = missing_issue(0);
        let mut rng = MazeRng::seed_from_u64(7);
        let result = apply_and_commit(
            &any_strategy(),
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
    fn apply_adds_vertical_passage_edges_between_floors() {
        let mut maze = two_level_maze(4);
        let issue = missing_issue(2);
        let mut rng = MazeRng::seed_from_u64(42);
        let result = apply_and_commit(
            &any_strategy(),
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(
            maze.graph
                .edges()
                .all(|e| e.kind == EdgeKind::VerticalPassage)
        );
        assert!(maze.graph.edges().count() > 0);
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
            &any_strategy(),
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
    fn one_way_balance_zero_always_adds_bidirectional_passages() {
        let mut maze = two_level_maze(4);
        let issue = missing_issue(1);
        let params = params_with(&[(PARAM_ONE_WAY_BALANCE, "0")]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &any_strategy(),
            &issue,
            &mut maze,
            &mut rng,
            &params,
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(
            maze.graph.edges().count(),
            2,
            "one_way_balance=0 must add both directions of the single passage"
        );
        for edge in maze.graph.edges() {
            assert!(
                maze.graph.edge_between(edge.to, edge.from).is_some(),
                "every added edge must have its reverse"
            );
        }
    }

    #[test]
    fn one_way_balance_one_always_adds_a_single_directed_edge() {
        let mut maze = two_level_maze(4);
        let issue = missing_issue(1);
        let params = params_with(&[(PARAM_ONE_WAY_BALANCE, "1")]);
        let mut rng = MazeRng::seed_from_u64(2);
        let result = apply_and_commit(
            &any_strategy(),
            &issue,
            &mut maze,
            &mut rng,
            &params,
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(
            maze.graph.edges().count(),
            1,
            "one_way_balance=1 must add only one direction"
        );
    }

    #[test]
    fn reserve_percent_override_increases_the_passage_count() {
        let mut maze = two_level_maze(4);
        let issue = missing_issue(2);
        let params = params_with(&[("reserve_percent", "100"), ("one_way_balance", "0")]);
        let mut rng = MazeRng::seed_from_u64(42);
        let result = apply_and_commit(
            &any_strategy(),
            &issue,
            &mut maze,
            &mut rng,
            &params,
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        // 2 * (1 + 100%) = 4 bidirectional passages => 8 directed edges, vs 4 with the 0 default.
        assert_eq!(maze.graph.edges().count(), 8);
    }

    #[test]
    fn src_mode_dead_end_priority_is_accepted_and_still_adds_passages() {
        // `dead_end_priority` for a vertical-passage src pool is valid but hard to isolate — the
        // passage endpoints are at src's own x-y point across floors, so a dead-end src whose
        // vertical neighbor is already connected contributes nothing. This just asserts the mode
        // parses and doesn't regress the happy path.
        let mut maze = two_level_maze(4);
        let issue = missing_issue(2);
        let params = params_with(&[("src_mode", "dead_end_priority")]);
        let mut rng = MazeRng::seed_from_u64(5);
        let result = apply_and_commit(
            &any_strategy(),
            &issue,
            &mut maze,
            &mut rng,
            &params,
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edges().count() > 0);
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let issue = missing_issue(2);

        let mut maze_a = two_level_maze(4);
        let mut rng_a = MazeRng::seed_from_u64(123);
        apply_and_commit(
            &any_strategy(),
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
            &any_strategy(),
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

    #[test]
    fn passage_type_two_way_always_adds_both_directions() {
        let mut maze = two_level_maze(4);
        let issue = missing_issue(1);
        let strategy = AddVerticalPassageStrategy {
            passage_type: VerticalPassageType::TwoWay,
        };
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &strategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(
            maze.graph.edges().count(),
            2,
            "TwoWay must add both directions regardless of one_way_balance"
        );
        for edge in maze.graph.edges() {
            assert!(
                maze.graph.edge_between(edge.to, edge.from).is_some(),
                "every added edge must have its reverse"
            );
        }
    }

    #[test]
    fn passage_type_one_way_always_adds_a_single_directed_edge() {
        let mut maze = two_level_maze(4);
        let issue = missing_issue(1);
        let strategy = AddVerticalPassageStrategy {
            passage_type: VerticalPassageType::OneWay,
        };
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &strategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(
            maze.graph.edges().count(),
            1,
            "OneWay must add exactly one direction regardless of one_way_balance"
        );
    }

    #[test]
    fn apply_never_adds_a_reverse_edge_completing_an_existing_edge_into_a_two_way_passage() {
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
        maze.graph.add_edge(b0, t0, EdgeKind::VerticalPassage);

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &any_strategy(),
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(
            matches!(result, RepairResult::Failed),
            "the only candidate pair already has an edge in one direction, so no reverse may be added to complete it into a two-way passage"
        );
        assert_eq!(maze.graph.edges().count(), 1);
    }

    #[test]
    fn passage_type_one_way_up_only_ever_adds_an_upward_edge() {
        let mut maze = two_level_maze(4);
        let issue = missing_issue(3);
        let strategy = AddVerticalPassageStrategy {
            passage_type: VerticalPassageType::OneWayUp,
        };
        let mut rng = MazeRng::seed_from_u64(5);
        let result = apply_and_commit(
            &strategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edges().count() > 0);
        for edge in maze.graph.edges() {
            let from_idx = maze.field.level_index_of(edge.from).unwrap();
            let to_idx = maze.field.level_index_of(edge.to).unwrap();
            assert!(
                from_idx < to_idx,
                "OneWayUp must only ever add edges going from a lower floor to a higher one"
            );
            assert!(
                maze.graph.edge_between(edge.to, edge.from).is_none(),
                "OneWayUp must never add a two-way passage"
            );
        }
    }

    #[test]
    fn passage_type_one_way_down_only_ever_adds_a_downward_edge() {
        let mut maze = two_level_maze(4);
        let issue = missing_issue(3);
        let strategy = AddVerticalPassageStrategy {
            passage_type: VerticalPassageType::OneWayDown,
        };
        let mut rng = MazeRng::seed_from_u64(9);
        let result = apply_and_commit(
            &strategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edges().count() > 0);
        for edge in maze.graph.edges() {
            let from_idx = maze.field.level_index_of(edge.from).unwrap();
            let to_idx = maze.field.level_index_of(edge.to).unwrap();
            assert!(
                from_idx > to_idx,
                "OneWayDown must only ever add edges going from a higher floor to a lower one"
            );
        }
    }

    // `direction_balance` pinned to exactly 0 or 1 under `Either` (passage_type `Any`/`OneWay`) is a
    // hard direction choice, not a probability -- it must not fall back to the other direction on a
    // boundary floor where the chosen one is unavailable. `two_level_maze` gives every node exactly
    // one neighbor floor, so a hard-pinned balance requesting the *other* one can never be satisfied.

    #[test]
    fn preset_locked_out_source_blocks_a_one_way_candidate() {
        // Scope to the bottom floor only, so its single node is the only candidate src: locking it
        // out via preset_state must make the strategy fail rather than silently add the edge.
        let mut maze = two_level_maze(1);
        let bottom = maze.field.levels_ordered().next().unwrap();
        let src = maze
            .field
            .node_at(bottom, crate::space::SquarePoint { x: 0, y: 0 })
            .unwrap();
        let mut preset_state = PresetState::empty();
        preset_state.locked_out.insert(src);

        let issue = MissingVerticalPassagesIssue::new_from_check(
            "min_vertical_passage_count",
            vec![(RepairArea::Level(bottom), 1)],
        );
        let strategy = AddVerticalPassageStrategy {
            passage_type: VerticalPassageType::OneWay,
        };
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &strategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &preset_state,
            &[],
        );
        assert!(
            matches!(result, RepairResult::Failed),
            "the only candidate's source is locked_out, so no one-way edge may be added"
        );
        assert_eq!(maze.graph.edges().count(), 0);
    }

    #[test]
    fn direction_balance_zero_never_falls_back_to_up_on_the_bottom_floor() {
        let mut maze = two_level_maze(4);
        // Scoped to the bottom floor only (via `RepairArea::Level`), so every candidate `src` has
        // just one neighbor: up. `direction_balance=0` pins the choice to down, which is unavailable
        // here -- the point being tested is that this must never fall back to the only floor that
        // *is* reachable.
        let bottom = maze.field.levels_ordered().next().unwrap();
        let issue = MissingVerticalPassagesIssue::new_from_check(
            "min_vertical_passage_count",
            vec![(RepairArea::Level(bottom), 1)],
        );
        let strategy = AddVerticalPassageStrategy {
            passage_type: VerticalPassageType::OneWay,
        };
        let params = params_with(&[(PARAM_DIRECTION_BALANCE, "0")]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &strategy,
            &issue,
            &mut maze,
            &mut rng,
            &params,
            &PresetState::empty(),
            &[],
        );
        assert!(
            matches!(result, RepairResult::Failed),
            "direction_balance=0 must never substitute an upward edge just because it's the only one available"
        );
        assert_eq!(maze.graph.edges().count(), 0);
    }

    #[test]
    fn direction_balance_one_never_falls_back_to_down_on_the_top_floor() {
        let mut maze = two_level_maze(4);
        // Mirrors the balance=0 test above, scoped to the top floor -- its only neighbor is down,
        // which `direction_balance=1` (pinned to up) must not fall back to.
        let top = maze.field.levels_ordered().last().unwrap();
        let issue = MissingVerticalPassagesIssue::new_from_check(
            "min_vertical_passage_count",
            vec![(RepairArea::Level(top), 1)],
        );
        let strategy = AddVerticalPassageStrategy {
            passage_type: VerticalPassageType::OneWay,
        };
        let params = params_with(&[(PARAM_DIRECTION_BALANCE, "1")]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &strategy,
            &issue,
            &mut maze,
            &mut rng,
            &params,
            &PresetState::empty(),
            &[],
        );
        assert!(
            matches!(result, RepairResult::Failed),
            "direction_balance=1 must never substitute a downward edge just because it's the only one available"
        );
        assert_eq!(maze.graph.edges().count(), 0);
    }
}
