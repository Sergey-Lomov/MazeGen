use crate::ids::NodeId;
use crate::Maze;
use crate::space::Tessellation;
use crate::repair::command::MutationCommand;
use crate::quality_control::checks::elevator_core::{elevator_groups, Elevator};

/// Finds the current `Elevator` (freshly re-resolved via `elevator_groups`) that has `stop` among
/// its own stop nodes — the shared "which elevator does this stop belong to" lookup every
/// per-stop elevator operation needs, since a group-select candidate only carries a bare `NodeId`
/// (see `ElevatorStopGroupKind`), not the elevator it came from.
pub fn find_elevator_by_stop<T: Tessellation>(maze: &Maze<T>, stop: NodeId) -> Option<Elevator> {
    elevator_groups(maze).into_iter().find(|e| e.stops.contains(&stop))
}

/// Commands to remove every `EdgeKind::Elevator` edge of the whole elevator `stop` belongs to —
/// used by `RemoveElevatorStrategy`. Returns `None` if `stop` isn't part of any current elevator.
pub fn remove_elevator_commands<T: Tessellation>(maze: &Maze<T>, stop: NodeId) -> Option<Vec<MutationCommand>> {
    let elevator = find_elevator_by_stop(maze, stop)?;
    Some(elevator.edges.iter().map(|&id| MutationCommand::RemoveEdgeWithReverse { id }).collect())
}

/// Commands to remove one `stop` from its elevator — every `Elevator`-kind edge between `stop`
/// and any of the elevator's other stops, leaving the rest of the elevator (and its remaining
/// stops' own fan) untouched. Returns `None` if `stop` isn't part of any current elevator. Used by
/// `RemoveElevatorStopStrategy` — see GitHub issue #399.
pub fn remove_stop_commands<T: Tessellation>(maze: &Maze<T>, stop: NodeId) -> Option<Vec<MutationCommand>> {
    let elevator = find_elevator_by_stop(maze, stop)?;
    let commands = elevator.edges.iter()
        .filter(|&&id| {
            maze.graph.edge(id).is_some_and(|e| e.from == stop || e.to == stop)
        })
        .map(|&id| MutationCommand::RemoveEdgeWithReverse { id })
        .collect();
    Some(commands)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, MultiLevelField, SquareTessellation, SquarePoint, square_rect};

    fn three_stop_elevator() -> (Maze<SquareTessellation>, Vec<NodeId>) {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let floors: Vec<_> = (0..3)
            .map(|_| mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap()))
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let nodes: Vec<NodeId> = floors.iter().map(|&l| mf.node_at(l, SquarePoint { x: 0, y: 0 }).unwrap()).collect();
        for i in 0..nodes.len() {
            for j in (i + 1)..nodes.len() {
                g.add_edge(nodes[i], nodes[j], EdgeKind::Elevator);
                g.add_edge(nodes[j], nodes[i], EdgeKind::Elevator);
            }
        }
        (Maze::new(mf, g), nodes)
    }

    #[test]
    fn find_elevator_by_stop_locates_the_owning_elevator() {
        let (maze, nodes) = three_stop_elevator();
        let elevator = find_elevator_by_stop(&maze, nodes[1]).expect("stop must belong to an elevator");
        assert_eq!(elevator.stops.len(), 3);
    }

    #[test]
    fn find_elevator_by_stop_returns_none_for_unrelated_node() {
        let (maze, _nodes) = three_stop_elevator();
        let unrelated = maze.field.all_node_ids().find(|&n| !maze.graph.edges().any(|e| e.from == n || e.to == n));
        if let Some(n) = unrelated {
            assert!(find_elevator_by_stop(&maze, n).is_none());
        }
    }

    #[test]
    fn remove_stop_commands_only_touch_edges_incident_to_the_target_stop() {
        let (maze, nodes) = three_stop_elevator();
        let commands = remove_stop_commands(&maze, nodes[0]).expect("stop must belong to an elevator");
        assert_eq!(commands.len(), 2, "stop 0 has 2 incident unordered pairs (with stop 1 and stop 2)");
    }

    #[test]
    fn remove_elevator_commands_cover_every_edge() {
        let (maze, _nodes) = three_stop_elevator();
        let stop = _nodes[0];
        let commands = remove_elevator_commands(&maze, stop).expect("stop must belong to an elevator");
        assert_eq!(commands.len(), 3, "3 stops -> 3 unordered pairs total");
    }

    #[test]
    fn remove_stop_commands_none_when_stop_has_no_elevator() {
        let (maze, _nodes) = three_stop_elevator();
        let unrelated = maze.field.all_node_ids().find(|&n| !maze.graph.edges().any(|e| e.from == n || e.to == n));
        if let Some(n) = unrelated {
            assert!(remove_stop_commands(&maze, n).is_none());
        }
    }
}
