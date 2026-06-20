use std::collections::HashSet;
use rand::{Rng, SeedableRng};
use rand::rngs::SmallRng;
use crate::ids::NodeId;
use crate::graph::Graph;
use crate::space::{Field, Tessellation};
use super::{ElementsConfig, PresetState, try_add_edge, can_connect};

pub fn generate<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    start: NodeId,
    elements: &ElementsConfig,
    preset_state: &PresetState,
    mut on_step: Option<&mut super::StepCallback<'_>>,
) {
    let mut visited: HashSet<NodeId> = HashSet::new();
    let mut rng = SmallRng::seed_from_u64(seed);

    let preset_connected = &preset_state.preset_connected;
    visited.insert(start);

    let mut stack: Vec<NodeId> = vec![start];

    while let Some(&current) = stack.last() {
        let unvisited: Vec<NodeId> = field
            .neighbors(current)
            .into_iter()
            .filter(|&n| !visited.contains(&n)
                && (preset_connected.contains(&current) && preset_connected.contains(&n) || can_connect(current, n, preset_state)))
            .collect();

        if unvisited.is_empty() {
            stack.pop();
        } else {
            let chosen = unvisited[rng.random_range(0..unvisited.len())];
            // Preset nodes already have their edge in the graph — skip try_add_edge to avoid duplicates.
            if !preset_connected.contains(&chosen) {
                try_add_edge(graph, current, chosen, elements, preset_state, &mut rng);
            }
            visited.insert(chosen);
            stack.push(chosen);
            if let Some(ref mut cb) = on_step { cb(graph, current, &stack); }
        }
    }
}
