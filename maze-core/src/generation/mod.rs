pub mod pipeline;

use rand::rngs::SmallRng;
use rand::Rng;
use crate::ids::NodeId;
use crate::graph::{Graph, EdgeKind};
use crate::space::Field;

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
pub enum GenerationAlgorithm {
    CustomVertexBased(GenerationParams),
    RecursiveBacktracker,
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

pub fn generate_maze<F: Field>(
    graph: &mut Graph,
    field: &F,
    seed: u64,
    start: NodeId,
    config: GenerationConfig,
) {
    match config.algorithm {
        GenerationAlgorithm::CustomVertexBased(params) =>
            vertex_based::generate(graph, field, seed, start, &params, &config.elements, None),
        GenerationAlgorithm::RecursiveBacktracker =>
            recursive_backtracker::generate(graph, field, seed, start, &config.elements, None),
    }
}

pub fn generate_maze_steps<F: Field>(
    graph: &mut Graph,
    field: &F,
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
        GenerationAlgorithm::RecursiveBacktracker =>
            recursive_backtracker::generate(graph, field, seed, start, &config.elements, Some(&mut on_step)),
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
    use crate::space::Field;
    use super::{ElementsConfig, GenerationParams, add_edge};

    struct FrontierEntry {
        node:   NodeId,
        parent: Option<NodeId>,
    }

    pub fn generate<F: Field>(
        graph: &mut Graph,
        field: &F,
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

    fn choose_candidate<F: Field>(
        candidates: &[NodeId],
        parent: Option<NodeId>,
        src: NodeId,
        params: &GenerationParams,
        rng: &mut SmallRng,
        field: &F,
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

    fn choose_junction_candidates<F: Field>(
        candidates: &[NodeId],
        parent: Option<NodeId>,
        src: NodeId,
        count: usize,
        params: &GenerationParams,
        rng: &mut SmallRng,
        field: &F,
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

mod recursive_backtracker {
    use std::collections::HashSet;
    use rand::{Rng, SeedableRng};
    use rand::rngs::SmallRng;
    use crate::ids::NodeId;
    use crate::graph::Graph;
    use crate::space::Field;
    use super::{ElementsConfig, add_edge};

    pub fn generate<F: Field>(
        graph: &mut Graph,
        field: &F,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::Graph;
    use crate::ids::IdGenerator;
    use crate::space::{ShapedField, SquareRect, Field};
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

    fn make_field_and_graph(w: usize, h: usize) -> (crate::space::SquareField, Graph) {
        let mut ids = IdGenerator::new();
        let field: crate::space::SquareField = ShapedField::new(SquareRect { width: w, height: h }, &mut ids);
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);
        (field, graph)
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
}
