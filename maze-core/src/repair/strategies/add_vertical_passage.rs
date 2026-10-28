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
#[path = "add_vertical_passage_tests.rs"]
mod tests;
