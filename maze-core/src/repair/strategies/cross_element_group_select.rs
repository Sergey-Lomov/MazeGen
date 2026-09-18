use crate::Maze;
use crate::generation::PresetState;
use crate::graph::route_protection::is_edge_on_route;
use crate::quality_control::cross_element::{
    CrossElement, cross_element_edges, cross_element_preset_locked, cross_element_still_violates,
    split_tile_nodes_of,
};
use crate::quality_control::{
    CrossElementGroupKind, INVALID_ELEVATOR_STOP, INVALID_ONE_WAY, INVALID_SPLIT_TILE,
    INVALID_TELEPORT, INVALID_VERTICAL_PASSAGE, InvalidCrossElementGroupIssue,
    InvalidElevatorStopIssue, InvalidOneWayIssue, InvalidSplitTileIssue, InvalidTeleportIssue,
    InvalidVerticalPassageIssue, Issue, SplitTileNodes,
};
use crate::repair::command::MutationCommand;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategies::group_select::{
    PARAM_PRIORITY, PRIORITY_OPTIONS, PRIORITY_PROBLEMATIC, multi_target_group_select_apply,
    order_by_priority,
};
use crate::repair::strategy::{
    NestedDispatchKind, NestedSlot, NestedStrategyConfig, RepairStrategy,
};
use crate::space::Tessellation;
use rand::RngCore;
use std::collections::HashMap;

static PARAMS: &[StrategyParam] = &[StrategyParam {
    id: PARAM_PRIORITY,
    label: "Fix priority",
    kind: StrategyParamKind::Enum {
        options: PRIORITY_OPTIONS,
        default: PRIORITY_PROBLEMATIC,
    },
}];

/// One nested slot per removable cross-element type — see GitHub issue #376. A cross-element pair
/// is heterogeneous (a teleport near a split tile), so unlike the single-slot
/// `OneWayGroupSelectStrategy` this strategy resolves a *different* nested strategy per candidate
/// depending on its type. Start / Finish have no slot: they are never removable.
pub const SLOT_TELEPORT_FIX: &str = "teleport_fix";
pub const SLOT_ONE_WAY_FIX: &str = "one_way_fix";
pub const SLOT_VERTICAL_PASSAGE_FIX: &str = "vertical_passage_fix";
pub const SLOT_ELEVATOR_STOP_FIX: &str = "elevator_stop_fix";
pub const SLOT_SPLIT_FIX: &str = "split_fix";

static NESTED_SLOTS: &[NestedSlot] = &[
    NestedSlot {
        slot_id: SLOT_TELEPORT_FIX,
        kind: INVALID_TELEPORT,
        min: 1,
        max: Some(1),
        dispatch_kind: NestedDispatchKind::Unordered,
    },
    NestedSlot {
        slot_id: SLOT_ONE_WAY_FIX,
        kind: INVALID_ONE_WAY,
        min: 1,
        max: Some(1),
        dispatch_kind: NestedDispatchKind::Unordered,
    },
    NestedSlot {
        slot_id: SLOT_VERTICAL_PASSAGE_FIX,
        kind: INVALID_VERTICAL_PASSAGE,
        min: 1,
        max: Some(1),
        dispatch_kind: NestedDispatchKind::Unordered,
    },
    NestedSlot {
        slot_id: SLOT_ELEVATOR_STOP_FIX,
        kind: INVALID_ELEVATOR_STOP,
        min: 1,
        max: Some(1),
        dispatch_kind: NestedDispatchKind::Unordered,
    },
    NestedSlot {
        slot_id: SLOT_SPLIT_FIX,
        kind: INVALID_SPLIT_TILE,
        min: 1,
        max: Some(1),
        dispatch_kind: NestedDispatchKind::Unordered,
    },
];

/// Handles `INVALID_CROSS_ELEMENT_GROUP` — see GitHub issue #376. Produced by
/// `CrossElementGeometricProximityCheck` / `CrossElementGraphProximityCheck`: one group per
/// too-close unordered pair of logical elements (`to_remove: 1` — removing either breaks the
/// pair).
///
/// Built on `group_select::multi_target_group_select_apply` (the multi-slot generalization of
/// `group_select_apply`): its own `nested_for` hook maps each candidate `CrossElement` to the
/// nested slot that can fix it and a freshly re-resolved synthetic issue, or `None` when the
/// element cannot be acted on:
/// - `Start` / `Finish` — never removable, always `None`. A `[Start, Finish]` pair (or any pair
///   both of whose elements are unremovable) has no actionable candidate; with
///   `wholly_protected_auto_resolve: false` its budget is kept and the strategy reports `Failed`,
///   so the issue survives and the user sees the constraint is unmet.
/// - A route-critical edge element under `protect_route` — `None` (its own underlying edge lies
///   on the current start->finish route).
///
/// `protect_route` (rule-level, resolved by the factory from `RuleParams`, mirroring
/// `OneWayGroupSelectStrategy` — see GitHub issue #253) — not a `StrategyParam`, no local
/// override.
pub struct CrossElementGroupSelectStrategy {
    pub protect_route: bool,
}

impl CrossElementGroupSelectStrategy {
    /// Whether `element`'s removal is blocked because one of its underlying edges is on the
    /// current route and `protect_route` is set. Split / Start / Finish own no edges, so this is
    /// always `false` for them (Start/Finish are excluded elsewhere, as unremovable).
    fn route_blocked<T: Tessellation>(&self, maze: &Maze<T>, element: &CrossElement) -> bool {
        self.protect_route
            && cross_element_edges(maze, element)
                .iter()
                .any(|&e| is_edge_on_route(maze, e))
    }

    /// The synthetic single-entity issue for `element`, re-resolving the entity from `maze` at
    /// call time (never a value cached in the `CrossElement`). `None` for `Start`/`Finish` and
    /// for an element that no longer exists.
    fn make_nested_issue<T: Tessellation>(
        maze: &Maze<T>,
        element: &CrossElement,
    ) -> Option<Box<dyn Issue>> {
        if !cross_element_still_violates(maze, element) {
            return None;
        }
        let check = "cross_element_group_select";
        match element {
            CrossElement::Teleport(_) => {
                let edge = *cross_element_edges(maze, element).first()?;
                Some(Box::new(InvalidTeleportIssue::new_from_check(
                    check,
                    vec![edge],
                )))
            }
            CrossElement::OneWay(id) => Some(Box::new(InvalidOneWayIssue::new_from_check(
                check,
                vec![*id],
            ))),
            CrossElement::VerticalPassage(id) => Some(Box::new(
                InvalidVerticalPassageIssue::new_from_check(check, vec![*id]),
            )),
            CrossElement::ElevatorStop(stop) => {
                // `cross_element_still_violates` already confirmed the stop is in an elevator with
                // >= 2 stops; removing just this one stop (not the whole elevator) breaks the pair.
                Some(Box::new(InvalidElevatorStopIssue::new_from_check(
                    check,
                    vec![*stop],
                )))
            }
            CrossElement::Split(tile) => {
                let nodes = split_tile_nodes_of(maze, &tile.0);
                if nodes.len() < 2 {
                    return None;
                }
                Some(Box::new(InvalidSplitTileIssue::new_from_check(
                    check,
                    vec![SplitTileNodes::new(nodes)],
                )))
            }
            CrossElement::Start(_) | CrossElement::Finish(_) => None,
        }
    }

    fn slot_for(element: &CrossElement) -> Option<&'static str> {
        match element {
            CrossElement::Teleport(_) => Some(SLOT_TELEPORT_FIX),
            CrossElement::OneWay(_) => Some(SLOT_ONE_WAY_FIX),
            CrossElement::VerticalPassage(_) => Some(SLOT_VERTICAL_PASSAGE_FIX),
            CrossElement::ElevatorStop(_) => Some(SLOT_ELEVATOR_STOP_FIX),
            CrossElement::Split(_) => Some(SLOT_SPLIT_FIX),
            CrossElement::Start(_) | CrossElement::Finish(_) => None,
        }
    }
}

impl<T: Tessellation> RepairStrategy<T, InvalidCrossElementGroupIssue>
    for CrossElementGroupSelectStrategy
{
    fn strategy_id(&self) -> &'static str {
        "cross_element_group_select"
    }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn expected_nested(&self) -> &'static [NestedSlot] {
        NESTED_SLOTS
    }

    fn apply(
        &self,
        issue: &InvalidCrossElementGroupIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        // One entry per filled slot, plus its pre-built params (mirrors `group_select_apply`'s
        // own `build_params(nested.strategy.params(), ...)`).
        let mut slots: HashMap<&'static str, (&NestedStrategyConfig<T>, StrategyParams)> =
            HashMap::new();
        for n in nested {
            let built =
                crate::repair::params::build_params(n.strategy.params(), Some(&n.param_overrides));
            slots.entry(n.slot.slot_id).or_insert((n, built));
        }

        if issue.groups().is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let nested_for = |element: &CrossElement, _others: &[CrossElement]| {
            if self.route_blocked(maze, element) {
                return None;
            }
            // A preset-locked element (every underlying edge is a preset connection) must never be
            // removed by repair -- unlike the same-type proximity checks, the cross-element checks
            // do flag preset elements (the user still sees the constraint is violated), so the skip
            // lives here in the strategy, not in the check. A pair both of whose elements are
            // preset-locked has no actionable candidate: `wholly_protected_auto_resolve: false`
            // keeps its budget, the strategy reports `Failed`, and the issue survives so the user
            // sees the unmet constraint -- same handling as a `[Start, Finish]` pair.
            if cross_element_preset_locked(maze, preset_state, element) {
                return None;
            }
            let slot_id = Self::slot_for(element)?;
            let (cfg, cfg_params) = slots.get(slot_id)?;
            let synthetic = Self::make_nested_issue(maze, element)?;
            Some((*cfg, cfg_params, synthetic))
        };

        // Whether `element` (some other still-live candidate, not the one just fixed) is moot
        // after `nested_commands` -- inferred from the commands themselves, not from `maze`'s
        // current graph, which is *not yet mutated* at this point (the strategy holds only `&Maze`;
        // actual mutation happens later in `apply_commands`). Mirrors
        // `TeleportGroupSelectStrategy`'s own `element_invalidated`: an element is moot when one of
        // its underlying edges (read from the still-unmutated `maze`, which is fine -- ids are
        // stable, only aliveness changes) is among the edges the just-applied commands remove.
        let element_invalidated =
            |element: &CrossElement, cmds: &[MutationCommand], maze: &Maze<T>| {
                let removed = crate::repair::command::removed_edge_ids(cmds);
                cross_element_edges(maze, element)
                    .iter()
                    .any(|id| removed.contains(id))
            };

        multi_target_group_select_apply::<T, CrossElementGroupKind>(
            issue.groups(),
            issue.invalid_sources(),
            maze,
            rng,
            preset_state,
            nested_for,
            element_invalidated,
            order_by_priority(params),
            false,
        )
    }
}

crate::impl_erased_repair_strategy!(
    CrossElementGroupSelectStrategy,
    InvalidCrossElementGroupIssue
);

#[cfg(test)]
#[path = "cross_element_group_select_tests.rs"]
mod tests;
