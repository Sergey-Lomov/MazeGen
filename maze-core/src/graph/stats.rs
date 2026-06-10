use std::collections::HashSet;
use crate::ids::NodeId;
use crate::space::{Field, Tessellation};
use crate::graph::Graph;
use super::classify::{GeometricNodeClass, classify_node};

pub struct GeometricNodeStats {
    pub dead_ends: usize,
    pub straight: usize,
    pub turns: usize,
    pub junctions: Vec<(usize, usize)>, // (degree, count), sorted by degree
}

// Spatial edge statistics. Walls are a spatial concept (adjacent node pair with no edge),
// not a graph property. Computed via field neighbors, not graph edges alone.
pub struct SpatialEdgeStats {
    pub bidirectional: usize,
    pub one_way: usize,
    pub walls: usize,
}

pub fn compute_node_stats<T: Tessellation>(graph: &Graph, field: &Field<T>) -> GeometricNodeStats {
    let mut dead_ends = 0usize;
    let mut straight = 0usize;
    let mut turns = 0usize;
    let mut junction_map: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();

    for node in graph.nodes() {
        match classify_node(graph, node.id, field) {
            GeometricNodeClass::DeadEnd => dead_ends += 1,
            GeometricNodeClass::Straight => straight += 1,
            GeometricNodeClass::Turn => turns += 1,
            GeometricNodeClass::Junction(n) => *junction_map.entry(n).or_insert(0) += 1,
        }
    }

    let mut junctions: Vec<(usize, usize)> = junction_map.into_iter().collect();
    junctions.sort_unstable_by_key(|&(deg, _)| deg);

    let stats = GeometricNodeStats { dead_ends, straight, turns, junctions };

    debug_assert!(
        stats.dead_ends
            + stats.straight
            + stats.turns
            + stats.junctions.iter().map(|(_, c)| c).sum::<usize>()
            == graph.node_count()
    );

    stats
}

fn adjacency_pairs<T: Tessellation>(graph: &Graph, field: &Field<T>) -> Vec<(NodeId, NodeId)> {
    let mut seen: HashSet<(NodeId, NodeId)> = HashSet::new();
    let mut pairs = Vec::new();
    for node in graph.nodes() {
        for neighbor in field.neighbors(node.id) {
            let pair = if node.id < neighbor {
                (node.id, neighbor)
            } else {
                (neighbor, node.id)
            };
            if seen.insert(pair) {
                pairs.push(pair);
            }
        }
    }
    pairs
}

pub fn compute_spatial_edge_stats<T: Tessellation>(graph: &Graph, field: &Field<T>) -> SpatialEdgeStats {
    let pairs = adjacency_pairs(graph, field);
    let total = pairs.len();
    let mut bidirectional = 0usize;
    let mut one_way = 0usize;
    let mut walls = 0usize;

    for (a, b) in &pairs {
        let ab = graph.edge_between(*a, *b).is_some();
        let ba = graph.edge_between(*b, *a).is_some();
        match (ab, ba) {
            (true, true)   => bidirectional += 1,
            (false, false) => walls += 1,
            _              => one_way += 1,
        }
    }

    debug_assert!(bidirectional + one_way + walls == total);

    SpatialEdgeStats { bidirectional, one_way, walls }
}
