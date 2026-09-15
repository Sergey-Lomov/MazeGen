use rand::{Rng, RngCore};
use crate::Maze;
use crate::graph::EdgeKind;
use crate::graph::route_protection::route_direction;
use crate::space::Tessellation;
use crate::quality_control::MissingOneWayIssue;
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;

pub const PARAM_PROTECT_ROUTE: &str = "protect_route";

const PROTECT_ROUTE_PARAM: StrategyParam = StrategyParam {
    id: PARAM_PROTECT_ROUTE,
    label: "Protect start-finish route",
    kind: StrategyParamKind::Bool { default: true },
};

static PARAMS: [StrategyParam; 1] = [PROTECT_ROUTE_PARAM];

/// Handles `MISSING_ONE_WAY` by downgrading exactly one existing bidirectional `Basic` passage
/// growing from `issue.src` to a one-way — GitHub issue #524, part of epic #520. Split out of the
/// old monolithic `MissingOneWaysFromPassageStrategy`. One of two interchangeable candidates for
/// `AddOneWayBatchStrategy`'s single nested `add_one_way` slot (the other is
/// `AddOneWayFromWallStrategy`) — the series owns the `src` pool,
/// `reserve_percent`/`attempts_limit` accounting; which one actually runs is a per-rule config
/// choice, not two separate series.
///
/// **Owns `dst` selection and `protect_route`** (GitHub issue #524's ownership decision, mirroring
/// `AddTeleportStrategy`'s `entry_pick`): tries every entry of `issue.allowed_dsts` in a random
/// order (mirrors the pre-split `pick_random_pairs`'s own per-`src` inner loop), picking the first
/// one that has a full bidirectional `Basic` passage to `src`. `protect_route` is a per-pair
/// decision — which direction of a route hop is safe to remove — so it stays fully
/// user-configurable here even when this strategy runs as a nested slot (no entry in
/// `nested_suppressed_params()`).
///
/// A passage on the maze's current start->finish route is a valid candidate too — but when
/// `protect_route` is enabled (the default), the direction removed is never the route's own
/// direction (`route_direction`, `route.path` is ordered start->finish so the hop direction is
/// read directly off it), so the route survives the downgrade instead of being severed. A
/// non-route passage still has its removed direction picked at random, same as before. Disabling
/// `protect_route` restores the old fully-random behavior even for route passages. Unlike
/// `AddOneWayFromWallStrategy`, which needs no such param since a wall was never part of any
/// route.
///
/// Fails outright (`RepairResult::Failed`, no commands) only once every entry of `allowed_dsts`
/// has been rejected — retrying with a fresh `src` is the series' job, not this strategy's.
pub struct AddOneWayFromPassageStrategy;

impl<T: Tessellation> RepairStrategy<T, MissingOneWayIssue> for AddOneWayFromPassageStrategy {
    fn strategy_id(&self) -> &'static str { "add_one_way_from_passage" }

    fn params(&self) -> &'static [StrategyParam] {
        &PARAMS
    }

    fn apply(
        &self,
        issue: &MissingOneWayIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let protect_route = match params.get(PARAM_PROTECT_ROUTE) {
            Some(StrategyParamValue::Bool(b)) => *b,
            _ => true,
        };

        let src = issue.src;
        let mut candidates = issue.allowed_dsts.clone();

        while !candidates.is_empty() {
            let idx = rng.random_range(0..candidates.len());
            let dst = candidates.swap_remove(idx);

            // A pair the series already downgraded earlier this `apply()` call (via a different
            // `src`) must not be touched again — `maze` is an immutable pre-mutation snapshot for
            // the whole call, so without this check two different pool candidates that are each
            // other's neighbor could each independently see the same original bidirectional
            // passage and each remove a different direction of it, fully severing the pair. See
            // `MissingOneWayIssue::excluded_pairs`'s own doc comment.
            if issue.excluded_pairs.contains(&MissingOneWayIssue::canonical_pair(src, dst)) {
                continue;
            }

            // Only a full bidirectional Basic passage qualifies — a wall, an existing one-way, or
            // a Teleport-only connection are not candidates for this strategy.
            let fwd = maze.graph.edge_between_kind(src, dst, &EdgeKind::Basic);
            let bwd = maze.graph.edge_between_kind(dst, src, &EdgeKind::Basic);
            let (Some(_), Some(_)) = (fwd, bwd) else { continue; };

            // If protect_route is enabled and this pair is a route hop, the direction to *keep*
            // is fixed (the route's own direction) — the removed direction must be the other one,
            // never chosen at random or substituted for the route's own direction. Otherwise (not
            // a route hop, or protection disabled) either direction may be removed, same as
            // before.
            let forced_remove = if protect_route {
                route_direction(maze, src, dst).map(|(route_from, route_to)| (route_to, route_from))
            } else {
                None
            };

            if let Some((from, to)) = forced_remove {
                // Skip the pair entirely if the one direction allowed to be removed is
                // preset-protected — never leaves it half-mutated, and never falls back to
                // removing the route's own direction instead.
                if preset_state.is_preset_edge(from, to) {
                    continue;
                }
                return (RepairResult::Fixed { score: None }, vec![MutationCommand::RemoveEdgeBetween { from, to }]);
            }

            // Not route-forced: keep whichever direction preset state allows removing; skip the
            // pair entirely if both directions are preset-protected.
            let remove_fwd = !preset_state.is_preset_edge(src, dst);
            let remove_bwd = !preset_state.is_preset_edge(dst, src);
            let (from, to) = if remove_fwd && remove_bwd {
                if rng.random::<bool>() { (src, dst) } else { (dst, src) }
            } else if remove_fwd {
                (src, dst)
            } else if remove_bwd {
                (dst, src)
            } else {
                continue;
            };
            return (RepairResult::Fixed { score: None }, vec![MutationCommand::RemoveEdgeBetween { from, to }]);
        }

        (RepairResult::Failed, vec![])
    }
}

crate::impl_erased_repair_strategy!(AddOneWayFromPassageStrategy, MissingOneWayIssue);

#[cfg(test)]
#[path = "add_one_way_from_passage_tests.rs"]
mod tests;
