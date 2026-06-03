use std::collections::{HashSet, VecDeque};
use crate::ids::NodeId;
use crate::graph::Graph;

// BFS over the union of outgoing and incoming edges — correct for both
// fully bidirectional mazes and graphs with one-way edges.
pub fn is_connected(graph: &Graph, start: NodeId) -> bool {
    let total = graph.node_count();
    if total == 0 {
        return true;
    }

    let mut visited: HashSet<NodeId> = HashSet::new();
    let mut queue: VecDeque<NodeId> = VecDeque::new();
    visited.insert(start);
    queue.push_back(start);

    while let Some(current) = queue.pop_front() {
        for neighbor in graph.outgoing_neighbors(current).chain(graph.incoming_neighbors(current)) {
            if visited.insert(neighbor) {
                queue.push_back(neighbor);
            }
        }
    }

    visited.len() == total
}
