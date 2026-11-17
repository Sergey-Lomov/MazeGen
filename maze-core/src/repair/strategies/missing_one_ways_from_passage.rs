use super::missing_one_ways_shared::{ProposedPairs, canonical_pair, pick_random_pairs};
use super::remaining_deficits::RemainingDeficits;
use super::standard_add_params::{self, attempts_limit, reserve_target, src_mode};
use crate::Maze;
use crate::generation::PresetState;
use crate::graph::EdgeKind;
use crate::graph::route_protection::route_direction;
use crate::quality_control::MissingOneWaysIssue;
use crate::quality_control::RepairArea;
use crate::repair::command::MutationCommand;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::{Rng, RngCore};

pub const PARAM_PROTECT_ROUTE: &str = "protect_route";

const PROTECT_ROUTE_PARAM: StrategyParam = StrategyParam {
    id: PARAM_PROTECT_ROUTE,
    label: "Protect start-finish route",
    kind: StrategyParamKind::Bool { default: true },
};

static PARAMS: [StrategyParam; 4] = crate::add_strategy_params!(PROTECT_ROUTE_PARAM);

/// Handles `MISSING_ONE_WAYS` — one of the two registered strategies (see
/// `MissingOneWaysFromWallStrategy` for the other) — see GitHub issue #201. Picks random existing
/// bidirectional `Basic` passages and downgrades each to a one-way by removing one of its two
/// directions. A passage on the maze's current start->finish route is a valid candidate too — but
/// when `protect_route` is enabled (the default), the direction removed is never the route's own
/// direction (`route_direction`, `route.path` is ordered start->finish so the hop direction is
/// read directly off it), so the route survives the downgrade instead of being severed. A
/// non-route passage still has its removed direction picked at random, same as before. Disabling
/// `protect_route` restores the old fully-random behavior even for route passages. Unlike
/// `MissingOneWaysFromWallStrategy`, which needs no such param since a wall was never part of any
/// route.
pub struct MissingOneWaysFromPassageStrategy;

impl<T: Tessellation> RepairStrategy<T, MissingOneWaysIssue> for MissingOneWaysFromPassageStrategy {
    fn strategy_id(&self) -> &'static str {
        "missing_one_ways_from_passage"
    }

    fn params(&self) -> &'static [StrategyParam] {
        &PARAMS
    }

    fn nested_suppressed_params(&self) -> &'static [&'static str] {
        standard_add_params::NESTED_SUPPRESSED_ADD_PARAMS
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

        let protect_route = match params.get(PARAM_PROTECT_ROUTE) {
            Some(StrategyParamValue::Bool(b)) => *b,
            _ => true,
        };
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
                    // Only a full bidirectional Basic passage qualifies — a wall, an existing
                    // one-way, or a Teleport-only connection are not candidates for this strategy.
                    let fwd = maze.graph.edge_between_kind(src, dst, &EdgeKind::Basic);
                    let bwd = maze.graph.edge_between_kind(dst, src, &EdgeKind::Basic);
                    let (Some(_), Some(_)) = (fwd, bwd) else {
                        return false;
                    };

                    // If protect_route is enabled and this pair is a route hop, the direction to
                    // *keep* is fixed (the route's own direction) — the removed direction must be
                    // the other one, never chosen at random or substituted for the route's own
                    // direction. Otherwise (not a route hop, or protection disabled) either
                    // direction may be removed, same as before.
                    let forced_remove = if protect_route {
                        route_direction(maze, src, dst)
                            .map(|(route_from, route_to)| (route_to, route_from))
                    } else {
                        None
                    };

                    proposed.insert(canonical_pair(src, dst));
                    if let Some((from, to)) = forced_remove {
                        // Skip the pair entirely if the one direction allowed to be removed is
                        // preset-protected — never leaves it half-mutated, and never falls back to
                        // removing the route's own direction instead.
                        if preset_state.is_preset_edge(from, to) {
                            return false;
                        }
                        commands.push(MutationCommand::RemoveEdgeBetween { from, to });
                        return true;
                    }

                    // Not route-forced: keep whichever direction preset state allows removing;
                    // skip the pair entirely if both directions are preset-protected.
                    let remove_fwd = !preset_state.is_preset_edge(src, dst);
                    let remove_bwd = !preset_state.is_preset_edge(dst, src);
                    if remove_fwd && remove_bwd {
                        let (from, to) = if rng.random::<bool>() {
                            (src, dst)
                        } else {
                            (dst, src)
                        };
                        commands.push(MutationCommand::RemoveEdgeBetween { from, to });
                        true
                    } else if remove_fwd {
                        commands.push(MutationCommand::RemoveEdgeBetween { from: src, to: dst });
                        true
                    } else if remove_bwd {
                        commands.push(MutationCommand::RemoveEdgeBetween { from: dst, to: src });
                        true
                    } else {
                        false
                    }
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

crate::impl_erased_repair_strategy!(MissingOneWaysFromPassageStrategy, MissingOneWaysIssue);

#[cfg(test)]
#[path = "missing_one_ways_from_passage_tests.rs"]
mod tests;
