pub mod pipeline;

use std::collections::HashSet;
use rand::{SeedableRng, Rng};
use rand::rngs::SmallRng;
use crate::ids::NodeId;
use crate::graph::{Graph, EdgeKind};
use crate::space::Field;

#[derive(Debug, Clone)]
pub struct GenerationParams {
    pub depth_first:     f64,
    pub corridor_chance: f64,
    pub branching:       f64,
    pub directionality:  f64,
    pub one_way_chance:  f64,
}

impl Default for GenerationParams {
    fn default() -> Self {
        GenerationParams {
            depth_first:     0.9,
            corridor_chance: 0.7,
            branching:       0.5,
            directionality:  0.0,
            one_way_chance:  0.04,
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
    /// All edges present in the graph after this step.
    pub edges: Vec<GenerationEdge>,
}

pub fn generate_maze<F: Field>(
    graph: &mut Graph,
    field: &F,
    seed: u64,
    start: NodeId,
    params: GenerationParams,
) {
    generate_inner(graph, field, seed, start, params, None);
}

pub fn generate_maze_steps<F: Field>(
    graph: &mut Graph,
    field: &F,
    seed: u64,
    start: NodeId,
    params: GenerationParams,
) -> Vec<GenerationStep> {
    let mut steps: Vec<GenerationStep> = Vec::new();
    let mut on_step = |g: &Graph| {
        let edges = g.edges().map(|e| GenerationEdge { from: e.from, to: e.to }).collect();
        steps.push(GenerationStep { edges });
    };
    generate_inner(graph, field, seed, start, params, Some(&mut on_step));
    steps
}

// ─── Internal ────────────────────────────────────────────────────────────────

struct FrontierEntry {
    node:   NodeId,
    parent: Option<NodeId>,
}

fn generate_inner<F: Field>(
    graph: &mut Graph,
    field: &F,
    seed: u64,
    start: NodeId,
    params: GenerationParams,
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
            // Find a reserve node that has at least one visited neighbor.
            // Nodes without visited neighbors are re-queued; we stop after
            // exhausting all current reserve nodes with no progress.
            let mut remaining = reserve.len();
            let src = loop {
                if remaining == 0 { break None; }
                let Some(candidate) = pop_reserve(&mut reserve, &mut in_reserve, &params, &mut rng) else {
                    break None;
                };
                if visited.contains(&candidate) { continue; }
                let has_visited_neighbor = field.neighbors(candidate)
                    .into_iter()
                    .any(|n| visited.contains(&n));
                if has_visited_neighbor {
                    break Some(candidate);
                }
                // No visited neighbor yet — put back and try another.
                reserve.push(candidate);
                in_reserve.insert(candidate);
                remaining -= 1;
            };
            let Some(src) = src else { break; };
            let visited_neighbors: Vec<NodeId> = field.neighbors(src)
                .into_iter()
                .filter(|n| visited.contains(n))
                .collect();
            let bridge = visited_neighbors[rng.random_range(0..visited_neighbors.len())];
            add_edge(graph, bridge, src, &params, &mut rng);
            visited.insert(src);
            add_to_frontier(src, Some(bridge), &mut frontier, &mut in_frontier);
            if let Some(ref mut cb) = on_step { cb(graph); }
            continue;
        }

        let fi = choose_from_frontier(&frontier, &params, &mut rng);
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
                vec![choose_candidate(&free_neighbors, parent, src, &params, &mut rng, field)]
            }
        } else {
            let max = free_neighbors.len();
            if max == 0 {
                vec![]
            } else if max == 1 {
                vec![free_neighbors[0]]
            } else {
                let count = junction_count(max, &params, &mut rng);
                choose_junction_candidates(&free_neighbors, parent, src, count, &params, &mut rng, field)
            }
        };

        for &dst in &connected {
            add_edge(graph, src, dst, &params, &mut rng);
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

fn junction_count(max: usize, params: &GenerationParams, rng: &mut SmallRng) -> usize {
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

fn add_edge(graph: &mut Graph, src: NodeId, dst: NodeId, params: &GenerationParams, rng: &mut SmallRng) {
    if rng.random::<f64>() < params.one_way_chance {
        if rng.random::<bool>() {
            graph.add_edge(src, dst, EdgeKind::Basic);
        } else {
            graph.add_edge(dst, src, EdgeKind::Basic);
        }
    } else {
        graph.add_bidirectional_edge(src, dst, EdgeKind::Basic);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rng(seed: u64) -> SmallRng { SmallRng::seed_from_u64(seed) }

    #[test]
    fn junction_count_branching_zero_always_two() {
        let params = GenerationParams { branching: 0.0, ..GenerationParams::default() };
        for seed in 0..50 {
            assert_eq!(junction_count(10, &params, &mut rng(seed)), 2);
        }
    }

    #[test]
    fn junction_count_branching_one_always_max() {
        let params = GenerationParams { branching: 1.0, ..GenerationParams::default() };
        for max in 2..=6 {
            for seed in 0..20 {
                assert_eq!(junction_count(max, &params, &mut rng(seed)), max);
            }
        }
    }

    #[test]
    fn junction_count_max_two_always_two_regardless_of_branching() {
        for branching in [0.0, 0.5, 1.0] {
            let params = GenerationParams { branching, ..GenerationParams::default() };
            for seed in 0..20 {
                assert_eq!(junction_count(2, &params, &mut rng(seed)), 2);
            }
        }
    }

    #[test]
    fn junction_count_result_in_range() {
        let params = GenerationParams { branching: 0.5, ..GenerationParams::default() };
        for max in 2..=8 {
            for seed in 0..50 {
                let count = junction_count(max, &params, &mut rng(seed));
                assert!(count >= 2 && count <= max, "count={count} not in [2,{max}]");
            }
        }
    }
}
