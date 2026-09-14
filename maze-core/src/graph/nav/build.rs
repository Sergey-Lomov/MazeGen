use std::collections::HashSet;
use crate::ids::NodeId;
use super::super::{EdgeKind, Graph};
use super::graph::NavGraph;

/// Every node touching (as `from` or `to`) any `Teleport`, `Elevator`, or `VerticalPassage` edge
/// in `graph` — computed once per `build_nav_graph_pinned` call and threaded through as a lookup
/// set, rather than rescanning `graph.edges()` on every `is_corridor_node` call (which runs once
/// per node during nav-graph construction, making a per-call O(E) scan an O(V*E) blowup overall
/// for large fields). See `is_corridor_node`'s own doc comment for why each of these three kinds
/// needs the exemption.
fn non_corridor_endpoints(graph: &Graph) -> HashSet<NodeId> {
    graph.edges()
        .filter(|e| matches!(e.kind, EdgeKind::Teleport | EdgeKind::Elevator | EdgeKind::VerticalPassage))
        .flat_map(|e| [e.from, e.to])
        .collect()
}

/// A node is a corridor node if it has exactly 2 outgoing and 2 incoming edges,
/// and those form two symmetric pairs: for each outgoing neighbor B there is a
/// corresponding incoming edge from B (and vice versa).
/// Pinned nodes are never corridor nodes — they are forced to be nav nodes.
///
/// A node touching a `Teleport` edge (per `non_corridor_endpoints`) is also never a corridor
/// node, even if its degree happens to satisfy the 2-symmetric-pairs shape — teleport-specific QC
/// checks (e.g. `TeleportWaypointDistanceCheck`) need a `NavNodeId` for every teleport endpoint
/// to look up its distance-to-waypoint via `distance_from_start`/`distance_from_finish`, which
/// are keyed on `NavNodeId`. Silently compressing a teleport endpoint into a passage node inside
/// some other nav-edge's `path` would make `nav_node_for` return `None` for it, making such a
/// check wrongly treat the endpoint as unreachable instead of measuring its real distance — see
/// GitHub issue #74's follow-up bug report. This exemption is unconditional (not just when a
/// teleport check is active), same as the `pinned` exemption, since nav-graph structure must not
/// depend on which QC checks happen to be configured.
///
/// A node touching an `Elevator` edge is exempted the same way (GitHub issue #372): an `Elevator`
/// connects its floors as a fully-connected fan, so a 3-floor elevator's floor node ends up with
/// exactly 2 outgoing/2 incoming symmetric neighbors (the other two floors) — coincidentally
/// satisfying the degree shape. Without this exemption such a node would be silently compressed
/// into a corridor's interior path, hiding the fan structure from `NavGraph` entirely and
/// defeating `cycle_core`'s elevator-fan cycle filter, which needs a real `NavNodeId` per floor
/// endpoint.
///
/// A node touching a `VerticalPassage` edge is exempted the same way — without it, a
/// vertical-passage endpoint whose degree happened to satisfy the 2-symmetric-pairs shape got
/// silently compressed into some other nav-edge's interior `path`, so `nav_node_for` returned
/// `None` for it and any caller keying off the endpoint's own `NavNodeId` (routing, QC distance
/// checks, cross-floor badge placement in the web renderers) resolved a neighboring corridor node
/// instead — GitHub issue #517.
fn is_corridor_node(graph: &Graph, node: NodeId, pinned: &HashSet<NodeId>, non_corridor_endpoints: &HashSet<NodeId>) -> bool {
    if pinned.contains(&node) { return false; }
    if non_corridor_endpoints.contains(&node) { return false; }
    let out: Vec<NodeId> = graph.outgoing_neighbors(node).collect();
    let inc: Vec<NodeId> = graph.incoming_neighbors(node).collect();
    if out.len() != 2 || inc.len() != 2 {
        return false;
    }
    let out_set: HashSet<NodeId> = out.into_iter().collect();
    let inc_set: HashSet<NodeId> = inc.into_iter().collect();
    out_set == inc_set
}

/// Advance one step along a chain: pick the outgoing neighbor of `current` that is not `prev`.
/// Returns `None` if no such neighbor exists (dead end or all neighbors are `prev`).
fn advance_chain(graph: &Graph, current: NodeId, prev: NodeId) -> Option<NodeId> {
    graph.outgoing_neighbors(current).filter(|&n| n != prev).min()
}

/// Walk a directed corridor from `start` in direction `next_node`, collecting the path
/// until we reach a non-corridor node or revisit a node (ring detection).
/// Returns the path (inclusive of start, exclusive of the final junction or the ring-close node)
/// and the terminal node.
fn walk_corridor(
    graph: &Graph,
    start: NodeId,
    next_node: NodeId,
    visited_corridor: &mut HashSet<NodeId>,
    pinned: &HashSet<NodeId>,
    non_corridor_endpoints: &HashSet<NodeId>,
) -> (Vec<NodeId>, NodeId) {
    let mut path = vec![start];
    let mut current = start;
    let mut next = next_node;

    loop {
        if visited_corridor.contains(&next) || !is_corridor_node(graph, next, pinned, non_corridor_endpoints) {
            // next is a junction or already visited (ring close)
            path.push(next);
            return (path, next);
        }
        visited_corridor.insert(next);
        path.push(next);
        let Some(advance) = advance_chain(graph, next, current) else {
            return (path, next);
        };
        current = next;
        next = advance;
    }
}

pub fn build_nav_graph(graph: &Graph) -> NavGraph {
    build_nav_graph_pinned(graph, &HashSet::new())
}

pub fn build_nav_graph_pinned(graph: &Graph, pinned: &HashSet<NodeId>) -> NavGraph {
    let mut nav = NavGraph::new();
    let mut remaining: HashSet<NodeId> = graph.nodes().map(|n| n.id).collect();
    let mut visited_junctions: HashSet<NodeId> = HashSet::new();
    let non_corridor_endpoints = non_corridor_endpoints(graph);

    while !remaining.is_empty() {
        let component_start = find_component_start(graph, &remaining, pinned, &non_corridor_endpoints);

        match component_start {
            ComponentStart::Junction(junction) => {
                dfs_from_junction(graph, junction, &mut nav, &mut remaining, &mut visited_junctions, pinned, &non_corridor_endpoints);
            }
            ComponentStart::Ring(ring_start) => {
                build_ring(graph, ring_start, &mut nav, &mut remaining, pinned);
            }
        }
    }

    nav.link_reverse_edges();
    nav
}

enum ComponentStart {
    Junction(NodeId),
    Ring(NodeId),
}

/// Walk from any node in `remaining` until we find a junction or loop back to start.
fn find_component_start(graph: &Graph, remaining: &HashSet<NodeId>, pinned: &HashSet<NodeId>, non_corridor_endpoints: &HashSet<NodeId>) -> ComponentStart {
    let seed = *remaining.iter().min().unwrap();

    // If seed itself is a junction, done
    if !is_corridor_node(graph, seed, pinned, non_corridor_endpoints) {
        return ComponentStart::Junction(seed);
    }

    // Walk forward looking for a junction, using advance_chain to avoid going back.
    // seed has no meaningful "prev", so pick its min outgoing neighbor as first step.
    let first_opt = graph.outgoing_neighbors(seed).min();
    let Some(first) = first_opt else {
        // Isolated node with no edges — treat as junction
        return ComponentStart::Junction(seed);
    };
    if !is_corridor_node(graph, first, pinned, non_corridor_endpoints) {
        return ComponentStart::Junction(first);
    }

    let mut prev = seed;
    let mut current = first;
    let mut visited = HashSet::new();
    visited.insert(seed);
    visited.insert(first);

    loop {
        let next_opt = advance_chain(graph, current, prev);
        let Some(next) = next_opt else {
            return ComponentStart::Junction(current);
        };

        if next == seed {
            return ComponentStart::Ring(seed);
        }
        if visited.contains(&next) {
            return ComponentStart::Ring(next);
        }
        if !is_corridor_node(graph, next, pinned, non_corridor_endpoints) {
            return ComponentStart::Junction(next);
        }
        visited.insert(next);
        prev = current;
        current = next;
    }
}

fn enqueue_junction(
    node: NodeId,
    visited_junctions: &HashSet<NodeId>,
    junction_stack: &mut Vec<NodeId>,
) {
    if !visited_junctions.contains(&node) {
        junction_stack.push(node);
    }
}

/// Build a nav edge from `junction` toward `next`: if `next` is a corridor node, walk the
/// full corridor to find the terminal junction; otherwise `next` is itself the terminal.
///
/// `first_kind` is the `EdgeKind` of the specific `junction -> next` graph edge this call is
/// processing — required (rather than re-derived via `Graph::edge_between_kind`) because a
/// `Basic` and a `Teleport` edge may coexist in the same direction between the same pair
/// (`Graph::add_edge`'s kind-aware dedup): `graph.outgoing_edges` yields one entry per `EdgeId`,
/// not deduped by target, so `dfs_from_junction` calls this once per physical edge in that case,
/// and only the caller knows which physical edge a given call corresponds to (GitHub issue #197).
fn process_outgoing(
    graph: &Graph,
    junction: NodeId,
    next: NodeId,
    first_kind: EdgeKind,
    nav: &mut NavGraph,
    remaining: &mut HashSet<NodeId>,
    visited_junctions: &mut HashSet<NodeId>,
    junction_stack: &mut Vec<NodeId>,
    pinned: &HashSet<NodeId>,
    non_corridor_endpoints: &HashSet<NodeId>,
) {
    let (path, terminal, is_teleport, is_elevator) = if is_corridor_node(graph, next, pinned, non_corridor_endpoints) {
        let mut visited_corridor: HashSet<NodeId> = HashSet::new();
        visited_corridor.insert(junction);
        let (path, terminal) = walk_corridor(graph, junction, next, &mut visited_corridor, pinned, non_corridor_endpoints);
        // Corridor-interior hops are always Basic (teleport/elevator/vertical-passage endpoints are never corridor nodes).
        (path, terminal, false, false)
    } else {
        (vec![junction, next], next, first_kind == EdgeKind::Teleport, first_kind == EdgeKind::Elevator)
    };

    for &n in &path[1..] {
        remaining.remove(&n);
    }

    let from_nav = nav.add_node(junction);
    let to_nav   = nav.add_node(terminal);
    nav.add_edge(from_nav, to_nav, path, is_teleport, is_elevator);

    enqueue_junction(terminal, visited_junctions, junction_stack);
}

/// DFS from a junction node, building nav edges for all reachable corridors.
fn dfs_from_junction(
    graph: &Graph,
    start: NodeId,
    nav: &mut NavGraph,
    remaining: &mut HashSet<NodeId>,
    visited_junctions: &mut HashSet<NodeId>,
    pinned: &HashSet<NodeId>,
    non_corridor_endpoints: &HashSet<NodeId>,
) {
    let mut junction_stack: Vec<NodeId> = vec![start];

    while let Some(junction) = junction_stack.pop() {
        if !visited_junctions.insert(junction) {
            continue;
        }
        remaining.remove(&junction);
        nav.add_node(junction);

        let outgoing: Vec<(NodeId, EdgeKind)> = graph.outgoing_edges(junction)
            .map(|e| (e.to, e.kind.clone()))
            .collect();
        for (next, kind) in outgoing {
            process_outgoing(graph, junction, next, kind, nav, remaining, visited_junctions, &mut junction_stack, pinned, non_corridor_endpoints);
        }
    }
}

/// Walk the ring from `ring_start` to find the first pinned node. Returns ring_start if none found.
/// Only walks through nodes in `remaining` to stay within the current ring component.
fn find_ring_anchor(graph: &Graph, ring_start: NodeId, pinned: &HashSet<NodeId>, remaining: &HashSet<NodeId>) -> NodeId {
    let Some(first) = graph.outgoing_neighbors(ring_start).filter(|n| remaining.contains(n) || *n == ring_start).min() else {
        return ring_start;
    };
    if first == ring_start { return ring_start; }
    let mut walk = first;
    let mut walk_prev = ring_start;
    loop {
        if pinned.contains(&walk) { return walk; }
        match advance_chain(graph, walk, walk_prev) {
            Some(n) if n == ring_start => return ring_start,
            Some(n) if remaining.contains(&n) => { walk_prev = walk; walk = n; }
            _ => return ring_start,
        }
    }
}

/// Walk one direction around the ring from `anchor` via `first_step`.
/// Returns the complete path (anchor → ... → anchor) if the ring closes, else None.
/// Always removes all visited nodes from `remaining`, whether or not the ring closes.
fn walk_ring_direction(
    graph: &Graph,
    anchor: NodeId,
    first_step: NodeId,
    remaining: &mut HashSet<NodeId>,
) -> Option<Vec<NodeId>> {
    let mut path = vec![anchor, first_step];
    remaining.remove(&first_step);
    let mut prev = anchor;
    let mut current = first_step;
    let mut visited: HashSet<NodeId> = HashSet::new();
    visited.insert(anchor);
    visited.insert(first_step);

    loop {
        match advance_chain(graph, current, prev) {
            Some(n) if n == anchor => {
                path.push(anchor);
                return Some(path);
            }
            Some(next) => {
                remaining.remove(&next);
                if visited.contains(&next) {
                    // cycle without closing on anchor — dead end for ring purposes
                    return None;
                }
                visited.insert(next);
                path.push(next);
                prev = current;
                current = next;
            }
            None => return None,
        }
    }
}

/// Build nav edges for a pure ring (all corridor nodes, no junctions).
/// If any node in the ring is pinned, it becomes the anchor nav node.
/// Otherwise picks `ring_start` as the single nav node, adds two self-edges (CW and CCW).
fn build_ring(
    graph: &Graph,
    ring_start: NodeId,
    nav: &mut NavGraph,
    remaining: &mut HashSet<NodeId>,
    pinned: &HashSet<NodeId>,
) {
    let anchor = if pinned.is_empty() {
        ring_start
    } else {
        find_ring_anchor(graph, ring_start, pinned, remaining)
    };

    let nav_id = nav.add_node(anchor);
    remaining.remove(&anchor);
    if ring_start != anchor {
        remaining.remove(&ring_start);
    }

    for first_step in graph.outgoing_neighbors(anchor).collect::<Vec<_>>() {
        if let Some(path) = walk_ring_direction(graph, anchor, first_step, remaining) {
            // A ring consists entirely of corridor nodes (teleport/elevator endpoints are never
            // corridor nodes, so never part of a ring), so its hops are always Basic.
            nav.add_edge(nav_id, nav_id, path, false, false);
        }
    }
}
