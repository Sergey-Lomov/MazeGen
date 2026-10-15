use crate::Maze;
use crate::generation::{PresetState, bidirectional_edge_feasible};
use crate::ids::NodeId;
use crate::quality_control::checks::elevator_core::{Elevator, elevator_groups};
use crate::repair::command::MutationCommand;
use crate::space::{LevelId, Tessellation};

/// Finds the current `Elevator` (freshly re-resolved via `elevator_groups`) that has `stop` among
/// its own stop nodes — the shared "which elevator does this stop belong to" lookup every
/// per-stop elevator operation needs, since a group-select candidate only carries a bare `NodeId`
/// (see `ElevatorStopGroupKind`), not the elevator it came from.
pub fn find_elevator_by_stop<T: Tessellation>(maze: &Maze<T>, stop: NodeId) -> Option<Elevator> {
    elevator_groups(maze)
        .into_iter()
        .find(|e| e.stops.contains(&stop))
}

/// Commands to remove every `EdgeKind::Elevator` edge of the whole elevator `stop` belongs to —
/// used by `RemoveElevatorStrategy`. Returns `None` if `stop` isn't part of any current elevator.
pub fn remove_elevator_commands<T: Tessellation>(
    maze: &Maze<T>,
    stop: NodeId,
) -> Option<Vec<MutationCommand>> {
    let elevator = find_elevator_by_stop(maze, stop)?;
    Some(
        elevator
            .edges
            .iter()
            .map(|&id| MutationCommand::RemoveEdgeWithReverse { id })
            .collect(),
    )
}

/// Commands to remove one `stop` from its elevator — every `Elevator`-kind edge between `stop`
/// and any of the elevator's other stops, leaving the rest of the elevator (and its remaining
/// stops' own fan) untouched. Returns `None` if `stop` isn't part of any current elevator. Used by
/// `RemoveElevatorStopStrategy` — see GitHub issue #399.
pub fn remove_stop_commands<T: Tessellation>(
    maze: &Maze<T>,
    stop: NodeId,
) -> Option<Vec<MutationCommand>> {
    let elevator = find_elevator_by_stop(maze, stop)?;
    let commands = elevator
        .edges
        .iter()
        .filter(|&&id| {
            maze.graph
                .edge(id)
                .is_some_and(|e| e.from == stop || e.to == stop)
        })
        .map(|&id| MutationCommand::RemoveEdgeWithReverse { id })
        .collect();
    Some(commands)
}

/// Commands to add `elevator` a new stop on `target_level`, at the same field point every other
/// stop of `elevator` already shares (an elevator stops at one column, by construction — see
/// `Elevator`'s doc comment) — one `AddBidirectionalElevator` command per existing stop, fanning
/// the new stop out to the whole elevator, mirroring `AddElevatorStrategy`'s own fully-connected-
/// fan convention. Used by `AddElevatorStopStrategy`'s reuse-existing-elevator branch (GitHub
/// issue #408).
///
/// Returns `None` if: `elevator` has no stops to derive a point from; `target_level` has no node
/// at that point; or the new stop would collide with (already-edged, or preset-infeasible against)
/// any existing stop — the caller falls back to the other repair branch in that case, same as
/// `AddElevatorStrategy`'s `stops_feasible` gate.
pub fn add_stop_command<T: Tessellation>(
    maze: &Maze<T>,
    elevator: &Elevator,
    target_level: LevelId,
    preset_state: &PresetState,
) -> Option<Vec<MutationCommand>> {
    let &existing = elevator.stops.first()?;
    let point = maze.field.point_of(existing)?;
    let new_stop = maze.field.node_at(target_level, point)?;

    if elevator.stops.contains(&new_stop) {
        return None;
    }

    for &stop in &elevator.stops {
        if maze.graph.edge_between(stop, new_stop).is_some()
            || maze.graph.edge_between(new_stop, stop).is_some()
        {
            return None;
        }
        if !bidirectional_edge_feasible(preset_state, stop, new_stop) {
            return None;
        }
    }

    Some(
        elevator
            .stops
            .iter()
            .map(|&stop| MutationCommand::AddBidirectionalElevator {
                a: stop,
                b: new_stop,
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::space::{Field, MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use std::sync::Arc;

    fn three_stop_elevator() -> (Maze<SquareTessellation>, Vec<NodeId>) {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let floors: Vec<_> = (0..3)
            .map(|_| {
                mf.add_level(
                    Field::<SquareTessellation>::new(Arc::default(), square_rect(1, 1), &mut ids)
                        .unwrap(),
                )
            })
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<NodeId> = floors
            .iter()
            .map(|&l| mf.node_at(l, SquarePoint { x: 0, y: 0 }).unwrap())
            .collect();
        for i in 0..nodes.len() {
            for j in (i + 1)..nodes.len() {
                g.add_edge(nodes[i], nodes[j], EdgeKind::Elevator);
                g.add_edge(nodes[j], nodes[i], EdgeKind::Elevator);
            }
        }
        (Maze::new(mf, g), nodes)
    }

    /// Same as `three_stop_elevator`, but with a 4th floor left untouched by any stop — a free
    /// target for `add_stop_command` to add a new stop on.
    fn three_stop_elevator_with_a_free_floor()
    -> (Maze<SquareTessellation>, Vec<NodeId>, crate::space::LevelId) {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let floors: Vec<_> = (0..4)
            .map(|_| {
                mf.add_level(
                    Field::<SquareTessellation>::new(Arc::default(), square_rect(1, 1), &mut ids)
                        .unwrap(),
                )
            })
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<NodeId> = floors[..3]
            .iter()
            .map(|&l| mf.node_at(l, SquarePoint { x: 0, y: 0 }).unwrap())
            .collect();
        for i in 0..nodes.len() {
            for j in (i + 1)..nodes.len() {
                g.add_edge(nodes[i], nodes[j], EdgeKind::Elevator);
                g.add_edge(nodes[j], nodes[i], EdgeKind::Elevator);
            }
        }
        (Maze::new(mf, g), nodes, floors[3])
    }

    #[test]
    fn find_elevator_by_stop_locates_the_owning_elevator() {
        let (maze, nodes) = three_stop_elevator();
        let elevator =
            find_elevator_by_stop(&maze, nodes[1]).expect("stop must belong to an elevator");
        assert_eq!(elevator.stops.len(), 3);
    }

    #[test]
    fn find_elevator_by_stop_returns_none_for_unrelated_node() {
        let (maze, _nodes) = three_stop_elevator();
        let unrelated = maze
            .field
            .all_node_ids()
            .find(|&n| !maze.graph.edges().any(|e| e.from == n || e.to == n));
        if let Some(n) = unrelated {
            assert!(find_elevator_by_stop(&maze, n).is_none());
        }
    }

    #[test]
    fn remove_stop_commands_only_touch_edges_incident_to_the_target_stop() {
        let (maze, nodes) = three_stop_elevator();
        let commands =
            remove_stop_commands(&maze, nodes[0]).expect("stop must belong to an elevator");
        assert_eq!(
            commands.len(),
            2,
            "stop 0 has 2 incident unordered pairs (with stop 1 and stop 2)"
        );
    }

    #[test]
    fn remove_elevator_commands_cover_every_edge() {
        let (maze, _nodes) = three_stop_elevator();
        let stop = _nodes[0];
        let commands =
            remove_elevator_commands(&maze, stop).expect("stop must belong to an elevator");
        assert_eq!(commands.len(), 3, "3 stops -> 3 unordered pairs total");
    }

    #[test]
    fn remove_stop_commands_none_when_stop_has_no_elevator() {
        let (maze, _nodes) = three_stop_elevator();
        let unrelated = maze
            .field
            .all_node_ids()
            .find(|&n| !maze.graph.edges().any(|e| e.from == n || e.to == n));
        if let Some(n) = unrelated {
            assert!(remove_stop_commands(&maze, n).is_none());
        }
    }

    #[test]
    fn add_stop_command_fans_the_new_stop_to_every_existing_stop() {
        let (maze, nodes, free_level) = three_stop_elevator_with_a_free_floor();
        let elevator = find_elevator_by_stop(&maze, nodes[0]).unwrap();
        let commands = add_stop_command(&maze, &elevator, free_level, &PresetState::empty())
            .expect("free floor must be feasible");
        assert_eq!(
            commands.len(),
            3,
            "3 existing stops -> 3 new AddBidirectionalElevator commands"
        );
        let new_stop = maze
            .field
            .node_at(free_level, SquarePoint { x: 0, y: 0 })
            .unwrap();
        for cmd in &commands {
            match cmd {
                MutationCommand::AddBidirectionalElevator { a, b } => {
                    assert!(
                        nodes.contains(a) && *b == new_stop,
                        "each command must pair an existing stop with the new stop"
                    );
                }
                _ => panic!("unexpected command variant"),
            }
        }
    }

    #[test]
    fn add_stop_command_none_when_target_level_already_has_a_stop() {
        let (maze, nodes) = three_stop_elevator();
        let elevator = find_elevator_by_stop(&maze, nodes[0]).unwrap();
        let existing_level = maze.field.level_of(nodes[1]).unwrap();
        assert!(
            add_stop_command(&maze, &elevator, existing_level, &PresetState::empty()).is_none()
        );
    }

    #[test]
    fn add_stop_command_none_when_preset_blocks_the_new_pair() {
        let (maze, nodes, free_level) = three_stop_elevator_with_a_free_floor();
        let elevator = find_elevator_by_stop(&maze, nodes[0]).unwrap();
        let new_stop = maze
            .field
            .node_at(free_level, SquarePoint { x: 0, y: 0 })
            .unwrap();
        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((nodes[0], new_stop));
        assert!(add_stop_command(&maze, &elevator, free_level, &preset_state).is_none());
    }
}
