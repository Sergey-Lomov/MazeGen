use std::collections::HashMap;
use rand::{Rng, SeedableRng};
use crate::random::MazeRng;
use crate::ids::NodeId;
use crate::graph::Graph;
use crate::space::{Field, Tessellation};
use super::{EdgeBasedParams, ElementsConfig, PresetState, StepCallback, try_add_edge, can_connect, gaussian_weighted_index};

#[derive(Clone, Copy, PartialEq, Eq)]
enum NodeState { Unseen, Active, Visited }

struct NodeEntry {
    state:      NodeState,
    parent:     Option<NodeId>,
    tree_depth: u32,
}

impl NodeEntry {
    fn unseen() -> Self {
        Self { state: NodeState::Unseen, parent: None, tree_depth: 0 }
    }
}

pub fn generate<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    start: NodeId,
    params: &EdgeBasedParams,
    elements: &ElementsConfig,
    preset_state: &PresetState,
    mut on_step: Option<&mut StepCallback<'_>>,
) {
    let mut rng = MazeRng::seed_from_u64(seed);

    let mut nodes: HashMap<NodeId, NodeEntry> = graph.nodes()
        .map(|n| (n.id, NodeEntry::unseen()))
        .collect();

    let mut active: Vec<NodeId> = Vec::new();
    let mut last_dst: Option<NodeId> = None;

    // preset_connected nodes stay Unseen so they remain visible as connection targets.
    // When an active node connects to one, it is marked Visited but NOT pushed to active.
    let preset_connected = &preset_state.preset_connected;

    // Ensure start is Active.
    if nodes.get(&start).map_or(true, |e| e.state == NodeState::Unseen) {
        nodes.insert(start, NodeEntry { state: NodeState::Active, parent: None, tree_depth: 0 });
        active.push(start);
    }

    loop {
        if active.is_empty() { break; }

        let prev_last_dst = last_dst;
        let src = choose_src(&active, last_dst, &nodes, params, preset_state, field, &mut rng);
        let corridor_fired = prev_last_dst == Some(src);

        let candidates: Vec<NodeId> = field.neighbors(src).into_iter()
            .filter(|&n| nodes.get(&n).map_or(false, |e| e.state == NodeState::Unseen)
                && (preset_connected.contains(&src) && preset_connected.contains(&n) || can_connect(src, n, preset_state)))
            .collect();

        if candidates.is_empty() {
            remove_from_active(src, &mut active, &mut nodes);
            if last_dst == Some(src) { last_dst = None; }
            continue;
        }

        // Cyclic roll: independent of normal dst selection, adds an extra edge to a visited neighbor.
        if rng.random::<f64>() < params.cyclicity {
            let visited_neighbors: Vec<NodeId> = field.neighbors(src).into_iter()
                .filter(|&n| nodes.get(&n).map_or(false, |e| e.state == NodeState::Visited)
                    && can_connect(src, n, preset_state)
                    && graph.edge_between(src, n).is_none() && graph.edge_between(n, src).is_none())
                .collect();
            if !visited_neighbors.is_empty() {
                let cyclic_dst = visited_neighbors[rng.random_range(0..visited_neighbors.len())];
                try_add_edge(graph, src, cyclic_dst, elements, preset_state, &mut rng);
                // last_dst not updated: visited node cannot seed a corridor chain
            }
        }

        let weights: Vec<f64> = candidates.iter().map(|&dst| {
            let free = field.neighbors(dst).iter()
                .filter(|n| nodes.get(n).map_or(false, |e| e.state == NodeState::Unseen))
                .count();
            let mut w = 1.0 + params.branching * (free as f64).sqrt();
            if !corridor_fired {
                if let Some(entry) = nodes.get(&src) {
                    if let Some(p) = entry.parent {
                        if field.is_straight(p, src, dst) {
                            w *= 1.0 + params.directionality * 3.0;
                        }
                    }
                }
            }
            w
        }).collect();

        let dst = candidates[weighted_sample_index(&weights, &mut rng)];

        // Preset nodes already have their edge in the graph — skip try_add_edge to avoid duplicates.
        if !preset_connected.contains(&dst) {
            try_add_edge(graph, src, dst, elements, preset_state, &mut rng);
            last_dst = Some(dst);
        }

        let depth = nodes.get(&src).map(|e| e.tree_depth + 1).unwrap_or(1);
        nodes.insert(dst, NodeEntry { state: NodeState::Active, parent: Some(src), tree_depth: depth });
        active.push(dst);

        if let Some(ref mut cb) = on_step { cb(graph, src, &active); }

        let src_exhausted = field.neighbors(src).into_iter()
            .all(|n| nodes.get(&n).map_or(true, |e| e.state != NodeState::Unseen)
                || !(preset_connected.contains(&src) && preset_connected.contains(&n) || can_connect(src, n, preset_state)));
        if src_exhausted {
            remove_from_active(src, &mut active, &mut nodes);
            if last_dst == Some(src) { last_dst = None; }
        }
    }
}

fn choose_src<T: Tessellation>(
    active: &[NodeId],
    last_dst: Option<NodeId>,
    nodes: &HashMap<NodeId, NodeEntry>,
    params: &EdgeBasedParams,
    preset_state: &PresetState,
    field: &Field<T>,
    rng: &mut MazeRng,
) -> NodeId {
    // Corridor attempt — continue from last dst (chain: A→B→C→...)
    if let Some(prev) = last_dst {
        if rng.random::<f64>() < params.corridor_length {
            let has_unseen = field.neighbors(prev).into_iter()
                .any(|n| nodes.get(&n).map_or(false, |e| e.state == NodeState::Unseen) && can_connect(prev, n, preset_state));
            if has_unseen { return prev; }
        }
    }

    // depth_first weighted sampling by position in active (oldest=0.0, newest=1.0)
    let idx = gaussian_weighted_index(active.len(), params.depth_first, rng);
    active[idx]
}

fn weighted_sample_index(weights: &[f64], rng: &mut MazeRng) -> usize {
    let total: f64 = weights.iter().sum();
    let mut r = rng.random::<f64>() * total;
    for (i, &w) in weights.iter().enumerate() {
        r -= w;
        if r <= 0.0 { return i; }
    }
    weights.len() - 1
}

fn remove_from_active(node: NodeId, active: &mut Vec<NodeId>, nodes: &mut HashMap<NodeId, NodeEntry>) {
    if let Some(pos) = active.iter().position(|&n| n == node) {
        active.remove(pos); // preserve insertion order for gaussian_weighted_index
    }
    if let Some(entry) = nodes.get_mut(&node) {
        entry.state = NodeState::Visited;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generation::test_utils::{default_elements, make_field_and_graph};
    use crate::space::{SquareTessellation, square_rect};
    use rand::SeedableRng;

    fn rng(seed: u64) -> MazeRng { MazeRng::seed_from_u64(seed) }

    #[test]
    fn choose_src_returns_last_dst_when_corridor_length_one() {
        let mut ids = crate::ids::IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(3, 3), &mut ids).unwrap();
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);

        let all: Vec<_> = graph.nodes().map(|n| n.id).collect();
        let center = all[4]; // middle node of 3x3
        let neighbor = field.neighbors(center)[0];

        let mut nodes: HashMap<_, _> = all.iter().map(|&n| (n, NodeEntry::unseen())).collect();
        nodes.insert(center,   NodeEntry { state: NodeState::Active, parent: None,          tree_depth: 0 });
        nodes.insert(neighbor, NodeEntry { state: NodeState::Active, parent: Some(center),  tree_depth: 1 });

        let active = vec![center, neighbor];
        let params = EdgeBasedParams { corridor_length: 1.0, depth_first: 0.5, branching: 0.0, directionality: 0.0, cyclicity: 0.0 };

        // last_dst = neighbor, corridor_length = 1.0 → must return neighbor (has unseen neighbors)
        for seed in 0..20 {
            let src = choose_src(&active, Some(neighbor), &nodes, &params, &empty_presets(), &field, &mut rng(seed));
            assert_eq!(src, neighbor, "corridor_length=1.0 must return last_dst when it has unseen neighbors");
        }
    }

    #[test]
    fn choose_src_ignores_corridor_when_length_zero() {
        let mut ids = crate::ids::IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(3, 3), &mut ids).unwrap();
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);

        let all: Vec<_> = graph.nodes().map(|n| n.id).collect();
        let a = all[0];
        let b = all[1];

        let mut nodes: HashMap<_, _> = all.iter().map(|&n| (n, NodeEntry::unseen())).collect();
        nodes.insert(a, NodeEntry { state: NodeState::Active, parent: None,    tree_depth: 0 });
        nodes.insert(b, NodeEntry { state: NodeState::Active, parent: Some(a), tree_depth: 1 });

        let active = vec![a, b];
        let params = EdgeBasedParams { corridor_length: 0.0, depth_first: 0.5, branching: 0.0, directionality: 0.0, cyclicity: 0.0 };

        // corridor_length=0.0 → corridor never fires; depth_first=0.5 → uniform → both nodes appear
        let results: Vec<_> = (0..50).map(|seed| {
            choose_src(&active, Some(b), &nodes, &params, &empty_presets(), &field, &mut rng(seed))
        }).collect();
        assert!(results.contains(&a), "corridor_length=0.0: node a never selected as src");
        assert!(results.contains(&b), "corridor_length=0.0: node b never selected as src");
    }

    #[test]
    fn choose_src_depth_first_one_prefers_newest() {
        let mut ids = crate::ids::IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(4, 4), &mut ids).unwrap();
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);

        let all: Vec<_> = graph.nodes().map(|n| n.id).collect();
        let oldest = all[0]; // position 0 in active
        let newest = all[3]; // position 3 in active (last)

        let mut nodes: HashMap<_, _> = all.iter().map(|&n| (n, NodeEntry::unseen())).collect();
        nodes.insert(oldest, NodeEntry { state: NodeState::Active, parent: None, tree_depth: 0 });
        nodes.insert(newest, NodeEntry { state: NodeState::Active, parent: None, tree_depth: 1 });

        let active = vec![oldest, newest];
        let params = EdgeBasedParams { corridor_length: 0.0, depth_first: 1.0, branching: 0.0, directionality: 0.0, cyclicity: 0.0 };

        let newest_wins = (0..100).filter(|&seed| {
            choose_src(&active, None, &nodes, &params, &empty_presets(), &field, &mut rng(seed)) == newest
        }).count();

        // depth_first=1.0, k=10 → newest weight=1.0, oldest weight=0.0 → newest dominates
        assert!(newest_wins >= 95, "depth_first=1.0: newest node should dominate, got {newest_wins}/100");
    }

    fn empty_presets() -> super::PresetState { super::PresetState::empty() }

    #[test]
    fn edge_based_visits_all_nodes() {
        let (field, mut graph) = make_field_and_graph(5, 5);
        let node_count = graph.nodes().count();
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut graph, &field, 42, start, &EdgeBasedParams::default(), &default_elements(), &empty_presets(), None);
        assert_eq!(graph.edges().count(), 2 * (node_count - 1));
    }

    #[test]
    fn edge_based_is_deterministic() {
        let (field, mut g1) = make_field_and_graph(4, 4);
        let (_, mut g2) = make_field_and_graph(4, 4);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut g1, &field, 7, start, &EdgeBasedParams::default(), &default_elements(), &empty_presets(), None);
        generate(&mut g2, &field, 7, start, &EdgeBasedParams::default(), &default_elements(), &empty_presets(), None);
        let mut e1: Vec<_> = g1.edges().map(|e| (e.from, e.to)).collect();
        let mut e2: Vec<_> = g2.edges().map(|e| (e.from, e.to)).collect();
        e1.sort();
        e2.sort();
        assert_eq!(e1, e2);
    }
}
