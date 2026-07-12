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

/// Mutable traversal state threaded through one `generate` run — bundled so the per-step helper
/// functions don't each need a 6+ parameter list. `all_nodes` is sorted once at construction for
/// deterministic iteration order (candidate pool for teleport rolls: any node in the graph, not
/// restricted to geometric neighbors).
struct GenState {
    visited:     HashSet<NodeId>,
    in_frontier: HashSet<NodeId>,
    frontier:    Vec<FrontierEntry>,
    reserve:     Vec<NodeId>,
    in_reserve:  HashSet<NodeId>,
    rng:         MazeRng,
    all_nodes:   Vec<NodeId>,
}

impl GenState {
    fn new(graph: &Graph, seed: u64, start: NodeId) -> Self {
        let mut all_nodes: Vec<NodeId> = graph.nodes().map(|n| n.id).collect();
        all_nodes.sort_unstable();
        let mut state = GenState {
            visited:     HashSet::new(),
            in_frontier: HashSet::new(),
            frontier:    Vec::new(),
            reserve:     Vec::new(),
            in_reserve:  HashSet::new(),
            rng:         MazeRng::seed_from_u64(seed),
            all_nodes,
        };
        // preset_connected nodes are NOT added to visited upfront — this keeps them visible
        // as connection targets for free_neighbors. Exception: start itself may be preset_connected
        // (e.g. gen_source inside a preset cluster) — it must enter the frontier regardless.
        state.visited.insert(start);
        add_to_frontier(start, None, &mut state.frontier, &mut state.in_frontier);
        state
    }

    fn frontier_ids(&self) -> Vec<NodeId> {
        self.frontier.iter().map(|e| e.node).collect()
    }
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
    let mut state = GenState::new(graph, seed, start);

    loop {
        if state.frontier.is_empty() {
            if !handle_empty_frontier(graph, field, params, elements, preset_state, &mut state, &mut on_step) {
                break;
            }
            continue;
        }

        step_from_frontier(graph, field, params, elements, preset_state, &mut state, &mut on_step);
    }
}

/// Bridges a new node into the maze when the frontier is empty — either via a teleport roll (a
/// hit replaces the step's entire mechanism: bridges via teleport instead of geometric adjacency)
/// or by popping a reachable candidate off `reserve`. Returns `false` when generation is done
/// (nothing left to bring in either way), `true` to keep looping.
fn handle_empty_frontier<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    params: &GenerationParams,
    elements: &ElementsConfig,
    preset_state: &PresetState,
    state: &mut GenState,
    on_step: &mut Option<&mut StepCallback<'_>>,
) -> bool {
    // Teleport roll happens before any reserve lookup — a hit replaces this step's
    // entire mechanism (bridges via a teleport instead of a geometric-adjacency bridge).
    if state.rng.random::<f64>() < elements.teleport_chance {
        let unvisited: Vec<NodeId> = state.all_nodes.iter().copied()
            .filter(|n| !state.visited.contains(n))
            .collect();
        if unvisited.is_empty() {
            // Nothing left to bring in via teleport either — generation is done.
            return false;
        }
        let src = unvisited[state.rng.random_range(0..unvisited.len())];
        let visited_nodes: Vec<NodeId> = state.all_nodes.iter().copied()
            .filter(|n| state.visited.contains(n))
            .collect();
        let bridge = visited_nodes[state.rng.random_range(0..visited_nodes.len())];
        try_add_edge_kind(graph, bridge, src, EdgeKind::Teleport, elements.teleport_one_way_chance, preset_state, &mut state.rng);
        state.visited.insert(src);
        add_to_frontier(src, Some(bridge), &mut state.frontier, &mut state.in_frontier);
        let frontier_ids = state.frontier_ids();
        if let Some(cb) = on_step { cb(graph, src, &frontier_ids); }
        return true;
    }

    // Pop candidates from reserve until we find one with a visited neighbor.
    // Track seen candidates to avoid infinite cycling over nodes that are
    // not yet reachable (none of their neighbors are visited).
    let mut seen: HashSet<NodeId> = HashSet::new();
    let src = loop {
        let Some(candidate) = pop_reserve(&mut state.reserve, &mut state.in_reserve, params, &mut state.rng) else {
            break None;
        };
        if state.visited.contains(&candidate) { continue; }
        if seen.contains(&candidate) { break None; }
        seen.insert(candidate);
        let has_visited_neighbor = field.neighbors(candidate)
            .into_iter()
            .any(|n| state.visited.contains(&n) && can_connect(n, candidate, preset_state));
        if has_visited_neighbor {
            break Some(candidate);
        }
        state.reserve.push(candidate);
        state.in_reserve.insert(candidate);
    };
    let Some(src) = src else { return false; };
    let visited_neighbors: Vec<NodeId> = field.neighbors(src)
        .into_iter()
        .filter(|&n| state.visited.contains(&n) && can_connect(n, src, preset_state))
        .collect();
    let bridge = visited_neighbors[state.rng.random_range(0..visited_neighbors.len())];
    try_add_edge(graph, bridge, src, elements, preset_state, &mut state.rng);
    state.visited.insert(src);
    add_to_frontier(src, Some(bridge), &mut state.frontier, &mut state.in_frontier);
    let frontier_ids = state.frontier_ids();
    if let Some(cb) = on_step { cb(graph, src, &frontier_ids); }
    true
}

/// One "pop a frontier node and connect its free neighbors" step — the main-loop body once the
/// frontier is non-empty: teleport roll, cyclic-roll (possibly teleport-widened), corridor/
/// junction connect-choice, then applying every mutation this step decided on in order.
fn step_from_frontier<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    params: &GenerationParams,
    elements: &ElementsConfig,
    preset_state: &PresetState,
    state: &mut GenState,
    on_step: &mut Option<&mut StepCallback<'_>>,
) {
    let fi = choose_from_frontier(&state.frontier, params, &mut state.rng);
    let src = state.frontier[fi].node;
    let parent = state.frontier[fi].parent;

    state.frontier.remove(fi);
    state.in_frontier.remove(&src);

    // Teleport roll happens immediately after src is fixed, before any geometric-neighbor
    // pool is built — a hit affects the cyclic-roll's candidate pool (below) and adds one
    // extra teleport connection alongside whatever the corridor/junction roll produces.
    let teleport_hit = state.rng.random::<f64>() < elements.teleport_chance;

    // free_regular: unvisited, non-frontier, non-preset neighbors — become frontier/reserve.
    // free_preset: preset-connected neighbors not yet visited — connect to them but skip frontier.
    let preset_connected = &preset_state.preset_connected;
    let all_free: Vec<NodeId> = field.neighbors(src)
        .into_iter()
        .filter(|&n| !state.visited.contains(&n) && !state.in_frontier.contains(&n)
            && (preset_connected.contains(&src) && preset_connected.contains(&n) || can_connect(src, n, preset_state)))
        .collect();
    let (free_preset, free_regular): (Vec<NodeId>, Vec<NodeId>) =
        all_free.into_iter().partition(|n| preset_connected.contains(n));

    let (cyclic_dst, teleport_spent_on_cycle) =
        roll_cyclic_edge(graph, field, params, preset_state, state, src, teleport_hit);
    // Teleport still available for the corridor/junction step below unless the cyclic
    // roll already consumed it (it fired and found a candidate).
    let teleport_for_connect = teleport_hit && !teleport_spent_on_cycle;

    let connected = choose_connect_targets(field, params, state, &free_regular, parent, src, teleport_for_connect);

    let cyclic_added = if let Some(cyclic) = cyclic_dst {
        if teleport_spent_on_cycle {
            try_add_edge_kind(graph, src, cyclic, EdgeKind::Teleport, elements.teleport_one_way_chance, preset_state, &mut state.rng);
        } else {
            try_add_edge(graph, src, cyclic, elements, preset_state, &mut state.rng);
        }
        true
    } else {
        false
    };

    // Preset neighbors: already connected by preset edges, so skip try_add_edge.
    // Just mark visited and push to frontier so the algorithm traverses through them.
    for &dst in &free_preset {
        state.visited.insert(dst);
        state.in_reserve.remove(&dst);
        add_to_frontier(dst, Some(src), &mut state.frontier, &mut state.in_frontier);
    }
    state.reserve.retain(|x| !free_preset.contains(x));

    let connected_set: HashSet<NodeId> = connected.iter().copied().collect();
    for &dst in &connected {
        try_add_edge(graph, src, dst, elements, preset_state, &mut state.rng);
        state.visited.insert(dst);
        state.in_reserve.remove(&dst);
        add_to_frontier(dst, Some(src), &mut state.frontier, &mut state.in_frontier);
    }
    state.reserve.retain(|x| !connected_set.contains(x));

    // Teleport connection: added alongside whatever corridor/junction chose above, to a
    // random unvisited node in the graph (not necessarily a geometric neighbor). Skipped if
    // the teleport roll was already spent on the cyclic edge, or if no unvisited node remains.
    let mut teleport_dst: Option<NodeId> = None;
    if teleport_for_connect {
        let unvisited: Vec<NodeId> = state.all_nodes.iter().copied()
            .filter(|n| !state.visited.contains(n))
            .collect();
        if !unvisited.is_empty() {
            let dst = unvisited[state.rng.random_range(0..unvisited.len())];
            try_add_edge_kind(graph, src, dst, EdgeKind::Teleport, elements.teleport_one_way_chance, preset_state, &mut state.rng);
            state.visited.insert(dst);
            state.in_reserve.remove(&dst);
            add_to_frontier(dst, Some(src), &mut state.frontier, &mut state.in_frontier);
            teleport_dst = Some(dst);
        }
    }

    for n in free_regular {
        // A node that just became the teleport destination is already `visited` (marked
        // above) by this point, so `!visited.contains(&n)` alone already keeps it out of
        // reserve — it went to the frontier instead, as intended.
        if !connected_set.contains(&n) && !state.in_reserve.contains(&n) && !state.visited.contains(&n) {
            state.reserve.push(n);
            state.in_reserve.insert(n);
        }
    }

    if !connected.is_empty() || !free_preset.is_empty() || cyclic_added || teleport_dst.is_some() {
        let frontier_ids = state.frontier_ids();
        if let Some(cb) = on_step { cb(graph, src, &frontier_ids); }
    }
}

/// Cyclic roll: if triggered, picks one visited neighbor and returns it as a cycle-edge target.
/// This happens regardless of free_neighbors availability. If a teleport was rolled for this src,
/// the candidate pool widens from "visited geometric neighbors" to "any visited node in the
/// graph" and the second return value is `true` (the teleport roll is considered "spent" on this
/// cyclic edge in that case, and must not also apply to the corridor/junction step).
fn roll_cyclic_edge<T: Tessellation>(
    graph: &Graph,
    field: &Field<T>,
    params: &GenerationParams,
    preset_state: &PresetState,
    state: &mut GenState,
    src: NodeId,
    teleport_hit: bool,
) -> (Option<NodeId>, bool) {
    if !(state.rng.random::<f64>() < params.cyclicity) {
        return (None, false);
    }
    if teleport_hit {
        let candidates: Vec<NodeId> = state.all_nodes.iter().copied()
            .filter(|&n| n != src && state.visited.contains(&n) && can_connect(src, n, preset_state)
                && graph.edge_between(src, n).is_none() && graph.edge_between(n, src).is_none())
            .collect();
        if candidates.is_empty() {
            (None, false)
        } else {
            (Some(candidates[state.rng.random_range(0..candidates.len())]), true)
        }
    } else {
        let visited_neighbors: Vec<NodeId> = field.neighbors(src)
            .into_iter()
            .filter(|&n| state.visited.contains(&n) && can_connect(src, n, preset_state)
                && graph.edge_between(src, n).is_none() && graph.edge_between(n, src).is_none())
            .collect();
        if visited_neighbors.is_empty() {
            (None, false)
        } else {
            (Some(visited_neighbors[state.rng.random_range(0..visited_neighbors.len())]), false)
        }
    }
}

/// Corridor/junction connect-choice: picks which of `free_regular` to connect `src` to this step.
/// When `teleport_for_connect` is set, `junction_count` is rolled against one extra virtual slot
/// so the teleport doesn't add branching *beyond* what junction already decided for this src —
/// count-1 geometric connections are taken, leaving exactly one slot for the teleport connection
/// `step_from_frontier` adds afterward.
fn choose_connect_targets<T: Tessellation>(
    field: &Field<T>,
    params: &GenerationParams,
    state: &mut GenState,
    free_regular: &[NodeId],
    parent: Option<NodeId>,
    src: NodeId,
    teleport_for_connect: bool,
) -> Vec<NodeId> {
    let is_corridor = state.rng.random::<f64>() < params.corridor_chance;

    if is_corridor {
        if free_regular.is_empty() {
            vec![]
        } else {
            vec![choose_candidate(free_regular, parent, src, params, &mut state.rng, field)]
        }
    } else {
        let max = free_regular.len();
        let virtual_max = if teleport_for_connect { max + 1 } else { max };
        if virtual_max == 0 {
            vec![]
        } else if virtual_max == 1 {
            if max == 0 { vec![] } else { vec![free_regular[0]] }
        } else {
            let count = junction_count(virtual_max, params, &mut state.rng);
            let geometric_count = if teleport_for_connect { count.saturating_sub(1) } else { count };
            if geometric_count == 0 {
                vec![]
            } else {
                choose_junction_candidates(free_regular, parent, src, geometric_count, params, &mut state.rng, field)
            }
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
#[path = "vertex_based_tests.rs"]
mod tests;
