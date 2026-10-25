use super::debug_state::DebugGenerationState;
use super::split_logic::StartReassignment;
use super::split_pattern::SplitGenerationConfig;
use super::split_shared::{
    apply_split_teleport, ensure_min_connectivity, maybe_reassign_start, mint_split_nodes,
    sync_all_nodes,
};
use super::vertex_based::{
    GenState, VertexBasedEvent, run_ordinary_step_body_for_node, try_add_regular_edge,
};
use super::{ElementsConfig, GenerationParams, PresetState};
use crate::event_log::ScopeGuard;
use crate::graph::Graph;
use crate::ids::{IdGenerator, NodeId};
use crate::space::{MultiLevelField, Tessellation};
use rand::seq::SliceRandom;
use std::collections::HashSet;

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
    field: &mut MultiLevelField<T>,
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
        log.emit(VertexBasedEvent::SplitNodesCreated {
            src,
            nodes: nodes.clone(),
            pattern: None,
        });
    }
    maybe_reassign_start(
        src,
        &nodes,
        start,
        start_reassignment,
        state,
        scope.as_deref_mut(),
    );

    if let Some(bridge) = bridge {
        let added = try_add_regular_edge(
            graph,
            field,
            bridge,
            src,
            elements,
            preset_state,
            state,
            scope.as_deref_mut(),
        );
        if let Some((from, to, bidirectional)) = added
            && let Some(log) = scope.as_deref_mut()
        {
            log.emit(VertexBasedEvent::EdgeAdded {
                src: from,
                dst: to,
                bidirectional,
            });
        }
        // `src` is processed synchronously by this same event's per-node loop below, not via a
        // later frontier pop — pushing it to `frontier` here (as the ordinary, non-split bridge
        // path does) would leave it stuck there permanently after that loop marks it visited,
        // causing a later `step_from_frontier` to pop and re-process it a second time (re-rolling
        // `split_chance` and re-running corridor/junction logic on an already-connected node).
        state.visited.insert(src);
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::NodeVisited {
                node: src,
                parent: bridge,
            });
        }
    }

    // Every resulting node shares the same field point, so they'd all see the same geometric
    // neighbor pool — without partitioning, the first-processed node (`src`) could claim every
    // free neighbor via `choose_connect_targets`'s multi-candidate junction pick, leaving later
    // nodes with nothing left and no guaranteed connection at all (see GitHub issue #222's
    // non-pattern split, "isolated new node" follow-up). Instead, the pool is split up front,
    // round-robin by position, so each node only ever competes for its own share.
    let free_neighbors: Vec<NodeId> = field
        .neighbors(src)
        .into_iter()
        .filter(|n| !state.visited.contains(n) && !state.in_frontier.contains(n))
        .collect();
    let mut allowed_per_node: Vec<HashSet<NodeId>> = vec![HashSet::new(); nodes.len()];
    for (i, n) in free_neighbors.into_iter().enumerate() {
        allowed_per_node[i % nodes.len()].insert(n);
    }

    for (i, &node) in nodes.iter().enumerate() {
        state.visited.insert(node);
        run_ordinary_step_body_for_node(
            graph,
            field,
            params,
            elements,
            preset_state,
            state,
            node,
            None,
            false,
            Some(&allowed_per_node[i]),
            scope.as_deref_mut(),
        );
    }

    // A node can still end up with zero free neighbors at all (the point simply didn't have
    // enough unvisited neighbors to go around) — partitioning the pool only prevents one node
    // from starving the others, it can't manufacture connections that don't exist. Guarantee
    // reachability by falling back to an already-visited geometric neighbor of the point (shuffled,
    // so the pick among several candidates is still random) — preferring a neighbor no sibling of
    // this same split event is already connected to, so distinct split nodes don't all pile onto
    // the same ordinary node unless there's no other choice.
    let sibling_targets: HashSet<NodeId> = nodes
        .iter()
        .flat_map(|&s| {
            graph
                .outgoing_neighbors(s)
                .chain(graph.incoming_neighbors(s))
        })
        .collect();
    let assignments = ensure_min_connectivity(
        nodes.len(),
        |i| {
            let node = nodes[i];
            graph.outgoing_neighbors(node).next().is_some()
                || graph.incoming_neighbors(node).next().is_some()
        },
        |i| {
            let mut visited_neighbors: Vec<NodeId> = field
                .neighbors(nodes[i])
                .into_iter()
                .filter(|n| state.visited.contains(n))
                .collect();
            visited_neighbors.shuffle(&mut state.rng);
            let preferred: Vec<NodeId> = visited_neighbors
                .iter()
                .copied()
                .filter(|n| !sibling_targets.contains(n))
                .collect();
            if preferred.is_empty() {
                visited_neighbors
            } else {
                preferred
            }
        },
    );
    for (i, dst) in assignments {
        let node = nodes[i];
        let added = try_add_regular_edge(
            graph,
            field,
            node,
            dst,
            elements,
            preset_state,
            state,
            scope.as_deref_mut(),
        );
        if let Some((from, to, bidirectional)) = added
            && let Some(log) = scope.as_deref_mut()
        {
            log.emit(VertexBasedEvent::EdgeAdded {
                src: from,
                dst: to,
                bidirectional,
            });
        }
    }

    apply_split_teleport(graph, field, elements, preset_state, state, &nodes, scope);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generation::GenerationParams;
    use crate::generation::split_pattern::SplitGenerationConfig;
    use crate::generation::test_utils::{default_elements, make_field_graph_ids};
    use crate::generation::vertex_based::GenState;
    use crate::space::SquarePoint;

    /// GitHub issue #222's "isolated new node" follow-up: even after `handle_non_pattern_split`'s
    /// round-robin partition of `src`'s free geometric neighbors, a node can still be left with no
    /// candidate at all (partitioning only prevents one node starving the others, it can't
    /// manufacture connections that don't exist) — `ensure_min_connectivity`'s fallback must then
    /// give every such node at least one edge to an already-visited neighbor.
    ///
    /// Fixture: `src` sits at the center of a 3x3 grid (4 geometric neighbors: up/down/left/right).
    /// Three of the four are pre-marked visited, leaving exactly one (`free`) as the free-neighbor
    /// pool `allowed_per_node` distributes. With `max_split_nodes: 3`, round-robin assigns `free`
    /// to node 0 only — nodes 1 and 2 get an empty allowed set and cannot connect via the ordinary
    /// step body, so only the fallback (with three independently visited candidates to draw from)
    /// can give them an edge.
    #[test]
    fn every_split_node_ends_up_with_at_least_one_edge_even_when_the_free_neighbor_pool_runs_out() {
        let (mut field, mut graph, mut ids) = make_field_graph_ids(3, 3);
        let level = field.levels_ordered().next().unwrap();
        let node = |x: i32, y: i32| field.node_at(level, SquarePoint { x, y }).unwrap();
        let src = node(1, 1);
        let (up, down, left) = (node(1, 0), node(1, 2), node(0, 1));

        let mut state = GenState::new(&graph, 1, src);
        state.visited.insert(up);
        state.visited.insert(down);
        state.visited.insert(left);

        let params = GenerationParams {
            corridor_chance: 1.0,
            ..GenerationParams::default()
        };
        let elements = default_elements();
        let preset_state = PresetState::empty();
        let split_config = SplitGenerationConfig {
            pattern_mode: false,
            max_split_nodes: 3,
            patterns: vec![],
        };
        let mut start_reassignment = None;

        handle_non_pattern_split(
            &mut graph,
            &mut field,
            &mut ids,
            &params,
            &elements,
            &split_config,
            &preset_state,
            &mut state,
            src,
            None,
            src,
            &mut start_reassignment,
            None,
            None,
        );

        let src_point = field.cell_of(src);
        let split_nodes: Vec<NodeId> = field
            .all_node_ids()
            .filter(|n| field.cell_of(*n) == src_point)
            .collect();
        assert_eq!(
            split_nodes.len(),
            3,
            "expected exactly 3 nodes minted at src's point"
        );
        for node in split_nodes {
            let has_edge = graph.outgoing_neighbors(node).next().is_some()
                || graph.incoming_neighbors(node).next().is_some();
            assert!(
                has_edge,
                "node {node:?} ended up with zero connections — fallback did not fire"
            );
        }
    }
}
