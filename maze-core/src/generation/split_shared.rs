use super::debug_state::DebugGenerationState;
use super::edge_ops::try_add_edge_kind;
use super::split_logic::StartReassignment;
use super::vertex_based::{
    GenState, VertexBasedEvent, add_edge_and_detect_direction, add_to_frontier,
};
use super::{ElementsConfig, PresetState};
use crate::event_log::ScopeGuard;
use crate::graph::{EdgeKind, Graph};
use crate::ids::{IdGenerator, NodeId};
use crate::space::{MultiLevelField, Tessellation};
use rand::Rng;
use std::collections::HashSet;

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
    let point = field.cell_of(src).expect("src must be in field");
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
    scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) {
    if src != start || start_reassignment.is_some() {
        return;
    }
    let idx = state.rng.random_range(0..all_split_nodes.len());
    let reassigned_to = all_split_nodes[idx];
    *start_reassignment = Some(StartReassignment {
        original: start,
        reassigned_to,
    });
    if reassigned_to != start
        && let Some(log) = scope
    {
        log.emit(VertexBasedEvent::SplitStartReassigned {
            original: start,
            reassigned_to,
        });
    }
}

/// Marks an outside neighbor `dst` reached by one of this split event's nodes as visited and
/// pushes it to `frontier` to continue the traversal — but never for `dst` that is itself one of
/// `split_nodes` (a `sibling_target` face connecting two of this event's own nodes): those are
/// already fully resolved by the event that created them and must never re-enter `frontier` (see
/// `apply_pattern_adaptation`'s own doc comment).
pub(super) fn mark_connected(
    state: &mut GenState,
    dst: NodeId,
    src: NodeId,
    split_nodes: &[NodeId],
    scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) {
    state.visited.insert(dst);
    state.in_reserve.remove(&dst);
    if !split_nodes.contains(&dst) {
        add_to_frontier(dst, Some(src), &mut state.frontier, &mut state.in_frontier);
    }
    if let Some(log) = scope {
        log.emit(VertexBasedEvent::NodeVisited {
            node: dst,
            parent: src,
        });
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
            log.emit(VertexBasedEvent::SplitTeleportRolled {
                roll,
                teleport_chance: elements.teleport_chance,
                fired,
                anchor: None,
            });
        }
        return;
    }
    let anchor = nodes[state.rng.random_range(0..nodes.len())];
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::SplitTeleportRolled {
            roll,
            teleport_chance: elements.teleport_chance,
            fired,
            anchor: Some(anchor),
        });
    }
    let unvisited: Vec<NodeId> = state
        .all_nodes
        .iter()
        .copied()
        .filter(|n| !state.visited.contains(n))
        .collect();
    if unvisited.is_empty() {
        return;
    }
    let dst = unvisited[state.rng.random_range(0..unvisited.len())];
    let added = add_edge_and_detect_direction(graph, anchor, dst, |g| {
        try_add_edge_kind(
            g,
            anchor,
            dst,
            EdgeKind::Teleport,
            elements.teleport_one_way_chance,
            preset_state,
            &mut state.rng,
        )
    });
    if let Some((from, to, bidirectional)) = added
        && let Some(log) = scope.as_deref_mut()
    {
        log.emit(VertexBasedEvent::TeleportConnectAdded {
            src: from,
            dst: to,
            bidirectional,
        });
    }
    mark_connected(state, dst, anchor, &[], scope);
}

/// Guarantees every one of `node_count` unconstrained split nodes ends up with at least one edge,
/// falling back to a `candidates` neighbor when `handle_non_pattern_split`'s own round-robin
/// partition of `at`'s free geometric neighbors left some node with none (partitioning only
/// prevents one node from starving the others — it can't manufacture a connection that doesn't
/// exist, see GitHub issue #222's "isolated new node" follow-up).
///
/// This is generation-only: repair's own `split_core::plan_unconstrained_split` deliberately has no
/// equivalent fallback — its documented contract is that it never adds or drops a connection, only
/// redistributes `at`'s existing ones (see that function's own doc comment), so a repaired
/// unconstrained split tile can still end up with a zero-connection node. Unifying the two was
/// considered (GitHub issue #389 follow-up) and rejected: adding this fallback to the repair path
/// breaks that documented "no new edges" contract and its own test
/// (`plan_unconstrained_split_without_required_matches_original_behavior`).
///
/// `has_edge(i)` reports whether node index `i` already has a connection from the caller's own
/// prior distribution. `candidates` is the caller's own geometric-neighbor pool, already filtered
/// to whatever the caller considers eligible (here, `state.visited`) — this function only adds "not
/// already claimed by an earlier node in this same call". Preference order within `candidates` is
/// caller-controlled (e.g. sibling-avoidance) and preserved; this function neither shuffles nor
/// reorders it. A node with no remaining eligible candidate at all is simply skipped — irreducible,
/// the point never had enough neighbors to go around.
pub(crate) fn ensure_min_connectivity(
    node_count: usize,
    has_edge: impl Fn(usize) -> bool,
    mut candidates: impl FnMut(usize) -> Vec<NodeId>,
) -> Vec<(usize, NodeId)> {
    let mut claimed: HashSet<NodeId> = HashSet::new();
    let mut assignments = Vec::new();
    for i in 0..node_count {
        if has_edge(i) {
            continue;
        }
        let Some(target) = candidates(i).into_iter().find(|n| !claimed.contains(n)) else {
            continue;
        };
        claimed.insert(target);
        assignments.push((i, target));
    }
    assignments
}

#[cfg(test)]
mod ensure_min_connectivity_tests {
    use super::*;

    #[test]
    fn skips_nodes_that_already_have_an_edge() {
        let assignments = ensure_min_connectivity(3, |i| i == 1, |_| vec![0]);
        assert_eq!(assignments, vec![(0, 0)]);
    }

    #[test]
    fn does_not_assign_the_same_candidate_to_two_nodes() {
        let assignments = ensure_min_connectivity(2, |_| false, |_| vec![0, 1]);
        assert_eq!(assignments, vec![(0, 0), (1, 1)]);
    }

    #[test]
    fn skips_a_node_with_no_unclaimed_candidate_left() {
        let assignments = ensure_min_connectivity(3, |_| false, |_| vec![0]);
        assert_eq!(assignments, vec![(0, 0)]);
    }

    #[test]
    fn preserves_candidate_order_picking_the_first_unclaimed() {
        let assignments = ensure_min_connectivity(1, |_| false, |_| vec![5, 0, 1]);
        assert_eq!(assignments, vec![(0, 5)]);
    }
}
