use rand::Rng;
use crate::ids::{IdGenerator, NodeId};
use crate::graph::{Graph, EdgeKind};
use crate::space::{MultiLevelField, Tessellation};
use crate::event_log::ScopeGuard;
use super::{ElementsConfig, PresetState};
use super::debug_state::DebugGenerationState;
use super::edge_ops::try_add_edge_kind;
use super::vertex_based::{VertexBasedEvent, GenState, add_to_frontier, add_edge_and_detect_direction};
use super::split_logic::StartReassignment;

/// Mints `count - 1` new nodes at `src`'s point (total `count` including `src`), syncing
/// `state.all_nodes` immediately so later-in-event RNG pools (teleport-connect, cyclic-widened
/// pool) see them.
pub(super) fn mint_split_nodes<T: Tessellation>(
    graph: &mut Graph,
    field: &mut MultiLevelField<T>,
    ids: &mut IdGenerator,
    src: NodeId,
    count: usize,
    mut debug_state: Option<&mut DebugGenerationState<T>>,
) -> Vec<NodeId> {
    let level = field.level_of(src).expect("src must be in field");
    let point = field.point_of(src).expect("src must be in field");
    let mut nodes = vec![src];
    for _ in 1..count {
        let node = field.add_node_at(level, point, ids);
        graph.add_node(node);
        if let Some(state) = debug_state.as_deref_mut() {
            state.note(node, point);
        }
        nodes.push(node);
    }
    nodes
}

/// Syncs newly minted nodes into `state.all_nodes`, re-sorted — must be called before this
/// event's own teleport-connect/cyclic-widened-pool candidates are built, otherwise a later "any
/// node in the graph" roll would never see them.
pub(super) fn sync_all_nodes(state: &mut GenState, new_nodes: &[NodeId]) {
    state.all_nodes.extend_from_slice(new_nodes);
    state.all_nodes.sort_unstable();
}

/// Reassigns `start` to a uniformly random node among `src` and its newly minted siblings, if
/// `src == start` and no reassignment has happened yet (fires at most once per run). A no-op when
/// there's an explicit `preset_start` — the caller (`run_generate`/`run_generate_typed`) only
/// consults `start_reassignment` when `preset_start` was absent, so this always computes it
/// unconditionally; the caller decides whether to use it.
pub(super) fn maybe_reassign_start(
    src: NodeId,
    all_split_nodes: &[NodeId],
    start: NodeId,
    start_reassignment: &mut Option<StartReassignment>,
    state: &mut GenState,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) {
    if src != start || start_reassignment.is_some() {
        return;
    }
    let idx = state.rng.random_range(0..all_split_nodes.len());
    let reassigned_to = all_split_nodes[idx];
    *start_reassignment = Some(StartReassignment { original: start, reassigned_to });
    if reassigned_to != start {
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::SplitStartReassigned { original: start, reassigned_to });
        }
    }
}

/// Marks an outside neighbor `dst` reached by one of this split event's nodes as visited and
/// pushes it to `frontier` to continue the traversal — but never for `dst` that is itself one of
/// `split_nodes` (a `sibling_target` face connecting two of this event's own nodes): those are
/// already fully resolved by the event that created them and must never re-enter `frontier` (see
/// `apply_pattern_adaptation`'s own doc comment).
pub(super) fn mark_connected(state: &mut GenState, dst: NodeId, src: NodeId, split_nodes: &[NodeId], mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>) {
    state.visited.insert(dst);
    state.in_reserve.remove(&dst);
    if !split_nodes.contains(&dst) {
        add_to_frontier(dst, Some(src), &mut state.frontier, &mut state.in_frontier);
    }
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::NodeVisited { node: dst, parent: src });
    }
}

/// Rolls the split event's shared teleport connection once for the whole event (not per-node, in
/// either mode) — anchored to a uniformly random resulting node, added alongside whatever each
/// node's own corridor/junction/cyclic logic decided.
pub(super) fn apply_split_teleport(
    graph: &mut Graph,
    elements: &ElementsConfig,
    preset_state: &PresetState,
    state: &mut GenState,
    nodes: &[NodeId],
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) {
    let roll = state.rng.random::<f64>();
    let fired = roll < elements.teleport_chance;
    if !fired {
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::SplitTeleportRolled { roll, teleport_chance: elements.teleport_chance, fired, anchor: None });
        }
        return;
    }
    let anchor = nodes[state.rng.random_range(0..nodes.len())];
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::SplitTeleportRolled { roll, teleport_chance: elements.teleport_chance, fired, anchor: Some(anchor) });
    }
    let unvisited: Vec<NodeId> = state.all_nodes.iter().copied().filter(|n| !state.visited.contains(n)).collect();
    if unvisited.is_empty() {
        return;
    }
    let dst = unvisited[state.rng.random_range(0..unvisited.len())];
    let added = add_edge_and_detect_direction(graph, anchor, dst, |g| {
        try_add_edge_kind(g, anchor, dst, EdgeKind::Teleport, elements.teleport_one_way_chance, preset_state, &mut state.rng)
    });
    if let Some((from, to, bidirectional)) = added {
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::TeleportConnectAdded { src: from, dst: to, bidirectional });
        }
    }
    mark_connected(state, dst, anchor, &[], scope);
}
