use std::collections::{HashMap, HashSet, VecDeque};
use super::nav::{NavEdge, NavGraph, NavNodeId};

/// Undirected connected components of the nav-graph (NavNodeId domain).
/// Built by DSU ignoring edge direction and self-loops.
pub struct NavUndirectedCc {
    /// node_component[nav_node_id] = component_id
    pub node_component: Vec<usize>,
    pub component_count: usize,
    /// Number of nav-nodes in each component.
    pub component_sizes: Vec<usize>,
}

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

fn build_nav_undirected_cc(nav: &NavGraph) -> NavUndirectedCc {
    let n = nav.nodes.len();
    let mut dsu = Dsu::new(n);

    for edge in nav.edges() {
        if edge.from != edge.to {
            dsu.union(edge.from, edge.to);
        }
    }

    let mut root_to_comp: HashMap<usize, usize> = HashMap::new();
    let mut comp_count = 0usize;
    let mut node_component = vec![0usize; n];

    for i in 0..n {
        let root = dsu.find(i);
        let comp_id = *root_to_comp.entry(root).or_insert_with(|| {
            let id = comp_count;
            comp_count += 1;
            id
        });
        node_component[i] = comp_id;
    }

    let mut component_sizes = vec![0usize; comp_count];
    for &c in &node_component {
        component_sizes[c] += 1;
    }

    NavUndirectedCc { node_component, component_count: comp_count, component_sizes }
}

/// Iterative Tarjan SCC on NavGraph (usize node ids).
/// Returns list of SCCs; each SCC is a Vec of NavNodeIds.
fn tarjan_nav_scc(nav: &NavGraph) -> Vec<Vec<NavNodeId>> {
    let n = nav.nodes.len();
    let mut index_of = vec![usize::MAX; n];
    let mut lowlink = vec![0usize; n];
    let mut on_stack = vec![false; n];
    let mut stack: Vec<NavNodeId> = Vec::new();
    let mut counter = 0usize;
    let mut components: Vec<Vec<NavNodeId>> = Vec::new();

    // work stack: (node, edge_index_into_outgoing)
    let mut work: Vec<(NavNodeId, usize)> = Vec::new();

    for start in 0..n {
        if index_of[start] != usize::MAX { continue; }

        index_of[start] = counter;
        lowlink[start] = counter;
        counter += 1;
        stack.push(start);
        on_stack[start] = true;
        work.push((start, 0));

        while let Some((v, ni)) = work.last_mut() {
            let v = *v;
            let outgoing: Vec<NavNodeId> = nav.outgoing_edges(v).map(|e| e.to).collect();

            if *ni < outgoing.len() {
                let w = outgoing[*ni];
                *ni += 1;

                if index_of[w] == usize::MAX {
                    index_of[w] = counter;
                    lowlink[w] = counter;
                    counter += 1;
                    stack.push(w);
                    on_stack[w] = true;
                    work.push((w, 0));
                } else if on_stack[w] {
                    lowlink[v] = lowlink[v].min(index_of[w]);
                }
            } else {
                work.pop();
                if let Some(&(parent, _)) = work.last() {
                    lowlink[parent] = lowlink[parent].min(lowlink[v]);
                }
                if lowlink[v] == index_of[v] {
                    let mut scc = Vec::new();
                    loop {
                        let w = stack.pop().unwrap();
                        on_stack[w] = false;
                        scc.push(w);
                        if w == v { break; }
                    }
                    components.push(scc);
                }
            }
        }
    }

    components
}

/// Find shortest directed cycle reachable from any node in `scc_nodes` using BFS.
/// Returns cycle length in edges, or None if no cycle found (shouldn't happen for SCC size>1).
fn min_cycle_in_scc(nav: &NavGraph, scc_nodes: &[NavNodeId]) -> Option<usize> {
    let scc_set: HashSet<NavNodeId> = scc_nodes.iter().copied().collect();
    let mut global_min: Option<usize> = None;

    for &start in scc_nodes {
        // BFS from start, staying within SCC, find shortest path back to start.
        let mut dist = HashMap::new();
        dist.insert(start, 0usize);
        let mut queue = VecDeque::new();

        for edge in nav.outgoing_edges(start) {
            if scc_set.contains(&edge.to) && edge.to != start {
                if !dist.contains_key(&edge.to) {
                    dist.insert(edge.to, 1);
                    queue.push_back(edge.to);
                }
            } else if edge.to == start {
                // Self-loop (rare in nav-graph but possible)
                global_min = Some(global_min.map_or(1, |m: usize| m.min(1)));
            }
        }

        while let Some(cur) = queue.pop_front() {
            let cur_dist = dist[&cur];
            for edge in nav.outgoing_edges(cur) {
                if !scc_set.contains(&edge.to) { continue; }
                if edge.to == start {
                    let cycle_len = cur_dist + 1;
                    global_min = Some(global_min.map_or(cycle_len, |m| m.min(cycle_len)));
                    // Found shortest cycle through this start — no need to continue from here
                    break;
                }
                if !dist.contains_key(&edge.to) {
                    dist.insert(edge.to, cur_dist + 1);
                    queue.push_back(edge.to);
                }
            }
        }
    }

    global_min
}

/// Find nav-nodes participating in real directed cycles (no immediate U-turn allowed).
/// Uses edge-state graph: state = (node, incoming_edge_idx).
/// Transition (v, e_in) → (w, e_out) allowed if e_out is not the reverse of e_in.
/// A real cycle exists iff there is an SCC of size > 1 in the edge-state graph.
/// Returns the set of nav-node ids that appear in any such cycle.
fn build_cyclic_core(nav: &NavGraph) -> HashSet<NavNodeId> {
    // State: (nav_node, incoming_edge_idx). Plus one "start" state per node: (node, usize::MAX).
    // state_id for (node, edge) encoded as: edge_idx * n + node (edge_idx < num_edges).
    // "entry" state (no incoming edge): num_edges * n + node.
    let n = nav.nodes.len();
    let edges: Vec<&NavEdge> = nav.edges().collect();
    let e = edges.len();
    // Total states: e * n + n = (e+1)*n.
    // Guard against combinatorial explosion on large nav-graphs.
    let total_states = (e + 1).saturating_mul(n);
    if total_states > 500_000 {
        return HashSet::new();
    }

    // state = edge_idx * n + node, or e * n + node for entry states.
    let state = |node: NavNodeId, edge_idx: usize| -> usize { edge_idx * n + node };
    let entry_state = |node: NavNodeId| -> usize { e * n + node };

    // Build adjacency: for each state, list of successor states.
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); total_states];

    // Entry states → first edge states (no restriction on first edge).
    for v in 0..n {
        for (out_idx, out_edge) in edges.iter().enumerate() {
            if out_edge.from == v && out_edge.to != v {
                adj[entry_state(v)].push(state(out_edge.to, out_idx));
            }
        }
    }

    // Edge states → next edge states (forbid immediate reverse).
    for (in_idx, in_edge) in edges.iter().enumerate() {
        let v = in_edge.to;
        if in_edge.from == v { continue; } // self-loop, skip
        let s = state(v, in_idx);
        for (out_idx, out_edge) in edges.iter().enumerate() {
            if out_edge.from != v || out_edge.to == v { continue; }
            // Forbid reverse: if in_edge.reverse_edge == Some(out_idx), skip.
            if in_edge.reverse_edge == Some(out_idx) { continue; }
            adj[s].push(state(out_edge.to, out_idx));
        }
    }

    // Tarjan SCC on edge-state graph.
    let mut index_of = vec![usize::MAX; total_states];
    let mut lowlink = vec![0usize; total_states];
    let mut on_stack = vec![false; total_states];
    let mut stack: Vec<usize> = Vec::new();
    let mut counter = 0usize;
    let mut cyclic_states: HashSet<usize> = HashSet::new();
    let mut work: Vec<(usize, usize)> = Vec::new();

    for start in 0..total_states {
        if adj[start].is_empty() && start < e * n { continue; } // skip empty non-entry states
        if index_of[start] != usize::MAX { continue; }

        index_of[start] = counter;
        lowlink[start] = counter;
        counter += 1;
        stack.push(start);
        on_stack[start] = true;
        work.push((start, 0));

        while let Some((v, ni)) = work.last_mut() {
            let v = *v;
            if *ni < adj[v].len() {
                let w = adj[v][*ni];
                *ni += 1;
                if index_of[w] == usize::MAX {
                    index_of[w] = counter;
                    lowlink[w] = counter;
                    counter += 1;
                    stack.push(w);
                    on_stack[w] = true;
                    work.push((w, 0));
                } else if on_stack[w] {
                    lowlink[v] = lowlink[v].min(index_of[w]);
                }
            } else {
                work.pop();
                if let Some(&(parent, _)) = work.last() {
                    lowlink[parent] = lowlink[parent].min(lowlink[v]);
                }
                if lowlink[v] == index_of[v] {
                    let mut scc: Vec<usize> = Vec::new();
                    loop {
                        let w = stack.pop().unwrap();
                        on_stack[w] = false;
                        scc.push(w);
                        if w == v { break; }
                    }
                    if scc.len() > 1 {
                        for s in scc { cyclic_states.insert(s); }
                    }
                }
            }
        }
    }

    // Extract nav-node ids from cyclic edge-states.
    let mut result: HashSet<NavNodeId> = HashSet::new();
    for s in cyclic_states {
        if s >= e * n { continue; } // entry states don't count
        let node = s % n;
        result.insert(node);
        // Also include the source node of the incoming edge.
        let edge_idx = s / n;
        result.insert(edges[edge_idx].from);
    }
    result
}

/// Global graph analytics computed on the nav-graph.
#[derive(Debug, Clone)]
pub struct GraphAnalytics {
    pub node_count: usize,
    pub edge_count: usize,
    /// Number of physical connectivity regions (WCC on base graph).
    pub component_count: usize,
    /// Number of independent cycles (E - V + C on cyclic core).
    pub cycle_count: usize,
    /// Number of connected cyclic regions (WCC on cyclic core subgraph).
    pub cycle_region_count: usize,
    /// nav_node_id → wcc_id (for RegionsRenderer coloring).
    pub nav_node_scc: Vec<usize>,
    /// SCCs ordered by id.
    pub scc_components: Vec<Vec<NavNodeId>>,
    /// Nav-node ids in the cyclic core.
    pub cyclic_core_nav_nodes: HashSet<NavNodeId>,
}

impl GraphAnalytics {
    pub fn empty() -> Self {
        GraphAnalytics {
            node_count: 0,
            edge_count: 0,
            component_count: 0,
            cycle_count: 0,
            cycle_region_count: 0,
            nav_node_scc: Vec::new(),
            cyclic_core_nav_nodes: HashSet::new(),
            scc_components: Vec::new(),
        }
    }
}

/// Compute graph analytics on the nav-graph.
/// Components = directed SCC. Cycle metrics based on cyclic SCCs (size > 1).
pub fn compute_graph_analytics(nav: &NavGraph) -> GraphAnalytics {
    let n = nav.nodes.len();
    if n == 0 {
        return GraphAnalytics::empty();
    }
    // Unique undirected edges (no self-loops) — for edge_count metric only.
    let undirected_edges: HashSet<(NavNodeId, NavNodeId)> = nav.edges()
        .filter(|e| e.from != e.to)
        .map(|e| (e.from.min(e.to), e.from.max(e.to)))
        .collect();
    let edge_count = undirected_edges.len();

    // WCC — physical connectivity (islands separated by walls), drives component_count and overlay coloring.
    let wcc = build_nav_undirected_cc(nav);
    let component_count = wcc.component_count;

    // nav_node_scc[nav_node_id] = wcc_id (used for RegionsRenderer coloring)
    let nav_node_scc = wcc.node_component.clone();

    // Directed SCC — kept for potential future use.
    let scc_components = tarjan_nav_scc(nav);

    // Cyclic core — nodes/edges participating in real directed cycles (no U-turns).
    let cyclic_core_nav_nodes = build_cyclic_core(nav);

    // Cycle metrics on cyclic core subgraph.
    // cycle_count = E_core - V_core + C_core (number of independent cycles).
    // cycle_region_count = number of connected components in cyclic core (undirected).
    let (cycle_count, cycle_region_count) = if cyclic_core_nav_nodes.is_empty() {
        (0, 0)
    } else {
        let core_nodes: Vec<NavNodeId> = cyclic_core_nav_nodes.iter().copied().collect();
        let v_core = core_nodes.len();
        // Undirected edges within core (deduplicated).
        let e_core: HashSet<(NavNodeId, NavNodeId)> = nav.edges()
            .filter(|e| cyclic_core_nav_nodes.contains(&e.from) && cyclic_core_nav_nodes.contains(&e.to) && e.from != e.to)
            .map(|e| (e.from.min(e.to), e.from.max(e.to)))
            .collect();
        let e_core = e_core.len();
        // WCC on core subgraph via DSU.
        let node_to_idx: HashMap<NavNodeId, usize> = core_nodes.iter().enumerate().map(|(i, &v)| (v, i)).collect();
        let mut dsu = Dsu::new(v_core);
        for edge in nav.edges() {
            if cyclic_core_nav_nodes.contains(&edge.from) && cyclic_core_nav_nodes.contains(&edge.to) && edge.from != edge.to {
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
        component_count,
        cycle_count,
        cycle_region_count,
        nav_node_scc,
        scc_components,
        cyclic_core_nav_nodes,
    }
}
