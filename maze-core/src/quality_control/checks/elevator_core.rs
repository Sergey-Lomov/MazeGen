use crate::Maze;
use crate::graph::EdgeKind;
use crate::ids::{EdgeId, NodeId};
use crate::space::{LevelId, Tessellation};
use std::collections::{HashMap, HashSet};

/// One `Elevator` — a maximal connected component of `EdgeKind::Elevator` edges, i.e. one
/// user-visible elevator's full stop set. Generation/preset setup always wires an elevator's
/// floors as a fully-connected two-way fan (see `generation::vertex_based`/`preset_state`'s
/// `build_initial_bidirectional_edge` loop), so in practice every component is a complete graph —
/// but this finder makes no such assumption: it just follows whatever `Elevator` edges actually
/// exist, so a partially-repaired or hand-edited fan is still recognized as one elevator rather
/// than silently splitting into several.
pub struct Elevator {
    /// Every node the elevator stops at (its floors), unordered.
    pub stops: Vec<NodeId>,
    /// One canonical `EdgeId` per unordered node pair actually connected within this elevator —
    /// used for highlight/preset-lock payloads and for removal. A pair with only one direction
    /// present (a partially-repaired fan) contributes that single edge; a two-way pair
    /// contributes just one of its two directions (removal strategies resolve the reverse via
    /// `Graph::edge_between`, mirroring `RemoveEdgeWithReverse`'s own contract).
    pub edges: Vec<EdgeId>,
}

/// Every elevator in the maze — see `Elevator`'s doc comment. Order is not guaranteed to be
/// stable across calls with different internal `HashMap` iteration, so callers needing
/// determinism (checks emitting issues) should sort their own output.
pub fn elevator_groups<T: Tessellation>(maze: &Maze<T>) -> Vec<Elevator> {
    let mut adjacency: HashMap<NodeId, Vec<(NodeId, EdgeId)>> = HashMap::new();
    for edge in maze.graph.edges().filter(|e| e.kind == EdgeKind::Elevator) {
        adjacency
            .entry(edge.from)
            .or_default()
            .push((edge.to, edge.id));
    }

    let mut visited: HashSet<NodeId> = HashSet::new();
    let mut groups = Vec::new();

    for &start in adjacency.keys() {
        if visited.contains(&start) {
            continue;
        }
        let mut stack = vec![start];
        let mut component: HashSet<NodeId> = HashSet::new();
        while let Some(node) = stack.pop() {
            if !component.insert(node) {
                continue;
            }
            visited.insert(node);
            for &(neighbor, _) in adjacency.get(&node).into_iter().flatten() {
                if !component.contains(&neighbor) {
                    stack.push(neighbor);
                }
            }
        }

        let mut seen_pairs: HashSet<(NodeId, NodeId)> = HashSet::new();
        let mut edges = Vec::new();
        for &node in &component {
            for &(neighbor, eid) in adjacency.get(&node).into_iter().flatten() {
                let key = if node < neighbor {
                    (node, neighbor)
                } else {
                    (neighbor, node)
                };
                if seen_pairs.insert(key) {
                    edges.push(eid);
                }
            }
        }

        let mut stops: Vec<NodeId> = component.into_iter().collect();
        stops.sort_unstable();
        groups.push(Elevator { stops, edges });
    }

    groups
}

/// `elevator.stops`' distinct floor indices, sorted ascending — the elevator's "stop count" is
/// `stop_floors(elevator, maze).len()`, not `elevator.stops.len()` directly, since a
/// (currently never generated, but not assumed impossible) multi-node-per-floor elevator stop
/// would otherwise double-count a floor.
pub fn stop_floors<T: Tessellation>(elevator: &Elevator, maze: &Maze<T>) -> Vec<usize> {
    let mut floors: Vec<usize> = elevator
        .stops
        .iter()
        .filter_map(|&n| maze.field.level_index_of(n))
        .collect();
    floors.sort_unstable();
    floors.dedup();
    floors
}

/// Every elevator stop node grouped by the floor it sits on, across every elevator in the maze —
/// shared by `MaxElevatorStopsPerFloorCheck` (extracted here, GitHub issue #408) and
/// `MinElevatorStopsPerAreaCountCheck`/`MinElevatorStopsPerAreaDensityCheck`'s `PerFloor` scope.
pub fn elevator_stops_per_floor<T: Tessellation>(maze: &Maze<T>) -> HashMap<LevelId, Vec<NodeId>> {
    let mut per_floor: HashMap<LevelId, Vec<NodeId>> = HashMap::new();
    for elevator in elevator_groups(maze) {
        for stop in elevator.stops {
            if let Some(level) = maze.field.level_of(stop) {
                per_floor.entry(level).or_default().push(stop);
            }
        }
    }
    per_floor
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::{Field, MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};

    fn three_floor_maze() -> (Maze<SquareTessellation>, Vec<NodeId>) {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let floors: Vec<_> = (0..3)
            .map(|_| {
                mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap())
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
        (Maze::new(mf, g), nodes)
    }

    #[test]
    fn empty_maze_has_no_elevators() {
        let (maze, _nodes) = three_floor_maze();
        assert!(elevator_groups(&maze).is_empty());
    }

    #[test]
    fn three_stop_fan_is_one_elevator() {
        let (mut maze, nodes) = three_floor_maze();
        for i in 0..nodes.len() {
            for j in (i + 1)..nodes.len() {
                maze.graph.add_edge(nodes[i], nodes[j], EdgeKind::Elevator);
                maze.graph.add_edge(nodes[j], nodes[i], EdgeKind::Elevator);
            }
        }
        let groups = elevator_groups(&maze);
        assert_eq!(groups.len(), 1);
        let mut stops = groups[0].stops.clone();
        stops.sort_unstable();
        let mut expected = nodes.clone();
        expected.sort_unstable();
        assert_eq!(stops, expected);
        assert_eq!(groups[0].edges.len(), 3, "3 stops -> 3 unordered pairs");
    }

    #[test]
    fn two_disjoint_pairs_are_two_elevators() {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let floors: Vec<_> = (0..2)
            .map(|_| {
                mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap())
            })
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let a0 = mf.node_at(floors[0], SquarePoint { x: 0, y: 0 }).unwrap();
        let a1 = mf.node_at(floors[1], SquarePoint { x: 0, y: 0 }).unwrap();
        let b0 = mf.node_at(floors[0], SquarePoint { x: 1, y: 0 }).unwrap();
        let b1 = mf.node_at(floors[1], SquarePoint { x: 1, y: 0 }).unwrap();
        g.add_edge(a0, a1, EdgeKind::Elevator);
        g.add_edge(a1, a0, EdgeKind::Elevator);
        g.add_edge(b0, b1, EdgeKind::Elevator);
        g.add_edge(b1, b0, EdgeKind::Elevator);
        let maze = Maze::new(mf, g);

        let groups = elevator_groups(&maze);
        assert_eq!(
            groups.len(),
            2,
            "two disjoint stop-pairs must not merge into one elevator"
        );
    }

    #[test]
    fn stop_floors_counts_distinct_floors_not_nodes() {
        let (mut maze, nodes) = three_floor_maze();
        maze.graph.add_edge(nodes[0], nodes[2], EdgeKind::Elevator);
        maze.graph.add_edge(nodes[2], nodes[0], EdgeKind::Elevator);
        let groups = elevator_groups(&maze);
        assert_eq!(groups.len(), 1);
        let floors = stop_floors(&groups[0], &maze);
        assert_eq!(floors, vec![0, 2]);
    }

    #[test]
    fn ignores_basic_and_vertical_passage_edges() {
        let (mut maze, nodes) = three_floor_maze();
        maze.graph
            .add_edge(nodes[0], nodes[1], EdgeKind::VerticalPassage);
        maze.graph
            .add_edge(nodes[1], nodes[0], EdgeKind::VerticalPassage);
        assert!(elevator_groups(&maze).is_empty());
    }
}
