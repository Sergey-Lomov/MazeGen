use std::collections::{BTreeSet, HashMap};
use rand::{Rng, SeedableRng};
use crate::random::MazeRng;
use crate::ids::NodeId;
use crate::graph::Graph;
use crate::space::{Field, Tessellation};
use crate::dsu::Dsu;
use super::{PresetState, try_add_bidirectional_edge, can_connect};

pub fn generate<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    preset_state: &PresetState,
) {
    let mut rng = MazeRng::seed_from_u64(seed);

    // Collect all unique undirected edges in sorted order for determinism.
    let mut edge_set: BTreeSet<(NodeId, NodeId)> = BTreeSet::new();
    for node in graph.nodes().map(|n| n.id).collect::<Vec<_>>() {
        for neighbor in field.neighbors(node) {
            if !can_connect(node, neighbor, preset_state) { continue; }
            let pair = if node < neighbor { (node, neighbor) } else { (neighbor, node) };
            edge_set.insert(pair);
        }
    }

    // Shuffle edges for randomness.
    let mut edges: Vec<(NodeId, NodeId)> = edge_set.into_iter().collect();
    for i in (1..edges.len()).rev() {
        let j = rng.random_range(0..=i);
        edges.swap(i, j);
    }

    // Union-Find over a dense 0..n index, since NodeId (u64) need not be contiguous.
    // Indices are assigned in NodeId order so `union_by_min` on indices matches the
    // original "lowest NodeId wins as root" determinism.
    let mut sorted_ids: Vec<NodeId> = graph.nodes().map(|n| n.id).collect();
    sorted_ids.sort_unstable();
    let node_index: HashMap<NodeId, usize> = sorted_ids.iter().enumerate().map(|(i, &id)| (id, i)).collect();
    let mut dsu = Dsu::new(node_index.len());

    // Pre-union nodes already connected by preset edges so Kruskal doesn't add duplicate edges.
    let preset_edges: Vec<(NodeId, NodeId)> = graph.edges()
        .map(|e| (e.from.min(e.to), e.from.max(e.to)))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    for (a, b) in preset_edges {
        dsu.union_by_min(node_index[&a], node_index[&b]);
    }

    for (a, b) in edges {
        let ra = dsu.find(node_index[&a]);
        let rb = dsu.find(node_index[&b]);
        if ra != rb {
            dsu.union_by_min(ra, rb);
            try_add_bidirectional_edge(graph, a, b, preset_state);
        }
    }
}
