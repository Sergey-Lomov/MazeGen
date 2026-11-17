use super::*;
use crate::graph::nav::build_nav_graph_pinned;
use crate::graph::{EdgeKind, Graph};
use crate::ids::NodeId;
use std::collections::HashSet;

fn bidir(g: &mut Graph, a: NodeId, b: NodeId) {
    g.add_edge(a, b, EdgeKind::Basic);
    g.add_edge(b, a, EdgeKind::Basic);
}

fn pinned(nodes: &[NodeId]) -> HashSet<NodeId> {
    nodes.iter().copied().collect()
}

#[test]
fn dijkstra_forward_finds_shortest_distance() {
    let mut g = Graph::new();
    for id in [1u64, 2, 3, 4] {
        g.add_node(id);
    }
    bidir(&mut g, 1, 2);
    bidir(&mut g, 2, 3);
    bidir(&mut g, 1, 4);
    bidir(&mut g, 4, 3);
    let nav = build_nav_graph_pinned(&g, &pinned(&[1, 2, 3, 4]));
    let source = nav.nav_node_for(1).unwrap();
    let dist = dijkstra_forward(&nav, source);
    let target = nav.nav_node_for(3).unwrap();
    assert_eq!(dist[target], 2, "both 1->2->3 and 1->4->3 are 2 hops");
}

#[test]
fn dijkstra_forward_unreachable_node_is_max() {
    let mut g = Graph::new();
    for id in [1u64, 2] {
        g.add_node(id);
    }
    // no edges -- disconnected.
    let nav = build_nav_graph_pinned(&g, &pinned(&[1, 2]));
    let source = nav.nav_node_for(1).unwrap();
    let dist = dijkstra_forward(&nav, source);
    let target = nav.nav_node_for(2).unwrap();
    assert_eq!(dist[target], usize::MAX);
}

#[test]
fn dijkstra_forward_respects_edge_direction() {
    let mut g = Graph::new();
    for id in [1u64, 2] {
        g.add_node(id);
    }
    g.add_edge(1, 2, EdgeKind::Basic); // one-way only
    let nav = build_nav_graph_pinned(&g, &pinned(&[1, 2]));
    let source = nav.nav_node_for(2).unwrap();
    let dist = dijkstra_forward(&nav, source);
    let target = nav.nav_node_for(1).unwrap();
    assert_eq!(
        dist[target],
        usize::MAX,
        "forward Dijkstra from 2 must not reach 1 via a 1->2-only edge"
    );
}

#[test]
fn dijkstra_reverse_finds_nodes_that_can_reach_target() {
    let mut g = Graph::new();
    for id in [1u64, 2, 3] {
        g.add_node(id);
    }
    g.add_edge(1, 2, EdgeKind::Basic);
    g.add_edge(2, 3, EdgeKind::Basic);
    let nav = build_nav_graph_pinned(&g, &pinned(&[1, 2, 3]));
    let target = nav.nav_node_for(3).unwrap();
    let dist = dijkstra_reverse(&nav, target);
    let source = nav.nav_node_for(1).unwrap();
    assert_eq!(
        dist[source], 2,
        "1 can reach 3 in 2 hops via incoming-edge traversal"
    );
}

#[test]
fn dijkstra_with_prev_reconstructs_correct_predecessor_chain() {
    let mut g = Graph::new();
    for id in [1u64, 2, 3] {
        g.add_node(id);
    }
    bidir(&mut g, 1, 2);
    bidir(&mut g, 2, 3);
    let nav = build_nav_graph_pinned(&g, &pinned(&[1, 2, 3]));
    let all_edges: Vec<_> = nav.edges().collect();
    let outgoing = build_outgoing_index(&nav, &all_edges);
    let source = nav.nav_node_for(1).unwrap();
    let (dist, prev_edge) = dijkstra_with_prev(&nav, source, &all_edges, &outgoing);
    let target = nav.nav_node_for(3).unwrap();
    assert_eq!(dist[target], 2);
    // Walk prev_edge back from target to source.
    let mut cur = target;
    let mut hops = 0;
    while cur != source {
        let ei = prev_edge[cur].expect("path must exist");
        cur = all_edges[ei].from;
        hops += 1;
        assert!(hops <= 3, "predecessor chain must not loop");
    }
    assert_eq!(hops, 2);
}

#[test]
fn dijkstra_forward_filtered_bounded_leaves_nodes_past_max_dist_unreached() {
    // A 10-hop chain 0->1->...->10. With max_dist=2, node 10 (true distance 10) must stay
    // at usize::MAX -- not merely because it's filtered out afterward, but because the heap
    // never got far enough to relax it. This is the actual proof the traversal stops early
    // (GitHub issue #196), as opposed to just computing the full map and discarding results.
    let mut g = Graph::new();
    let ids: Vec<u64> = (0..=10).collect();
    for &id in &ids {
        g.add_node(id);
    }
    for w in ids.windows(2) {
        g.add_edge(w[0], w[1], EdgeKind::Basic);
    }
    let nav = build_nav_graph_pinned(&g, &pinned(&ids));
    let source = nav.nav_node_for(0).unwrap();
    let far = nav.nav_node_for(10).unwrap();
    let near = nav.nav_node_for(2).unwrap();

    let bounded = dijkstra_forward_filtered_bounded(&nav, source, |_| true, Some(2));
    assert_eq!(
        bounded[near], 2,
        "node within max_dist must still get its correct distance"
    );
    assert_eq!(
        bounded[far],
        usize::MAX,
        "node past max_dist must be left unreached, not merely filtered"
    );

    let unbounded = dijkstra_forward_filtered_bounded(&nav, source, |_| true, None);
    assert_eq!(
        unbounded[far], 10,
        "sanity check: without a bound the same traversal does reach node 10"
    );
}

#[test]
fn dijkstra_forward_visit_edges_bounded_visits_every_edge_in_non_decreasing_distance_order() {
    // Diamond: 0->1, 0->2, 1->3, 2->3. Edges leaving a node are visited only once that node's
    // own shortest distance is known, so the two edges out of 0 (distance 0) are seen before
    // the two edges out of 1/2 (distance 1) -- direct proof of the function's own "visits an
    // edge with the already-known distance to its `from` end" contract, and that it reaches
    // every edge in the graph rather than stopping early.
    let mut g = Graph::new();
    for id in [0u64, 1, 2, 3] {
        g.add_node(id);
    }
    g.add_edge(0, 1, EdgeKind::Basic);
    g.add_edge(0, 2, EdgeKind::Basic);
    g.add_edge(1, 3, EdgeKind::Basic);
    g.add_edge(2, 3, EdgeKind::Basic);
    let nav = build_nav_graph_pinned(&g, &pinned(&[0, 1, 2, 3]));
    let source = nav.nav_node_for(0).unwrap();

    let mut seen: Vec<(NodeId, NodeId, usize)> = Vec::new();
    dijkstra_forward_visit_edges_bounded(
        &nav,
        source,
        |_| true,
        None,
        |edge, dist| {
            let from_id = nav.nodes[edge.from].node_id;
            let to_id = nav.nodes[edge.to].node_id;
            seen.push((from_id, to_id, dist));
            true
        },
    );

    assert_eq!(
        seen.len(),
        4,
        "every edge in the diamond must be visited exactly once"
    );
    assert!(
        seen.iter()
            .all(|&(from, _, dist)| (from == 0) == (dist == 0)),
        "an edge leaving node 0 must be visited at distance 0, no other edge at distance 0: {seen:?}"
    );
    assert!(
        seen.iter()
            .any(|&(from, to, dist)| from == 1 && to == 3 && dist == 1),
        "edge 1->3 must be visited once node 1's own distance (1) is known: {seen:?}"
    );
}

#[test]
fn dijkstra_forward_visit_edges_bounded_stops_early_when_on_edge_returns_false() {
    let mut g = Graph::new();
    for id in [0u64, 1, 2] {
        g.add_node(id);
    }
    g.add_edge(0, 1, EdgeKind::Basic);
    g.add_edge(1, 2, EdgeKind::Basic);
    let nav = build_nav_graph_pinned(&g, &pinned(&[0, 1, 2]));
    let source = nav.nav_node_for(0).unwrap();

    let mut visits = 0;
    dijkstra_forward_visit_edges_bounded(
        &nav,
        source,
        |_| true,
        None,
        |_, _| {
            visits += 1;
            false // stop right after the first edge
        },
    );
    assert_eq!(
        visits, 1,
        "on_edge returning false must end the traversal immediately"
    );
}

#[test]
fn dijkstra_reverse_visit_edges_bounded_visits_incoming_edges_with_distance_to_their_to_end() {
    // Chain 0->1->2 (one-way). Scanning in reverse from 2 must visit edge 1->2 first (distance
    // 0 to 2, its own `to` end), then edge 0->1 (distance 1, once node 1's own distance from 2
    // is known) -- proves it follows `incoming_edges` and relaxes toward `edge.from`, the
    // mirror image of the forward variant's own contract.
    let mut g = Graph::new();
    for id in [0u64, 1, 2] {
        g.add_node(id);
    }
    g.add_edge(0, 1, EdgeKind::Basic);
    g.add_edge(1, 2, EdgeKind::Basic);
    let nav = build_nav_graph_pinned(&g, &pinned(&[0, 1, 2]));
    let target = nav.nav_node_for(2).unwrap();

    let mut seen: Vec<(NodeId, NodeId, usize)> = Vec::new();
    dijkstra_reverse_visit_edges_bounded(
        &nav,
        target,
        |_| true,
        None,
        |edge, dist| {
            let from_id = nav.nodes[edge.from].node_id;
            let to_id = nav.nodes[edge.to].node_id;
            seen.push((from_id, to_id, dist));
            true
        },
    );

    assert_eq!(seen.len(), 2, "both edges on the chain must be visited");
    assert_eq!(
        seen[0],
        (1, 2, 0),
        "edge 1->2 must be visited first, at distance 0 (its own `to` end is the source)"
    );
    assert_eq!(
        seen[1],
        (0, 1, 1),
        "edge 0->1 must be visited once node 1's own distance to the target (1) is known"
    );
}

#[test]
fn dijkstra_reverse_visit_edges_bounded_respects_max_dist() {
    // Chain 0->1->2->3. Scanning in reverse from 3 with max_dist=1 must not visit edge 0->1
    // (distance 2 to the target), only 2->3 (distance 0) and 1->2 (distance 1).
    let mut g = Graph::new();
    for id in [0u64, 1, 2, 3] {
        g.add_node(id);
    }
    g.add_edge(0, 1, EdgeKind::Basic);
    g.add_edge(1, 2, EdgeKind::Basic);
    g.add_edge(2, 3, EdgeKind::Basic);
    let nav = build_nav_graph_pinned(&g, &pinned(&[0, 1, 2, 3]));
    let target = nav.nav_node_for(3).unwrap();

    let mut seen: Vec<(NodeId, NodeId)> = Vec::new();
    dijkstra_reverse_visit_edges_bounded(
        &nav,
        target,
        |_| true,
        Some(1),
        |edge, _| {
            seen.push((nav.nodes[edge.from].node_id, nav.nodes[edge.to].node_id));
            true
        },
    );

    assert_eq!(
        seen,
        vec![(2, 3), (1, 2)],
        "edge 0->1 (distance 2 to the target) must never be visited when max_dist is 1"
    );
}

#[test]
fn build_outgoing_index_groups_edges_by_source() {
    let mut g = Graph::new();
    for id in [1u64, 2, 3] {
        g.add_node(id);
    }
    g.add_edge(1, 2, EdgeKind::Basic);
    g.add_edge(1, 3, EdgeKind::Basic);
    let nav = build_nav_graph_pinned(&g, &pinned(&[1, 2, 3]));
    let all_edges: Vec<_> = nav.edges().collect();
    let outgoing = build_outgoing_index(&nav, &all_edges);
    let source = nav.nav_node_for(1).unwrap();
    assert_eq!(outgoing[source].len(), 2, "node 1 has 2 outgoing nav edges");
}

#[test]
fn bfs_distances_follow_edge_direction_and_omit_unreachable_nodes() {
    let mut g = Graph::new();
    for id in [1u64, 2, 3, 4, 5] {
        g.add_node(id);
    }
    // 1 -> 2 -> 3 and a shortcut 1 -> 3; 4 only points into 1; 5 is isolated.
    g.add_edge(1, 2, EdgeKind::Basic);
    g.add_edge(2, 3, EdgeKind::Basic);
    g.add_edge(1, 3, EdgeKind::Basic);
    g.add_edge(4, 1, EdgeKind::Basic);

    let forward = bfs_distances(&g, 1);
    assert_eq!(forward.get(&1), Some(&0));
    assert_eq!(forward.get(&2), Some(&1));
    assert_eq!(forward.get(&3), Some(&1), "the shortcut wins over 1->2->3");
    assert!(
        !forward.contains_key(&4),
        "4 only reaches 1, not the reverse"
    );
    assert!(!forward.contains_key(&5));

    let reverse = bfs_distances_reverse(&g, 3);
    assert_eq!(reverse.get(&3), Some(&0));
    assert_eq!(reverse.get(&1), Some(&1));
    assert_eq!(reverse.get(&2), Some(&1));
    assert_eq!(reverse.get(&4), Some(&2));
    assert!(!reverse.contains_key(&5));
}
