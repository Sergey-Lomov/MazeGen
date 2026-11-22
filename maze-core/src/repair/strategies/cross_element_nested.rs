use crate::Maze;
use crate::graph::route_protection::is_edge_on_route;
use crate::quality_control::cross_element::{
    CrossElement, cross_element_edges, cross_element_still_violates, split_tile_nodes_of,
};
use crate::quality_control::{
    INVALID_ELEVATOR_STOP, INVALID_ONE_WAY, INVALID_SPLIT_TILE, INVALID_TELEPORT,
    INVALID_VERTICAL_PASSAGE, InvalidElevatorStopIssue, InvalidOneWayIssue, InvalidSplitTileIssue,
    InvalidTeleportIssue, InvalidVerticalPassageIssue, Issue, SplitTileNodes,
};
use crate::repair::strategy::{NestedDispatchKind, NestedSlot};
use crate::space::Tessellation;

/// Per-type nested slots of `CrossElementRemoveStrategy` — one per removable cross-element type
/// (GitHub issues #376, #1060). Start / Finish have no slot: they are never removable.
/// `CrossElementGroupSelectStrategy` reaches these through its own single `fix_target` slot and
/// only shares `route_blocked`.
pub const SLOT_TELEPORT_FIX: &str = "teleport_fix";
pub const SLOT_ONE_WAY_FIX: &str = "one_way_fix";
pub const SLOT_VERTICAL_PASSAGE_FIX: &str = "vertical_passage_fix";
pub const SLOT_ELEVATOR_STOP_FIX: &str = "elevator_stop_fix";
pub const SLOT_SPLIT_FIX: &str = "split_fix";

pub static NESTED_SLOTS: &[NestedSlot] = &[
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

/// The nested slot that can fix `element`, `None` for `Start` / `Finish`.
pub fn slot_for(element: &CrossElement) -> Option<&'static str> {
    match element {
        CrossElement::Teleport(_) => Some(SLOT_TELEPORT_FIX),
        CrossElement::OneWay(_) => Some(SLOT_ONE_WAY_FIX),
        CrossElement::VerticalPassage(_) => Some(SLOT_VERTICAL_PASSAGE_FIX),
        CrossElement::ElevatorStop(_) => Some(SLOT_ELEVATOR_STOP_FIX),
        CrossElement::Split(_) => Some(SLOT_SPLIT_FIX),
        CrossElement::Start(_) | CrossElement::Finish(_) => None,
    }
}

/// Whether `element`'s removal is blocked because one of its underlying edges is on the current
/// route and `protect_route` is set. Split / Start / Finish own no edges, so this is always
/// `false` for them.
pub fn route_blocked<T: Tessellation>(
    maze: &Maze<T>,
    protect_route: bool,
    element: &CrossElement,
) -> bool {
    protect_route
        && cross_element_edges(maze, element)
            .iter()
            .any(|&e| is_edge_on_route(maze, e))
}

/// The synthetic single-entity issue for `element`, re-resolving the entity from `maze` at call
/// time (never a value cached in the `CrossElement`). `None` for `Start`/`Finish` and for an
/// element that no longer exists.
pub fn make_nested_issue<T: Tessellation>(
    maze: &Maze<T>,
    element: &CrossElement,
    check: &str,
) -> Option<Box<dyn Issue>> {
    if !cross_element_still_violates(maze, element) {
        return None;
    }
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
            // >= 2 stops; removing just this one stop (not the whole elevator) fixes the element.
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
