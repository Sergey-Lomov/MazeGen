use std::collections::HashMap;
use rand::{Rng, SeedableRng};
use crate::random::MazeRng;
use crate::ids::NodeId;
use crate::graph::{Graph, EdgeKind};
use crate::space::{Field, Tessellation};
use super::{EdgeBasedParams, ElementsConfig, PresetState, StepCallback, try_add_edge, try_add_edge_kind, can_connect, gaussian_weighted_index};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NodeState { Unseen, Active, Visited }

struct NodeEntry {
    state:      NodeState,
    parent:     Option<NodeId>,
    tree_depth: u32,
    /// Whether `teleport_chance` has already been rolled for this node while it was `src`. A
    /// node may become `src` multiple times before exhausting its geometric neighbors (each
    /// `active`-lifetime pop is a separate connection opportunity), so without this guard the
    /// same node's effective teleport probability would compound with its degree instead of
    /// applying once per node.
    teleport_rolled: bool,
}

impl NodeEntry {
    fn unseen() -> Self {
        Self { state: NodeState::Unseen, parent: None, tree_depth: 0, teleport_rolled: false }
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
        nodes.insert(start, NodeEntry { state: NodeState::Active, parent: None, tree_depth: 0, teleport_rolled: false });
        active.push(start);
    }

    loop {
        if active.is_empty() { break; }

        let prev_last_dst = last_dst;
        let src = choose_src(&active, last_dst, &nodes, params, preset_state, field, &mut rng);
        let corridor_fired = prev_last_dst == Some(src);

        // Teleport and cyclic are both rolled right after src is fixed, before any candidate
        // pool is built — the combination of the two decides which pool the normal dst-choice
        // step (below) draws from: teleport only takes over that pool when cyclic did NOT also
        // fire this step (see the cyclic block below for the "both fired" case, where teleport
        // is spent on the cyclic edge instead).
        //
        // teleport_chance is rolled at most once per node, not once per connection opportunity:
        // a node can become `src` several times before exhausting its geometric neighbors, and
        // rolling on every one of those visits would make the effective teleport probability
        // compound with the node's degree instead of applying once per node. `teleport_rolled`
        // guards this — once rolled (hit or miss), the node never rolls again.
        let already_rolled = nodes.get(&src).map_or(false, |e| e.teleport_rolled);
        let teleport_flag = if already_rolled {
            false
        } else {
            let hit = rng.random::<f64>() < elements.teleport_chance;
            if let Some(entry) = nodes.get_mut(&src) { entry.teleport_rolled = true; }
            hit
        };
        let cyclic_flag = rng.random::<f64>() < params.cyclicity;
        let use_geometric_pool = !teleport_flag || cyclic_flag;

        let candidates: Vec<NodeId> = if use_geometric_pool {
            field.neighbors(src).into_iter()
                .filter(|&n| nodes.get(&n).map_or(false, |e| e.state == NodeState::Unseen)
                    && (preset_connected.contains(&src) && preset_connected.contains(&n) || can_connect(src, n, preset_state)))
                .collect()
        } else {
            // Teleport candidate pool: every Unseen node in the graph, not just geometric
            // neighbors of src. No preset_connected exception here — that exception exists only
            // to handle geometrically-adjacent preset pairs, which doesn't apply to teleport.
            sorted_nodes_in_state(&nodes, NodeState::Unseen, |n| n != src && can_connect(src, n, preset_state))
        };
        if candidates.is_empty() {
            remove_from_active(src, &mut active, &mut nodes);
            if last_dst == Some(src) { last_dst = None; }
            continue;
        }

        // Cyclic roll (already decided above): adds an extra edge to a visited node, independent
        // of the normal dst selection below. If teleport also fired this step, the cyclic
        // candidate pool widens from "visited geometric neighbors" to "any visited node in the
        // graph", and the added edge is a Teleport rather than a Basic connection — teleport is
        // considered spent on this cyclic edge in that case (the dst-choice step below then
        // always uses the geometric pool, per `use_geometric_pool` already computed above).
        if cyclic_flag {
            if teleport_flag {
                let visited_nodes = sorted_nodes_in_state(&nodes, NodeState::Visited, |n| {
                    n != src && can_connect(src, n, preset_state)
                        && graph.edge_between(src, n).is_none() && graph.edge_between(n, src).is_none()
                });
                if !visited_nodes.is_empty() {
                    let cyclic_dst = visited_nodes[rng.random_range(0..visited_nodes.len())];
                    try_add_edge_kind(graph, src, cyclic_dst, EdgeKind::Teleport, elements.teleport_one_way_chance, preset_state, &mut rng);
                    // last_dst not updated: visited node cannot seed a corridor chain
                }
            } else {
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
        }

        // dst-choice weight: directionality only makes sense for the geometric pool (it needs
        // `field.is_straight`, which is meaningless for a non-adjacent teleport candidate) — the
        // teleport pool (`!use_geometric_pool`) uses branching alone.
        let weights: Vec<f64> = candidates.iter().map(|&dst| {
            let free = field.neighbors(dst).iter()
                .filter(|n| nodes.get(n).map_or(false, |e| e.state == NodeState::Unseen))
                .count();
            let mut w = 1.0 + params.branching * (free as f64).sqrt();
            if use_geometric_pool && !corridor_fired {
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
            if use_geometric_pool {
                try_add_edge(graph, src, dst, elements, preset_state, &mut rng);
            } else {
                try_add_edge_kind(graph, src, dst, EdgeKind::Teleport, elements.teleport_one_way_chance, preset_state, &mut rng);
            }
            last_dst = Some(dst);
        }

        let depth = nodes.get(&src).map(|e| e.tree_depth + 1).unwrap_or(1);
        nodes.insert(dst, NodeEntry { state: NodeState::Active, parent: Some(src), tree_depth: depth, teleport_rolled: false });
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

/// Collects every node in the given `state` (besides `n != src`-style exclusions folded into
/// `extra_filter`) into a `Vec`, sorted for determinism. `nodes` is a `HashMap`, whose iteration
/// order is randomized per-process — without sorting, the same seed could pick a different node
/// on a different run. Shared by every "scan the whole graph for nodes in state X" pool used by
/// the teleport model (candidate pool, cyclic-partner pool), so the sort is applied exactly once.
fn sorted_nodes_in_state(
    nodes: &HashMap<NodeId, NodeEntry>,
    state: NodeState,
    extra_filter: impl Fn(NodeId) -> bool,
) -> Vec<NodeId> {
    let mut pool: Vec<NodeId> = nodes.iter()
        .filter(|&(&n, e)| e.state == state && extra_filter(n))
        .map(|(&n, _)| n)
        .collect();
    pool.sort_unstable();
    pool
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

    // ─── weighted_sample_index ──────────────────────────────────────────────

    #[test]
    fn weighted_sample_index_single_element_always_zero() {
        for seed in 0..20 {
            assert_eq!(weighted_sample_index(&[1.0], &mut rng(seed)), 0);
        }
    }

    #[test]
    fn weighted_sample_index_zero_weight_never_chosen() {
        // weights[1] = 0.0 must never be picked, regardless of seed.
        for seed in 0..200 {
            let idx = weighted_sample_index(&[1.0, 0.0, 1.0], &mut rng(seed));
            assert_ne!(idx, 1, "seed {seed}: zero-weight entry must never be chosen");
        }
    }

    #[test]
    fn weighted_sample_index_all_zero_weights_returns_first() {
        // total=0.0 → r=0.0 → first iteration's `r -= w[0]` leaves r <= 0.0 → index 0.
        for seed in 0..20 {
            assert_eq!(weighted_sample_index(&[0.0, 0.0, 0.0], &mut rng(seed)), 0);
        }
    }

    #[test]
    fn weighted_sample_index_result_always_in_bounds() {
        let weights = [0.1, 2.5, 0.0, 1.0, 0.3];
        for seed in 0..200 {
            let idx = weighted_sample_index(&weights, &mut rng(seed));
            assert!(idx < weights.len(), "seed {seed}: index {idx} out of bounds");
        }
    }

    #[test]
    fn weighted_sample_index_distribution_respects_weights() {
        // Heavily-weighted entry should dominate over ~1000 draws.
        let weights = [0.01, 100.0, 0.01];
        let mut counts = [0usize; 3];
        for seed in 0..1000 {
            counts[weighted_sample_index(&weights, &mut rng(seed))] += 1;
        }
        assert!(counts[1] > 950, "expected heavily-weighted index 1 to dominate, got counts={counts:?}");
    }

    // ─── remove_from_active / sorted_nodes_in_state ─────────────────────────

    #[test]
    fn remove_from_active_removes_node_and_marks_visited() {
        let mut ids = crate::ids::IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(3, 3), &mut ids).unwrap();
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);
        let all: Vec<_> = graph.nodes().map(|n| n.id).collect();
        let a = all[0];
        let b = all[1];

        let mut nodes: HashMap<_, _> = all.iter().map(|&n| (n, NodeEntry::unseen())).collect();
        nodes.get_mut(&a).unwrap().state = NodeState::Active;
        nodes.get_mut(&b).unwrap().state = NodeState::Active;
        let mut active = vec![a, b];

        remove_from_active(a, &mut active, &mut nodes);

        assert_eq!(active, vec![b], "removed node must be gone from active, order of remaining preserved");
        assert_eq!(nodes[&a].state, NodeState::Visited, "removed node must become Visited");
        assert_eq!(nodes[&b].state, NodeState::Active, "untouched node must keep its state");
    }

    #[test]
    fn remove_from_active_marks_visited_even_when_not_present_in_active() {
        // The state transition to Visited and the active-list removal are independent — a node
        // absent from `active` still gets marked Visited (state is the source of truth for
        // exhaustion elsewhere in the algorithm; `active` is just the pending-src worklist).
        let mut ids = crate::ids::IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(3, 3), &mut ids).unwrap();
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);
        let all: Vec<_> = graph.nodes().map(|n| n.id).collect();
        let a = all[0];
        let mut nodes: HashMap<_, _> = all.iter().map(|&n| (n, NodeEntry::unseen())).collect();
        let mut active: Vec<NodeId> = vec![];

        remove_from_active(a, &mut active, &mut nodes);

        assert!(active.is_empty());
        assert_eq!(nodes[&a].state, NodeState::Visited);
    }

    #[test]
    fn sorted_nodes_in_state_filters_by_state_and_extra_filter_and_sorts() {
        let mut ids = crate::ids::IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(3, 3), &mut ids).unwrap();
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);
        let mut all: Vec<_> = graph.nodes().map(|n| n.id).collect();
        all.sort_unstable();

        let mut nodes: HashMap<_, _> = all.iter().map(|&n| (n, NodeEntry::unseen())).collect();
        // Mark a couple of nodes Visited, leave the rest Unseen.
        nodes.get_mut(&all[2]).unwrap().state = NodeState::Visited;
        nodes.get_mut(&all[5]).unwrap().state = NodeState::Visited;
        nodes.get_mut(&all[0]).unwrap().state = NodeState::Active;

        let result = sorted_nodes_in_state(&nodes, NodeState::Visited, |_| true);
        let mut expected = vec![all[2], all[5]];
        expected.sort_unstable();
        assert_eq!(result, expected);

        // extra_filter further restricts the pool.
        let filtered = sorted_nodes_in_state(&nodes, NodeState::Visited, |n| n != all[2]);
        assert_eq!(filtered, vec![all[5]]);
    }

    #[test]
    fn sorted_nodes_in_state_empty_when_no_match() {
        let mut ids = crate::ids::IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(3, 3), &mut ids).unwrap();
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);
        let all: Vec<_> = graph.nodes().map(|n| n.id).collect();
        let nodes: HashMap<_, _> = all.iter().map(|&n| (n, NodeEntry::unseen())).collect();

        assert!(sorted_nodes_in_state(&nodes, NodeState::Visited, |_| true).is_empty());
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
        nodes.insert(center,   NodeEntry { state: NodeState::Active, parent: None,          tree_depth: 0, teleport_rolled: false });
        nodes.insert(neighbor, NodeEntry { state: NodeState::Active, parent: Some(center),  tree_depth: 1, teleport_rolled: false });

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
        nodes.insert(a, NodeEntry { state: NodeState::Active, parent: None,    tree_depth: 0, teleport_rolled: false });
        nodes.insert(b, NodeEntry { state: NodeState::Active, parent: Some(a), tree_depth: 1, teleport_rolled: false });

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
        nodes.insert(oldest, NodeEntry { state: NodeState::Active, parent: None, tree_depth: 0, teleport_rolled: false });
        nodes.insert(newest, NodeEntry { state: NodeState::Active, parent: None, tree_depth: 1, teleport_rolled: false });

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

    // ─── teleport ────────────────────────────────────────────────────────

    fn teleport_edges(graph: &Graph) -> Vec<(NodeId, NodeId)> {
        graph.edges().filter(|e| e.kind == EdgeKind::Teleport).map(|e| (e.from, e.to)).collect()
    }

    fn no_teleport_elements() -> ElementsConfig {
        ElementsConfig { one_way_chance: 0.0, teleport_chance: 0.0, teleport_one_way_chance: 0.0 }
    }

    fn full_two_way_teleport_elements() -> ElementsConfig {
        ElementsConfig { one_way_chance: 0.0, teleport_chance: 1.0, teleport_one_way_chance: 0.0 }
    }

    fn full_one_way_teleport_elements() -> ElementsConfig {
        ElementsConfig { one_way_chance: 0.0, teleport_chance: 1.0, teleport_one_way_chance: 1.0 }
    }

    #[test]
    fn teleport_chance_zero_adds_no_teleport_edges() {
        for seed in [1, 7, 42, 1234, 9999] {
            let (field, mut graph) = make_field_and_graph(6, 6);
            let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
            generate(&mut graph, &field, seed, start, &EdgeBasedParams::default(), &no_teleport_elements(), &empty_presets(), None);
            assert!(teleport_edges(&graph).is_empty(), "seed {seed}: teleport_chance=0.0 must add no teleport edges");
        }
    }

    #[test]
    fn teleport_chance_one_adds_teleport_edges() {
        let (field, mut graph) = make_field_and_graph(6, 6);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut graph, &field, 42, start, &EdgeBasedParams::default(), &full_two_way_teleport_elements(), &empty_presets(), None);
        assert!(!teleport_edges(&graph).is_empty(), "teleport_chance=1.0 should add at least one teleport edge on a 6x6 field");
    }

    #[test]
    fn teleport_edges_can_connect_non_geometric_neighbors() {
        let (field, mut graph) = make_field_and_graph(8, 8);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut graph, &field, 7, start, &EdgeBasedParams::default(), &full_two_way_teleport_elements(), &empty_presets(), None);
        let has_non_adjacent_teleport = teleport_edges(&graph).iter()
            .any(|&(from, to)| !field.neighbors(from).contains(&to));
        assert!(has_non_adjacent_teleport, "expected at least one teleport edge between non-adjacent nodes");
    }

    #[test]
    fn teleport_one_way_chance_zero_all_teleports_are_two_way() {
        let (field, mut graph) = make_field_and_graph(6, 6);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut graph, &field, 42, start, &EdgeBasedParams::default(), &full_two_way_teleport_elements(), &empty_presets(), None);
        let edges = teleport_edges(&graph);
        assert!(!edges.is_empty());
        for &(from, to) in &edges {
            assert!(graph.edges().any(|e| e.from == to && e.to == from && e.kind == EdgeKind::Teleport),
                "teleport {from}->{to} has no reverse, but teleport_one_way_chance was 0.0");
        }
    }

    #[test]
    fn teleport_one_way_chance_one_all_teleports_are_one_way() {
        let (field, mut graph) = make_field_and_graph(6, 6);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut graph, &field, 42, start, &EdgeBasedParams::default(), &full_one_way_teleport_elements(), &empty_presets(), None);
        let edges = teleport_edges(&graph);
        assert!(!edges.is_empty());
        for &(from, to) in &edges {
            assert!(!graph.edges().any(|e| e.from == to && e.to == from && e.kind == EdgeKind::Teleport),
                "teleport {from}->{to} has a reverse, but teleport_one_way_chance was 1.0");
        }
    }

    #[test]
    fn teleport_full_chance_still_visits_all_nodes_and_stays_connected() {
        let (field, mut graph) = make_field_and_graph(6, 6);
        let node_count = graph.nodes().count();
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut graph, &field, 42, start, &EdgeBasedParams::default(), &full_two_way_teleport_elements(), &empty_presets(), None);
        for node in graph.nodes() {
            let has_edge = graph.edges().any(|e| e.from == node.id || e.to == node.id);
            assert!(has_edge, "node {} was never connected", node.id);
        }
        assert_eq!(graph.nodes().count(), node_count);
        assert!(crate::validation::is_connected(&graph, start), "maze with teleport_chance=1.0 must stay connected from start");
    }

    #[test]
    fn teleport_is_deterministic_for_fixed_seed() {
        let (field, mut g1) = make_field_and_graph(6, 6);
        let (_, mut g2) = make_field_and_graph(6, 6);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut g1, &field, 55, start, &EdgeBasedParams::default(), &full_two_way_teleport_elements(), &empty_presets(), None);
        generate(&mut g2, &field, 55, start, &EdgeBasedParams::default(), &full_two_way_teleport_elements(), &empty_presets(), None);
        let mut e1: Vec<_> = g1.edges().map(|e| (e.from, e.to, e.kind.clone())).collect();
        let mut e2: Vec<_> = g2.edges().map(|e| (e.from, e.to, e.kind.clone())).collect();
        e1.sort_by_key(|(f, t, _)| (*f, *t));
        e2.sort_by_key(|(f, t, _)| (*f, *t));
        assert_eq!(e1, e2);
    }

    #[test]
    fn teleport_single_node_field_never_panics() {
        let mut ids = crate::ids::IdGenerator::new();
        let field: Field<SquareTessellation> =
            Field::new(vec![crate::space::SquarePoint { x: 0, y: 0 }], &mut ids).unwrap();
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut graph, &field, 1, start, &EdgeBasedParams::default(), &full_two_way_teleport_elements(), &empty_presets(), None);
        assert!(teleport_edges(&graph).is_empty(), "single-node field has no partner for a teleport");
    }

    #[test]
    fn teleport_respects_locked_out_source() {
        let (field, mut graph) = make_field_and_graph(4, 4);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        let a = start;
        let mut preset_state = PresetState::empty();
        preset_state.locked_out.insert(a);

        generate(&mut graph, &field, 42, start, &EdgeBasedParams::default(), &full_two_way_teleport_elements(), &preset_state, None);

        assert!(graph.edges().all(|e| e.from != a), "locked_out node {a} must never be an edge source (teleport or otherwise)");
    }

    #[test]
    fn teleport_respects_locked_in_destination() {
        let (field, mut graph) = make_field_and_graph(4, 4);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        let b = field.node_at(crate::space::SquarePoint { x: 3, y: 3 }).unwrap();
        let mut preset_state = PresetState::empty();
        preset_state.locked_in.insert(b);

        generate(&mut graph, &field, 42, start, &EdgeBasedParams::default(), &full_two_way_teleport_elements(), &preset_state, None);

        assert!(graph.edges().all(|e| e.to != b), "locked_in node {b} must never be an edge destination (teleport or otherwise)");
    }

    #[test]
    fn teleport_respects_blocked_pair() {
        let (field, mut graph) = make_field_and_graph(4, 4);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        let a = start;
        let b = field.node_at(crate::space::SquarePoint { x: 3, y: 3 }).unwrap();
        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((a, b));
        preset_state.blocked.insert((b, a));

        generate(&mut graph, &field, 42, start, &EdgeBasedParams::default(), &full_two_way_teleport_elements(), &preset_state, None);

        assert!(graph.edge_between(a, b).is_none(), "fully blocked pair ({a},{b}) must never get an edge, teleport or otherwise");
    }

    // Note: a same-direction Basic+Teleport parallel pair cannot arise from this algorithm's own
    // rolls — the teleport destination is always drawn from the Unseen pool, which by definition
    // has no prior edge from src yet. The Graph-level coexistence guarantee (kind-aware dedup
    // in add_edge/add_bidirectional_edge) is covered directly in graph::parallel_edges_tests.

    #[test]
    fn teleport_never_creates_self_loop() {
        for seed in 0..30 {
            let (field, mut graph) = make_field_and_graph(4, 4);
            let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
            generate(&mut graph, &field, seed, start, &EdgeBasedParams::default(), &full_two_way_teleport_elements(), &empty_presets(), None);
            assert!(graph.edges().all(|e| e.from != e.to), "seed {seed}: no edge (teleport or otherwise) may be a self-loop");
        }
    }

    #[test]
    fn teleport_cyclic_together_widens_pool_to_any_visited_node() {
        // cyclicity=1.0 forces cyclic_flag every step; teleport_chance=1.0 forces teleport_flag
        // every step. When both fire on the same step, the model says teleport is spent on the
        // cyclic edge (widened to "any visited node"), and the normal dst-choice step falls back
        // to the geometric pool. This must produce at least one non-adjacent Teleport edge
        // (proving the widened cyclic pool actually ran), and the normal connections must still
        // only ever link geometric neighbors.
        let params = EdgeBasedParams {
            corridor_length: 0.5,
            branching: 0.0,
            depth_first: 0.5,
            directionality: 0.0,
            cyclicity: 1.0,
        };
        let (field, mut graph) = make_field_and_graph(8, 8);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut graph, &field, 21, start, &params, &full_two_way_teleport_elements(), &empty_presets(), None);

        let has_non_adjacent_teleport = teleport_edges(&graph).iter()
            .any(|&(from, to)| !field.neighbors(from).contains(&to));
        assert!(has_non_adjacent_teleport, "expected at least one non-adjacent teleport edge from the cyclic+teleport combination");

        // Basic edges must always still be between geometric neighbors.
        for e in graph.edges().filter(|e| e.kind == EdgeKind::Basic) {
            assert!(field.neighbors(e.from).contains(&e.to), "Basic edge {}->{} is not between geometric neighbors", e.from, e.to);
        }
    }

    #[test]
    fn teleport_without_cyclic_replaces_normal_dst_choice_with_teleport() {
        // cyclicity=0.0 (cyclic_flag never fires) + teleport_chance=1.0: every node's *first*
        // outgoing connection (its one-time teleport roll) must be a Teleport edge, since
        // `use_geometric_pool` is only true when `!teleport_flag || cyclic_flag`, and cyclic_flag
        // is always false here. Once a node has rolled (hit, in this case), it never rolls again,
        // so a node's later outgoing connections (while it remains `src` across multiple
        // connection opportunities) fall back to Basic.
        let params = EdgeBasedParams {
            corridor_length: 0.5,
            branching: 0.5,
            depth_first: 0.5,
            directionality: 0.0,
            cyclicity: 0.0,
        };
        let (field, mut graph) = make_field_and_graph(5, 5);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut graph, &field, 9, start, &params, &full_two_way_teleport_elements(), &empty_presets(), None);

        // Note: not every node's outgoing edge is necessarily a Teleport even though
        // teleport_chance=1.0 guarantees a hit on every node's one-time roll — a node whose own
        // roll found an empty candidate pool (e.g. no Unseen node left anywhere) contributes no
        // edge of its own, but may still end up with an outgoing Basic edge as the *other* side
        // of a bidirectional connection initiated by a different node's non-teleport roll.
        assert!(!teleport_edges(&graph).is_empty(), "expected at least one Teleport edge with teleport_chance=1.0");
    }

    #[test]
    fn teleport_rolled_at_most_once_per_node() {
        // A node that becomes `src` multiple times (before exhausting its geometric neighbors)
        // must roll teleport_chance only on its first connection opportunity, guarded by
        // `NodeEntry.teleport_rolled`. Since a successful roll can only occur once per node, the
        // number of distinct teleport connections actually created (collapsed to unordered pairs,
        // since a one-way edge's direction is a separate coin flip unrelated to which node
        // rolled) can never exceed the total node count — this is a regression guard against the
        // bug this fix addresses, where density scaled with per-node degree instead of node count.
        let one_way_only = ElementsConfig { one_way_chance: 0.0, teleport_chance: 1.0, teleport_one_way_chance: 1.0 };
        let params = EdgeBasedParams {
            corridor_length: 0.0, // force src reselection every step, maximizing repeat-src chances
            branching: 1.0,
            depth_first: 0.5,
            directionality: 0.0,
            cyclicity: 0.0,
        };
        let (field, mut graph) = make_field_and_graph(6, 6);
        let node_count = graph.nodes().count();
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut graph, &field, 3, start, &params, &one_way_only, &empty_presets(), None);

        let unordered_teleport_pairs: std::collections::HashSet<(NodeId, NodeId)> = graph.edges()
            .filter(|e| e.kind == EdgeKind::Teleport)
            .map(|e| (e.from.min(e.to), e.from.max(e.to)))
            .collect();
        assert!(unordered_teleport_pairs.len() <= node_count,
            "got {} distinct teleport pairs across {node_count} nodes — density must be bounded by node count, not scale with per-node degree",
            unordered_teleport_pairs.len());
    }
}
