use std::collections::HashMap;
use rand::{Rng, RngCore};
use crate::Maze;
use crate::ids::EdgeId;
use crate::space::Tessellation;
use crate::quality_control::{IssueKindConst, TeleportGroupProximityIssue};
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;
use crate::graph::route_protection::is_teleport_route_protected;

/// Records `id` (and its opposite-direction `Teleport` counterpart, if any) as resolved, mirroring
/// what `try_remove_teleport_with_reverse`'s returned `Vec<EdgeId>` tracked under the old in-place
/// contract — read-only here (GitHub issue #118, `Specs/repair.md`'s immutable-snapshot contract):
/// a `Teleport` edge can never itself be preset-protected (only Basic edges can), so removal is
/// always logically "successful" for the purpose of this bookkeeping regardless of whether the
/// resulting `RemoveTeleportWithReverse` command later gets dropped on revalidation.
fn mark_removed<T: Tessellation>(maze: &Maze<T>, id: EdgeId, removed: &mut std::collections::HashSet<EdgeId>) {
    removed.insert(id);
    if let Some(reverse_id) = maze.graph.teleport_reverse(id) {
        removed.insert(reverse_id);
    }
}

pub const PARAM_PRIORITY: &str = "priority";
pub const PARAM_PROTECT_ROUTE: &str = "protect_route";

pub const PRIORITY_RANDOM: &str = "random";
pub const PRIORITY_PROBLEMATIC: &str = "problematic";

static PRIORITY_OPTIONS: &[&str] = &[PRIORITY_RANDOM, PRIORITY_PROBLEMATIC];

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_PRIORITY,
        label: "Removal priority",
        kind: StrategyParamKind::Enum { options: PRIORITY_OPTIONS, default: PRIORITY_PROBLEMATIC },
    },
    StrategyParam {
        id: PARAM_PROTECT_ROUTE,
        label: "Protect route teleports",
        kind: StrategyParamKind::Bool { default: true },
    },
];

/// Handles `TELEPORT_GROUP_PROXIMITY` — see GitHub issue #75. For each problematic pair flagged by
/// `TeleportGroupProximityCheck`, removes one of the two teleport edges: removing a teleport
/// immediately drops every problematic pair that references it, so a pair already resolved by an
/// earlier removal in the same `apply()` call is skipped rather than acted on twice.
///
/// **`issue.data` is mandatory for this kind**: `IssueData::TeleportProximityPairs { pairs }` is
/// the producing check's result — there is no other channel to learn which edges are paired.
///
/// `PARAM_PROTECT_ROUTE` (see GitHub issue #78): when enabled, the side of a pair chosen for
/// removal is skipped if it (or, for a two-way teleport, its opposite-direction counterpart)
/// lies on the maze's current start->finish route (`is_teleport_route_protected`); the other
/// side of the pair is removed instead. If both sides are route-protected, the pair is left
/// untouched entirely (still counted as resolved — see `apply`'s doc comment).
///
/// Removing a chosen edge also removes its opposite-direction `Teleport` counterpart, if any
/// (`try_remove_teleport_with_reverse`), so a two-way teleport is never left half-removed. Both
/// ids returned by that call are recorded in `removed`, so a later pair referencing the reverse
/// direction is correctly treated as already resolved.
pub struct TeleportGroupProximityStrategy;

impl<T: Tessellation> RepairStrategy<T, TeleportGroupProximityIssue> for TeleportGroupProximityStrategy {
    fn strategy_id(&self) -> &'static str { "teleport_group_proximity" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        issue: &TeleportGroupProximityIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        _preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let pairs = &issue.pairs;
        if pairs.is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let priority = match params.get(PARAM_PRIORITY) {
            Some(StrategyParamValue::Enum(v)) => v.as_str(),
            _ => PRIORITY_PROBLEMATIC,
        };
        let protect_route = matches!(params.get(PARAM_PROTECT_ROUTE), Some(StrategyParamValue::Bool(true)));

        // Membership counts computed once up front, over the original (unresolved) pair set —
        // "belongs to more other problematic pairs" is a snapshot of the check's findings, not a
        // running count that would otherwise favor whichever edge happens to be processed first.
        let mut membership: HashMap<EdgeId, usize> = HashMap::new();
        for &(a, b) in pairs {
            *membership.entry(a).or_insert(0) += 1;
            *membership.entry(b).or_insert(0) += 1;
        }

        let mut removed: std::collections::HashSet<EdgeId> = std::collections::HashSet::new();
        let mut commands = Vec::new();
        for &(a, b) in pairs {
            // Removing a teleport drops every pair referencing it — if either side of this pair
            // was already removed while resolving an earlier pair, this one is already resolved.
            if removed.contains(&a) || removed.contains(&b) {
                continue;
            }
            let to_remove = match priority {
                PRIORITY_PROBLEMATIC => {
                    let count_a = membership.get(&a).copied().unwrap_or(0);
                    let count_b = membership.get(&b).copied().unwrap_or(0);
                    if count_a > count_b { a }
                    else if count_b > count_a { b }
                    else if rng.random_bool(0.5) { a } else { b }
                }
                _ => if rng.random_bool(0.5) { a } else { b },
            };

            if protect_route && is_teleport_route_protected(maze, to_remove) {
                // The chosen side is route-critical — fall back to the other side of the pair
                // instead. If that side is also route-critical, neither is removed; the pair is
                // still considered resolved (see the strategy's own doc comment).
                let fallback = if to_remove == a { b } else { a };
                if !is_teleport_route_protected(maze, fallback) {
                    // Also removes fallback's opposite-direction Teleport counterpart, if any —
                    // both removed ids are recorded so a later pair referencing either one (e.g.
                    // the reverse direction, close to some other teleport too) is skipped as
                    // already resolved instead of attempting a no-op removal.
                    commands.push(MutationCommand::RemoveTeleportWithReverse { id: fallback });
                    mark_removed(maze, fallback, &mut removed);
                }
                continue;
            }

            commands.push(MutationCommand::RemoveTeleportWithReverse { id: to_remove });
            mark_removed(maze, to_remove, &mut removed);
        }

        (RepairResult::Fixed { score: None }, commands)
    }
}

crate::impl_erased_repair_strategy!(TeleportGroupProximityStrategy, TeleportGroupProximityIssue);

#[cfg(test)]
#[path = "teleport_group_proximity_tests.rs"]
mod tests;
