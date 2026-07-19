use super::*;
use std::collections::HashSet;
use crate::ids::NodeId;
use crate::graph::{Graph, EdgeKind};

fn add_bidir(g: &mut Graph, a: NodeId, b: NodeId) {
    g.add_edge(a, b, EdgeKind::Basic);
    g.add_edge(b, a, EdgeKind::Basic);
}

// Simple ring A⇄B⇄C⇄A — no pinned.
// All three are corridor nodes → one NavNode, two self-edges.
#[test]
fn test_simple_ring() {
    let mut g = Graph::new();
    for id in [1u64, 2, 3] { g.add_node(id); }
    add_bidir(&mut g, 1, 2);
    add_bidir(&mut g, 2, 3);
    add_bidir(&mut g, 3, 1);

    let nav = build_nav_graph(&g);
    assert_eq!(nav.nodes.len(), 1, "pure ring → 1 nav node");
    assert_eq!(nav.edges().count(), 2, "pure ring → 2 self-edges");
}

// Ring A⇄B⇄C⇄A, plus junction J⇄A (J has 1 neighbor = dead-end).
// A: out={B,C,J} in={B,C,J} — junction (3 neighbors). B,C: corridor.
// Nav nodes: J, A, plus B/C should be absorbed.
#[test]
fn test_ring_with_extra_junction_neighbor() {
    let mut g = Graph::new();
    for id in [1u64, 2, 3, 10] { g.add_node(id); }
    // ring 1⇄2⇄3⇄1
    add_bidir(&mut g, 1, 2);
    add_bidir(&mut g, 2, 3);
    add_bidir(&mut g, 3, 1);
    // extra junction 10⇄1
    add_bidir(&mut g, 10, 1);

    let nav = build_nav_graph(&g);
    // node 1: out={2,3,10}, in={2,3,10} → junction
    // node 10: out={1}, in={1} → dead-end junction
    // nodes 2,3: each has 2 symmetric bidir neighbors → corridor
    // Expected: nav nodes = {1, 10}, edges = 10→1, 1→10, 1→1(CW), 1→1(CCW)
    let node_ids: Vec<NodeId> = nav.nodes.iter().map(|n| n.node_id).collect();
    assert!(!node_ids.contains(&2), "node 2 should be corridor (absorbed)");
    assert!(!node_ids.contains(&3), "node 3 should be corridor (absorbed)");
    assert!(node_ids.contains(&1), "node 1 should be junction (nav node)");
    assert!(node_ids.contains(&10), "node 10 should be junction (nav node)");
}

// Ring A⇄B⇄C⇄A, pinned={A}.
// A pinned → junction. B,C corridor.
// build_ring finds ring_start=B (min corridor), anchor=A (pinned).
// A has outgoing {B, C} (both in ring) → both walks should succeed.
#[test]
fn test_ring_with_pinned_node() {
    let mut g = Graph::new();
    for id in [1u64, 2, 3] { g.add_node(id); }
    add_bidir(&mut g, 1, 2);
    add_bidir(&mut g, 2, 3);
    add_bidir(&mut g, 3, 1);

    let mut pinned = HashSet::new();
    pinned.insert(1u64);

    let nav = build_nav_graph_pinned(&g, &pinned);
    assert_eq!(nav.nodes.len(), 1, "pinned ring → 1 nav node (the pinned anchor)");
    assert_eq!(nav.edges().count(), 2, "pinned ring → 2 self-edges");
    assert_eq!(nav.nodes[0].node_id, 1, "anchor should be pinned node 1");
}

// Ring A⇄B⇄C⇄A, pinned={A}, plus separate ring D⇄E⇄F⇄D connected to A via A⇄D.
// A: out={B,C,D}, in={B,C,D} → junction (3 neighbors).
// B,C: corridor in ring1. D,E,F: D has extra neighbor A → junction; E,F corridor.
// This is the topology suspected to cause the freeze.
#[test]
fn test_ring_pinned_with_extra_ring_neighbor() {
    let mut g = Graph::new();
    for id in [1u64, 2, 3, 4, 5, 6] { g.add_node(id); }
    // ring1: 1⇄2⇄3⇄1
    add_bidir(&mut g, 1, 2);
    add_bidir(&mut g, 2, 3);
    add_bidir(&mut g, 3, 1);
    // ring2: 4⇄5⇄6⇄4
    add_bidir(&mut g, 4, 5);
    add_bidir(&mut g, 5, 6);
    add_bidir(&mut g, 6, 4);
    // bridge: 1⇄4
    add_bidir(&mut g, 1, 4);

    let mut pinned = HashSet::new();
    pinned.insert(1u64);

    // Should terminate without hanging
    let nav = build_nav_graph_pinned(&g, &pinned);
    // All nodes should be accounted for in nav (no remaining)
    let nav_node_ids: HashSet<NodeId> = nav.nodes.iter().map(|n| n.node_id).collect();
    // corridor nodes 2,3 absorbed into edges from node 1
    // node 4: out={1,5,6} in={1,5,6} → junction
    // nodes 5,6: corridor (neighbors {4,6} and {4,5} — symmetric bidir)
    assert!(!nav_node_ids.contains(&2), "node 2 absorbed");
    assert!(!nav_node_ids.contains(&3), "node 3 absorbed");
    assert!(nav_node_ids.contains(&1), "node 1 is junction");
    assert!(nav_node_ids.contains(&4), "node 4 is junction");
}

// corridor_index must map every interior corridor node of a corridor edge to the
// NavNodeId of that edge's destination, for O(1) lookup of which nav edge a corridor
// node belongs to.
#[test]
fn corridor_index_maps_interior_nodes_to_destination() {
    let mut g = Graph::new();
    for id in [1u64, 2, 3, 4] { g.add_node(id); }
    // linear corridor 1⇄2⇄3⇄4; 1 and 4 are dead-end junctions, 2 and 3 are corridor.
    add_bidir(&mut g, 1, 2);
    add_bidir(&mut g, 2, 3);
    add_bidir(&mut g, 3, 4);

    let nav = build_nav_graph(&g);
    let nav1 = nav.nav_node_for(1).unwrap();
    let nav4 = nav.nav_node_for(4).unwrap();

    // Edge 1->4 has path [1,2,3,4]; interior nodes 2,3 should map to nav4 (destination of that edge).
    // Edge 4->1 has path [4,3,2,1]; interior nodes 3,2 should map to nav1.
    // Since corridor_index uses entry().or_insert(), whichever edge is built first wins;
    // both are valid corridor->destination mappings, so just check the indexed value is
    // one of the two valid destinations for both interior nodes.
    let valid = [nav1, nav4];
    assert!(valid.contains(&nav.corridor_index[&2]), "node 2 corridor_index must point to a real nav node");
    assert!(valid.contains(&nav.corridor_index[&3]), "node 3 corridor_index must point to a real nav node");
    // Junction nodes themselves must not appear in corridor_index.
    assert!(!nav.corridor_index.contains_key(&1), "junction node must not be in corridor_index");
    assert!(!nav.corridor_index.contains_key(&4), "junction node must not be in corridor_index");
}

// link_reverse_edges must pair up the two directed edges of a bidirectional corridor.
#[test]
fn reverse_edge_linked_for_bidirectional_corridor() {
    let mut g = Graph::new();
    for id in [1u64, 2, 3] { g.add_node(id); }
    add_bidir(&mut g, 1, 2);
    add_bidir(&mut g, 2, 3);

    let nav = build_nav_graph(&g);
    assert_eq!(nav.edges().count(), 2, "expected forward + backward edge");

    let edges: Vec<&NavEdge> = nav.edges().collect();
    for e in &edges {
        let rev_idx = e.reverse_edge.expect("bidirectional edge must have a reverse_edge");
        let rev = nav.edge_by_idx(rev_idx);
        assert_eq!(rev.from, e.to, "reverse edge must swap from/to");
        assert_eq!(rev.to, e.from, "reverse edge must swap from/to");
        assert_eq!(rev.path, e.path.iter().copied().rev().collect::<Vec<_>>(), "reverse edge path must be reversed");
    }
}

// A one-way corridor has no reverse edge — link_reverse_edges must leave reverse_edge as None
// rather than incorrectly pairing it with an unrelated edge.
#[test]
fn reverse_edge_none_for_one_way_corridor() {
    let mut g = Graph::new();
    for id in [1u64, 2, 3] { g.add_node(id); }
    // one-way chain 1->2->3, no edges back
    g.add_edge(1, 2, EdgeKind::Basic);
    g.add_edge(2, 3, EdgeKind::Basic);

    let nav = build_nav_graph(&g);
    for e in nav.edges() {
        assert!(e.reverse_edge.is_none(), "one-way edge must not have a reverse_edge");
    }
}

// GitHub issue #197: with a Basic and a Teleport edge coexisting in the same direction between
// the same pair, in both directions (1->2 Basic + Teleport, 2->1 Basic + Teleport), construction
// builds 4 one-hop NavEdges all sharing path [1,2] or [2,1]. link_reverse_edges must pair each
// edge with the reverse of the *same* kind — keying by path alone (pre-fix behavior) would let
// one direction's Basic/Teleport insert overwrite the other's slot in path_to_idx, risking a
// Basic edge's reverse_edge pointing at an unrelated Teleport edge or vice versa.
#[test]
fn reverse_edge_links_same_kind_only_for_parallel_basic_and_teleport_edges() {
    let mut g = Graph::new();
    for id in [1u64, 2] { g.add_node(id); }
    g.add_edge(1, 2, EdgeKind::Basic);
    g.add_edge(1, 2, EdgeKind::Teleport);
    g.add_edge(2, 1, EdgeKind::Basic);
    g.add_edge(2, 1, EdgeKind::Teleport);

    let nav = build_nav_graph(&g);
    let edges: Vec<&NavEdge> = nav.edges().collect();
    assert_eq!(edges.len(), 4, "expected one NavEdge per physical graph edge");

    for e in &edges {
        let rev_idx = e.reverse_edge.expect("every edge here has a same-kind counterpart in the opposite direction");
        let rev = nav.edge_by_idx(rev_idx);
        assert_eq!(rev.is_teleport, e.is_teleport, "reverse_edge must link edges of the same is_teleport kind");
        assert_eq!(rev.path, e.path.iter().copied().rev().collect::<Vec<_>>(), "reverse edge path must be reversed");
    }

    let teleport_count = edges.iter().filter(|e| e.is_teleport).count();
    let basic_count = edges.iter().filter(|e| !e.is_teleport).count();
    assert_eq!(teleport_count, 2, "expected 2 teleport-backed one-hop edges (one per direction)");
    assert_eq!(basic_count, 2, "expected 2 basic-backed one-hop edges (one per direction)");
}

// outgoing_edges/incoming_edges/edge_by_idx must return the correct edges for a junction
// with multiple distinct corridors.
#[test]
fn outgoing_incoming_edges_getters() {
    let mut g = Graph::new();
    for id in [1u64, 2, 3, 4] { g.add_node(id); }
    // junction 1 with two bidirectional dead-end neighbors 2 and 3 (no shared edges, so corridor check fails)
    add_bidir(&mut g, 1, 2);
    add_bidir(&mut g, 1, 3);
    add_bidir(&mut g, 1, 4);

    let nav = build_nav_graph(&g);
    let nav1 = nav.nav_node_for(1).unwrap();

    let out: Vec<NodeId> = nav.outgoing_edges(nav1).map(|e| nav.nodes[e.to].node_id).collect();
    let inc: Vec<NodeId> = nav.incoming_edges(nav1).map(|e| nav.nodes[e.from].node_id).collect();
    let mut out_sorted = out.clone();
    out_sorted.sort();
    let mut inc_sorted = inc.clone();
    inc_sorted.sort();
    assert_eq!(out_sorted, vec![2, 3, 4], "node 1 must have outgoing edges to 2,3,4");
    assert_eq!(inc_sorted, vec![2, 3, 4], "node 1 must have incoming edges from 2,3,4");

    // edge_by_idx must resolve the same edge instances returned by outgoing_edges.
    for e in nav.outgoing_edges(nav1) {
        let idx = nav.edges().position(|x| std::ptr::eq(x, e)).unwrap();
        assert_eq!(nav.edge_by_idx(idx).path, e.path);
    }
}

// walk_corridor must detect a ring-close (revisit) even when started mid-DFS from a junction:
// junction J connects to a ring of pure corridor nodes that loops back without passing through
// another junction — J⇄A⇄B⇄A is impossible (would make A a junction), so instead test
// J⇄A, with A,B,C forming a sub-ring reachable only via one outgoing step from J, where the
// walk must stop upon revisiting a node already seen in this corridor walk.
#[test]
fn walk_corridor_detects_revisit_without_hanging() {
    // J(1) -> 2 (one-way in), ring 2<->3<->4<->2 is bidirectional so nodes 2,3,4 are corridor
    // nodes EXCEPT node 2 also receives the one-way edge from J, making it asymmetric (junction).
    // To force a genuine "revisit inside walk_corridor" case, build a ring directly attached
    // to a junction via a single bidirectional edge, then verify it terminates (no hang) and
    // produces a self-edge back to the junction's neighbor anchor — i.e. delegate to build_ring.
    let mut g = Graph::new();
    for id in [1u64, 2, 3, 4, 5] { g.add_node(id); }
    add_bidir(&mut g, 1, 2); // dead-end junction 1 attached to ring anchor 2
    add_bidir(&mut g, 2, 3);
    add_bidir(&mut g, 3, 4);
    add_bidir(&mut g, 4, 2);
    // extra dead end so node 5 is isolated/separate component, ensuring multi-component handling
    let _ = g.add_node(5);

    let nav = build_nav_graph(&g);
    // Must terminate (test itself proves no infinite loop) and cover all 5 nodes.
    let nav_ids: HashSet<NodeId> = nav.nodes.iter().map(|n| n.node_id).collect();
    let mut covered: HashSet<NodeId> = nav_ids.clone();
    for e in nav.edges() { for &n in &e.path { covered.insert(n); } }
    assert_eq!(covered.len(), 5, "all 5 nodes (including isolated node 5) must be covered");
    assert!(nav_ids.contains(&1), "dead-end junction 1 must be a nav node");
    assert!(nav_ids.contains(&5), "isolated node 5 must be a nav node");
}
