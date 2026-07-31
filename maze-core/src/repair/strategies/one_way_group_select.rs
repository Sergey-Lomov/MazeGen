use rand::RngCore;
use crate::Maze;
use crate::ids::EdgeId;
use crate::space::Tessellation;
use crate::quality_control::{OneWayGroupKind, InvalidOneWayGroupIssue, InvalidOneWayIssue, INVALID_ONE_WAY};
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedSlot, NestedStrategyConfig, NestedDispatchKind};
use crate::repair::command::MutationCommand;
use crate::repair::strategies::group_select::{group_select_apply, PARAM_PRIORITY, PRIORITY_PROBLEMATIC, PRIORITY_RANDOM, PRIORITY_OPTIONS};
use crate::graph::route_protection::is_edge_on_route;

pub const PARAM_PROTECT_ROUTE: &str = "protect_route";

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
    NestedSlot { slot_id: SLOT_FIX_TARGET, kind: INVALID_ONE_WAY, min: 1, max: Some(1), dispatch_kind: NestedDispatchKind::Unordered },
];

/// Handles `INVALID_ONE_WAY_GROUP` — see GitHub issue #199, generalized in #200 and #202. Not
/// tied to any one producing check: `OneWayGroupGeometricProximityCheck`/
/// `OneWayGroupGraphProximityCheck` (proximity pairs), `OneWayGroupSuperHubCheck` (per-vertex
/// excess count), and `MaxOneWayCountCheck`/`MaxOneWayRatioCheck` (maze-wide count/ratio excess)
/// all emit the same `groups: Vec<(Vec<EdgeId>, u32)>` shape, and this strategy handles any of
/// them uniformly — hence "select", not "proximity", in the name.
///
/// GitHub issue #208: `apply()`'s own candidate-pass/budget/nested-delegation mechanics are now
/// `group_select::group_select_apply`, the reference instance every `InvalidGroupIssue<K>` select
/// strategy shares — see that function's doc comment for the full walkthrough (membership
/// priority, single global candidate pass, per-group `to_remove` budget, nested delegation). This
/// strategy's own remaining responsibility is exactly what's specific to one-ways:
/// `PARAM_PROTECT_ROUTE` (excluding route-critical edges from the candidate pool, via
/// `is_edge_on_route`), resolving `SLOT_FIX_TARGET`/`INVALID_ONE_WAY` from `nested`, and (GitHub
/// issue #210) supplying `build_nested_issue`/`element_invalidated`/`order_by_priority(params)` to
/// `group_select_apply`.
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
        let matching: Vec<&NestedStrategyConfig<T>> =
            nested.iter().filter(|n| n.slot.slot_id == SLOT_FIX_TARGET).collect();
        debug_assert!(matching.len() <= 1,
            "OneWayGroupSelectStrategy: expected_nested()'s max: Some(1) for slot \"{SLOT_FIX_TARGET}\" should prevent more than one nested strategy filling it");
        let Some(&fix_target) = matching.first() else {
            if issue.groups.is_empty() {
                return (RepairResult::Fixed { score: None }, vec![]);
            }
            return (RepairResult::Failed, vec![]);
        };

        let protect_route = matches!(params.get(PARAM_PROTECT_ROUTE), Some(StrategyParamValue::Bool(true)));
        let element_allowed = |edge: &EdgeId| !protect_route || !is_edge_on_route(maze, *edge);
        let build_nested_issue = |source_check: &str, target: &EdgeId, _others: &[EdgeId]| -> Box<dyn crate::quality_control::Issue> {
            Box::new(InvalidOneWayIssue::new_from_check(source_check, vec![*target]))
        };
        let element_invalidated = |edge: &EdgeId, nested_commands: &[MutationCommand], _maze: &Maze<T>| {
            crate::repair::removed_edge_ids(nested_commands).contains(edge)
        };

        group_select_apply::<T, OneWayGroupKind>(issue, maze, rng, preset_state, fix_target, element_allowed, build_nested_issue, element_invalidated, crate::repair::strategies::group_select::order_by_priority(params))
    }
}

crate::impl_erased_repair_strategy!(OneWayGroupSelectStrategy, InvalidOneWayGroupIssue);

#[cfg(test)]
#[path = "one_way_group_select_tests.rs"]
mod tests;
