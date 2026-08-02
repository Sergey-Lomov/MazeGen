use std::collections::HashSet;
use rand::Rng;
use crate::ids::{IdGenerator, NodeId};
use crate::graph::Graph;
use crate::space::{Field, Tessellation};
use crate::event_log::ScopeGuard;
use super::{ElementsConfig, PresetState, GenerationParams};
use super::debug_state::DebugGenerationState;
use super::split_pattern::SplitGenerationConfig;
use super::edge_ops::try_add_edge;
use super::vertex_based::{VertexBasedEvent, GenState, run_ordinary_step_body_for_node, add_edge_and_detect_direction};
use super::split_logic::StartReassignment;
use super::split_shared::{mint_split_nodes, sync_all_nodes, maybe_reassign_start, apply_split_teleport};

/// Non-pattern split path: mints `max_split_nodes - 1` new nodes (total node count on the tile,
/// including `src`, is `max_split_nodes` — an exact count, `1` is a valid no-op), then processes
/// every one of the `max_split_nodes` nodes uniformly through `run_ordinary_step_body_for_node`
/// with `parent: None` (including `src` itself — a deliberate behavior change scoped to this split
/// event only, so every resulting node is treated identically instead of `src` being the odd one
/// out). Nodes are processed strictly in creation order (`src` first) — deterministic for a fixed
/// seed, each subsequent node sees every earlier one's connections as ordinary visited state.
/// `bridge`, when present, is connected to `src` (node 0) exactly as the ordinary flow would have,
/// out of band from `run_ordinary_step_body_for_node`'s own candidate pool. Teleport and cyclicity
/// are per-node (each node's own `run_ordinary_step_body_for_node` call rolls its own), matching
/// the ordinary flow's granularity — unlike pattern mode, which rolls both once per event.
#[allow(clippy::too_many_arguments)]
pub(super) fn handle_non_pattern_split<T: Tessellation>(
    graph: &mut Graph,
    field: &mut Field<T>,
    ids: &mut IdGenerator,
    params: &GenerationParams,
    elements: &ElementsConfig,
    split_config: &SplitGenerationConfig,
    preset_state: &PresetState,
    state: &mut GenState,
    src: NodeId,
    bridge: Option<NodeId>,
    start: NodeId,
    start_reassignment: &mut Option<StartReassignment>,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
    debug_state: Option<&mut DebugGenerationState<T>>,
) {
    let count = (split_config.max_split_nodes as usize).max(1);
    let nodes = mint_split_nodes(graph, field, ids, src, count, debug_state);
    sync_all_nodes(state, &nodes[1..]);
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::SplitNodesCreated { src, nodes: nodes.clone(), pattern: None });
    }
    maybe_reassign_start(src, &nodes, start, start_reassignment, state, scope.as_deref_mut());

    if let Some(bridge) = bridge {
        let added = add_edge_and_detect_direction(graph, bridge, src, |g| {
            try_add_edge(g, bridge, src, elements, preset_state, &mut state.rng)
        });
        if let Some((from, to, bidirectional)) = added {
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::EdgeAdded { src: from, dst: to, bidirectional });
            }
        }
        // `src` is processed synchronously by this same event's per-node loop below, not via a
        // later frontier pop — pushing it to `frontier` here (as the ordinary, non-split bridge
        // path does) would leave it stuck there permanently after that loop marks it visited,
        // causing a later `step_from_frontier` to pop and re-process it a second time (re-rolling
        // `split_chance` and re-running corridor/junction logic on an already-connected node).
        state.visited.insert(src);
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::NodeVisited { node: src, parent: bridge });
        }
    }

    // Every resulting node shares the same field point, so they'd all see the same geometric
    // neighbor pool — without partitioning, the first-processed node (`src`) could claim every
    // free neighbor via `choose_connect_targets`'s multi-candidate junction pick, leaving later
    // nodes with nothing left and no guaranteed connection at all (see GitHub issue #222's
    // non-pattern split, "isolated new node" follow-up). Instead, the pool is split up front,
    // round-robin by position, so each node only ever competes for its own share.
    let free_neighbors: Vec<NodeId> = field.neighbors(src)
        .into_iter()
        .filter(|n| !state.visited.contains(n) && !state.in_frontier.contains(n))
        .collect();
    let mut allowed_per_node: Vec<HashSet<NodeId>> = vec![HashSet::new(); nodes.len()];
    for (i, n) in free_neighbors.into_iter().enumerate() {
        allowed_per_node[i % nodes.len()].insert(n);
    }

    for (i, &node) in nodes.iter().enumerate() {
        state.visited.insert(node);
        run_ordinary_step_body_for_node(graph, field, params, elements, preset_state, state, node, None, false, Some(&allowed_per_node[i]), scope.as_deref_mut());
    }

    // A node can still end up with zero free neighbors at all (the point simply didn't have
    // enough unvisited neighbors to go around) — partitioning the pool only prevents one node
    // from starving the others, it can't manufacture connections that don't exist. Guarantee
    // reachability by falling back to an already-visited geometric neighbor of the point (any
    // one, chosen at random) — preferring a neighbor no sibling of this same split event is
    // already connected to, so distinct split nodes don't all pile onto the same ordinary node
    // unless there's no other choice.
    for &node in &nodes {
        let has_edge = graph.outgoing_neighbors(node).next().is_some() || graph.incoming_neighbors(node).next().is_some();
        if has_edge {
            continue;
        }
        let visited_neighbors: Vec<NodeId> = field.neighbors(node)
            .into_iter()
            .filter(|n| state.visited.contains(n))
            .collect();
        if visited_neighbors.is_empty() {
            continue;
        }
        let sibling_targets: HashSet<NodeId> = nodes.iter()
            .flat_map(|&s| graph.outgoing_neighbors(s).chain(graph.incoming_neighbors(s)))
            .collect();
        let preferred: Vec<NodeId> = visited_neighbors.iter().copied().filter(|n| !sibling_targets.contains(n)).collect();
        let pool = if preferred.is_empty() { &visited_neighbors } else { &preferred };
        let dst = pool[state.rng.random_range(0..pool.len())];
        let added = add_edge_and_detect_direction(graph, node, dst, |g| {
            try_add_edge(g, node, dst, elements, preset_state, &mut state.rng)
        });
        if let Some((from, to, bidirectional)) = added {
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::EdgeAdded { src: from, dst: to, bidirectional });
            }
        }
    }

    apply_split_teleport(graph, elements, preset_state, state, &nodes, scope);
}
