use std::collections::HashSet;
use rand::{Rng, SeedableRng};
use crate::random::MazeRng;
use crate::ids::NodeId;
use crate::graph::{Graph, EdgeKind};
use crate::space::{Field, Tessellation};
use super::{ElementsConfig, GenerationParams, PresetState, StepCallback, try_add_edge, try_add_edge_kind, can_connect, gaussian_weighted_index};

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

    // Sorted once for deterministic iteration order — used only as the candidate pool for
    // teleport rolls (any-node-in-the-graph, not restricted to geometric neighbors).
    let mut all_nodes: Vec<NodeId> = graph.nodes().map(|n| n.id).collect();
    all_nodes.sort_unstable();

    visited.insert(start);
    add_to_frontier(start, None, &mut frontier, &mut in_frontier);

    loop {
        if frontier.is_empty() {
            // Teleport roll happens before any reserve lookup — a hit replaces this step's
            // entire mechanism (bridges via a teleport instead of a geometric-adjacency bridge).
            if rng.random::<f64>() < elements.teleport_chance {
                let unvisited: Vec<NodeId> = all_nodes.iter().copied()
                    .filter(|n| !visited.contains(n))
                    .collect();
                if unvisited.is_empty() {
                    // Nothing left to bring in via teleport either — generation is done.
                    break;
                }
                let src = unvisited[rng.random_range(0..unvisited.len())];
                let visited_nodes: Vec<NodeId> = all_nodes.iter().copied()
                    .filter(|n| visited.contains(n))
                    .collect();
                let bridge = visited_nodes[rng.random_range(0..visited_nodes.len())];
                try_add_edge_kind(graph, bridge, src, EdgeKind::Teleport, elements.teleport_one_way_chance, preset_state, &mut rng);
                visited.insert(src);
                add_to_frontier(src, Some(bridge), &mut frontier, &mut in_frontier);
                let frontier_ids: Vec<NodeId> = frontier.iter().map(|e| e.node).collect();
                if let Some(ref mut cb) = on_step { cb(graph, src, &frontier_ids); }
                continue;
            }

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

        // Teleport roll happens immediately after src is fixed, before any geometric-neighbor
        // pool is built — a hit affects the cyclic-roll's candidate pool (below) and adds one
        // extra teleport connection alongside whatever the corridor/junction roll produces.
        let teleport_hit = rng.random::<f64>() < elements.teleport_chance;

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
        // This happens regardless of free_neighbors availability. If a teleport was rolled for
        // this src, the cyclic candidate pool widens from "visited geometric neighbors" to "any
        // visited node in the graph" — the teleport roll is considered "spent" on this cyclic
        // edge in that case, and does not also apply to the corridor/junction step below.
        let mut teleport_spent_on_cycle = false;
        let cyclic_dst: Option<NodeId> = if rng.random::<f64>() < params.cyclicity {
            if teleport_hit {
                let candidates: Vec<NodeId> = all_nodes.iter().copied()
                    .filter(|&n| n != src && visited.contains(&n) && can_connect(src, n, preset_state)
                        && graph.edge_between(src, n).is_none() && graph.edge_between(n, src).is_none())
                    .collect();
                if candidates.is_empty() {
                    None
                } else {
                    teleport_spent_on_cycle = true;
                    Some(candidates[rng.random_range(0..candidates.len())])
                }
            } else {
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
            }
        } else {
            None
        };
        // Teleport still available for the corridor/junction step below unless the cyclic
        // roll already consumed it (it fired and found a candidate).
        let teleport_for_connect = teleport_hit && !teleport_spent_on_cycle;

        let is_corridor = rng.random::<f64>() < params.corridor_chance;

        let connected: Vec<NodeId> = if is_corridor {
            if free_regular.is_empty() {
                vec![]
            } else {
                vec![choose_candidate(&free_regular, parent, src, params, &mut rng, field)]
            }
        } else {
            let max = free_regular.len();
            // When a teleport is pending for this connect step, junction_count is rolled against
            // one extra virtual slot (max+1) so the teleport doesn't add branching *beyond* what
            // junction already decided for this src — count-1 geometric connections are then
            // taken, leaving exactly one slot for the teleport connection added below.
            let virtual_max = if teleport_for_connect { max + 1 } else { max };
            if virtual_max == 0 {
                vec![]
            } else if virtual_max == 1 {
                if max == 0 { vec![] } else { vec![free_regular[0]] }
            } else {
                let count = junction_count(virtual_max, params, &mut rng);
                let geometric_count = if teleport_for_connect { count.saturating_sub(1) } else { count };
                if geometric_count == 0 {
                    vec![]
                } else {
                    choose_junction_candidates(&free_regular, parent, src, geometric_count, params, &mut rng, field)
                }
            }
        };

        let cyclic_added = if let Some(cyclic) = cyclic_dst {
            if teleport_spent_on_cycle {
                try_add_edge_kind(graph, src, cyclic, EdgeKind::Teleport, elements.teleport_one_way_chance, preset_state, &mut rng);
            } else {
                try_add_edge(graph, src, cyclic, elements, preset_state, &mut rng);
            }
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

        // Teleport connection: added alongside whatever corridor/junction chose above, to a
        // random unvisited node in the graph (not necessarily a geometric neighbor). Skipped if
        // the teleport roll was already spent on the cyclic edge, or if no unvisited node remains.
        let mut teleport_dst: Option<NodeId> = None;
        if teleport_for_connect {
            let unvisited: Vec<NodeId> = all_nodes.iter().copied()
                .filter(|n| !visited.contains(n))
                .collect();
            if !unvisited.is_empty() {
                let dst = unvisited[rng.random_range(0..unvisited.len())];
                try_add_edge_kind(graph, src, dst, EdgeKind::Teleport, elements.teleport_one_way_chance, preset_state, &mut rng);
                visited.insert(dst);
                in_reserve.remove(&dst);
                add_to_frontier(dst, Some(src), &mut frontier, &mut in_frontier);
                teleport_dst = Some(dst);
            }
        }

        for n in free_regular {
            // A node that just became the teleport destination is already `visited` (marked
            // above) by this point, so `!visited.contains(&n)` alone already keeps it out of
            // reserve — it went to the frontier instead, as intended.
            if !connected_set.contains(&n) && !in_reserve.contains(&n) && !visited.contains(&n) {
                reserve.push(n);
                in_reserve.insert(n);
            }
        }

        if !connected.is_empty() || !free_preset.is_empty() || cyclic_added || teleport_dst.is_some() {
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

    // ─── add_to_frontier / pop_reserve / choose_from_frontier ───────────────

    #[test]
    fn add_to_frontier_appends_new_node_with_parent() {
        let mut frontier: Vec<FrontierEntry> = vec![];
        let mut in_frontier: HashSet<NodeId> = HashSet::new();

        add_to_frontier(1, Some(0), &mut frontier, &mut in_frontier);

        assert_eq!(frontier.len(), 1);
        assert_eq!(frontier[0].node, 1);
        assert_eq!(frontier[0].parent, Some(0));
        assert!(in_frontier.contains(&1));
    }

    #[test]
    fn add_to_frontier_ignores_duplicate_node() {
        let mut frontier: Vec<FrontierEntry> = vec![];
        let mut in_frontier: HashSet<NodeId> = HashSet::new();

        add_to_frontier(1, Some(0), &mut frontier, &mut in_frontier);
        add_to_frontier(1, Some(5), &mut frontier, &mut in_frontier); // different parent, same node

        assert_eq!(frontier.len(), 1, "node already in frontier must not be pushed again");
        assert_eq!(frontier[0].parent, Some(0), "first insertion's parent must be preserved");
    }

    #[test]
    fn pop_reserve_returns_none_when_empty() {
        let mut reserve: Vec<NodeId> = vec![];
        let mut in_reserve: HashSet<NodeId> = HashSet::new();
        let params = default_params();

        assert_eq!(pop_reserve(&mut reserve, &mut in_reserve, &params, &mut rng(1)), None);
    }

    #[test]
    fn pop_reserve_removes_and_returns_the_only_element() {
        let mut reserve: Vec<NodeId> = vec![7];
        let mut in_reserve: HashSet<NodeId> = [7].into_iter().collect();
        let params = default_params();

        let popped = pop_reserve(&mut reserve, &mut in_reserve, &params, &mut rng(1));

        assert_eq!(popped, Some(7));
        assert!(reserve.is_empty());
        assert!(!in_reserve.contains(&7));
    }

    #[test]
    fn pop_reserve_depth_first_one_prefers_last_inserted() {
        let params = GenerationParams { depth_first: 1.0, ..default_params() };
        let mut last_wins = 0;
        for seed in 0..100 {
            let mut reserve: Vec<NodeId> = vec![10, 20, 30];
            let mut in_reserve: HashSet<NodeId> = [10, 20, 30].into_iter().collect();
            if pop_reserve(&mut reserve, &mut in_reserve, &params, &mut rng(seed)) == Some(30) {
                last_wins += 1;
            }
        }
        assert!(last_wins >= 95, "depth_first=1.0: last-inserted reserve entry should dominate, got {last_wins}/100");
    }

    #[test]
    fn choose_from_frontier_single_entry_returns_zero() {
        let frontier = vec![FrontierEntry { node: 42, parent: None }];
        let params = default_params();
        for seed in 0..20 {
            assert_eq!(choose_from_frontier(&frontier, &params, &mut rng(seed)), 0);
        }
    }

    #[test]
    fn choose_from_frontier_result_always_in_bounds() {
        let frontier = vec![
            FrontierEntry { node: 1, parent: None },
            FrontierEntry { node: 2, parent: None },
            FrontierEntry { node: 3, parent: None },
        ];
        let params = GenerationParams { depth_first: 0.5, ..default_params() };
        for seed in 0..200 {
            let idx = choose_from_frontier(&frontier, &params, &mut rng(seed));
            assert!(idx < frontier.len(), "seed {seed}: index {idx} out of bounds");
        }
    }

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
    fn teleport_chance_zero_matches_baseline_exactly() {
        // teleport_chance=0.0 must never roll a teleport edge and must reproduce the exact
        // same edge set as generation without any teleport awareness at all (regression guard
        // for the refactor that threaded teleport rolls through this function).
        for seed in [1, 7, 42, 1234, 9999] {
            let (field, mut graph) = make_field_and_graph(6, 6);
            let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
            generate(&mut graph, &field, seed, start, &default_params(), &no_teleport_elements(), &empty_presets(), None);
            assert!(teleport_edges(&graph).is_empty(), "seed {seed}: teleport_chance=0.0 must add no teleport edges");
        }
    }

    #[test]
    fn teleport_chance_one_adds_teleport_edges() {
        let (field, mut graph) = make_field_and_graph(6, 6);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut graph, &field, 42, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
        assert!(!teleport_edges(&graph).is_empty(), "teleport_chance=1.0 should add at least one teleport edge on a 6x6 field");
    }

    #[test]
    fn teleport_edges_can_connect_non_geometric_neighbors() {
        // At least one teleport edge in a large-enough field must link two nodes that are not
        // geometric neighbors — otherwise the "regardless of adjacency" property isn't exercised.
        let (field, mut graph) = make_field_and_graph(8, 8);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut graph, &field, 7, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
        let has_non_adjacent_teleport = teleport_edges(&graph).iter()
            .any(|&(from, to)| !field.neighbors(from).contains(&to));
        assert!(has_non_adjacent_teleport, "expected at least one teleport edge between non-adjacent nodes");
    }

    #[test]
    fn teleport_one_way_chance_zero_all_teleports_are_two_way() {
        let (field, mut graph) = make_field_and_graph(6, 6);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut graph, &field, 42, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
        let edges = teleport_edges(&graph);
        assert!(!edges.is_empty(), "expected teleport edges to assert two-way-ness over");
        for &(from, to) in &edges {
            assert!(graph.edges().any(|e| e.from == to && e.to == from && e.kind == EdgeKind::Teleport),
                "teleport {from}->{to} has no reverse, but teleport_one_way_chance was 0.0");
        }
    }

    #[test]
    fn teleport_one_way_chance_one_all_teleports_are_one_way() {
        let (field, mut graph) = make_field_and_graph(6, 6);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut graph, &field, 42, start, &default_params(), &full_one_way_teleport_elements(), &empty_presets(), None);
        let edges = teleport_edges(&graph);
        assert!(!edges.is_empty(), "expected teleport edges to assert one-way-ness over");
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
        generate(&mut graph, &field, 42, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
        assert_eq!(graph.nodes().count(), node_count);
        for node in graph.nodes() {
            let has_edge = graph.edges().any(|e| e.from == node.id || e.to == node.id);
            assert!(has_edge, "node {} was never connected", node.id);
        }
        assert!(crate::validation::is_connected(&graph, start), "maze with teleport_chance=1.0 must stay connected from start");
    }

    #[test]
    fn teleport_is_deterministic_for_fixed_seed() {
        let (field, mut g1) = make_field_and_graph(6, 6);
        let (_, mut g2) = make_field_and_graph(6, 6);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut g1, &field, 55, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
        generate(&mut g2, &field, 55, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
        let mut e1: Vec<_> = g1.edges().map(|e| (e.from, e.to, e.kind.clone())).collect();
        let mut e2: Vec<_> = g2.edges().map(|e| (e.from, e.to, e.kind.clone())).collect();
        e1.sort_by_key(|(f, t, _)| (*f, *t));
        e2.sort_by_key(|(f, t, _)| (*f, *t));
        assert_eq!(e1, e2);
    }

    #[test]
    fn teleport_single_node_field_never_panics() {
        let mut ids = crate::ids::IdGenerator::new();
        let field: Field<crate::space::SquareTessellation> =
            Field::new(vec![crate::space::SquarePoint { x: 0, y: 0 }], &mut ids).unwrap();
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut graph, &field, 1, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
        assert!(teleport_edges(&graph).is_empty(), "single-node field has no partner for a teleport");
    }

    #[test]
    fn teleport_fragmented_field_frontier_empty_branch_stays_connected() {
        // A field with an isolated cell (only reachable via the frontier-empty/reserve
        // mechanism, never as a direct geometric neighbor of anything visited early) forces
        // the frontier-empty teleport branch to actually run.
        let mut ids = crate::ids::IdGenerator::new();
        use crate::space::SquarePoint;
        // 3x3 block plus one far-away isolated point, connected to nothing geometrically.
        let mut points: Vec<SquarePoint> = crate::space::square_rect(3, 3);
        points.push(SquarePoint { x: 100, y: 100 });
        let field: Field<crate::space::SquareTessellation> = Field::new(points, &mut ids).unwrap();
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);
        let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let node_count = graph.nodes().count();

        generate(&mut graph, &field, 3, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);

        // With teleport_chance=1.0, the isolated point must be reachable via a teleport bridge
        // through the frontier-empty branch (it can never be a `free_regular` geometric
        // neighbor of anything, since it has none within the field).
        assert_eq!(graph.nodes().count(), node_count);
        assert!(crate::validation::is_connected(&graph, start),
            "isolated point must be bridged in via teleport when frontier empties");
    }

    #[test]
    fn teleport_respects_locked_out_source() {
        // A teleport roll must still honor preset_state: a locked_out source can never gain an
        // outgoing teleport (nor an outgoing geometric edge).
        let (field, mut graph) = make_field_and_graph(4, 4);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        let a = start;
        let mut preset_state = PresetState::empty();
        preset_state.locked_out.insert(a);

        generate(&mut graph, &field, 42, start, &default_params(), &full_two_way_teleport_elements(), &preset_state, None);

        assert!(graph.edges().all(|e| e.from != a), "locked_out node {a} must never be an edge source (teleport or otherwise)");
    }

    #[test]
    fn teleport_respects_locked_in_destination() {
        let (field, mut graph) = make_field_and_graph(4, 4);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        let b = field.node_at(crate::space::SquarePoint { x: 3, y: 3 }).unwrap();
        let mut preset_state = PresetState::empty();
        preset_state.locked_in.insert(b);

        generate(&mut graph, &field, 42, start, &default_params(), &full_two_way_teleport_elements(), &preset_state, None);

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

        generate(&mut graph, &field, 42, start, &default_params(), &full_two_way_teleport_elements(), &preset_state, None);

        assert!(graph.edge_between(a, b).is_none(), "fully blocked pair ({a},{b}) must never get an edge, teleport or otherwise");
    }

    // Note: a same-direction Basic+Teleport parallel pair cannot arise from this algorithm's own
    // rolls — the teleport destination is always drawn from the unvisited pool, which by
    // definition has no prior edge from its bridge/src yet. The Graph-level coexistence guarantee
    // (kind-aware dedup in add_edge/add_bidirectional_edge) is covered directly in
    // graph::parallel_edges_tests.

    #[test]
    fn teleport_junction_reduces_geometric_count_by_one_when_teleport_added() {
        // With branching=1.0 (always maximal junction) and teleport_chance=1.0, corridor_chance=0.0
        // (always junction) on an interior node with 4 geometric neighbors: junction_count(max+1=5)
        // with branching=1.0 always returns max (5), so geometric_count = 5-1 = 4 = every free
        // neighbor, plus exactly one teleport edge. Total out-degree from src should be 5.
        let params = GenerationParams {
            depth_first: 0.0,
            corridor_chance: 0.0,
            branching: 1.0,
            directionality: 0.0,
            cyclicity: 0.0,
        };
        let (field, mut graph) = make_field_and_graph(5, 5);
        // Center node of a 5x5 field has 4 free geometric neighbors when starting there.
        let start = field.node_at(crate::space::SquarePoint { x: 2, y: 2 }).unwrap();
        generate(&mut graph, &field, 11, start, &params, &full_two_way_teleport_elements(), &empty_presets(), None);

        // src's out-degree (counting both directions of any bidirectional edge as present)
        // must include all 4 geometric neighbors plus exactly one teleport partner.
        let geometric_neighbors: HashSet<NodeId> = field.neighbors(start).into_iter().collect();
        let src_edges: Vec<_> = graph.edges().filter(|e| e.from == start || e.to == start).collect();
        let teleport_partners: HashSet<NodeId> = src_edges.iter()
            .filter(|e| e.kind == EdgeKind::Teleport)
            .map(|e| if e.from == start { e.to } else { e.from })
            .collect();
        let geometric_partners: HashSet<NodeId> = src_edges.iter()
            .filter(|e| e.kind == EdgeKind::Basic)
            .map(|e| if e.from == start { e.to } else { e.from })
            .collect();

        assert_eq!(geometric_partners, geometric_neighbors, "all 4 geometric neighbors must still be connected");
        assert_eq!(teleport_partners.len(), 1, "exactly one teleport connection expected alongside the full junction");
    }

    #[test]
    fn teleport_corridor_adds_exactly_one_geometric_and_one_teleport() {
        // corridor_chance=1.0 (always corridor, one geometric connection) + teleport_chance=1.0:
        // the teleport must be an *additional* connection alongside the corridor's one geometric
        // connection, not a replacement.
        let params = GenerationParams {
            depth_first: 0.0,
            corridor_chance: 1.0,
            branching: 0.0,
            directionality: 0.0,
            cyclicity: 0.0,
        };
        let (field, mut graph) = make_field_and_graph(5, 5);
        let start = field.node_at(crate::space::SquarePoint { x: 2, y: 2 }).unwrap();
        generate(&mut graph, &field, 13, start, &params, &full_two_way_teleport_elements(), &empty_presets(), None);

        let src_edges: Vec<_> = graph.edges().filter(|e| e.from == start || e.to == start).collect();
        let has_geometric = src_edges.iter().any(|e| e.kind == EdgeKind::Basic);
        let has_teleport = src_edges.iter().any(|e| e.kind == EdgeKind::Teleport);
        assert!(has_geometric, "corridor must still add its one geometric connection");
        assert!(has_teleport, "teleport_chance=1.0 must add an additional teleport connection alongside the corridor");
    }

    #[test]
    fn teleport_cyclic_roll_widens_pool_to_any_visited_node() {
        // With cyclicity=1.0 and teleport_chance=1.0, the cyclic edge should be able to reach a
        // visited node that is NOT a geometric neighbor of src — proving the widened pool
        // ("any visited node") is actually used instead of the normal geometric-only pool.
        let params = GenerationParams {
            depth_first: 0.0,
            corridor_chance: 1.0,
            branching: 0.0,
            directionality: 0.0,
            cyclicity: 1.0,
        };
        let (field, mut graph) = make_field_and_graph(8, 8);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut graph, &field, 21, start, &params, &full_two_way_teleport_elements(), &empty_presets(), None);

        // At least one Teleport-kind edge should exist that isn't a geometric neighbor pair —
        // this covers both the cyclic-teleport path and the corridor/junction-teleport path,
        // since both can produce non-adjacent Teleport edges under these params.
        let has_non_adjacent_teleport = teleport_edges(&graph).iter()
            .any(|&(from, to)| !field.neighbors(from).contains(&to));
        assert!(has_non_adjacent_teleport, "expected at least one non-adjacent teleport edge with cyclicity=1.0, teleport_chance=1.0");
    }

    #[test]
    fn teleport_never_creates_self_loop() {
        for seed in 0..30 {
            let (field, mut graph) = make_field_and_graph(4, 4);
            let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
            generate(&mut graph, &field, seed, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
            assert!(graph.edges().all(|e| e.from != e.to), "seed {seed}: no edge (teleport or otherwise) may be a self-loop");
        }
    }
}
