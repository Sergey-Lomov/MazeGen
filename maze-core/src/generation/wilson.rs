use std::collections::{HashSet, HashMap};
use rand::{Rng, SeedableRng};
use crate::random::MazeRng;
use crate::ids::NodeId;
use crate::graph::Graph;
use crate::space::{Field, Tessellation};
use super::{PresetState, try_add_bidirectional_edge, can_connect};

pub fn generate<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    start: NodeId,
    preset_state: &PresetState,
) {
    let all_nodes: Vec<NodeId> = graph.nodes().map(|n| n.id).collect();
    let mut visited: HashSet<NodeId> = HashSet::new();
    let mut rng = MazeRng::seed_from_u64(seed);

    for &pc in &preset_state.preset_connected {
        visited.insert(pc);
    }
    visited.insert(start);

    let mut unvisited: Vec<NodeId> = all_nodes.iter().copied().filter(|&n| !visited.contains(&n)).collect();

    while !unvisited.is_empty() {
        // Pick a random unvisited node to start a random walk from.
        let pick_idx = rng.random_range(0..unvisited.len());
        let walk_start = unvisited[pick_idx];

        // Loop-erased random walk until we hit a visited node.
        // next[node] = the node we stepped to from node during the walk.
        let mut next: HashMap<NodeId, NodeId> = HashMap::new();
        let mut current = walk_start;
        loop {
            let neighbors: Vec<NodeId> = field.neighbors(current)
                .into_iter()
                .filter(|&n| can_connect(current, n, preset_state))
                .collect();
            if neighbors.is_empty() { break; }
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
            let Some(&dst) = next.get(&node) else { break; };
            try_add_bidirectional_edge(graph, node, dst, preset_state);
            visited.insert(node);
            node = dst;
        }

        unvisited.retain(|n| !visited.contains(n));
    }
}
