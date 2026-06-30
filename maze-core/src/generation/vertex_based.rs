use std::collections::HashSet;
use rand::{Rng, SeedableRng};
use crate::random::MazeRng;
use crate::ids::NodeId;
use crate::graph::Graph;
use crate::space::{Field, Tessellation};
use super::{ElementsConfig, GenerationParams, PresetState, StepCallback, try_add_edge, can_connect, gaussian_weighted_index};

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
    preset_state: &PresetState,
    mut on_step: Option<&mut StepCallback<'_>>,
) {
    let mut visited:     HashSet<NodeId> = HashSet::new();
    let mut in_frontier: HashSet<NodeId> = HashSet::new();
    let mut frontier:    Vec<FrontierEntry> = Vec::new();
    let mut reserve:     Vec<NodeId> = Vec::new();
    let mut in_reserve:  HashSet<NodeId> = HashSet::new();
    let mut rng = MazeRng::seed_from_u64(seed);

    // preset_connected nodes are NOT added to visited upfront — this keeps them visible
    // as connection targets for free_neighbors. Exception: start itself may be preset_connected
    // (e.g. gen_source inside a preset cluster) — it must enter the frontier regardless.
    let preset_connected = &preset_state.preset_connected;

    visited.insert(start);
    add_to_frontier(start, None, &mut frontier, &mut in_frontier);

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
                    .any(|n| visited.contains(&n) && can_connect(n, candidate, preset_state));
                if has_visited_neighbor {
                    break Some(candidate);
                }
                reserve.push(candidate);
                in_reserve.insert(candidate);
            };
            let Some(src) = src else { break; };
            let visited_neighbors: Vec<NodeId> = field.neighbors(src)
                .into_iter()
                .filter(|&n| visited.contains(&n) && can_connect(n, src, preset_state))
                .collect();
            let bridge = visited_neighbors[rng.random_range(0..visited_neighbors.len())];
            try_add_edge(graph, bridge, src, elements, preset_state, &mut rng);
            visited.insert(src);
            add_to_frontier(src, Some(bridge), &mut frontier, &mut in_frontier);
            let frontier_ids: Vec<NodeId> = frontier.iter().map(|e| e.node).collect();
            if let Some(ref mut cb) = on_step { cb(graph, src, &frontier_ids); }
            continue;
        }

        let fi = choose_from_frontier(&frontier, params, &mut rng);
        let src = frontier[fi].node;
        let parent = frontier[fi].parent;

        frontier.remove(fi);
        in_frontier.remove(&src);

        // free_regular: unvisited, non-frontier, non-preset neighbors — become frontier/reserve.
        // free_preset: preset-connected neighbors not yet visited — connect to them but skip frontier.
        let all_free: Vec<NodeId> = field.neighbors(src)
            .into_iter()
            .filter(|&n| !visited.contains(&n) && !in_frontier.contains(&n)
                && (preset_connected.contains(&src) && preset_connected.contains(&n) || can_connect(src, n, preset_state)))
            .collect();
        let (free_preset, free_regular): (Vec<NodeId>, Vec<NodeId>) =
            all_free.into_iter().partition(|n| preset_connected.contains(n));

        // Cyclic roll: if triggered, pick one visited neighbor and add a cycle edge.
        // This happens regardless of free_neighbors availability.
        let cyclic_dst: Option<NodeId> = if rng.random::<f64>() < params.cyclicity {
            let visited_neighbors: Vec<NodeId> = field.neighbors(src)
                .into_iter()
                .filter(|&n| visited.contains(&n) && can_connect(src, n, preset_state)
                    && graph.edge_between(src, n).is_none() && graph.edge_between(n, src).is_none())
                .collect();
            if visited_neighbors.is_empty() {
                None
            } else {
                Some(visited_neighbors[rng.random_range(0..visited_neighbors.len())])
            }
        } else {
            None
        };

        let is_corridor = rng.random::<f64>() < params.corridor_chance;

        let connected: Vec<NodeId> = if is_corridor {
            if free_regular.is_empty() {
                vec![]
            } else {
                vec![choose_candidate(&free_regular, parent, src, params, &mut rng, field)]
            }
        } else {
            let max = free_regular.len();
            if max == 0 {
                vec![]
            } else if max == 1 {
                vec![free_regular[0]]
            } else {
                let count = junction_count(max, params, &mut rng);
                choose_junction_candidates(&free_regular, parent, src, count, params, &mut rng, field)
            }
        };

        let cyclic_added = if let Some(cyclic) = cyclic_dst {
            try_add_edge(graph, src, cyclic, elements, preset_state, &mut rng);
            true
        } else {
            false
        };

        // Preset neighbors: already connected by preset edges, so skip try_add_edge.
        // Just mark visited and push to frontier so the algorithm traverses through them.
        for &dst in &free_preset {
            visited.insert(dst);
            in_reserve.remove(&dst);
            add_to_frontier(dst, Some(src), &mut frontier, &mut in_frontier);
        }
        reserve.retain(|x| !free_preset.contains(x));

        let connected_set: HashSet<NodeId> = connected.iter().copied().collect();
        for &dst in &connected {
            try_add_edge(graph, src, dst, elements, preset_state, &mut rng);
            visited.insert(dst);
            in_reserve.remove(&dst);
            add_to_frontier(dst, Some(src), &mut frontier, &mut in_frontier);
        }
        reserve.retain(|x| !connected_set.contains(x));
        for n in free_regular {
            if !connected_set.contains(&n) && !in_reserve.contains(&n) && !visited.contains(&n) {
                reserve.push(n);
                in_reserve.insert(n);
            }
        }

        if !connected.is_empty() || !free_preset.is_empty() || cyclic_added {
            let frontier_ids: Vec<NodeId> = frontier.iter().map(|e| e.node).collect();
            if let Some(ref mut cb) = on_step { cb(graph, src, &frontier_ids); }
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
    rng: &mut MazeRng,
) -> Option<NodeId> {
    if reserve.is_empty() { return None; }
    let idx = gaussian_weighted_index(reserve.len(), params.depth_first, rng);
    let node = reserve.remove(idx);
    in_reserve.remove(&node);
    Some(node)
}

fn choose_from_frontier(frontier: &[FrontierEntry], params: &GenerationParams, rng: &mut MazeRng) -> usize {
    if frontier.len() == 1 { return 0; }
    gaussian_weighted_index(frontier.len(), params.depth_first, rng)
}

pub(super) fn junction_count(max: usize, params: &GenerationParams, rng: &mut MazeRng) -> usize {
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
    rng: &mut MazeRng,
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
    rng: &mut MazeRng,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generation::test_utils::{default_elements, make_field_and_graph};
    use rand::SeedableRng;

    fn rng(seed: u64) -> MazeRng { MazeRng::seed_from_u64(seed) }
    fn default_params() -> GenerationParams { GenerationParams::default() }

    #[test]
    fn junction_count_branching_zero_always_two() {
        let params = GenerationParams { branching: 0.0, ..default_params() };
        for seed in 0..50 {
            assert_eq!(junction_count(10, &params, &mut rng(seed)), 2);
        }
    }

    #[test]
    fn junction_count_branching_one_always_max() {
        let params = GenerationParams { branching: 1.0, ..default_params() };
        for max in 2..=6 {
            for seed in 0..20 {
                assert_eq!(junction_count(max, &params, &mut rng(seed)), max);
            }
        }
    }

    #[test]
    fn junction_count_max_two_always_two_regardless_of_branching() {
        for branching in [0.0, 0.5, 1.0] {
            let params = GenerationParams { branching, ..default_params() };
            for seed in 0..20 {
                assert_eq!(junction_count(2, &params, &mut rng(seed)), 2);
            }
        }
    }

    #[test]
    fn junction_count_result_in_range() {
        let params = GenerationParams { branching: 0.5, ..default_params() };
        for max in 2..=8 {
            for seed in 0..50 {
                let count = junction_count(max, &params, &mut rng(seed));
                assert!(count >= 2 && count <= max, "count={count} not in [2,{max}]");
            }
        }
    }

    fn empty_presets() -> super::PresetState { super::PresetState::empty() }

    #[test]
    fn vertex_based_visits_all_nodes() {
        let (field, mut graph) = make_field_and_graph(5, 5);
        let node_count = graph.nodes().count();
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut graph, &field, 42, start, &default_params(), &default_elements(), &empty_presets(), None);
        assert_eq!(graph.edges().count(), 2 * (node_count - 1));
    }

    #[test]
    fn vertex_based_is_deterministic() {
        let (field, mut g1) = make_field_and_graph(4, 4);
        let (_, mut g2) = make_field_and_graph(4, 4);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut g1, &field, 7, start, &default_params(), &default_elements(), &empty_presets(), None);
        generate(&mut g2, &field, 7, start, &default_params(), &default_elements(), &empty_presets(), None);
        let mut e1: Vec<_> = g1.edges().map(|e| (e.from, e.to)).collect();
        let mut e2: Vec<_> = g2.edges().map(|e| (e.from, e.to)).collect();
        e1.sort();
        e2.sort();
        assert_eq!(e1, e2);
    }
}
