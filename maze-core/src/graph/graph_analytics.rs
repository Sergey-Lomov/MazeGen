use std::collections::{HashMap, HashSet, VecDeque};
use super::nav::{NavEdge, NavGraph, NavNodeId};

struct Dsu {
    parent: Vec<usize>,
    size: Vec<usize>,
}

impl Dsu {
    fn new(n: usize) -> Self {
        Self { parent: (0..n).collect(), size: vec![1; n] }
    }

    fn find(&mut self, x: usize) -> usize {
        if self.parent[x] != x {
            self.parent[x] = self.find(self.parent[x]);
        }
        self.parent[x]
    }

    fn union(&mut self, a: usize, b: usize) {
        let ra = self.find(a);
        let rb = self.find(b);
        if ra == rb { return; }
        if self.size[ra] >= self.size[rb] {
            self.parent[rb] = ra;
            self.size[ra] += self.size[rb];
        } else {
            self.parent[ra] = rb;
            self.size[rb] += self.size[ra];
        }
    }
}

/// Iteratively trim dead-end nav-nodes: a node with at most one *distinct undirected
/// connection* — counting an edge and its `reverse_edge` as one, but counting parallel
/// edges to the same neighbor (e.g. a direct corridor plus a longer detour between the
/// same two junctions) as separate connections, since each is a potential cycle leg —
/// cannot lie on any directed cycle. Walking out and back along the single connection is
/// the only option, forbidden by the no-edge-reuse rule. Removing it can turn its neighbor
/// into a new dead end, so this repeats until stable (leaf-pruning a tree, but direction-
/// and multi-edge-safe: it only ever strips nodes topologically incapable of being on a
/// cycle, regardless of edge direction or one-way edges).
/// Returns, per nav-node id, whether it survives trimming — candidates for `build_cyclic_core`.
fn trim_dead_ends(nav: &NavGraph) -> Vec<bool> {
    let n = nav.nodes.len();

    // Undirected adjacency: each distinct nav-edge counts once (its reverse_edge, if any,
    // is the same physical connection and must not be double-counted), but two different
    // edge indices to the same neighbor (parallel corridors) each count separately.
    let mut adj: Vec<Vec<NavNodeId>> = vec![Vec::new(); n];
    let mut counted: HashSet<usize> = HashSet::new();
    for (idx, edge) in nav.edges().enumerate() {
        if edge.from == edge.to { continue; }
        if counted.contains(&idx) { continue; }
        if let Some(rev) = edge.reverse_edge { counted.insert(rev); }
        counted.insert(idx);
        adj[edge.from].push(edge.to);
        adj[edge.to].push(edge.from);
    }
    let mut degree: Vec<usize> = adj.iter().map(|v| v.len()).collect();

    let mut removed = vec![false; n];
    let mut queue: VecDeque<NavNodeId> = VecDeque::new();
    for nid in 0..n {
        if degree[nid] <= 1 { queue.push_back(nid); }
    }
    while let Some(nid) = queue.pop_front() {
        if removed[nid] { continue; }
        removed[nid] = true;
        for &nb in &adj[nid] {
            if removed[nb] { continue; }
            degree[nb] = degree[nb].saturating_sub(1);
            if degree[nb] <= 1 { queue.push_back(nb); }
        }
    }

    removed.into_iter().map(|r| !r).collect()
}

/// Find nav-nodes and nav-edges participating in real directed cycles.
/// An edge (u -> v) lies on a real cycle iff there is a directed path from v back to u
/// that does not reuse this edge or its reverse (reusing the reverse would just be
/// walking the same corridor back and forth, not a real cycle).
/// Returns (cyclic nav-node ids, cyclic nav-edge indices).
fn build_cyclic_core(nav: &NavGraph) -> (HashSet<NavNodeId>, HashSet<usize>) {
    let n = nav.nodes.len();
    let edges: Vec<&NavEdge> = nav.edges().collect();

    // Dead-end nodes can never be on a cycle — exclude them before the expensive BFS pass.
    let survivors = trim_dead_ends(nav);

    // Adjacency: node -> list of (edge_idx, to). Restricted to surviving nodes.
    let mut adj: Vec<Vec<(usize, NavNodeId)>> = vec![Vec::new(); n];
    for (idx, edge) in edges.iter().enumerate() {
        if edge.from == edge.to { continue; } // self-loop, skip
        if !survivors[edge.from] || !survivors[edge.to] { continue; }
        adj[edge.from].push((idx, edge.to));
    }

    let mut cyclic_nodes: HashSet<NavNodeId> = HashSet::new();
    let mut cyclic_edges: HashSet<usize> = HashSet::new();

    for (idx, edge) in edges.iter().enumerate() {
        if edge.from == edge.to { continue; }
        if !survivors[edge.from] || !survivors[edge.to] { continue; }
        if cyclic_edges.contains(&idx) { continue; } // already proven cyclic
        let u = edge.from;
        let v = edge.to;
        let excluded_reverse = edge.reverse_edge;

        // BFS from v to u, forbidding this edge and its reverse.
        let mut visited = vec![false; n];
        let mut parent_edge: Vec<Option<usize>> = vec![None; n];
        visited[v] = true;
        let mut queue: VecDeque<NavNodeId> = VecDeque::new();
        queue.push_back(v);
        let mut found = v == u;

        while let Some(node) = queue.pop_front() {
            if node == u { found = true; break; }
            for &(e_idx, to) in &adj[node] {
                if e_idx == idx || Some(e_idx) == excluded_reverse { continue; }
                if visited[to] { continue; }
                visited[to] = true;
                parent_edge[to] = Some(e_idx);
                queue.push_back(to);
            }
        }

        if !found { continue; }

        // Reconstruct the path v -> u and mark all its edges + this edge as cyclic.
        cyclic_edges.insert(idx);
        cyclic_nodes.insert(u);
        cyclic_nodes.insert(v);
        let mut cur = u;
        while cur != v {
            let e_idx = parent_edge[cur].expect("BFS path must have a parent edge");
            cyclic_edges.insert(e_idx);
            let e = edges[e_idx];
            cyclic_nodes.insert(e.from);
            cyclic_nodes.insert(e.to);
            cur = e.from;
        }
    }

    (cyclic_nodes, cyclic_edges)
}

/// Global graph analytics computed on the nav-graph.
#[derive(Debug, Clone)]
pub struct GraphAnalytics {
    pub node_count: usize,
    pub edge_count: usize,
    /// Number of independent cycles (E - V + C on the pure-cycle core).
    pub cycle_count: usize,
    /// Number of connected cyclic regions (WCC on the pure-cycle core subgraph).
    pub cycle_region_count: usize,
    /// Nav-node ids in the pure-cycle core (real cycles only, no bridges).
    pub pure_cycle_nav_nodes: HashSet<NavNodeId>,
    /// Nav-edge indices in the pure-cycle core (real cycles only, no bridges).
    pub pure_cycle_edge_indices: HashSet<usize>,
}

impl GraphAnalytics {
    pub fn empty() -> Self {
        GraphAnalytics {
            node_count: 0,
            edge_count: 0,
            cycle_count: 0,
            cycle_region_count: 0,
            pure_cycle_nav_nodes: HashSet::new(),
            pure_cycle_edge_indices: HashSet::new(),
        }
    }
}

/// Compute graph analytics on the nav-graph.
/// Cycle metrics are based on the pure-cycle core (see `build_cyclic_core`), not raw SCCs.
pub fn compute_graph_analytics(nav: &NavGraph) -> GraphAnalytics {
    let n = nav.nodes.len();
    if n == 0 {
        return GraphAnalytics::empty();
    }
    // Unique undirected nav-edges (no self-loops) — for edge_count metric only. An edge and
    // its `reverse_edge` are the same physical corridor and count once; edges without a
    // reverse (one-way) count individually by edge index, NOT deduped by node-pair — two
    // distinct one-way edges between the same pair (e.g. a direct path plus a detour) are
    // genuinely separate corridors and must both be counted.
    let mut edge_counted: HashSet<usize> = HashSet::new();
    let mut edge_count = 0usize;
    for (idx, edge) in nav.edges().enumerate() {
        if edge.from == edge.to { continue; }
        if edge_counted.contains(&idx) { continue; }
        edge_counted.insert(idx);
        if let Some(rev) = edge.reverse_edge { edge_counted.insert(rev); }
        edge_count += 1;
    }

    // Pure-cycle core — nodes/edges participating in real directed cycles (no bridges).
    let (pure_cycle_nav_nodes, pure_cycle_edge_indices) = build_cyclic_core(nav);

    // Cycle metrics on the pure-cycle core. Bridges never participate, so they never
    // affect the cycle count or region count.
    // cycle_count = E_core - V_core + C_core (number of independent cycles).
    // cycle_region_count = number of connected components in the pure-cycle core (undirected).
    let (cycle_count, cycle_region_count) = if pure_cycle_nav_nodes.is_empty() {
        (0, 0)
    } else {
        let core_nodes: Vec<NavNodeId> = pure_cycle_nav_nodes.iter().copied().collect();
        let v_core = core_nodes.len();
        // Undirected edges within core. An edge and its reverse_edge are the same physical
        // corridor and count once; edges with no reverse_edge (one-way, or a corridor whose
        // reverse direction simply isn't in the core) count via plain undirected-pair dedup.
        // Distinct parallel corridors between the same node pair (e.g. a direct path plus a
        // longer detour, each compressed from a different chain of corridor nodes) must each
        // count separately — they're genuinely different cycle legs.
        let mut counted: HashSet<usize> = HashSet::new();
        let mut paired_count = 0usize;
        let mut unpaired_pairs: HashSet<(NavNodeId, NavNodeId)> = HashSet::new();
        for (idx, edge) in nav.edges().enumerate() {
            if !pure_cycle_edge_indices.contains(&idx) || edge.from == edge.to { continue; }
            if counted.contains(&idx) { continue; }
            match edge.reverse_edge {
                Some(rev) if pure_cycle_edge_indices.contains(&rev) => {
                    counted.insert(idx);
                    counted.insert(rev);
                    paired_count += 1;
                }
                _ => {
                    counted.insert(idx);
                    unpaired_pairs.insert((edge.from.min(edge.to), edge.from.max(edge.to)));
                }
            }
        }
        let e_core = paired_count + unpaired_pairs.len();
        // WCC on core subgraph via DSU.
        let node_to_idx: HashMap<NavNodeId, usize> = core_nodes.iter().enumerate().map(|(i, &v)| (v, i)).collect();
        let mut dsu = Dsu::new(v_core);
        for (idx, edge) in nav.edges().enumerate() {
            if pure_cycle_edge_indices.contains(&idx) && edge.from != edge.to {
                let a = node_to_idx[&edge.from];
                let b = node_to_idx[&edge.to];
                dsu.union(a, b);
            }
        }
        let mut roots = HashSet::new();
        for i in 0..v_core { roots.insert(dsu.find(i)); }
        let c_core = roots.len();
        let cycle_count = (e_core + c_core).saturating_sub(v_core);
        (cycle_count, c_core)
    };

    GraphAnalytics {
        node_count: n,
        edge_count,
        cycle_count,
        cycle_region_count,
        pure_cycle_nav_nodes,
        pure_cycle_edge_indices,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Graph, EdgeKind};
    use crate::graph::nav::{build_nav_graph, build_nav_graph_pinned};
    use crate::ids::NodeId;

    /// Two isolated bowtie clusters, each made of two directed triangles sharing one edge.
    /// Cluster 1: A=0,B=1,C=2,D=3 — cycle A->B->C->A, cycle B->D->C->B (shared edge B-C).
    /// Cluster 2: E=4,F=5,G=6,H=7 — same shape, disconnected from cluster 1.
    fn two_bowtie_clusters() -> Graph {
        let mut g = Graph::new();
        for id in 0..8 {
            g.add_node(id);
        }
        // Cluster 1
        g.add_edge(0, 1, EdgeKind::Basic); // A->B
        g.add_edge(1, 2, EdgeKind::Basic); // B->C
        g.add_edge(2, 0, EdgeKind::Basic); // C->A
        g.add_edge(1, 3, EdgeKind::Basic); // B->D
        g.add_edge(3, 2, EdgeKind::Basic); // D->C
        g.add_edge(2, 1, EdgeKind::Basic); // C->B
        // Cluster 2 (mirrors cluster 1, disjoint node ids)
        g.add_edge(4, 5, EdgeKind::Basic);
        g.add_edge(5, 6, EdgeKind::Basic);
        g.add_edge(6, 4, EdgeKind::Basic);
        g.add_edge(5, 7, EdgeKind::Basic);
        g.add_edge(7, 6, EdgeKind::Basic);
        g.add_edge(6, 5, EdgeKind::Basic);
        g
    }

    #[test]
    fn two_disjoint_bowtie_clusters_have_two_cycle_regions() {
        let g = two_bowtie_clusters();
        let nav = build_nav_graph(&g);
        let analytics = compute_graph_analytics(&nav);

        assert_eq!(analytics.node_count, 8, "8 distinct nav-nodes, no compression in two bowties");
        assert_eq!(analytics.edge_count, 10, "6 directed edges per cluster, but B<->C is a paired reverse (counts once) — 5 corridors per cluster");
        assert_eq!(analytics.cycle_count, 4, "two cycles per cluster, two clusters");
        assert_eq!(analytics.cycle_region_count, 2, "clusters are disconnected");
        assert_eq!(analytics.pure_cycle_nav_nodes.len(), 8, "all 8 nodes participate in a cycle");
    }

    /// Real post-edit graph from a 6x6 maze: two disjoint simple cycles
    /// (no shared edge), connected to each other only by non-cyclic corridors.
    /// Cycle A: 1-7-8-14-13-12-6-0-1. Cycle B: 34-28-22-21-20-26-27-33-34.
    fn user_reported_two_cycle_graph() -> (Graph, HashSet<NodeId>) {
        let bidir: &[(NodeId, NodeId)] = &[
            (21,20),(20,26),(26,27),(21,22),(22,16),(22,23),(22,28),(28,34),(34,33),
            (26,25),(23,29),(29,35),(33,27),(33,32),(32,31),(31,30),(30,24),(24,18),
            (18,12),(12,13),(13,14),(14,8),(25,19),(12,6),(8,7),(7,1),(8,9),(16,15),
            (16,10),(10,11),(11,17),(1,2),(2,3),(6,0),(10,4),(4,5),(0,1),
        ];
        let mut g = Graph::new();
        for id in 0..36 {
            g.add_node(id);
        }
        for &(a, b) in bidir {
            g.add_bidirectional_edge(a, b, EdgeKind::Basic);
        }
        let mut pinned = HashSet::new();
        pinned.insert(22);
        pinned.insert(14);
        (g, pinned)
    }

    /// Same 6x6 maze as `user_reported_two_cycle_graph`, but with an extra edge (34-35)
    /// instead of (0-1) that merges the two cycles into one connected cyclic region
    /// (they now share nodes 22,23,29,35,34) while still being two independent cycles.
    fn user_reported_merged_two_cycle_graph() -> (Graph, HashSet<NodeId>) {
        let bidir: &[(NodeId, NodeId)] = &[
            (21,20),(20,26),(26,27),(21,22),(22,16),(22,23),(22,28),(28,34),(34,33),
            (26,25),(23,29),(29,35),(33,27),(33,32),(32,31),(31,30),(30,24),(24,18),
            (18,12),(12,13),(13,14),(14,8),(25,19),(12,6),(8,7),(7,1),(8,9),(16,15),
            (16,10),(10,11),(11,17),(1,2),(2,3),(6,0),(10,4),(4,5),(34,35),
        ];
        let mut g = Graph::new();
        for id in 0..36 {
            g.add_node(id);
        }
        for &(a, b) in bidir {
            g.add_bidirectional_edge(a, b, EdgeKind::Basic);
        }
        let mut pinned = HashSet::new();
        pinned.insert(22);
        pinned.insert(14);
        (g, pinned)
    }

    #[test]
    fn real_maze_merged_cycles_have_two_cycles_in_one_region() {
        let (g, pinned) = user_reported_merged_two_cycle_graph();
        let nav = build_nav_graph_pinned(&g, &pinned);
        let analytics = compute_graph_analytics(&nav);


        assert_eq!(analytics.cycle_region_count, 1, "the two cycles now share nodes — one region");
        assert_eq!(analytics.cycle_count, 2, "still two independent cycles (beta_1 = E - V + C)");
    }

    #[test]
    fn real_maze_two_disjoint_simple_cycles_have_two_cycle_regions() {
        let (g, pinned) = user_reported_two_cycle_graph();
        let nav = build_nav_graph_pinned(&g, &pinned);
        let analytics = compute_graph_analytics(&nav);

        assert_eq!(analytics.cycle_count, 2, "two independent simple cycles");
        assert_eq!(analytics.cycle_region_count, 2, "the two cycles share no node — must be 2 regions");
    }

    #[test]
    fn two_disjoint_bowtie_clusters_have_nonempty_pure_cycle_core() {
        let g = two_bowtie_clusters();
        let nav = build_nav_graph(&g);
        let analytics = compute_graph_analytics(&nav);

        // No bridges: every node has degree >= 2 inside its bowtie, shared edge is on two cycles.
        assert_eq!(analytics.pure_cycle_nav_nodes.len(), 8, "no bridges in a bowtie — all nodes are pure-cycle");
        assert!(!analytics.pure_cycle_edge_indices.is_empty());
    }

    #[test]
    fn trim_dead_ends_strips_a_linear_chain_entirely() {
        // 0 - 1 - 2 - 3: a plain path, no cycle anywhere — every node is a dead end.
        let mut g = Graph::new();
        for id in 0..4 { g.add_node(id); }
        g.add_bidirectional_edge(0, 1, EdgeKind::Basic);
        g.add_bidirectional_edge(1, 2, EdgeKind::Basic);
        g.add_bidirectional_edge(2, 3, EdgeKind::Basic);
        let nav = build_nav_graph(&g);

        let survivors = trim_dead_ends(&nav);
        assert!(survivors.iter().all(|&s| !s), "a tree has no nodes on a cycle");
    }

    #[test]
    fn trim_dead_ends_keeps_a_simple_cycle_intact() {
        // 0 -> 1 -> 2 -> 0: every node has two distinct undirected connections.
        let mut g = Graph::new();
        for id in 0..3 { g.add_node(id); }
        g.add_edge(0, 1, EdgeKind::Basic);
        g.add_edge(1, 2, EdgeKind::Basic);
        g.add_edge(2, 0, EdgeKind::Basic);
        let nav = build_nav_graph(&g);

        let survivors = trim_dead_ends(&nav);
        assert!(survivors.iter().all(|&s| s), "no dead ends on a pure cycle");
    }

    #[test]
    fn trim_dead_ends_strips_a_tail_hanging_off_a_cycle() {
        // Cycle 0-1-2-0, plus a dangling branch node 3 hanging off 2 (a single edge, not a
        // 2-degree corridor, so it survives nav-graph compression as its own nav-node).
        let mut g = Graph::new();
        for id in 0..4 { g.add_node(id); }
        g.add_edge(0, 1, EdgeKind::Basic);
        g.add_edge(1, 2, EdgeKind::Basic);
        g.add_edge(2, 0, EdgeKind::Basic);
        g.add_bidirectional_edge(2, 3, EdgeKind::Basic);
        let nav = build_nav_graph(&g);

        let survivors = trim_dead_ends(&nav);
        assert!(survivors[0] && survivors[1] && survivors[2], "cycle nodes survive");
        assert!(!survivors[3], "branch node is trimmed");
    }

    #[test]
    fn cycle_through_a_single_one_way_edge_is_pure() {
        // 0 <-> 1 <-> 2 -> 0 (one-way close). Whole ring is a real cycle even though
        // edge 2->0 has no reverse. Each ring node gets a dangling branch (node 3/4/5) so
        // it keeps degree >= 3 and survives nav-graph corridor compression as its own node.
        let mut g = Graph::new();
        for id in 0..6 { g.add_node(id); }
        g.add_bidirectional_edge(0, 1, EdgeKind::Basic);
        g.add_bidirectional_edge(1, 2, EdgeKind::Basic);
        g.add_edge(2, 0, EdgeKind::Basic); // one-way close
        g.add_bidirectional_edge(0, 3, EdgeKind::Basic);
        g.add_bidirectional_edge(1, 4, EdgeKind::Basic);
        g.add_bidirectional_edge(2, 5, EdgeKind::Basic);
        let nav = build_nav_graph(&g);
        let analytics = compute_graph_analytics(&nav);

        assert_eq!(analytics.pure_cycle_nav_nodes.len(), 3, "all 3 ring nodes lie on the cycle");
        assert_eq!(analytics.cycle_count, 1, "single ring = one independent cycle");
    }

    #[test]
    fn cycle_through_two_one_way_edges_sharing_a_node_is_pure() {
        // 0 -> 1 (one-way), 1 <-> 2, 2 -> 0 (one-way). Two one-way edges meet at node 0
        // (one leaves it, one enters it) but the ring is still a single real cycle.
        let mut g = Graph::new();
        for id in 0..3 { g.add_node(id); }
        g.add_edge(0, 1, EdgeKind::Basic); // one-way
        g.add_bidirectional_edge(1, 2, EdgeKind::Basic);
        g.add_edge(2, 0, EdgeKind::Basic); // one-way
        let nav = build_nav_graph(&g);
        let analytics = compute_graph_analytics(&nav);

        assert_eq!(analytics.pure_cycle_nav_nodes.len(), 3, "all 3 nodes lie on the ring");
        assert_eq!(analytics.cycle_count, 1, "single ring = one independent cycle");
    }

    #[test]
    fn cycle_through_two_nonadjacent_one_way_edges_is_pure() {
        // A1->A2<->A3<->A4->A5<->A1: a 5-node ring where two one-way edges (A1->A2, A4->A5)
        // are not adjacent to each other, separated by bidirectional legs on both sides.
        // Each ring node gets a dangling branch (nodes 5..9) to survive corridor compression.
        let mut g = Graph::new();
        for id in 0..10 { g.add_node(id); } // A1=0 A2=1 A3=2 A4=3 A5=4, branches=5..9
        g.add_edge(0, 1, EdgeKind::Basic); // A1->A2 one-way
        g.add_bidirectional_edge(1, 2, EdgeKind::Basic); // A2<->A3
        g.add_bidirectional_edge(2, 3, EdgeKind::Basic); // A3<->A4
        g.add_edge(3, 4, EdgeKind::Basic); // A4->A5 one-way
        g.add_bidirectional_edge(4, 0, EdgeKind::Basic); // A5<->A1
        for (ring_node, branch) in (0..5).zip(5..10) {
            g.add_bidirectional_edge(ring_node, branch, EdgeKind::Basic);
        }
        let nav = build_nav_graph(&g);
        let analytics = compute_graph_analytics(&nav);

        assert_eq!(analytics.pure_cycle_nav_nodes.len(), 5, "all 5 ring nodes lie on the cycle");
        assert_eq!(analytics.cycle_count, 1, "single ring = one independent cycle");
    }

    #[test]
    fn opposite_one_ways_converging_on_one_node_form_no_cycle() {
        // A1->A2<-A3-A4-A1: A1<->A4<->A3 bidirectional, plus A1->A2 and A3->A2 one-way.
        // A2 only receives — no edge leaves it — so it's a dead end and no cycle exists.
        let mut g = Graph::new();
        for id in 0..4 { g.add_node(id); } // A1=0 A2=1 A3=2 A4=3
        g.add_edge(0, 1, EdgeKind::Basic); // A1->A2 one-way
        g.add_edge(2, 1, EdgeKind::Basic); // A3->A2 one-way
        g.add_bidirectional_edge(2, 3, EdgeKind::Basic); // A3<->A4
        g.add_bidirectional_edge(3, 0, EdgeKind::Basic); // A4<->A1
        let nav = build_nav_graph(&g);
        let analytics = compute_graph_analytics(&nav);

        assert!(analytics.pure_cycle_nav_nodes.is_empty(), "convergent one-ways form no cycle");
        assert_eq!(analytics.cycle_count, 0);
    }

    #[test]
    fn opposite_one_ways_into_a_connected_pair_form_no_cycle() {
        // A1->A2-A3-A4<-A5-A1: A1<->A5 and A2<->A3 bidirectional, A1->A2 and A5->A4 one-way.
        // A2 and A4 each only receive from their one-way edge with no way back to A1/A5 — no cycle.
        let mut g = Graph::new();
        for id in 0..5 { g.add_node(id); } // A1=0 A2=1 A3=2 A4=3 A5=4
        g.add_edge(0, 1, EdgeKind::Basic); // A1->A2 one-way
        g.add_bidirectional_edge(1, 2, EdgeKind::Basic); // A2<->A3
        g.add_edge(4, 3, EdgeKind::Basic); // A5->A4 one-way
        g.add_bidirectional_edge(0, 4, EdgeKind::Basic); // A1<->A5
        let nav = build_nav_graph(&g);
        let analytics = compute_graph_analytics(&nav);

        assert!(analytics.pure_cycle_nav_nodes.is_empty(), "convergent one-ways form no cycle");
        assert_eq!(analytics.cycle_count, 0);
    }

    #[test]
    fn parallel_corridors_between_same_junction_pair_compress_to_two_nav_edges() {
        // Two junctions A=0, B=1 (each also has an extra branch to stay degree>=3 and
        // avoid being corridor-compressed themselves). Two distinct bidirectional corridor
        // chains connect A and B: a direct edge, and a detour through 4,5 (degree-2,
        // symmetric in/out — true corridor nodes, collapse into a single nav-edge).
        // Net result: 2 junctions, 2 parallel nav-edges between them — exactly the "direct
        // path plus a longer detour" shape called out in the e_core hybrid-counting comment.
        let mut g = Graph::new();
        for id in 0..6 { g.add_node(id); } // A=0 B=1 branchA=2 branchB=3 detour=4,5
        g.add_bidirectional_edge(0, 1, EdgeKind::Basic); // A<->B direct
        g.add_bidirectional_edge(0, 4, EdgeKind::Basic);
        g.add_bidirectional_edge(4, 5, EdgeKind::Basic);
        g.add_bidirectional_edge(5, 1, EdgeKind::Basic); // A<->B via detour 4,5
        g.add_bidirectional_edge(0, 2, EdgeKind::Basic); // branch off A
        g.add_bidirectional_edge(1, 3, EdgeKind::Basic); // branch off B
        let nav = build_nav_graph(&g);
        let analytics = compute_graph_analytics(&nav);

        assert_eq!(analytics.node_count, 4, "detour nodes 4,5 compress away, A,B,branchA,branchB survive");
        assert_eq!(analytics.edge_count, 4, "A-B direct, A-B detour, A-branchA, B-branchB are 4 distinct corridors");
        assert_eq!(analytics.pure_cycle_nav_nodes.len(), 2, "detour nodes 4,5 compress away, only A,B survive as junctions");
        assert_eq!(analytics.cycle_count, 1, "direct edge + detour = one independent cycle");
    }

    #[test]
    fn two_independent_return_paths_from_a_junction_count_as_two_cycles() {
        // Junctions A=0, B=1, plus branch nodes C=2, D=3 (no compression here — every node
        // already has degree >= 3 or is on a one-way leg, none are symmetric corridor nodes).
        // A->B direct, then two independent one-way return legs B->C->A and B->D->A sharing
        // only the A->B edge. Two distinct return paths from a shared fork = two independent
        // cycles, not one (must not be deduped into a single ring or double-counted as 3).
        let mut g = Graph::new();
        for id in 0..4 { g.add_node(id); } // A=0 B=1 C=2 D=3
        g.add_edge(0, 1, EdgeKind::Basic); // A->B direct, one-way
        g.add_edge(1, 2, EdgeKind::Basic); // B->C
        g.add_edge(2, 0, EdgeKind::Basic); // C->A
        g.add_edge(1, 3, EdgeKind::Basic); // B->D
        g.add_edge(3, 0, EdgeKind::Basic); // D->A
        let nav = build_nav_graph(&g);
        let analytics = compute_graph_analytics(&nav);

        assert_eq!(analytics.cycle_count, 2, "two distinct return corridors = two independent cycles");
    }
}
