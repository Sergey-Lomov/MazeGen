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

/// Handles `INVALID_ONE_WAY_GROUP` — see GitHub issue #199, generalized in #200. Not tied to any
/// one producing check: `OneWayGroupGeometricProximityCheck`/`OneWayGroupGraphProximityCheck`
/// (proximity pairs) and `OneWayGroupSuperHubCheck` (per-vertex excess count) all emit the same
/// `groups: Vec<Vec<EdgeId>>` shape, and this strategy handles any of them uniformly — hence
/// "select", not "proximity", in the name. For each problematic group, picks one one-way edge to
/// fix and delegates the actual fix to a nested `INVALID_ONE_WAY` strategy filling the
/// `fix_target` slot. Mirrors `TeleportGroupProximityStrategy`'s per-pair resolution, generalized
/// to any group size (`issue.groups: Vec<Vec<EdgeId>>`, not a flat pair list).
///
/// `PARAM_PRIORITY`: `random` picks a random edge from the group; `problematic` picks the edge
/// present in the most *other* groups (membership counts computed once up front, over the
/// original unresolved group set — a snapshot, not a running count that would favor whichever
/// group is processed first, same rationale as `TeleportGroupProximityStrategy`'s own
/// `problematic` priority). Ties broken randomly.
///
/// `PARAM_PROTECT_ROUTE` (default `true`): a candidate lying on the maze's current start->finish
/// route (`is_edge_on_route`) is excluded from being picked. If every edge in a group is
/// route-protected, the group is left untouched (still counted as resolved).
///
/// After a nested-strategy call successfully fixes the picked edge, every group containing that
/// edge is dropped from the remaining group list — mirrors `TeleportGroupProximityStrategy`'s
/// `removed` bookkeeping: a group already resolved by an earlier pick in the same `apply()` call
/// is skipped rather than acted on a second time.
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
        for group in &issue.groups {
            for &id in group {
                *membership.entry(id).or_insert(0) += 1;
            }
        }

        let nested_params = crate::repair::params::build_params(fix_target.strategy.params(), Some(&fix_target.param_overrides));
        let mut resolved: std::collections::HashSet<EdgeId> = std::collections::HashSet::new();
        let mut commands = Vec::new();
        let mut any_succeeded = false;

        for group in &issue.groups {
            if group.iter().any(|id| resolved.contains(id)) {
                continue;
            }

            let candidates: Vec<EdgeId> = if protect_route {
                group.iter().copied().filter(|&id| !is_edge_on_route(maze, id)).collect()
            } else {
                group.clone()
            };
            let Some(&target) = pick(&candidates, priority, &membership, rng) else {
                // Every edge in the group is route-protected -- left untouched, still resolved.
                continue;
            };

            let synthetic = InvalidOneWayIssue::new_from_check("one_way_group_select", vec![target]);
            let (nested_result, nested_commands) = fix_target.strategy.apply(
                &synthetic as &dyn crate::quality_control::Issue, maze, rng, &nested_params, preset_state, &fix_target.nested,
            );
            any_succeeded |= matches!(nested_result, RepairResult::Fixed { .. });

            let removed: std::collections::HashSet<EdgeId> = removed_edge_ids(&nested_commands).into_iter().collect();
            resolved.insert(target);
            resolved.extend(removed);

            commands.extend(nested_commands);
        }

        if any_succeeded {
            (RepairResult::Fixed { score: None }, commands)
        } else {
            (RepairResult::Failed, vec![])
        }
    }
}

/// Picks one edge from `candidates` per `priority` — `problematic` favors the edge with the
/// highest group-membership count (ties broken randomly), `random`/unrecognized picks uniformly.
/// `None` when `candidates` is empty (every edge in the group was route-protected).
fn pick<'a>(candidates: &'a [EdgeId], priority: &str, membership: &HashMap<EdgeId, usize>, rng: &mut dyn RngCore) -> Option<&'a EdgeId> {
    if candidates.is_empty() {
        return None;
    }
    match priority {
        PRIORITY_PROBLEMATIC => {
            let max_count = candidates.iter().map(|id| membership.get(id).copied().unwrap_or(0)).max().unwrap_or(0);
            let top: Vec<&EdgeId> = candidates.iter().filter(|id| membership.get(id).copied().unwrap_or(0) == max_count).collect();
            let idx = rng.random_range(0..top.len());
            Some(top[idx])
        }
        _ => {
            let idx = rng.random_range(0..candidates.len());
            Some(&candidates[idx])
        }
    }
}

crate::impl_erased_repair_strategy!(OneWayGroupSelectStrategy, InvalidOneWayGroupIssue);

#[cfg(test)]
#[path = "one_way_group_select_tests.rs"]
mod tests;
