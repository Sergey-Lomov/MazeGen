use crate::ids::NodeId;
use crate::space::{Field, Tessellation};
use crate::graph::Graph;

pub enum GeometricNodeClass {
    DeadEnd,
    Straight,
    Turn,
    Junction(usize),
}

pub(crate) fn unique_neighbors(graph: &Graph, node: NodeId) -> Vec<NodeId> {
    let mut v: Vec<NodeId> = graph.outgoing_neighbors(node).collect();
    v.sort_unstable();
    v.dedup();
    v
}

pub fn classify_node<T: Tessellation>(graph: &Graph, node: NodeId, field: &Field<T>) -> GeometricNodeClass {
    let neighbors = unique_neighbors(graph, node);
    match neighbors.len() {
        0 | 1 => GeometricNodeClass::DeadEnd,
        2 => {
            if field.is_straight(neighbors[0], node, neighbors[1]) {
                GeometricNodeClass::Straight
            } else {
                GeometricNodeClass::Turn
            }
        }
        n => GeometricNodeClass::Junction(n),
    }
}
