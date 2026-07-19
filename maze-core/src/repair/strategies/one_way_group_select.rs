use std::collections::HashMap;
use rand::{Rng, RngCore};
use crate::Maze;
use crate::ids::EdgeId;
use crate::space::Tessellation;
use crate::quality_control::{IssueKindConst, InvalidOneWayIssue, InvalidOneWayGroupIssue, INVALID_ONE_WAY};
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedSlot, NestedStrategyConfig};
use crate::repair::command::{MutationCommand, removed_edge_ids};
use crate::graph::route_protection::is_edge_on_route;

pub const PARAM_PRIORITY: &str = "priority";
pub const PARAM_PROTECT_ROUTE: &str = "protect_route";

pub const PRIORITY_RANDOM: &str = "random";
pub const PRIORITY_PROBLEMATIC: &str = "problematic";

static PRIORITY_OPTIONS: &[&str] = &[PRIORITY_RANDOM, PRIORITY_PROBLEMATIC];

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_PRIORITY,
        label: "Fix priority",
        kind: StrategyParamKind::Enum { options: PRIORITY_OPTIONS, default: PRIORITY_PROBLEMATIC },
    },
    StrategyParam {
        id: PARAM_PROTECT_ROUTE,
        label: "Protect route one-ways",
        kind: StrategyParamKind::Bool { default: true },
    },
];

/// Slot id for the nested strategy this strategy delegates the actual per-edge fix to — one of
/// the `INVALID_ONE_WAY`-handling strategies (`OneWayToPassageStrategy`/`OneWayToWallStrategy`,
/// see GitHub issue #198), mirroring `InvalidLoopGroupSelectStrategy`'s `SLOT_CUT_TARGET`.
pub const SLOT_FIX_TARGET: &str = "fix_target";

static NESTED_SLOTS: &[NestedSlot] = &[
    NestedSlot { slot_id: SLOT_FIX_TARGET, kind: INVALID_ONE_WAY, min: 1, max: Some(1) },
];

/// Handles `INVALID_ONE_WAY_GROUP` — see GitHub issue #199, generalized in #200 and #202. Not
/// tied to any one producing check: `OneWayGroupGeometricProximityCheck`/
/// `OneWayGroupGraphProximityCheck` (proximity pairs), `OneWayGroupSuperHubCheck` (per-vertex
/// excess count), and `MaxOneWayCountCheck`/`MaxOneWayRatioCheck` (maze-wide count/ratio excess)
/// all emit the same `groups: Vec<OneWayGroup>` shape (see `OneWayGroup`'s doc comment), and this
/// strategy handles any of them uniformly — hence "select", not "proximity", in the name.
///
/// **Per-group `to_remove` budget (GitHub issue #202 follow-up)**: earlier revisions assumed one
/// successful fix always resolved a group, true for a 2-edge proximity pair but not for a
/// super-hub vertex (needs its whole excess removed) or a maze-wide count/ratio excess (same). A
/// group is only dropped once its own `to_remove` budget reaches zero, and each `apply()` call
/// works through every group's budget, not just one edge total — this is what lets a single
/// maze-wide excess group actually converge within a bounded number of `apply()` calls instead of
/// needing one repair iteration per excess edge.
///
/// **Single global candidate pass, not one scan per group (GitHub issue #202 follow-up review)**:
/// an earlier revision picked one edge per group per loop iteration, rescanning that group's own
/// candidate list every time — for one very large group (the common case here, e.g. a maze-wide
/// count/ratio excess) that's `O(to_remove * group_size)` in a single `apply()` call. Instead,
/// candidates are deduplicated into one global list up front (`groups_by_edge: edge -> [group
/// indices]`, route-protected edges excluded from it entirely) and visited once, in priority
/// order:
/// - `problematic`: every candidate shuffled first (so same-membership ties resolve randomly,
///   not by incidental `HashMap` iteration order), then stably sorted by membership count
///   descending — the edge present in the most groups (membership counts computed once up front
///   over the original unresolved group set, a snapshot, same rationale as
///   `TeleportGroupProximityStrategy`'s own `problematic` priority) is tried first, globally
///   across every group, not just within whichever group happens to be visited first.
/// - `random`: the same shuffle, used directly as the visiting order.
///
/// For each candidate still needed by at least one group with `to_remove > 0`, delegates the
/// actual fix to a nested `INVALID_ONE_WAY` strategy filling the `fix_target` slot:
/// - On success, the fixed edge (and anything else the nested strategy's own commands removed) is
///   dropped from the reverse index everywhere, and every group that still needed one of those
///   edges retires one unit of its own `to_remove` budget — a single shared edge can retire budget
///   in several groups from one fix.
/// - On failure (nested strategy couldn't fix it), the edge is dropped from the reverse index too
///   — the maze doesn't change within one `apply()` call, so a failed edge would fail identically
///   on a second try; there's nothing to gain by revisiting it from another group.
///
/// A group is resolved once its `to_remove` reaches zero; if the whole candidate pass runs out
/// (every remaining candidate route-protected, or already tried and failed) some groups may still
/// have `to_remove > 0` left — they simply carry over to the next repair iteration's fresh issue.
///
/// `PARAM_PROTECT_ROUTE` (default `true`): a candidate lying on the maze's current start->finish
/// route (`is_edge_on_route`) is excluded from the candidate pool up front, for every group.
pub struct OneWayGroupSelectStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidOneWayGroupIssue> for OneWayGroupSelectStrategy {
    fn strategy_id(&self) -> &'static str { "one_way_group_select" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn expected_nested(&self) -> &'static [NestedSlot] {
        NESTED_SLOTS
    }

    fn apply(
        &self,
        issue: &InvalidOneWayGroupIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        if issue.groups.is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let matching: Vec<&NestedStrategyConfig<T>> =
            nested.iter().filter(|n| n.slot.slot_id == SLOT_FIX_TARGET).collect();
        debug_assert!(matching.len() <= 1,
            "OneWayGroupSelectStrategy: expected_nested()'s max: Some(1) for slot \"{SLOT_FIX_TARGET}\" should prevent more than one nested strategy filling it");
        let Some(&fix_target) = matching.first() else {
            return (RepairResult::Failed, vec![]);
        };

        let priority = match params.get(PARAM_PRIORITY) {
            Some(StrategyParamValue::Enum(v)) => v.as_str(),
            _ => PRIORITY_PROBLEMATIC,
        };
        let protect_route = matches!(params.get(PARAM_PROTECT_ROUTE), Some(StrategyParamValue::Bool(true)));

        // Membership counts computed once up front, over the original (unresolved) group set —
        // a static snapshot, same rationale as `TeleportGroupProximityStrategy`'s own.
        let mut membership: HashMap<EdgeId, usize> = HashMap::new();
        for (group, _) in &issue.groups {
            for &id in group {
                *membership.entry(id).or_insert(0) += 1;
            }
        }

        let nested_params = crate::repair::params::build_params(fix_target.strategy.params(), Some(&fix_target.param_overrides));

        // Remaining-to-remove budget per group, indexed the same as `issue.groups` — the only
        // per-group state left; candidate iteration itself is now global (see below), not
        // per-group, to keep one apply() call linear in the total candidate count instead of
        // quadratic (GitHub issue #202 follow-up review).
        let mut remaining: Vec<u32> = issue.groups.iter().map(|(_, to_remove)| *to_remove).collect();

        // Reverse index: edge -> every group (by index into `issue.groups`/`remaining`) that
        // still lists it as a candidate. Built once; an edge is removed from every entry the
        // moment it's fixed (or immediately if route-protected), so later lookups never revisit
        // a resolved edge.
        let mut groups_by_edge: HashMap<EdgeId, Vec<usize>> = HashMap::new();
        for (i, (group, _)) in issue.groups.iter().enumerate() {
            for &id in group {
                if protect_route && is_edge_on_route(maze, id) {
                    continue;
                }
                groups_by_edge.entry(id).or_default().push(i);
            }
        }

        // One global candidate order instead of a per-group scan: `problematic` visits the
        // highest-membership edges first regardless of which group they belong to (fixing the
        // cross-group priority gap `problematic` is meant to address), `random` visits in a single
        // shuffled order. Either way each candidate is tried at most once per apply() call.
        let mut candidates: Vec<EdgeId> = groups_by_edge.keys().copied().collect();
        {
            use rand::seq::SliceRandom;
            // Shuffle first regardless of priority -- HashMap key iteration order is not itself
            // seeded by `rng` and must not leak into tie-break order. `problematic`'s stable sort
            // on top of an already-shuffled vector then makes same-membership ties resolve
            // randomly (mirrors the old per-group `pick()`'s random tie-break), and `random`
            // keeps the shuffle as its own final order.
            candidates.shuffle(rng);
        }
        if priority == PRIORITY_PROBLEMATIC {
            candidates.sort_by_key(|id| std::cmp::Reverse(membership.get(id).copied().unwrap_or(0)));
        }

        let mut commands = Vec::new();
        let mut any_succeeded = false;

        for target in candidates {
            let still_needed = groups_by_edge.get(&target).is_some_and(|gs| gs.iter().any(|&gi| remaining[gi] > 0));
            if !still_needed {
                continue;
            }

            let synthetic = InvalidOneWayIssue::new_from_check("one_way_group_select", vec![target]);
            let (nested_result, nested_commands) = fix_target.strategy.apply(
                &synthetic as &dyn crate::quality_control::Issue, maze, rng, &nested_params, preset_state, &fix_target.nested,
            );

            if matches!(nested_result, RepairResult::Fixed { .. }) {
                any_succeeded = true;
                let removed: std::collections::HashSet<EdgeId> = removed_edge_ids(&nested_commands).into_iter()
                    .chain(std::iter::once(target))
                    .collect();
                // Every group that still needed one of the removed edges retires one unit of
                // budget -- a shared edge can retire budget in several groups from a single fix.
                for id in &removed {
                    if let Some(group_ids) = groups_by_edge.remove(id) {
                        for gi in group_ids {
                            if remaining[gi] > 0 {
                                remaining[gi] -= 1;
                            }
                        }
                    }
                }
                commands.extend(nested_commands);
            } else {
                // Failed -- this edge never succeeds again within the same apply() call (the
                // maze it's evaluated against doesn't change), so drop it everywhere rather than
                // leaving it to be retried from another group.
                groups_by_edge.remove(&target);
            }
        }

        if any_succeeded {
            (RepairResult::Fixed { score: None }, commands)
        } else {
            (RepairResult::Failed, vec![])
        }
    }
}

crate::impl_erased_repair_strategy!(OneWayGroupSelectStrategy, InvalidOneWayGroupIssue);

#[cfg(test)]
#[path = "one_way_group_select_tests.rs"]
mod tests;
