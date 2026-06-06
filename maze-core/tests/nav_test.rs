use maze_core::graph::Graph;
use maze_core::graph::nav::build_nav_graph;
use maze_core::graph::EdgeKind;
use maze_core::ids::IdGenerator;

fn bi(g: &mut Graph, a: u64, b: u64) {
    g.add_bidirectional_edge(a, b, EdgeKind::Basic);
}

fn uni(g: &mut Graph, a: u64, b: u64) {
    g.add_edge(a, b, EdgeKind::Basic);
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
    assert_eq!(nav.edges().count(), 2, "expected 2 nav edges (forward + backward)");

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
        assert_eq!(e.path[0], e.path[e.path.len() - 1], "ring path starts and ends at anchor");
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

