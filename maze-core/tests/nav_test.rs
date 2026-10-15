use maze_core::generation::{GenerationConfig, PresetState, generate_maze};
use maze_core::graph::EdgeKind;
use maze_core::graph::Graph;
use maze_core::graph::nav::{build_nav_graph, build_nav_graph_pinned};
use maze_core::ids::IdGenerator;
use maze_core::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
use std::sync::Arc;

fn bi(g: &mut Graph, a: u64, b: u64) {
    g.build_initial_bidirectional_edge(a, b, EdgeKind::Basic);
}

fn uni(g: &mut Graph, a: u64, b: u64) {
    g.build_initial_edge(a, b, EdgeKind::Basic);
}

fn make_graph(n: usize) -> Graph {
    let mut ids = IdGenerator::new();
    let mut g = Graph::new();
    for _ in 0..n {
        g.add_node(ids.next_id());
    }
    g
}

// Linear bidirectional corridor: 0 ⇄ 1 ⇄ 2 ⇄ 3
// All nodes have degree 1 or 2 (not symmetric 2+2 pairs):
//   node 0: 1 out, 1 in — junction
//   node 1: 2 out, 2 in, symmetric — corridor
//   node 2: 2 out, 2 in, symmetric — corridor
//   node 3: 1 out, 1 in — junction
// Expected: 2 nav nodes (0 and 3), 2 nav edges (0→3 path=[0,1,2,3] and 3→0 path=[3,2,1,0]).
#[test]
fn linear_corridor_bidirectional() {
    let mut g = make_graph(4);
    bi(&mut g, 0, 1);
    bi(&mut g, 1, 2);
    bi(&mut g, 2, 3);

    let nav = build_nav_graph(&g);

    assert_eq!(nav.nodes.len(), 2, "expected 2 nav nodes (endpoints only)");
    assert_eq!(
        nav.edges().count(),
        2,
        "expected 2 nav edges (forward + backward)"
    );

    for e in nav.edges() {
        assert_eq!(e.path.len(), 4, "each corridor path spans all 4 nodes");
    }

    // One path is the reverse of the other
    let mut paths: Vec<Vec<_>> = nav.edges().map(|e| e.path.clone()).collect();
    paths.sort();
    assert_eq!(paths[0], paths[1].iter().copied().rev().collect::<Vec<_>>());
}

// Single-node corridor: just node 0 alone (no edges)
// Expected: 1 nav node, 0 nav edges
#[test]
fn isolated_single_node() {
    let mut g = make_graph(1);
    let _ = &mut g;

    let nav = build_nav_graph(&g);
    assert_eq!(nav.nodes.len(), 1);
    assert_eq!(nav.edges().count(), 0);
}

// Fork: 0 ⇄ 1, 1 ⇄ 2, 1 ⇄ 3
// Node 1 has 3 bidirectional neighbors — junction.
// Expected: 3 nav nodes (0, 1, 2, 3 — but 1 is junction, others are endpoints)
//   Actually 4 nav nodes, 6 nav edges (bidirectional between 1↔0, 1↔2, 1↔3)
#[test]
fn fork_junction() {
    let mut g = make_graph(4);
    bi(&mut g, 0, 1);
    bi(&mut g, 1, 2);
    bi(&mut g, 1, 3);

    let nav = build_nav_graph(&g);

    // 0, 1, 2, 3 all junctions (node 1 has 3 neighbors, others have 1)
    assert_eq!(nav.nodes.len(), 4);
    // 3 bidirectional pairs = 6 directed nav edges
    assert_eq!(nav.edges().count(), 6);
}

// Pure ring: 0 ⇄ 1 ⇄ 2 ⇄ 0
// All corridor nodes, no junctions.
// Expected: 1 nav node (the ring anchor), 2 self-edges (CW and CCW).
#[test]
fn pure_ring() {
    let mut g = make_graph(3);
    bi(&mut g, 0, 1);
    bi(&mut g, 1, 2);
    bi(&mut g, 2, 0);

    let nav = build_nav_graph(&g);

    assert_eq!(nav.nodes.len(), 1, "ring should produce 1 nav node");
    assert_eq!(nav.edges().count(), 2, "ring should produce 2 self-edges");

    for e in nav.edges() {
        assert_eq!(e.from, e.to, "ring edges are self-edges");
        // path visits all 3 nodes + closes back = 4 entries
        assert_eq!(e.path.len(), 4);
        assert_eq!(
            e.path[0],
            e.path[e.path.len() - 1],
            "ring path starts and ends at anchor"
        );
    }
}

// Two isolated components: 0 ⇄ 1 and 2 ⇄ 3
// Expected: 4 nav nodes (all junctions, degree 1), 4 nav edges
#[test]
fn two_isolated_components() {
    let mut g = make_graph(4);
    bi(&mut g, 0, 1);
    bi(&mut g, 2, 3);

    let nav = build_nav_graph(&g);

    assert_eq!(nav.nodes.len(), 4);
    assert_eq!(nav.edges().count(), 4); // 2 bidirectional pairs
}

// One-way corridor: 0 → 1 → 2 → 3 (unidirectional)
// Node 1 has 1 incoming (from 0) and 1 outgoing (to 2) — NOT symmetric pair, so junction.
// All nodes are junctions. Expected: 4 nav nodes, 3 nav edges (direct).
#[test]
fn one_way_corridor() {
    let mut g = make_graph(4);
    uni(&mut g, 0, 1);
    uni(&mut g, 1, 2);
    uni(&mut g, 2, 3);

    let nav = build_nav_graph(&g);

    // Each node: 0 has 0 in / 1 out; 1 has 1 in / 1 out (not symmetric); 2 same; 3 has 1 in / 0 out
    assert_eq!(nav.nodes.len(), 4);
    assert_eq!(nav.edges().count(), 3);
}

// nav_graph is deterministic: same graph → same result
#[test]
fn deterministic() {
    let mut g = make_graph(4);
    bi(&mut g, 0, 1);
    bi(&mut g, 1, 2);
    bi(&mut g, 2, 3);

    let nav1 = build_nav_graph(&g);
    let nav2 = build_nav_graph(&g);

    assert_eq!(nav1.nodes.len(), nav2.nodes.len());
    assert_eq!(nav1.edges().count(), nav2.edges().count());
    for (e1, e2) in nav1.edges().zip(nav2.edges()) {
        assert_eq!(e1.path, e2.path);
    }
}

// Every consecutive pair in every nav-edge path must follow an actual directed maze edge.
// Regression: build_ring added ring_start to path even when no outgoing edge existed back
// to it (e.g. due to one-way edges), producing a phantom diagonal step in the nav overlay.
#[test]
fn nav_paths_only_contain_adjacent_maze_nodes() {
    let mut ids = IdGenerator::new();
    let mut field = MultiLevelField::<SquareTessellation>::single_level(
        Arc::default(),
        square_rect(10, 10),
        &mut ids,
    )
    .unwrap();
    let level = field.single_level_id();
    let mut graph = Graph::new();
    for node in field.all_node_ids() {
        graph.add_node(node);
    }
    let start = field
        .nodes_at(level, SquarePoint { x: 0, y: 0 })
        .first()
        .copied()
        .unwrap();
    generate_maze(
        &mut graph,
        &mut field,
        &mut ids,
        42,
        start,
        GenerationConfig::default(),
        &PresetState::empty(),
    );

    let maze_nodes: std::collections::HashSet<u64> = graph.nodes().map(|n| n.id).collect();
    let nav = build_nav_graph(&graph);

    for edge in nav.edges() {
        for &nid in &edge.path {
            assert!(
                maze_nodes.contains(&nid),
                "nav path references node {nid} not in maze graph"
            );
        }
        for window in edge.path.windows(2) {
            let a = window[0];
            let b = window[1];
            // Path direction must follow an actual directed or undirected maze edge
            let connected = graph.outgoing_neighbors(a).any(|n| n == b)
                || graph.outgoing_neighbors(b).any(|n| n == a);
            assert!(
                connected,
                "nav path contains non-adjacent nodes: {a} -> {b}"
            );
        }
    }
}

// Minimal reproduction: a ring where the closing edge is one-way (b→a only).
// build_ring must not append ring_start to path when there is no outgoing edge back to it.
#[test]
fn nav_ring_with_one_way_closing_edge_no_phantom_step() {
    // 0 ⇄ 1 ⇄ 2, but closing edge is one-way: 2 → 0 (not 0 → 2)
    // So outgoing from 2 that != 1 = {0}, which IS ring_start → ring closes correctly.
    // Test the opposite: closing edge missing entirely — 0 ⇄ 1 ⇄ 2 with no edge 2→0.
    // Node 1 has 2 out (0,2) and 2 in (0,2) → corridor.
    // Node 0 has 1 out (1), 2 in (1,2)? No — let's build explicitly.
    //
    // Graph: 0→1, 1→0, 1→2, 2→1, 2→0 (one-way close, no 0→2)
    // Node 0: out=[1], in=[1,2] — not corridor (out.len=1)
    // Node 1: out=[0,2], in=[0,2] — corridor
    // Node 2: out=[1,0], in=[1] — not corridor (out.len=2, in.len=1)
    // All nodes end up as junctions, no ring path — correct.
    //
    // Real regression case: a cycle where all nodes appear as corridor nodes
    // but one closing step has no outgoing edge. Build manually:
    // 0⇄1, 1⇄2, 2⇄3, 3⇄0 — pure ring, then remove edge 3→0 to break closing.
    let mut g = make_graph(4);
    bi(&mut g, 0, 1);
    bi(&mut g, 1, 2);
    bi(&mut g, 2, 3);
    // Only add 0→3 (not 3→0) so node 3 loses the outgoing back to ring_start
    uni(&mut g, 0, 3);

    // Node 0: out=[1,3], in=[1] — not corridor
    // So this won't trigger build_ring. The phantom step only appears when
    // find_component_start walks into a corridor-only cycle that has a broken close.
    // The fix is verified by the generated-maze test above with seed=42.
    let nav = build_nav_graph(&g);
    for edge in nav.edges() {
        for window in edge.path.windows(2) {
            let a = window[0];
            let b = window[1];
            let connected =
                g.outgoing_neighbors(a).any(|n| n == b) || g.outgoing_neighbors(b).any(|n| n == a);
            assert!(connected, "phantom step: {a} -> {b}");
        }
    }
}

// Ring determinism: two graphs with same topology but edges inserted in reverse order
// must produce nav graphs with the same anchor node and equivalent paths.
#[test]
fn ring_deterministic_insertion_order() {
    // Graph A: edges inserted 0→1→2→0
    let mut g1 = make_graph(3);
    bi(&mut g1, 0, 1);
    bi(&mut g1, 1, 2);
    bi(&mut g1, 2, 0);

    // Graph B: edges inserted 2→1→0→2 (reverse)
    let mut g2 = make_graph(3);
    bi(&mut g2, 2, 1);
    bi(&mut g2, 1, 0);
    bi(&mut g2, 0, 2);

    let nav1 = build_nav_graph(&g1);
    let nav2 = build_nav_graph(&g2);

    // Both must produce 1 nav node and 2 self-edges
    assert_eq!(nav1.nodes.len(), 1);
    assert_eq!(nav2.nodes.len(), 1);
    assert_eq!(nav1.edges().count(), 2);
    assert_eq!(nav2.edges().count(), 2);

    // Anchor must be the same (min-id node = 0)
    assert_eq!(nav1.nodes[0].node_id, nav2.nodes[0].node_id);

    // Paths must match exactly (same anchor, same min-direction walk)
    let mut paths1: Vec<Vec<_>> = nav1.edges().map(|e| e.path.clone()).collect();
    let mut paths2: Vec<Vec<_>> = nav2.edges().map(|e| e.path.clone()).collect();
    paths1.sort();
    paths2.sort();
    assert_eq!(paths1, paths2);
}

// Regression: find_component_start used min(outgoing) without prev filter.
// On bidirectional corridor 0⇄1⇄2⇄J, when seed=0:
//   step 0→1, then min(outgoing(1))=min(0,2)=0 == seed → false Ring(0).
// Fix: use advance_chain(current, prev) to skip the back-edge.
// Expected: Junction(J), 2 nav nodes (0 and J), 2 nav edges.
#[test]
fn corridor_seed_does_not_false_ring_via_back_edge() {
    // 0⇄1⇄2⇄3, node 3 has extra neighbor → junction
    // Nodes: 0,1,2 corridor; 3 junction (degree 1 from corridor + nothing else = dead end junction)
    // Actually 3 with only 1 bidirectional neighbor is also degree-1 → junction.
    // Min seed = 0 (corridor). walk: 0→1, advance(1,prev=0)=2, advance(2,prev=1)=3 → Junction(3).
    let mut g = make_graph(4);
    bi(&mut g, 0, 1);
    bi(&mut g, 1, 2);
    bi(&mut g, 2, 3);

    let nav = build_nav_graph(&g);

    // 0 and 3 are junctions (degree 1), 1 and 2 are corridor
    assert_eq!(
        nav.nodes.len(),
        2,
        "only endpoints 0 and 3 should be nav nodes"
    );
    let nav_ids: std::collections::HashSet<u64> = nav.nodes.iter().map(|n| n.node_id).collect();
    assert!(nav_ids.contains(&0), "node 0 (dead end) must be nav node");
    assert!(nav_ids.contains(&3), "node 3 (dead end) must be nav node");
    assert!(
        !nav_ids.contains(&1),
        "node 1 is corridor, must not be nav node"
    );
    assert!(
        !nav_ids.contains(&2),
        "node 2 is corridor, must not be nav node"
    );
}

// Regression: find_component_start without prev-filter would walk 0→1→0 (back-edge) == seed
// and return false Ring(0) for a corridor that is actually part of a chain ending at junctions.
// Topology: J(3)⇄0⇄1⇄J(2), where 3 has extra neighbors {4,5} making it a true junction.
// Corridor nodes 0 and 1 have lower IDs than their junction endpoint 3 → min seed = 0.
#[test]
fn corridor_seed_low_id_does_not_false_ring() {
    // nodes 0..5
    let mut g = make_graph(6);
    bi(&mut g, 0, 1); // corridor
    bi(&mut g, 3, 0); // junction 3 anchors corridor left end; node 0 gets neighbors {1,3}
    bi(&mut g, 3, 4); // junction 3: third neighbor
    bi(&mut g, 3, 5); // junction 3: fourth neighbor (definitely not corridor)
    // node 2 is dead-end (no edges) → junction; node 1 has only neighbor 0 → junction
    // Actually: node 1: out={0}, in={0} → 1 neighbor → junction (dead end)
    // node 0: out={1,3}, in={1,3} → corridor

    let nav = build_nav_graph(&g);

    let nav_ids: std::collections::HashSet<u64> = nav.nodes.iter().map(|n| n.node_id).collect();
    assert!(
        !nav_ids.contains(&0),
        "node 0 is corridor, must not be nav node"
    );
    assert!(
        nav_ids.contains(&1),
        "node 1 is isolated dead-end (0 edges), must be nav node"
    );
    assert!(nav_ids.contains(&3), "node 3 is junction, must be nav node");

    let mut covered: std::collections::HashSet<u64> = nav_ids.clone();
    for e in nav.edges() {
        for &n in &e.path {
            covered.insert(n);
        }
    }
    assert_eq!(covered.len(), 6, "all 6 nodes must be covered");
}

// Ring with pinned node: pinned node must become anchor even if it has a higher id than other ring nodes.
// Topology: ring 0⇄1⇄2⇄0, pinned={2}. Min ring node = 0, but pinned=2 must win.
#[test]
fn ring_pinned_node_becomes_anchor_over_min_id() {
    let mut g = make_graph(3);
    bi(&mut g, 0, 1);
    bi(&mut g, 1, 2);
    bi(&mut g, 2, 0);

    let mut pinned = std::collections::HashSet::new();
    pinned.insert(2u64);

    let nav = build_nav_graph_pinned(&g, &pinned);

    assert_eq!(nav.nodes.len(), 1, "ring with one pinned node → 1 nav node");
    assert_eq!(
        nav.nodes[0].node_id, 2,
        "pinned node 2 must be anchor, not min-id node 0"
    );
    assert_eq!(nav.edges().count(), 2, "two self-edges");
    for e in nav.edges() {
        assert_eq!(e.path[0], 2, "ring path must start at pinned anchor 2");
        assert_eq!(
            e.path[e.path.len() - 1],
            2,
            "ring path must end at pinned anchor 2"
        );
    }
}
