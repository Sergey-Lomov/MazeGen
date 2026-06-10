use std::collections::HashSet;
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
            let chosen = unvisited[rng.random_range(0..unvisited.len())];
            add_edge(graph, current, chosen, elements, &mut rng);
            visited.insert(chosen);
            stack.push(chosen);
            if let Some(ref mut cb) = on_step { cb(graph); }
        }
    }
}
