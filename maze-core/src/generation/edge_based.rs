use std::collections::HashMap;
use rand::{Rng, SeedableRng};
use crate::random::MazeRng;
use crate::ids::NodeId;
use crate::graph::{Graph, EdgeKind};
use crate::space::{Field, Tessellation};
use super::{EdgeBasedParams, ElementsConfig, PresetState, try_add_edge, try_add_edge_kind, can_connect, gaussian_weighted_index};

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
        // fire this step (see try_add_cyclic_edge for the "both fired" case, where teleport is
        // spent on the cyclic edge instead).
        let teleport_flag = roll_teleport(src, &mut nodes, elements, &mut rng);
        let cyclic_flag = rng.random::<f64>() < params.cyclicity;
        let use_geometric_pool = !teleport_flag || cyclic_flag;

        let candidates = build_candidate_pool(src, use_geometric_pool, &nodes, preset_connected, preset_state, field);
        if candidates.is_empty() {
            remove_from_active(src, &mut active, &mut nodes);
            if last_dst == Some(src) { last_dst = None; }
            continue;
        }

        try_add_cyclic_edge(graph, field, src, cyclic_flag, teleport_flag, &nodes, elements, preset_state, &mut rng);

        let weights = dst_weights(src, &candidates, use_geometric_pool, corridor_fired, &nodes, params, field);
        let dst = candidates[weighted_sample_index(&weights, &mut rng)];

        if use_geometric_pool {
            // Geometric pool only: a `src`-`dst` preset pair (both `preset_connected`, matched by
            // the `preset_connected.contains(&src) && preset_connected.contains(&n)` exception in
            // `build_candidate_pool`) already has its edge built by `build_preset_state` — skip
            // `try_add_edge` (and `last_dst`, so a preset-skipped step can't seed a corridor
            // chain) to avoid duplicating it. Doesn't apply to the teleport pool below: there,
            // `dst` being `preset_connected` says nothing about the specific src-dst pair (it's
            // any Unseen node in the whole graph, not a geometric neighbor of `src`), so no edge
            // exists yet and skipping would silently drop the teleport.
            if !preset_connected.contains(&dst) {
                try_add_edge(graph, src, dst, elements, preset_state, &mut rng);
                last_dst = Some(dst);
            }
        } else {
            try_add_edge_kind(graph, src, dst, EdgeKind::Teleport, elements.teleport_one_way_chance, preset_state, &mut rng);
            last_dst = Some(dst);
        }

        let depth = nodes.get(&src).map(|e| e.tree_depth + 1).unwrap_or(1);
        nodes.insert(dst, NodeEntry { state: NodeState::Active, parent: Some(src), tree_depth: depth, teleport_rolled: false });
        active.push(dst);

        if is_src_exhausted(src, &nodes, preset_connected, preset_state, field) {
            remove_from_active(src, &mut active, &mut nodes);
            if last_dst == Some(src) { last_dst = None; }
        }
    }
}

/// Rolls `teleport_chance` for `src`, guarded to at most once per node (`NodeEntry.teleport_rolled`).
/// A node may become `src` multiple times before exhausting its geometric neighbors (each
/// `active`-lifetime pop is a separate connection opportunity), so without this guard the same
/// node's effective teleport probability would compound with its degree instead of applying once
/// per node.
fn roll_teleport(
    src: NodeId,
    nodes: &mut HashMap<NodeId, NodeEntry>,
    elements: &ElementsConfig,
    rng: &mut MazeRng,
) -> bool {
    let already_rolled = nodes.get(&src).map_or(false, |e| e.teleport_rolled);
    if already_rolled { return false; }
    let hit = rng.random::<f64>() < elements.teleport_chance;
    if let Some(entry) = nodes.get_mut(&src) { entry.teleport_rolled = true; }
    hit
}

/// Whether `n` is a geometric neighbor of `src` that a normal (non-teleport) connection could
/// still reach: Unseen, and either both nodes are preset_connected (a geometrically-adjacent
/// preset pair) or the pair isn't blocked/locked. Shared by `build_candidate_pool`'s geometric
/// branch and `is_src_exhausted`, which is exactly this predicate's negation over all neighbors.
fn is_reachable_unseen_neighbor(
    src: NodeId,
    n: NodeId,
    nodes: &HashMap<NodeId, NodeEntry>,
    preset_connected: &std::collections::BTreeSet<NodeId>,
    preset_state: &PresetState,
) -> bool {
    nodes.get(&n).map_or(false, |e| e.state == NodeState::Unseen)
        && (preset_connected.contains(&src) && preset_connected.contains(&n) || can_connect(src, n, preset_state))
}

fn build_candidate_pool<T: Tessellation>(
    src: NodeId,
    use_geometric_pool: bool,
    nodes: &HashMap<NodeId, NodeEntry>,
    preset_connected: &std::collections::BTreeSet<NodeId>,
    preset_state: &PresetState,
    field: &Field<T>,
) -> Vec<NodeId> {
    if use_geometric_pool {
        field.neighbors(src).into_iter()
            .filter(|&n| is_reachable_unseen_neighbor(src, n, nodes, preset_connected, preset_state))
            .collect()
    } else {
        // Teleport candidate pool: every Unseen node in the graph, not just geometric neighbors
        // of src. No preset_connected exception here — that exception exists only to handle
        // geometrically-adjacent preset pairs, which doesn't apply to teleport.
        sorted_nodes_in_state(nodes, NodeState::Unseen, |n| n != src && can_connect(src, n, preset_state))
    }
}

/// Cyclic roll (already decided by the caller): adds an extra edge to a visited node, independent
/// of the normal dst selection. If teleport also fired this step, the cyclic candidate pool
/// widens from "visited geometric neighbors" to "any visited node in the graph", and the added
/// edge is a Teleport rather than a Basic connection — teleport is considered spent on this
/// cyclic edge in that case (the caller's dst-choice step then always uses the geometric pool).
fn try_add_cyclic_edge<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    src: NodeId,
    cyclic_flag: bool,
    teleport_flag: bool,
    nodes: &HashMap<NodeId, NodeEntry>,
    elements: &ElementsConfig,
    preset_state: &PresetState,
    rng: &mut MazeRng,
) {
    if !cyclic_flag { return; }

    if teleport_flag {
        let visited_nodes = sorted_nodes_in_state(nodes, NodeState::Visited, |n| {
            n != src && can_connect(src, n, preset_state)
                && graph.edge_between(src, n).is_none() && graph.edge_between(n, src).is_none()
        });
        if !visited_nodes.is_empty() {
            let cyclic_dst = visited_nodes[rng.random_range(0..visited_nodes.len())];
            try_add_edge_kind(graph, src, cyclic_dst, EdgeKind::Teleport, elements.teleport_one_way_chance, preset_state, rng);
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
            try_add_edge(graph, src, cyclic_dst, elements, preset_state, rng);
            // last_dst not updated: visited node cannot seed a corridor chain
        }
    }
}

/// dst-choice weight: directionality only makes sense for the geometric pool (it needs
/// `field.is_straight`, which is meaningless for a non-adjacent teleport candidate) — the
/// teleport pool (`!use_geometric_pool`) uses branching alone.
fn dst_weights<T: Tessellation>(
    src: NodeId,
    candidates: &[NodeId],
    use_geometric_pool: bool,
    corridor_fired: bool,
    nodes: &HashMap<NodeId, NodeEntry>,
    params: &EdgeBasedParams,
    field: &Field<T>,
) -> Vec<f64> {
    candidates.iter().map(|&dst| {
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
    }).collect()
}

fn is_src_exhausted<T: Tessellation>(
    src: NodeId,
    nodes: &HashMap<NodeId, NodeEntry>,
    preset_connected: &std::collections::BTreeSet<NodeId>,
    preset_state: &PresetState,
    field: &Field<T>,
) -> bool {
    field.neighbors(src).into_iter()
        .all(|n| !is_reachable_unseen_neighbor(src, n, nodes, preset_connected, preset_state))
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
#[path = "edge_based_tests.rs"]
mod tests;
