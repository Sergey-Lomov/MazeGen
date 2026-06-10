use std::collections::HashMap;
use rand::{Rng, SeedableRng};
use rand::rngs::SmallRng;
use crate::ids::NodeId;
use crate::graph::Graph;
use crate::space::{Field, Tessellation};
use super::{EdgeBasedParams, ElementsConfig, add_edge};

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
    mut on_step: Option<&mut dyn FnMut(&Graph)>,
) {
    let mut rng = SmallRng::seed_from_u64(seed);

    let mut nodes: HashMap<NodeId, NodeEntry> = graph.nodes()
        .map(|n| (n.id, NodeEntry::unseen()))
        .collect();

    let mut active: Vec<NodeId> = Vec::new();
    let mut max_active_depth: u32 = 0;
    let mut last_dst: Option<NodeId> = None;

    nodes.insert(start, NodeEntry { state: NodeState::Active, parent: None, tree_depth: 0 });
    active.push(start);

    loop {
        if active.is_empty() { break; }

        let prev_last_dst = last_dst;
        let src = choose_src(&active, last_dst, &nodes, max_active_depth, params, field, &mut rng);
        let corridor_fired = prev_last_dst == Some(src);

        let candidates: Vec<NodeId> = field.neighbors(src).into_iter()
            .filter(|n| nodes.get(n).map_or(false, |e| e.state == NodeState::Unseen))
            .collect();

        if candidates.is_empty() {
            remove_from_active(src, &mut active, &mut nodes);
            if last_dst == Some(src) { last_dst = None; }
            continue;
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

        add_edge(graph, src, dst, &elements, &mut rng);
        last_dst = Some(dst);

        let depth = nodes.get(&src).map(|e| e.tree_depth + 1).unwrap_or(1);
        nodes.insert(dst, NodeEntry { state: NodeState::Active, parent: Some(src), tree_depth: depth });
        active.push(dst);
        if depth > max_active_depth { max_active_depth = depth; }

        if let Some(ref mut cb) = on_step { cb(graph); }

        let src_exhausted = field.neighbors(src).into_iter()
            .all(|n| nodes.get(&n).map_or(true, |e| e.state != NodeState::Unseen));
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
    max_active_depth: u32,
    params: &EdgeBasedParams,
    field: &Field<T>,
    rng: &mut SmallRng,
) -> NodeId {
    // State 1: corridor attempt — continue from last dst (chain: A→B→C→...)
    if let Some(prev) = last_dst {
        if rng.random::<f64>() < params.corridor_length {
            let has_unseen = field.neighbors(prev).into_iter()
                .any(|n| nodes.get(&n).map_or(false, |e| e.state == NodeState::Unseen));
            if has_unseen { return prev; }
        }
    }

    // State 2: locality weighted sampling
    let weights: Vec<f64> = active.iter().map(|n| {
        let depth = nodes.get(n).map(|e| e.tree_depth).unwrap_or(0);
        if max_active_depth == 0 || params.locality == 0.0 {
            1.0
        } else {
            (-params.locality * depth as f64 / max_active_depth as f64).exp()
        }
    }).collect();

    let idx = weighted_sample_index(&weights, rng);
    active[idx]
}

fn remove_from_active(node: NodeId, active: &mut Vec<NodeId>, nodes: &mut HashMap<NodeId, NodeEntry>) {
    if let Some(pos) = active.iter().position(|&n| n == node) {
        active.swap_remove(pos);
    }
    if let Some(entry) = nodes.get_mut(&node) {
        entry.state = NodeState::Visited;
    }
}

pub(crate) fn weighted_sample_index(weights: &[f64], rng: &mut SmallRng) -> usize {
    let total: f64 = weights.iter().sum();
    let mut r = rng.random::<f64>() * total;
    for (i, &w) in weights.iter().enumerate() {
        r -= w;
        if r <= 0.0 { return i; }
    }
    weights.len() - 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generation::test_utils::{default_elements, make_field_and_graph};
    use crate::space::{SquareTessellation, square_rect};
    use rand::SeedableRng;

    fn rng(seed: u64) -> SmallRng { SmallRng::seed_from_u64(seed) }

    #[test]
    fn weighted_sample_index_uniform_covers_all() {
        // Equal weights — over many trials every index should be selected at least once.
        let weights = vec![1.0, 1.0, 1.0, 1.0];
        let mut counts = vec![0usize; 4];
        for seed in 0..200 {
            let i = weighted_sample_index(&weights, &mut rng(seed));
            counts[i] += 1;
        }
        for (i, &c) in counts.iter().enumerate() {
            assert!(c > 0, "index {i} never selected with uniform weights");
        }
    }

    #[test]
    fn weighted_sample_index_zero_weight_never_selected() {
        // First weight is zero — should never be picked.
        let weights = vec![0.0, 1.0, 1.0];
        for seed in 0..100 {
            let i = weighted_sample_index(&weights, &mut rng(seed));
            assert_ne!(i, 0, "zero-weight index 0 selected at seed {seed}");
        }
    }

    #[test]
    fn weighted_sample_index_dominant_weight_almost_always_selected() {
        // One weight 1000x larger — should win nearly every time.
        let weights = vec![1.0, 1000.0, 1.0];
        let mut wins = 0usize;
        for seed in 0..100 {
            if weighted_sample_index(&weights, &mut rng(seed)) == 1 {
                wins += 1;
            }
        }
        assert!(wins >= 95, "dominant index selected only {wins}/100 times");
    }

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
        let params = EdgeBasedParams { corridor_length: 1.0, locality: 0.0, branching: 0.0, directionality: 0.0 };

        // last_dst = neighbor, corridor_length = 1.0 → must return neighbor (has unseen neighbors)
        for seed in 0..20 {
            let src = choose_src(&active, Some(neighbor), &nodes, 1, &params, &field, &mut rng(seed));
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
        let params = EdgeBasedParams { corridor_length: 0.0, locality: 0.0, branching: 0.0, directionality: 0.0 };

        // corridor_length = 0.0 → corridor never fires → result comes from locality sampling, not always b
        let results: Vec<_> = (0..50).map(|seed| {
            choose_src(&active, Some(b), &nodes, 1, &params, &field, &mut rng(seed))
        }).collect();
        // With uniform locality and 2 nodes, both should appear
        assert!(results.contains(&a), "corridor_length=0.0: node a never selected as src");
        assert!(results.contains(&b), "corridor_length=0.0: node b never selected as src");
    }

    #[test]
    fn choose_src_locality_one_prefers_shallow_nodes() {
        let mut ids = crate::ids::IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(4, 4), &mut ids).unwrap();
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);

        let all: Vec<_> = graph.nodes().map(|n| n.id).collect();
        let shallow = all[0]; // depth 0
        let deep    = all[3]; // depth 3

        let mut nodes: HashMap<_, _> = all.iter().map(|&n| (n, NodeEntry::unseen())).collect();
        nodes.insert(shallow, NodeEntry { state: NodeState::Active, parent: None, tree_depth: 0 });
        nodes.insert(deep,    NodeEntry { state: NodeState::Active, parent: None, tree_depth: 3 });

        let active = vec![shallow, deep];
        let params = EdgeBasedParams { corridor_length: 0.0, locality: 1.0, branching: 0.0, directionality: 0.0 };

        let shallow_wins = (0..100).filter(|&seed| {
            choose_src(&active, None, &nodes, 3, &params, &field, &mut rng(seed)) == shallow
        }).count();

        // shallow weight = exp(0) = 1.0, deep weight = exp(-1.0 * 3/3) = exp(-1) ≈ 0.368
        // expected shallow win rate ≈ 1.0 / (1.0 + 0.368) ≈ 73%, threshold 60 gives headroom
        assert!(shallow_wins >= 60, "locality=1.0: shallow node should dominate, got {shallow_wins}/100");
    }

    #[test]
    fn edge_based_visits_all_nodes() {
        let (field, mut graph) = make_field_and_graph(5, 5);
        let node_count = graph.nodes().count();
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut graph, &field, 42, start, &EdgeBasedParams::default(), &default_elements(), None);
        assert_eq!(graph.edges().count(), 2 * (node_count - 1));
    }

    #[test]
    fn edge_based_is_deterministic() {
        let (field, mut g1) = make_field_and_graph(4, 4);
        let (_, mut g2) = make_field_and_graph(4, 4);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut g1, &field, 7, start, &EdgeBasedParams::default(), &default_elements(), None);
        generate(&mut g2, &field, 7, start, &EdgeBasedParams::default(), &default_elements(), None);
        let mut e1: Vec<_> = g1.edges().map(|e| (e.from, e.to)).collect();
        let mut e2: Vec<_> = g2.edges().map(|e| (e.from, e.to)).collect();
        e1.sort();
        e2.sort();
        assert_eq!(e1, e2);
    }
}
