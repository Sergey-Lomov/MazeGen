pub mod pipeline;

use std::collections::HashSet;
use rand::{SeedableRng, Rng};
use rand::rngs::SmallRng;
use crate::ids::NodeId;
use crate::graph::{Graph, EdgeKind};
use crate::space::Field;

pub fn generate_maze<F: Field>(graph: &mut Graph, field: &F, seed: u64, start: NodeId) {
    let mut visited: HashSet<NodeId> = HashSet::new();
    let mut stack: Vec<NodeId> = vec![start];
    visited.insert(start);
    let mut rng = SmallRng::seed_from_u64(seed);

    while let Some(&current) = stack.last() {
        let unvisited: Vec<NodeId> = field
            .neighbors(current)
            .into_iter()
            .filter(|n| !visited.contains(n))
            .collect();

        if unvisited.is_empty() {
            stack.pop();
        } else {
            let idx = rng.random_range(0..unvisited.len());
            let chosen = unvisited[idx];
            const ONE_WAY_CHANCE: f64 = 0.4;
            if rng.random::<f64>() < ONE_WAY_CHANCE {
                if rng.random::<bool>() {
                    graph.add_edge(current, chosen, EdgeKind::Basic);
                } else {
                    graph.add_edge(chosen, current, EdgeKind::Basic);
                }
            } else {
                graph.add_bidirectional_edge(current, chosen, EdgeKind::Basic);
            }
            visited.insert(chosen);
            stack.push(chosen);
        }
    }
}
