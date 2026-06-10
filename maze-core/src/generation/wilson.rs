use std::collections::{HashSet, HashMap};
use rand::{Rng, SeedableRng};
use rand::rngs::SmallRng;
use crate::ids::NodeId;
use crate::graph::Graph;
use crate::space::{Field, Tessellation};
use super::{ElementsConfig, add_edge};

pub fn generate<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    start: NodeId,
    elements: &ElementsConfig,
    mut on_step: Option<&mut dyn FnMut(&Graph)>,
) {
    let all_nodes: Vec<NodeId> = graph.nodes().map(|n| n.id).collect();
    let mut visited: HashSet<NodeId> = HashSet::new();
    let mut rng = SmallRng::seed_from_u64(seed);

    visited.insert(start);

    // Build list of unvisited nodes in a stable order for determinism.
    // We pick a random index from this list each outer iteration.
    let mut unvisited: Vec<NodeId> = all_nodes.iter().copied().filter(|&n| n != start).collect();

    while !unvisited.is_empty() {
        // Pick a random unvisited node to start a random walk from.
        let pick_idx = rng.random_range(0..unvisited.len());
        let walk_start = unvisited[pick_idx];

        // Loop-erased random walk until we hit a visited node.
        // next[node] = the node we stepped to from node during the walk.
        let mut next: HashMap<NodeId, NodeId> = HashMap::new();
        let mut current = walk_start;
        loop {
            let neighbors = field.neighbors(current);
            let chosen = neighbors[rng.random_range(0..neighbors.len())];
            next.insert(current, chosen);
            if visited.contains(&chosen) {
                break;
            }
            current = chosen;
        }

        // Commit the loop-erased path: walk from walk_start following next[] until visited.
        let mut node = walk_start;
        while !visited.contains(&node) {
            let dst = next[&node];
            add_edge(graph, node, dst, elements, &mut rng);
            visited.insert(node);
            if let Some(ref mut cb) = on_step { cb(graph); }
            node = dst;
        }

        unvisited.retain(|n| !visited.contains(n));
    }
}
