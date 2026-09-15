use std::collections::HashSet;
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::{MissingOneWaysIssue, MissingOneWayIssue, RepairArea, MISSING_ONE_WAY};
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedSlot, NestedStrategyConfig, NestedDispatchKind};
use crate::repair::command::MutationCommand;
use super::standard_add_params::{self, reserve_target, attempts_limit, src_mode, inherited_overrides};
use super::remaining_deficits::RemainingDeficits;
use super::pool::Pool;

/// Slot id for the nested single-element strategy this series delegates every attempt to. Exactly
/// one candidate is configured here (`min: 1, max: Some(1)`) — typically `AddOneWayFromWallStrategy`
/// or `AddOneWayFromPassageStrategy`, both of which handle the same synthetic `MISSING_ONE_WAY`
/// kind, so either is a valid fill for this one slot (a per-rule config choice, not a dispatch
/// among several candidates at runtime).
pub const SLOT_ADD_ONE_WAY: &str = "add_one_way";

static NESTED_SLOTS: &[NestedSlot] = &[
    // `Unordered` carries no real selection meaning here (one mandatory slot, nothing to choose
    // between) — set because `NestedSlot::dispatch_kind` has no implicit default (see its own
    // doc comment), not because ordering matters for this slot.
    NestedSlot { slot_id: SLOT_ADD_ONE_WAY, kind: MISSING_ONE_WAY, min: 1, max: Some(1), dispatch_kind: NestedDispatchKind::Unordered },
];

// `reserve_percent`, `src_mode` (orders the `src` pool), `attempts_limit` — no compatibility
// façade for the nested strategy's own params (each candidate's own creation params, e.g.
// `AddOneWayFromPassageStrategy`'s `protect_route`, are resolved from its own `param_overrides`,
// not mirrored here — see `AddTeleportBatchStrategy`'s own `PARAMS` doc comment for why a façade
// doesn't generalize).
static PARAMS: [StrategyParam; 3] = crate::add_strategy_params!();

/// Handles `MISSING_ONE_WAYS` by adding the whole computed target count of one-way passage edges
/// in a single `apply()` call — GitHub issue #524, part of epic #520. Split out of the two old
/// monolithic strategies `MissingOneWaysFromWallStrategy`/`MissingOneWaysFromPassageStrategy`,
/// unified into **one** series here (unlike the initial #524 draft, which kept two separate
/// series structs — corrected during implementation: a rule should pick one series and configure
/// *which* element-creation approach it uses via the nested slot, the same way
/// `PriorityMissingLoopsStrategy` doesn't duplicate itself per nested candidate either). Renamed
/// without migration — old configs referencing either pre-split id (`missing_one_ways_from_wall`,
/// `missing_one_ways_from_passage`) stop working.
///
/// **Series/child split**: this strategy owns the `src` pool (`Pool<NodeId>`, ordered via
/// `src_mode`) and `reserve_percent`/`attempts_limit` accounting; each individual one-way edge is
/// actually built by the nested `SLOT_ADD_ONE_WAY` strategy (`AddOneWayFromWallStrategy` or
/// `AddOneWayFromPassageStrategy`), which owns `dst` selection (and, for the passage family,
/// `protect_route`). Per pool candidate, the series passes `src`'s full field-neighbor list as
/// `MissingOneWayIssue::allowed_dsts` — unrestricted, same as the pre-split `pick_random_pairs`'s
/// own per-`src` inner loop offered every neighbor.
///
/// A nested attempt that fails (`Failed`, having tried every one of `src`'s neighbors) evicts
/// `src` from the pool for good and counts toward `attempts_limit` — a per-neighbor rejection
/// inside the nested strategy's own loop does not (mirrors the pre-split shared helper's
/// `failed_attempts` semantics exactly: a running total of failed *`src` nodes*, not failed
/// pairs).
///
/// **`excluded_pairs` dedup, mirroring `AddTeleportBatchStrategy`'s `excluded: HashSet<TeleportPairKey>`.**
/// Since a pool candidate is drawn at most once (`Pool::take`), the *same* `src` never proposes
/// the same pair twice — but two *different* `src` nodes that are each other's geometric neighbor
/// can each independently see the same original, still-unmutated passage/wall pair (`maze` stays
/// an immutable pre-mutation snapshot for the whole `apply()` call) and each act on it. For
/// `AddOneWayFromWallStrategy` this is harmless (two independent one-way directions through the
/// same wall never conflict), but for `AddOneWayFromPassageStrategy` it is a real bug: each of the
/// two `src` attempts would downgrade a *different* direction of the same passage, fully severing
/// it instead of leaving one direction standing. The series accumulates every pair it successfully
/// acts on into `excluded: HashSet<(NodeId, NodeId)>` (canonicalized, unordered) across the whole
/// call and passes it down via `MissingOneWayIssue::excluded_pairs`; the nested strategy is
/// responsible for consulting it (`AddOneWayFromPassageStrategy` does, `AddOneWayFromWallStrategy`
/// does not need to).
pub struct AddOneWayBatchStrategy;

impl<T: Tessellation> RepairStrategy<T, MissingOneWaysIssue> for AddOneWayBatchStrategy {
    fn strategy_id(&self) -> &'static str { "add_one_way_batch" }

    fn params(&self) -> &'static [StrategyParam] {
        &PARAMS
    }

    fn nested_suppressed_params(&self) -> &'static [&'static str] {
        standard_add_params::NESTED_SUPPRESSED_ADD_PARAMS
    }

    fn expected_nested(&self) -> &'static [NestedSlot] {
        NESTED_SLOTS
    }

    fn apply(
        &self,
        issue: &MissingOneWaysIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        if issue.missing.is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let Some(add_target) = nested.iter().find(|n| n.slot.slot_id == SLOT_ADD_ONE_WAY) else {
            return (RepairResult::Failed, vec![]);
        };

        let inherited = inherited_overrides(params);
        let child_params = crate::repair::nested_dispatch::nested_params(add_target, &inherited);
        let attempts_limit = attempts_limit(params);
        let src_mode = src_mode(params);

        let mut commands = Vec::new();
        let mut total_added: u32 = 0;
        let mut excluded_pairs: HashSet<(crate::ids::NodeId, crate::ids::NodeId)> = HashSet::new();

        let mut deficits = RemainingDeficits::new(&issue.missing);
        let areas: Vec<RepairArea> = deficits.areas().collect();
        for area in areas {
            let missing = deficits.live(area);
            if missing == 0 {
                continue;
            }
            let target = reserve_target(params, missing);

            let base_pool: Vec<_> = maze.field.all_node_ids()
                .filter(|&n| match area {
                    RepairArea::WholeMaze => true,
                    RepairArea::Level(level) => maze.field.level_of(n) == Some(level),
                })
                .collect();
            let mut pool = Pool::new(base_pool, src_mode, maze, rng);
            let mut added: u32 = 0;
            let mut failed_attempts: usize = 0;

            while added < target && !pool.is_empty() && failed_attempts < attempts_limit {
                let Some(src) = pool.take() else { break };
                let allowed_dsts = maze.field.neighbors(src);

                let synthetic = MissingOneWayIssue::with_excluded_pairs(src, allowed_dsts, excluded_pairs.clone());
                let (result, cmds) = add_target.strategy.apply(
                    &synthetic as &dyn crate::quality_control::Issue, maze, rng, &child_params, preset_state, &add_target.nested,
                );

                if matches!(result, RepairResult::Fixed { .. }) {
                    if let Some(dst) = one_way_dst_from_commands(src, &cmds) {
                        excluded_pairs.insert(MissingOneWayIssue::canonical_pair(src, dst));
                    }
                    commands.extend(cmds);
                    added += 1;
                    deficits.consume(&[area, RepairArea::WholeMaze]);
                } else {
                    failed_attempts += 1;
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

/// Recovers `dst` from the pair a nested `Fixed` attempt actually touched, given the `src` the
/// series called it with — used to populate `excluded_pairs` for later attempts. A nested strategy
/// always returns exactly one `AddDirectedEdge` or `RemoveEdgeBetween` command on `Fixed` (the
/// "exactly one element" postcondition every single-mandatory-slot series relies on, same as
/// `AddTeleportBatchStrategy`'s own `logical_teleport_from_commands`), touching `src` as one of its
/// two endpoints; an unexpected shape (wrong command type, or `src` matching neither endpoint)
/// yields `None`, so nothing is excluded rather than panicking.
fn one_way_dst_from_commands(src: crate::ids::NodeId, commands: &[MutationCommand]) -> Option<crate::ids::NodeId> {
    let (from, to) = match commands.first()? {
        MutationCommand::AddDirectedEdge { from, to } => (*from, *to),
        MutationCommand::RemoveEdgeBetween { from, to } => (*from, *to),
        _ => return None,
    };
    if from == src { Some(to) } else if to == src { Some(from) } else { None }
}

crate::impl_erased_repair_strategy!(AddOneWayBatchStrategy, MissingOneWaysIssue);

#[cfg(test)]
#[path = "add_one_way_batch_tests.rs"]
mod tests;
