use rand::RngCore;
use crate::Maze;
use crate::ids::EdgeId;
use crate::space::Tessellation;
use crate::quality_control::{TeleportGroupKind, InvalidTeleportGroupIssue, InvalidTeleportIssue, INVALID_TELEPORT};
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedSlot, NestedStrategyConfig, NestedDispatchKind};
use crate::repair::command::MutationCommand;
use crate::repair::strategies::group_select::{group_select_apply, PARAM_PRIORITY, PRIORITY_PROBLEMATIC, PRIORITY_OPTIONS};
use crate::graph::route_protection::is_teleport_route_protected;

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_PRIORITY,
        label: "Removal priority",
        kind: StrategyParamKind::Enum { options: PRIORITY_OPTIONS, default: PRIORITY_PROBLEMATIC },
    },
];

/// Slot id for the nested strategy this strategy delegates the actual per-teleport removal to —
/// `RemoveTeleportStrategy`, the sole `INVALID_TELEPORT`-handling strategy. Mirrors
/// `OneWayGroupSelectStrategy::SLOT_FIX_TARGET`.
pub const SLOT_FIX_TARGET: &str = "fix_target";

static NESTED_SLOTS: &[NestedSlot] = &[
    NestedSlot { slot_id: SLOT_FIX_TARGET, kind: INVALID_TELEPORT, min: 1, max: Some(1), dispatch_kind: NestedDispatchKind::Unordered },
];

/// Handles `INVALID_TELEPORT_GROUP` — see GitHub issue #75, migrated onto the generic group-issue
/// abstraction in GitHub issue #209. Renamed from `TeleportGroupProximityStrategy` in that same
/// migration: like `OneWayGroupSelectStrategy`, this strategy's own logic has nothing proximity-
/// specific left in it — it's a generic "pick candidates out of `InvalidTeleportGroupIssue`'s
/// groups and delegate each fix to a nested strategy" mechanism, not tied to any one producing
/// check. `TeleportGroupProximityCheck` is currently the only check that produces
/// `INVALID_TELEPORT_GROUP`, but nothing about this strategy assumes that stays true. For each
/// problematic pair, removes one of the two teleport edges: removing a teleport immediately drops
/// every problematic pair that references it, so a pair already resolved by an earlier removal in
/// the same `apply()` call is skipped rather than acted on twice.
///
/// GitHub issue #209: `apply()`'s own candidate-pass/budget/nested-delegation mechanics are now
/// `group_select::group_select_apply`, the same shared mechanism `OneWayGroupSelectStrategy` uses
/// — see that function's doc comment for the full walkthrough (membership priority, single global
/// candidate pass, per-group `to_remove` budget, nested delegation, wholly-protected-group
/// auto-resolve). This strategy's own remaining responsibility is exactly what's specific to
/// teleports: `protect_route` (excluding route-critical teleports from the candidate pool,
/// via `is_teleport_route_protected`), resolving `SLOT_FIX_TARGET`/`INVALID_TELEPORT`
/// (`RemoveTeleportStrategy`) from `nested`, and (GitHub issue #210) supplying
/// `build_nested_issue`/`element_invalidated`/`order_by_priority(params)` to `group_select_apply`.
///
/// `protect_route` (see GitHub issue #78, default `true`): a teleport lying on the maze's
/// current start->finish route (`is_teleport_route_protected`) is excluded from the candidate
/// pool up front, for every pair. When *both* sides of a pair are route-protected, the pair has no
/// allowed candidate at all — `group_select_apply` zeroes its budget up front so it's never
/// offered to a nested call that could never succeed. When at least one *other* pair in the same
/// issue does have an allowed candidate, the whole call is still `Fixed` off that pair's own
/// progress, and the wholly-protected pair is simply left alone. When only one side of a pair is
/// protected (not both), the other side remains in the candidate pool and is removed through the
/// normal `problematic`/`random` pass — no separate per-pair fallback code needed, since the
/// protected side was never a candidate to begin with. **Behavior change from pre-#209**: if
/// *every* pair in the issue is wholly-protected (both sides route-critical), this strategy now
/// returns `Failed` instead of the old "leave every pair untouched, still report `Fixed`" — this
/// permanently skips the rule for the rest of the current repair stage's fixpoint loop (see
/// `Stage::check_and_dispatch`'s `failed` set), rather than the issue being silently re-detected
/// and re-"resolved" as a no-op on every future iteration until the repair budget runs out.
///
/// `allow_reverse` — whether removing a chosen teleport also removes its opposite-direction
/// counterpart — moved onto the nested `RemoveTeleportStrategy`'s own param (GitHub issue #190)
/// now that removal itself is delegated there, rather than staying a param of this strategy.
///
/// `protect_route` (GitHub issue #253) is a rule-level parameter, resolved once by the factory
/// (`maze-runner`'s `build_rule_for!`) from `RuleParams` — not a `StrategyParam` anymore, so it
/// has no local override.
pub struct TeleportGroupSelectStrategy {
    pub protect_route: bool,
}

impl<T: Tessellation> RepairStrategy<T, InvalidTeleportGroupIssue> for TeleportGroupSelectStrategy {
    fn strategy_id(&self) -> &'static str { "teleport_group_select" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn expected_nested(&self) -> &'static [NestedSlot] {
        NESTED_SLOTS
    }

    fn apply(
        &self,
        issue: &InvalidTeleportGroupIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let matching: Vec<&NestedStrategyConfig<T>> =
            nested.iter().filter(|n| n.slot.slot_id == SLOT_FIX_TARGET).collect();
        debug_assert!(matching.len() <= 1,
            "TeleportGroupSelectStrategy: expected_nested()'s max: Some(1) for slot \"{SLOT_FIX_TARGET}\" should prevent more than one nested strategy filling it");
        let Some(&fix_target) = matching.first() else {
            if issue.groups.is_empty() {
                return (RepairResult::Fixed { score: None }, vec![]);
            }
            return (RepairResult::Failed, vec![]);
        };

        let protect_route = self.protect_route;
        let element_allowed = |edge: &EdgeId| !protect_route || !is_teleport_route_protected(maze, *edge);
        let build_nested_issue = |source_check: &str, target: &EdgeId, _others: &[EdgeId]| -> Box<dyn crate::quality_control::Issue> {
            Box::new(InvalidTeleportIssue::new_from_check(source_check, vec![*target]))
        };
        // Mirrors `TeleportGroupKind`'s old `resolved_elements`: an edge counts as invalidated if
        // the nested call actually removed it, or if it's the opposite-direction `Teleport`
        // counterpart (read from `maze`, the pre-mutation snapshot) of any edge the call removed
        // -- `removed_edge_ids` alone never recognizes a `RemoveTeleportWithReverse` command's
        // reverse id (GitHub issue #171's known gap).
        let element_invalidated = |edge: &EdgeId, nested_commands: &[MutationCommand], maze: &Maze<T>| {
            let removed = crate::repair::removed_edge_ids(nested_commands);
            removed.contains(edge) || removed.iter().any(|&id| maze.graph.teleport_reverse(id) == Some(*edge))
        };

        group_select_apply::<T, TeleportGroupKind>(issue, maze, rng, preset_state, fix_target, element_allowed, build_nested_issue, element_invalidated, crate::repair::strategies::group_select::order_by_priority(params))
    }
}

crate::impl_erased_repair_strategy!(TeleportGroupSelectStrategy, InvalidTeleportGroupIssue);

#[cfg(test)]
#[path = "teleport_group_select_tests.rs"]
mod tests;
