pub mod pipeline;

use rand::rngs::SmallRng;
use rand::Rng;
use crate::ids::NodeId;
use crate::graph::{Graph, EdgeKind};
use crate::space::{Field, Tessellation};

#[derive(Debug, Clone)]
pub struct ElementsConfig {
    pub one_way_chance: f64,
}

impl Default for ElementsConfig {
    fn default() -> Self {
        ElementsConfig { one_way_chance: 0.04 }
    }
}

#[derive(Debug, Clone)]
pub struct GenerationParams {
    pub depth_first:     f64,
    pub corridor_chance: f64,
    pub branching:       f64,
    pub directionality:  f64,
}

impl Default for GenerationParams {
    fn default() -> Self {
        GenerationParams {
            depth_first:     0.9,
            corridor_chance: 0.7,
            branching:       0.5,
            directionality:  0.0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct EdgeBasedParams {
    pub corridor_length: f64,
    pub branching:       f64,
    pub locality:        f64,
    pub directionality:  f64,
}

impl Default for EdgeBasedParams {
    fn default() -> Self {
        EdgeBasedParams {
            corridor_length: 0.5,
            branching:       0.5,
            locality:        0.0,
            directionality:  0.0,
        }
    }
}

#[derive(Debug, Clone)]
pub enum GenerationAlgorithm {
    CustomVertexBased(GenerationParams),
    CustomEdgeBased(EdgeBasedParams),
    RecursiveBacktracker,
    WilsonAlgorithm,
    KruskalAlgorithm,
}

#[derive(Debug, Clone)]
pub struct GenerationConfig {
    pub algorithm: GenerationAlgorithm,
    pub elements:  ElementsConfig,
}

impl Default for GenerationConfig {
    fn default() -> Self {
        GenerationConfig {
            algorithm: GenerationAlgorithm::CustomVertexBased(GenerationParams::default()),
            elements:  ElementsConfig::default(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct GenerationEdge {
    pub from: NodeId,
    pub to:   NodeId,
}

#[derive(Debug, Clone)]
pub struct GenerationStep {
    pub edges: Vec<GenerationEdge>,
}

pub fn generate_maze<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    start: NodeId,
    config: GenerationConfig,
) {
    match config.algorithm {
        GenerationAlgorithm::CustomVertexBased(params) =>
            vertex_based::generate(graph, field, seed, start, &params, &config.elements, None),
        GenerationAlgorithm::CustomEdgeBased(params) =>
            edge_based::generate(graph, field, seed, start, &params, &config.elements, None),
        GenerationAlgorithm::RecursiveBacktracker =>
            recursive_backtracker::generate(graph, field, seed, start, &config.elements, None),
        GenerationAlgorithm::WilsonAlgorithm =>
            wilson::generate(graph, field, seed, start, &config.elements, None),
        GenerationAlgorithm::KruskalAlgorithm =>
            kruskal::generate(graph, field, seed, &config.elements, None),
    }
}

pub fn generate_maze_steps<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    start: NodeId,
    config: GenerationConfig,
) -> Vec<GenerationStep> {
    let mut steps: Vec<GenerationStep> = Vec::new();
    let mut on_step = |g: &Graph| {
        let edges = g.edges().map(|e| GenerationEdge { from: e.from, to: e.to }).collect();
        steps.push(GenerationStep { edges });
    };
    match config.algorithm {
        GenerationAlgorithm::CustomVertexBased(params) =>
            vertex_based::generate(graph, field, seed, start, &params, &config.elements, Some(&mut on_step)),
        GenerationAlgorithm::CustomEdgeBased(params) =>
            edge_based::generate(graph, field, seed, start, &params, &config.elements, Some(&mut on_step)),
        GenerationAlgorithm::RecursiveBacktracker =>
            recursive_backtracker::generate(graph, field, seed, start, &config.elements, Some(&mut on_step)),
        GenerationAlgorithm::WilsonAlgorithm =>
            wilson::generate(graph, field, seed, start, &config.elements, Some(&mut on_step)),
        GenerationAlgorithm::KruskalAlgorithm =>
            kruskal::generate(graph, field, seed, &config.elements, Some(&mut on_step)),
    }
    steps
}

// ─── Shared edge helper ───────────────────────────────────────────────────────

// One-way edges consume two RNG samples (one for the chance check, one for direction),
// while bidirectional edges consume only one. This means maze topology differs between
// runs with one_way_chance > 0 and runs with one_way_chance == 0, even at the same seed.
pub(crate) fn add_edge(graph: &mut Graph, src: NodeId, dst: NodeId, elements: &ElementsConfig, rng: &mut SmallRng) {
    if rng.random::<f64>() < elements.one_way_chance {
        if rng.random::<bool>() {
            graph.add_edge(src, dst, EdgeKind::Basic);
        } else {
            graph.add_edge(dst, src, EdgeKind::Basic);
        }
    } else {
        graph.add_bidirectional_edge(src, dst, EdgeKind::Basic);
    }
}

// ─── Algorithms ──────────────────────────────────────────────────────────────

mod vertex_based {
    use std::collections::HashSet;
    use rand::{Rng, SeedableRng};
    use rand::rngs::SmallRng;
    use crate::ids::NodeId;
    use crate::graph::Graph;
    use crate::space::{Field, Tessellation};
    use super::{ElementsConfig, GenerationParams, add_edge};

    struct FrontierEntry {
        node:   NodeId,
        parent: Option<NodeId>,
    }

    pub fn generate<T: Tessellation>(
        graph: &mut Graph,
        field: &Field<T>,
        seed: u64,
        start: NodeId,
        params: &GenerationParams,
        elements: &ElementsConfig,
        mut on_step: Option<&mut dyn FnMut(&Graph)>,
    ) {
        let mut visited:     HashSet<NodeId> = HashSet::new();
        let mut in_frontier: HashSet<NodeId> = HashSet::new();
        let mut frontier:    Vec<FrontierEntry> = Vec::new();
        let mut reserve:     Vec<NodeId> = Vec::new();
        let mut in_reserve:  HashSet<NodeId> = HashSet::new();
        let mut rng = SmallRng::seed_from_u64(seed);

        add_to_frontier(start, None, &mut frontier, &mut in_frontier);
        visited.insert(start);

        loop {
            if frontier.is_empty() {
                // Pop candidates from reserve until we find one with a visited neighbor.
                // Track seen candidates to avoid infinite cycling over nodes that are
                // not yet reachable (none of their neighbors are visited).
                let mut seen: HashSet<NodeId> = HashSet::new();
                let src = loop {
                    let Some(candidate) = pop_reserve(&mut reserve, &mut in_reserve, params, &mut rng) else {
                        break None;
                    };
                    if visited.contains(&candidate) { continue; }
                    if seen.contains(&candidate) { break None; }
                    seen.insert(candidate);
                    let has_visited_neighbor = field.neighbors(candidate)
                        .into_iter()
                        .any(|n| visited.contains(&n));
                    if has_visited_neighbor {
                        break Some(candidate);
                    }
                    reserve.push(candidate);
                    in_reserve.insert(candidate);
                };
                let Some(src) = src else { break; };
                let visited_neighbors: Vec<NodeId> = field.neighbors(src)
                    .into_iter()
                    .filter(|n| visited.contains(n))
                    .collect();
                let bridge = visited_neighbors[rng.random_range(0..visited_neighbors.len())];
                add_edge(graph, bridge, src, elements, &mut rng);
                visited.insert(src);
                add_to_frontier(src, Some(bridge), &mut frontier, &mut in_frontier);
                if let Some(ref mut cb) = on_step { cb(graph); }
                continue;
            }

            let fi = choose_from_frontier(&frontier, params, &mut rng);
            let src = frontier[fi].node;
            let parent = frontier[fi].parent;

            frontier.swap_remove(fi);
            in_frontier.remove(&src);

            let free_neighbors: Vec<NodeId> = field.neighbors(src)
                .into_iter()
                .filter(|n| !visited.contains(n) && !in_frontier.contains(n))
                .collect();

            let is_corridor = rng.random::<f64>() < params.corridor_chance;

            let connected: Vec<NodeId> = if is_corridor {
                if free_neighbors.is_empty() {
                    vec![]
                } else {
                    vec![choose_candidate(&free_neighbors, parent, src, params, &mut rng, field)]
                }
            } else {
                let max = free_neighbors.len();
                if max == 0 {
                    vec![]
                } else if max == 1 {
                    vec![free_neighbors[0]]
                } else {
                    let count = junction_count(max, params, &mut rng);
                    choose_junction_candidates(&free_neighbors, parent, src, count, params, &mut rng, field)
                }
            };

            for &dst in &connected {
                add_edge(graph, src, dst, elements, &mut rng);
                visited.insert(dst);
                in_reserve.remove(&dst);
                add_to_frontier(dst, Some(src), &mut frontier, &mut in_frontier);
            }
            reserve.retain(|x| !connected.contains(x));
            for n in free_neighbors {
                if !connected.contains(&n) && !in_reserve.contains(&n) && !visited.contains(&n) {
                    reserve.push(n);
                    in_reserve.insert(n);
                }
            }

            if !connected.is_empty() {
                if let Some(ref mut cb) = on_step { cb(graph); }
            }
        }
    }

    fn add_to_frontier(node: NodeId, parent: Option<NodeId>, frontier: &mut Vec<FrontierEntry>, in_frontier: &mut HashSet<NodeId>) {
        if in_frontier.insert(node) {
            frontier.push(FrontierEntry { node, parent });
        }
    }

    fn pop_reserve(
        reserve: &mut Vec<NodeId>,
        in_reserve: &mut HashSet<NodeId>,
        params: &GenerationParams,
        rng: &mut SmallRng,
    ) -> Option<NodeId> {
        if reserve.is_empty() { return None; }
        let idx = if rng.random::<f64>() < params.depth_first {
            reserve.len() - 1
        } else {
            rng.random_range(0..reserve.len())
        };
        let node = reserve.swap_remove(idx);
        in_reserve.remove(&node);
        Some(node)
    }

    fn choose_from_frontier(frontier: &[FrontierEntry], params: &GenerationParams, rng: &mut SmallRng) -> usize {
        if frontier.len() == 1 { return 0; }
        if rng.random::<f64>() < params.depth_first {
            frontier.len() - 1
        } else {
            rng.random_range(0..frontier.len())
        }
    }

    pub(super) fn junction_count(max: usize, params: &GenerationParams, rng: &mut SmallRng) -> usize {
        debug_assert!(max >= 2, "junction_count requires max >= 2, got {max}");
        let mut count = 2;
        for _ in 0..max.saturating_sub(2) {
            if rng.random::<f64>() < params.branching {
                count += 1;
            }
        }
        count
    }

    fn choose_candidate<T: Tessellation>(
        candidates: &[NodeId],
        parent: Option<NodeId>,
        src: NodeId,
        params: &GenerationParams,
        rng: &mut SmallRng,
        field: &Field<T>,
    ) -> NodeId {
        if candidates.len() == 1 { return candidates[0]; }
        if let Some(p) = parent {
            if rng.random::<f64>() < params.directionality {
                if let Some(&straight) = candidates.iter().find(|&&n| field.is_straight(p, src, n)) {
                    return straight;
                }
            }
        }
        candidates[rng.random_range(0..candidates.len())]
    }

    fn choose_junction_candidates<T: Tessellation>(
        candidates: &[NodeId],
        parent: Option<NodeId>,
        src: NodeId,
        count: usize,
        params: &GenerationParams,
        rng: &mut SmallRng,
        field: &Field<T>,
    ) -> Vec<NodeId> {
        let mut pool: Vec<NodeId> = candidates.to_vec();
        let mut chosen = Vec::with_capacity(count);

        let first = choose_candidate(&pool, parent, src, params, rng, field);
        chosen.push(first);
        pool.retain(|&n| n != first);

        while chosen.len() < count && !pool.is_empty() {
            let idx = rng.random_range(0..pool.len());
            chosen.push(pool.swap_remove(idx));
        }

        chosen
    }
}

mod wilson {
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
}

mod kruskal {
    use std::collections::{BTreeSet, HashMap};
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
        elements: &ElementsConfig,
        mut on_step: Option<&mut dyn FnMut(&Graph)>,
    ) {
        let mut rng = SmallRng::seed_from_u64(seed);

        // Collect all unique undirected edges in sorted order for determinism.
        let mut edge_set: BTreeSet<(NodeId, NodeId)> = BTreeSet::new();
        for node in graph.nodes().map(|n| n.id).collect::<Vec<_>>() {
            for neighbor in field.neighbors(node) {
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

        // Union-Find: parent map, path-compressed find.
        let mut parent: HashMap<NodeId, NodeId> = graph.nodes().map(|n| (n.id, n.id)).collect();

        fn find(parent: &mut HashMap<NodeId, NodeId>, mut x: NodeId) -> NodeId {
            while parent[&x] != x {
                let gp = parent[&parent[&x]];
                *parent.get_mut(&x).unwrap() = gp;
                x = gp;
            }
            x
        }

        for (a, b) in edges {
            let ra = find(&mut parent, a);
            let rb = find(&mut parent, b);
            if ra != rb {
                // Merge smaller into larger (union by id — deterministic).
                if ra < rb { *parent.get_mut(&rb).unwrap() = ra; }
                else       { *parent.get_mut(&ra).unwrap() = rb; }
                add_edge(graph, a, b, elements, &mut rng);
                if let Some(ref mut cb) = on_step { cb(graph); }
            }
        }
    }
}

mod recursive_backtracker {
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
}

mod edge_based {
    use std::collections::HashMap;
    use rand::{Rng, SeedableRng};
    use rand::rngs::SmallRng;
    use crate::ids::NodeId;
    use crate::graph::Graph;
    use crate::space::{Field, Tessellation};
    use super::{EdgeBasedParams, ElementsConfig, add_edge};

    #[derive(Clone, Copy, PartialEq, Eq)]
    pub(crate) enum NodeState { Unseen, Active, Visited }

    pub(crate) struct NodeMeta {
        pub(crate) parent:     Option<NodeId>,
        pub(crate) tree_depth: u32,
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

        let all_nodes: Vec<NodeId> = graph.nodes().map(|n| n.id).collect();

        let mut node_state: HashMap<NodeId, NodeState> = all_nodes.iter()
            .map(|&n| (n, NodeState::Unseen))
            .collect();
        let mut node_meta: HashMap<NodeId, NodeMeta> = HashMap::new();

        let mut active: Vec<NodeId> = Vec::new();
        let mut max_active_depth: u32 = 0;
        let mut last_dst: Option<NodeId> = None;

        node_state.insert(start, NodeState::Active);
        active.push(start);
        node_meta.insert(start, NodeMeta { parent: None, tree_depth: 0 });

        loop {
            if active.is_empty() { break; }

            let prev_last_dst = last_dst;
            let src = choose_src(
                &active, last_dst, &node_state, &node_meta,
                max_active_depth, params, field, &mut rng,
            );
            let corridor_fired = prev_last_dst == Some(src);

            let candidates: Vec<NodeId> = field.neighbors(src).into_iter()
                .filter(|n| node_state.get(n) == Some(&NodeState::Unseen))
                .collect();

            if candidates.is_empty() {
                remove_from_active(src, &mut active, &mut node_state);
                if last_dst == Some(src) { last_dst = None; }
                continue;
            }

            let weights: Vec<f64> = candidates.iter().map(|&dst| {
                let free = field.neighbors(dst).iter()
                    .filter(|n| node_state.get(n) == Some(&NodeState::Unseen))
                    .count();
                let mut w = 1.0 + params.branching * (free as f64).sqrt();
                if !corridor_fired {
                    if let Some(meta) = node_meta.get(&src) {
                        if let Some(p) = meta.parent {
                            if field.is_straight(p, src, dst) {
                                w *= 1.0 + params.directionality * 3.0;
                            }
                        }
                    }
                }
                w
            }).collect();

            let dst = weighted_sample(&candidates, &weights, &mut rng);

            add_edge(graph, src, dst, &elements, &mut rng);
            last_dst = Some(dst);

            let depth = node_meta.get(&src).map(|m| m.tree_depth + 1).unwrap_or(1);
            node_state.insert(dst, NodeState::Active);
            active.push(dst);
            node_meta.insert(dst, NodeMeta { parent: Some(src), tree_depth: depth });
            if depth > max_active_depth { max_active_depth = depth; }

            if let Some(ref mut cb) = on_step { cb(graph); }

            let src_exhausted = field.neighbors(src).into_iter()
                .all(|n| node_state.get(&n) != Some(&NodeState::Unseen));
            if src_exhausted {
                remove_from_active(src, &mut active, &mut node_state);
                if last_dst == Some(src) { last_dst = None; }
            }
        }
    }

    pub(crate) fn choose_src<T: Tessellation>(
        active: &[NodeId],
        last_dst: Option<NodeId>,
        node_state: &HashMap<NodeId, NodeState>,
        node_meta: &HashMap<NodeId, NodeMeta>,
        max_active_depth: u32,
        params: &EdgeBasedParams,
        field: &Field<T>,
        rng: &mut SmallRng,
    ) -> NodeId {
        // State 1: corridor attempt — continue from last dst (chain: A→B→C→...)
        if let Some(prev) = last_dst {
            if rng.random::<f64>() < params.corridor_length {
                let has_unseen = field.neighbors(prev).into_iter()
                    .any(|n| node_state.get(&n) == Some(&NodeState::Unseen));
                if has_unseen { return prev; }
            }
        }

        // State 2: locality weighted sampling
        let weights: Vec<f64> = active.iter().map(|n| {
            let depth = node_meta.get(n).map(|m| m.tree_depth).unwrap_or(0);
            if max_active_depth == 0 || params.locality == 0.0 {
                1.0
            } else {
                (-params.locality * depth as f64 / max_active_depth as f64).exp()
            }
        }).collect();

        let idx = weighted_sample_index(&weights, rng);
        active[idx]
    }

    fn remove_from_active(node: NodeId, active: &mut Vec<NodeId>, node_state: &mut HashMap<NodeId, NodeState>) {
        if let Some(pos) = active.iter().position(|&n| n == node) {
            active.swap_remove(pos);
        }
        node_state.insert(node, NodeState::Visited);
    }

    pub(crate) fn weighted_sample(items: &[NodeId], weights: &[f64], rng: &mut SmallRng) -> NodeId {
        items[weighted_sample_index(weights, rng)]
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::Graph;
    use crate::ids::IdGenerator;
    use crate::space::{Field, SquareTessellation, square_rect};
    use crate::validation::is_connected;
    use rand::SeedableRng;
    use rand::rngs::SmallRng;

    fn rng(seed: u64) -> SmallRng { SmallRng::seed_from_u64(seed) }

    fn default_params() -> GenerationParams { GenerationParams::default() }
    fn default_elements() -> ElementsConfig { ElementsConfig { one_way_chance: 0.0 } }

    #[test]
    fn junction_count_branching_zero_always_two() {
        let params = GenerationParams { branching: 0.0, ..default_params() };
        for seed in 0..50 {
            assert_eq!(vertex_based::junction_count(10, &params, &mut rng(seed)), 2);
        }
    }

    #[test]
    fn junction_count_branching_one_always_max() {
        let params = GenerationParams { branching: 1.0, ..default_params() };
        for max in 2..=6 {
            for seed in 0..20 {
                assert_eq!(vertex_based::junction_count(max, &params, &mut rng(seed)), max);
            }
        }
    }

    #[test]
    fn junction_count_max_two_always_two_regardless_of_branching() {
        for branching in [0.0, 0.5, 1.0] {
            let params = GenerationParams { branching, ..default_params() };
            for seed in 0..20 {
                assert_eq!(vertex_based::junction_count(2, &params, &mut rng(seed)), 2);
            }
        }
    }

    #[test]
    fn junction_count_result_in_range() {
        let params = GenerationParams { branching: 0.5, ..default_params() };
        for max in 2..=8 {
            for seed in 0..50 {
                let count = vertex_based::junction_count(max, &params, &mut rng(seed));
                assert!(count >= 2 && count <= max, "count={count} not in [2,{max}]");
            }
        }
    }

    #[test]
    fn elements_config_default_one_way_chance() {
        assert_eq!(ElementsConfig::default().one_way_chance, 0.04);
    }

    fn make_field_and_graph(w: usize, h: usize) -> (Field<SquareTessellation>, Graph) {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(w, h), &mut ids).unwrap();
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);
        (field, graph)
    }

    #[test]
    fn wilson_visits_all_nodes() {
        let (field, mut graph) = make_field_and_graph(5, 5);
        let node_count = graph.nodes().count();
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        let config = GenerationConfig {
            algorithm: GenerationAlgorithm::WilsonAlgorithm,
            elements: default_elements(),
        };
        generate_maze(&mut graph, &field, 42, start, config);
        assert_eq!(graph.edges().count(), 2 * (node_count - 1));
    }

    #[test]
    fn wilson_is_deterministic() {
        let (field, mut g1) = make_field_and_graph(4, 4);
        let (_, mut g2) = make_field_and_graph(4, 4);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        let config = GenerationConfig {
            algorithm: GenerationAlgorithm::WilsonAlgorithm,
            elements: default_elements(),
        };
        generate_maze(&mut g1, &field, 7, start, config.clone());
        generate_maze(&mut g2, &field, 7, start, config);
        let mut e1: Vec<_> = g1.edges().map(|e| (e.from, e.to)).collect();
        let mut e2: Vec<_> = g2.edges().map(|e| (e.from, e.to)).collect();
        e1.sort();
        e2.sort();
        assert_eq!(e1, e2);
    }

    #[test]
    fn kruskal_visits_all_nodes() {
        let (field, mut graph) = make_field_and_graph(5, 5);
        let node_count = graph.nodes().count();
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        let config = GenerationConfig {
            algorithm: GenerationAlgorithm::KruskalAlgorithm,
            elements: default_elements(),
        };
        generate_maze(&mut graph, &field, 42, start, config);
        assert_eq!(graph.edges().count(), 2 * (node_count - 1));
    }

    #[test]
    fn kruskal_is_deterministic() {
        let (field, mut g1) = make_field_and_graph(4, 4);
        let (_, mut g2) = make_field_and_graph(4, 4);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        let config = GenerationConfig {
            algorithm: GenerationAlgorithm::KruskalAlgorithm,
            elements: default_elements(),
        };
        generate_maze(&mut g1, &field, 7, start, config.clone());
        generate_maze(&mut g2, &field, 7, start, config);
        let mut e1: Vec<_> = g1.edges().map(|e| (e.from, e.to)).collect();
        let mut e2: Vec<_> = g2.edges().map(|e| (e.from, e.to)).collect();
        e1.sort();
        e2.sort();
        assert_eq!(e1, e2);
    }

    #[test]
    fn kruskal_produces_connected_graph() {
        let (field, mut graph) = make_field_and_graph(6, 6);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        let config = GenerationConfig {
            algorithm: GenerationAlgorithm::KruskalAlgorithm,
            elements: default_elements(),
        };
        generate_maze(&mut graph, &field, 99, start, config);
        assert!(is_connected(&graph, start));
    }

    #[test]
    fn recursive_backtracker_visits_all_nodes() {
        let (field, mut graph) = make_field_and_graph(5, 5);
        let node_count = graph.nodes().count();
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        let config = GenerationConfig {
            algorithm: GenerationAlgorithm::RecursiveBacktracker,
            elements: default_elements(),
        };
        generate_maze(&mut graph, &field, 42, start, config);
        // Perfect maze: exactly node_count - 1 bidirectional corridors = 2*(node_count-1) directed edges
        assert_eq!(graph.edges().count(), 2 * (node_count - 1));
    }

    #[test]
    fn recursive_backtracker_is_deterministic() {
        let (field, mut g1) = make_field_and_graph(4, 4);
        let (_, mut g2) = make_field_and_graph(4, 4);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        let config = GenerationConfig {
            algorithm: GenerationAlgorithm::RecursiveBacktracker,
            elements: default_elements(),
        };
        generate_maze(&mut g1, &field, 7, start, config.clone());
        generate_maze(&mut g2, &field, 7, start, config);
        let mut e1: Vec<_> = g1.edges().map(|e| (e.from, e.to)).collect();
        let mut e2: Vec<_> = g2.edges().map(|e| (e.from, e.to)).collect();
        e1.sort();
        e2.sort();
        assert_eq!(e1, e2);
    }

    // ── edge_based internals ──────────────────────────────────────────────────

    #[test]
    fn weighted_sample_index_uniform_covers_all() {
        // Equal weights — over many trials every index should be selected at least once.
        let weights = vec![1.0, 1.0, 1.0, 1.0];
        let mut counts = vec![0usize; 4];
        for seed in 0..200 {
            let i = edge_based::weighted_sample_index(&weights, &mut rng(seed));
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
            let i = edge_based::weighted_sample_index(&weights, &mut rng(seed));
            assert_ne!(i, 0, "zero-weight index 0 selected at seed {seed}");
        }
    }

    #[test]
    fn weighted_sample_index_dominant_weight_almost_always_selected() {
        // One weight 1000x larger — should win nearly every time.
        let weights = vec![1.0, 1000.0, 1.0];
        let mut wins = 0usize;
        for seed in 0..100 {
            if edge_based::weighted_sample_index(&weights, &mut rng(seed)) == 1 {
                wins += 1;
            }
        }
        assert!(wins >= 95, "dominant index selected only {wins}/100 times");
    }

    #[test]
    fn choose_src_returns_last_dst_when_corridor_length_one() {
        use std::collections::HashMap;
        use edge_based::{NodeState, NodeMeta, choose_src};
        use crate::space::{Field, SquareTessellation, square_rect};

        let mut ids = crate::ids::IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(3, 3), &mut ids).unwrap();
        let mut graph = crate::graph::Graph::new();
        field.build_nodes(&mut graph);

        let all: Vec<_> = graph.nodes().map(|n| n.id).collect();
        let center = all[4]; // middle node of 3x3
        let neighbor = field.neighbors(center)[0];

        let mut node_state: HashMap<_, _> = all.iter().map(|&n| (n, NodeState::Unseen)).collect();
        node_state.insert(center, NodeState::Active);
        node_state.insert(neighbor, NodeState::Active);

        let mut node_meta = HashMap::new();
        node_meta.insert(center,   NodeMeta { parent: None, tree_depth: 0 });
        node_meta.insert(neighbor, NodeMeta { parent: Some(center), tree_depth: 1 });

        let active = vec![center, neighbor];
        let params = EdgeBasedParams { corridor_length: 1.0, locality: 0.0, branching: 0.0, directionality: 0.0 };

        // last_dst = neighbor, corridor_length = 1.0 → must return neighbor (has unseen neighbors)
        for seed in 0..20 {
            let src = choose_src(&active, Some(neighbor), &node_state, &node_meta, 1, &params, &field, &mut rng(seed));
            assert_eq!(src, neighbor, "corridor_length=1.0 must return last_dst when it has unseen neighbors");
        }
    }

    #[test]
    fn choose_src_ignores_corridor_when_length_zero() {
        use std::collections::HashMap;
        use edge_based::{NodeState, NodeMeta, choose_src};
        use crate::space::{Field, SquareTessellation, square_rect};

        let mut ids = crate::ids::IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(3, 3), &mut ids).unwrap();
        let mut graph = crate::graph::Graph::new();
        field.build_nodes(&mut graph);

        let all: Vec<_> = graph.nodes().map(|n| n.id).collect();
        let a = all[0];
        let b = all[1];

        let mut node_state: HashMap<_, _> = all.iter().map(|&n| (n, NodeState::Unseen)).collect();
        node_state.insert(a, NodeState::Active);
        node_state.insert(b, NodeState::Active);

        let mut node_meta = HashMap::new();
        node_meta.insert(a, NodeMeta { parent: None, tree_depth: 0 });
        node_meta.insert(b, NodeMeta { parent: Some(a), tree_depth: 1 });

        let active = vec![a, b];
        let params = EdgeBasedParams { corridor_length: 0.0, locality: 0.0, branching: 0.0, directionality: 0.0 };

        // corridor_length = 0.0 → corridor never fires → result comes from locality sampling, not always b
        let results: Vec<_> = (0..50).map(|seed| {
            choose_src(&active, Some(b), &node_state, &node_meta, 1, &params, &field, &mut rng(seed))
        }).collect();
        // With uniform locality and 2 nodes, both should appear
        assert!(results.contains(&a), "corridor_length=0.0: node a never selected as src");
        assert!(results.contains(&b), "corridor_length=0.0: node b never selected as src");
    }

    #[test]
    fn choose_src_locality_one_prefers_shallow_nodes() {
        use std::collections::HashMap;
        use edge_based::{NodeState, NodeMeta, choose_src};
        use crate::space::{Field, SquareTessellation, square_rect};

        let mut ids = crate::ids::IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(4, 4), &mut ids).unwrap();
        let mut graph = crate::graph::Graph::new();
        field.build_nodes(&mut graph);

        let all: Vec<_> = graph.nodes().map(|n| n.id).collect();
        let shallow = all[0]; // depth 0
        let deep    = all[3]; // depth 3

        let mut node_state: HashMap<_, _> = all.iter().map(|&n| (n, NodeState::Unseen)).collect();
        node_state.insert(shallow, NodeState::Active);
        node_state.insert(deep,    NodeState::Active);

        let mut node_meta = HashMap::new();
        node_meta.insert(shallow, NodeMeta { parent: None, tree_depth: 0 });
        node_meta.insert(deep,    NodeMeta { parent: None, tree_depth: 3 });

        let active = vec![shallow, deep];
        let params = EdgeBasedParams { corridor_length: 0.0, locality: 1.0, branching: 0.0, directionality: 0.0 };

        let shallow_wins = (0..100).filter(|&seed| {
            choose_src(&active, None, &node_state, &node_meta, 3, &params, &field, &mut rng(seed)) == shallow
        }).count();

        // shallow weight = exp(0) = 1.0, deep weight = exp(-1.0 * 3/3) = exp(-1) ≈ 0.368
        // expected shallow win rate ≈ 1.0 / (1.0 + 0.368) ≈ 73%, threshold 60 gives headroom
        assert!(shallow_wins >= 60, "locality=1.0: shallow node should dominate, got {shallow_wins}/100");
    }
}
