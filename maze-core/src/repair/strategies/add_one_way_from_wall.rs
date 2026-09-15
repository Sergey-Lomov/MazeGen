use rand::{Rng, RngCore};
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::MissingOneWayIssue;
use crate::generation::PresetState;
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;

/// Handles `MISSING_ONE_WAY` by growing exactly one one-way passage edge from `issue.src` through
/// a wall — GitHub issue #524, part of epic #520. Split out of the old monolithic
/// `MissingOneWaysFromWallStrategy`. One of two interchangeable candidates for
/// `AddOneWayBatchStrategy`'s single nested `add_one_way` slot (the other is
/// `AddOneWayFromPassageStrategy`) — the series owns the `src` pool,
/// `reserve_percent`/`attempts_limit` accounting; which one actually runs is a per-rule config
/// choice, not two separate series.
///
/// **Owns `dst` selection**: tries every entry of `issue.allowed_dsts` in a random order (mirrors
/// the pre-split `pick_random_pairs`'s own per-`src` inner loop, now living here instead of the
/// shared helper), picking the first one that qualifies as a wall — no edge of any kind in either
/// direction between `src` and the candidate `dst` — and preset-feasible in at least one
/// direction. Fails outright (`RepairResult::Failed`, no commands) only once every entry of
/// `allowed_dsts` has been rejected — retrying with a fresh `src` is the series' job, not this
/// strategy's.
///
/// No params of its own — unlike `AddOneWayFromPassageStrategy`, a wall was never part of any
/// start->finish route, so there's no `protect_route`-equivalent decision to make here.
pub struct AddOneWayFromWallStrategy;

impl<T: Tessellation> RepairStrategy<T, MissingOneWayIssue> for AddOneWayFromWallStrategy {
    fn strategy_id(&self) -> &'static str { "add_one_way_from_wall" }

    fn apply(
        &self,
        issue: &MissingOneWayIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        _params: &crate::repair::params::StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let src = issue.src;
        let mut candidates = issue.allowed_dsts.clone();

        while !candidates.is_empty() {
            let idx = rng.random_range(0..candidates.len());
            let dst = candidates.swap_remove(idx);

            // A wall: no edge of any kind in either direction between the pair.
            if maze.graph.edge_between(src, dst).is_some() || maze.graph.edge_between(dst, src).is_some() {
                continue;
            }

            let add_fwd = crate::generation::directed_edge_feasible(preset_state, src, dst);
            let add_bwd = crate::generation::directed_edge_feasible(preset_state, dst, src);
            let (from, to) = if add_fwd && add_bwd {
                if rng.random::<bool>() { (src, dst) } else { (dst, src) }
            } else if add_fwd {
                (src, dst)
            } else if add_bwd {
                (dst, src)
            } else {
                continue;
            };

            return (RepairResult::Fixed { score: None }, vec![MutationCommand::AddDirectedEdge { from, to }]);
        }

        (RepairResult::Failed, vec![])
    }
}

crate::impl_erased_repair_strategy!(AddOneWayFromWallStrategy, MissingOneWayIssue);

#[cfg(test)]
#[path = "add_one_way_from_wall_tests.rs"]
mod tests;
