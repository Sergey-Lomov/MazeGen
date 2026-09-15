use rand::RngCore;
use std::collections::HashSet;
use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::quality_control::{MissingTeleportsIssue, RepairArea, MissingTeleportIssue, TeleportPairKey, logical_teleport_from_commands, MISSING_TELEPORT};
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedSlot, NestedStrategyConfig, NestedDispatchKind};
use crate::repair::command::MutationCommand;
use super::standard_add_params::{self, reserve_target, attempts_limit, inherited_overrides, RESERVE_PERCENT_PARAM, ATTEMPTS_LIMIT_PARAM};
use super::remaining_deficits::RemainingDeficits;
use super::pool::Pool;
use super::dead_end_priority::SRC_MODE_RANDOM;

/// Slot id for the nested single-element strategy this series delegates every attempt to —
/// matches `AddTeleportStrategy::strategy_id()` (no extra suffix, GitHub issue #522's naming
/// standard: series slot ids for a mandatory single-candidate slot reuse the child's own id).
pub const SLOT_ADD_TELEPORT: &str = "add_teleport";

static NESTED_SLOTS: &[NestedSlot] = &[
    // `Unordered` carries no real selection meaning here (one mandatory slot, nothing to choose
    // between) — set because `NestedSlot::dispatch_kind` has no implicit default (see its own
    // doc comment), not because ordering matters for this slot.
    NestedSlot { slot_id: SLOT_ADD_TELEPORT, kind: MISSING_TELEPORT, min: 1, max: Some(1), dispatch_kind: NestedDispatchKind::Unordered },
];

// Only the standard `reserve_percent`/`attempts_limit` pair — no compatibility façade for the
// nested strategy's own creation params (GitHub issue #522 design correction: a façade re-
// declaring a *fixed* nested strategy's params under the series' id doesn't generalize to a slot
// whose filler is chosen dynamically among several candidates, e.g. loop-adding series with
// multiple nested options — those candidates' params can't be known ahead of time at the series'
// own `PARAMS` declaration site). Renamed from `"missing_teleports"` without migration, so this
// is an intentional break, not an oversight: a param id that only ever meant something on the
// pre-split monolithic strategy has no reason to keep resolving on the series post-split.
static PARAMS: [StrategyParam; 2] = [RESERVE_PERCENT_PARAM, ATTEMPTS_LIMIT_PARAM];

/// Handles `MISSING_TELEPORTS` (see GitHub issue #211/#212) by adding the whole computed target
/// count of teleport edges in a single `apply()` call — mirrors `MissingLoopsRandomStrategy`'s
/// `reserve_percent` target-count approach, not `MissingOneWaysFromWall`/`PassageStrategy`'s
/// one-fix-per-call shape.
///
/// **Series/child split (GitHub issue #522, part of epic #520)**: this strategy owns the pool,
/// `reserve_percent`/`attempts_limit` accounting, and cross-attempt pair dedup; each individual
/// teleport is actually built by the nested `SLOT_ADD_TELEPORT` strategy (typically
/// `AddTeleportStrategy`), which owns `entry_pick` resolution and the exit search. Renamed from
/// `MissingTeleportsStrategy`/`"missing_teleports"` to `AddTeleportBatchStrategy`/
/// `"add_teleport_batch"` as part of the same issue's naming standard — **renamed without
/// migration**, old configs referencing the pre-split id stop working.
///
/// Per pool candidate: the series passes the raw, unresolved node as `MissingTeleportIssue::
/// candidate` — the nested strategy resolves `entry_pick` itself and returns the actual
/// `MutationCommand`(s). The series never inspects `entry_pick`; it learns the resulting teleport
/// only by parsing those commands (`logical_teleport_from_commands`), which it needs for two
/// things: (1) attributing the deficit decrement to the entry/exit's actual levels, (2) recording
/// the pair in `excluded` so a later attempt within this same `apply()` call can't re-propose it —
/// `maze` stays an immutable pre-mutation snapshot for the whole call (GitHub issue #118), so
/// nothing but this accumulated set makes an already-queued-but-unapplied pair visible again.
///
/// A nested strategy result that doesn't parse into exactly one logical teleport (`None` from
/// `logical_teleport_from_commands` — wrong command shape, e.g. a misconfigured/incompatible
/// nested strategy) is treated as an ordinary failed attempt, not a panic: the candidate is
/// evicted from the pool and a fresh one is tried, same as an outright `Failed` result. Kind
/// mismatch (a nested strategy that doesn't actually handle `MISSING_TELEPORT`) is caught earlier,
/// at config-parse time (`ErasedRepairStrategy::apply`'s downcast `expect`, guarded by
/// `NestedSlot.kind` validation — see `Specs/repair.md`), so it never reaches this shape check.
pub struct AddTeleportBatchStrategy;

impl<T: Tessellation> RepairStrategy<T, MissingTeleportsIssue> for AddTeleportBatchStrategy {
    fn strategy_id(&self) -> &'static str { "add_teleport_batch" }

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
        issue: &MissingTeleportsIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        if issue.missing.is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let Some(add_target) = nested.iter().find(|n| n.slot.slot_id == SLOT_ADD_TELEPORT) else {
            return (RepairResult::Failed, vec![]);
        };

        // Only the standard `reserve_percent`/`attempts_limit` are dispatcher-owned and injected
        // into the nested call (GitHub issue #486's mechanism, same as `dispatch_weighted`/
        // `dispatch_priority` use) — the nested strategy's own creation params are entirely its
        // own concern, resolved from its own `param_overrides` on the config node, not mirrored
        // or overridden here (see this file's own `PARAMS` doc comment for why a façade doesn't
        // generalize). Built once before the attempts loop: neither value changes mid-`apply()`.
        let inherited = inherited_overrides(params);
        let child_params = crate::repair::nested_dispatch::nested_params(add_target, &inherited);
        let attempts_limit = attempts_limit(params);

        let mut excluded: HashSet<TeleportPairKey> = HashSet::new();
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

            // Only the entry side is restricted to the reported area — a teleport's exit is free
            // to land on any floor (GitHub issue #369's floor-scope follow-up): teleports
            // legitimately connect points on different floors, so forcing the exit onto the same
            // area as the entry would rule out exactly the cross-floor teleports this strategy is
            // meant to be able to add.
            let base_pool: Vec<NodeId> = maze.field.all_node_ids()
                .filter(|&n| match area {
                    RepairArea::WholeMaze => true,
                    RepairArea::Level(level) => maze.field.level_of(n) == Some(level),
                })
                .collect();
            let mut pool = Pool::new(base_pool, SRC_MODE_RANDOM, maze, rng);
            let mut added: u32 = 0;

            while added < target && !pool.is_empty() {
                let mut slot_filled = false;

                for _ in 0..attempts_limit {
                    let Some(candidate) = pool.take() else { break };

                    let synthetic = MissingTeleportIssue::new(candidate, excluded.clone());
                    let (result, cmds) = add_target.strategy.apply(
                        &synthetic as &dyn crate::quality_control::Issue, maze, rng, &child_params, preset_state, &add_target.nested,
                    );
                    let logical = matches!(result, RepairResult::Fixed { .. })
                        .then(|| logical_teleport_from_commands(&cmds))
                        .flatten();

                    let Some(teleport) = logical else {
                        continue;
                    };

                    excluded.insert(teleport.canonical_key());
                    commands.extend(cmds);
                    added += 1;
                    slot_filled = true;

                    // Decrement the entry's own area (usually `area`, but the entry may differ
                    // from `candidate` under `entry_pick: farthest_from_random`, so re-derive it
                    // from the resolved entry's actual level rather than assuming it's still
                    // `area`) plus the exit's level if it lands on a different floor, plus
                    // `WholeMaze` always — a teleport can cross floors, so both ends' per-floor
                    // deficits are satisfied by this one addition (GitHub issue #369 follow-up).
                    let mut covered = vec![RepairArea::WholeMaze];
                    if let Some(entry_level) = maze.field.level_of(teleport.entry) {
                        covered.push(RepairArea::Level(entry_level));
                    }
                    if let Some(exit_level) = maze.field.level_of(teleport.exit) {
                        covered.push(RepairArea::Level(exit_level));
                    }
                    deficits.consume(&covered);
                    break;
                }

                // attempts_limit consecutive failures without exhausting the pool -- give up on
                // this teleport slot only, not the whole apply() call. The failed candidates were
                // evicted from `pool` above (via `Pool::take`), so the next slot's attempts_limit
                // budget draws from a smaller, different pool rather than retrying the exact same
                // losing candidates.
                if !slot_filled && pool.is_empty() {
                    break;
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

crate::impl_erased_repair_strategy!(AddTeleportBatchStrategy, MissingTeleportsIssue);

#[cfg(test)]
#[path = "add_teleport_batch_tests.rs"]
mod tests;
