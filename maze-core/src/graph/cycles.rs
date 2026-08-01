use std::collections::HashSet;
use crate::ids::EdgeId;
use super::Graph;
use super::nav::{NavGraph, NavNodeId, NavEdge};

/// Canonical undirected index for dedup: the lower of an edge's own index and its
/// `reverse_edge`'s, so a bidirectional corridor's forward and backward edge always
/// map to the same value regardless of which one a cycle happened to use. Applies equally
/// to self-loop CW/CCW pairs (linked via `reverse_edge` by the same path-reversal mechanism
/// `link_reverse_edges` uses for ordinary corridors — no special case needed).
fn canonical_index(edge: &NavEdge, idx: usize) -> usize {
    match edge.reverse_edge {
        Some(rev) => idx.min(rev),
        None => idx,
    }
}

/// Find nodes/edges partitioned into strongly-connected components, restricted to `nodes`.
/// Iterative to avoid stack overflow.
fn strongly_connected_components(
    adjacency: &[Vec<(usize, NavNodeId)>],
    nodes: &HashSet<NavNodeId>,
) -> Vec<Vec<NavNodeId>> {
    struct State {
        index: usize,
        lowlink: usize,
    }

    let mut index_counter = 0usize;
    let mut stack: Vec<NavNodeId> = Vec::new();
    let mut on_stack: HashSet<NavNodeId> = HashSet::new();
    let mut state: std::collections::HashMap<NavNodeId, State> = std::collections::HashMap::new();
    let mut components: Vec<Vec<NavNodeId>> = Vec::new();
    let mut work: Vec<(NavNodeId, usize)> = Vec::new();

    let mut sorted_nodes: Vec<NavNodeId> = nodes.iter().copied().collect();
    sorted_nodes.sort_unstable();

    let mut neighbor_cache: std::collections::HashMap<NavNodeId, Vec<NavNodeId>> = std::collections::HashMap::new();

    for &root in &sorted_nodes {
        if state.contains_key(&root) {
            continue;
        }
        state.insert(root, State { index: index_counter, lowlink: index_counter });
        index_counter += 1;
        stack.push(root);
        on_stack.insert(root);
        work.push((root, 0));

        while !work.is_empty() {
            let (v, ni) = *work.last().unwrap();
            let neighbors = neighbor_cache.entry(v).or_insert_with(|| {
                adjacency[v].iter()
                    .map(|&(_, to)| to)
                    .filter(|to| nodes.contains(to))
                    .collect()
            });

            if ni < neighbors.len() {
                work.last_mut().unwrap().1 += 1;
                let w = neighbors[ni];
                if !state.contains_key(&w) {
                    state.insert(w, State { index: index_counter, lowlink: index_counter });
                    index_counter += 1;
                    stack.push(w);
                    on_stack.insert(w);
                    work.push((w, 0));
                } else if on_stack.contains(&w) {
                    let idx_w = state[&w].index;
                    let s_v = state.get_mut(&v).unwrap();
                    s_v.lowlink = s_v.lowlink.min(idx_w);
                }
            } else {
                let is_root = state[&v].lowlink == state[&v].index;
                if is_root {
                    let mut component = Vec::new();
                    loop {
                        let w = stack.pop().unwrap();
                        on_stack.remove(&w);
                        component.push(w);
                        if w == v {
                            break;
                        }
                    }
                    components.push(component);
                }
                work.pop();
                if let Some(&(parent, _)) = work.last() {
                    let ll_v = state[&v].lowlink;
                    let s_parent = state.get_mut(&parent).unwrap();
                    s_parent.lowlink = s_parent.lowlink.min(ll_v);
                }
            }
        }
    }

    components
}

/// One physical connection inside an SCC: either a real nav-edge (bidirectional or one-way)
/// or a fictitious reverse added on top of a one-way edge to make the working graph fully
/// bidirectional for spanning-tree purposes (see `find_fundamental_cycles`'s doc comment).
#[derive(Clone, Copy)]
struct Link {
    /// Nav-edge index to walk for this link's direction: the real edge whose own `from`/`to`
    /// matches this `Link`'s `from`/`to`, or — for a fictitious link — the mirrored one-way
    /// edge's own index (fictitious links have no `NavEdge` of their own to walk).
    edge_idx: usize,
    /// Canonical id of the physical connection this link belongs to (`canonical_index` of
    /// either direction's real edge) — identical for both directions of the same connection,
    /// used for tree/non-tree membership regardless of which direction was walked to reach it.
    connection: usize,
    from: NavNodeId,
    to: NavNodeId,
    /// True if this link is the fictitious reverse of a one-way edge — walking it does NOT
    /// correspond to a real directed traversal; `edge_idx`/`from`/`to` describe the direction
    /// this fictitious link points (opposite of the real edge).
    fictitious: bool,
    /// True if this link's underlying physical connection has a real edge in BOTH directions
    /// (a bidirectional corridor) — false for a one-way connection's single real direction (or
    /// its fictitious mirror). Used to prefer bidirectional real links over one-way real links
    /// when building the spanning tree: a one-way connection picked as a tree edge can only ever
    /// be walked forward, so if the tree later needs to cross it backward (an LCA tree-path
    /// requiring child->parent on that edge), no real reverse exists — see `build_spanning_tree`.
    bidirectional: bool,
}

/// Build per-SCC adjacency of `Link`s: one entry per physical connection (an edge and its
/// `reverse_edge` count once — via `canonical_index` — never as two separate links), plus one
/// fictitious reverse `Link` for every one-way edge (no `reverse_edge`) so the graph used for
/// spanning-tree construction is fully bidirectional. Real links are listed before fictitious
/// ones for each node, so a priority-order neighbor scan naturally prefers them.
fn build_scc_links(
    edges: &[&NavEdge],
    scc_set: &HashSet<NavNodeId>,
) -> Vec<Vec<Link>> {
    let n = edges.iter().map(|e| e.from.max(e.to)).max().map(|m| m + 1).unwrap_or(0);
    let mut real: Vec<Vec<Link>> = vec![Vec::new(); n];
    let mut fictitious: Vec<Vec<Link>> = vec![Vec::new(); n];
    let mut seen_canonical: HashSet<usize> = HashSet::new();

    for (idx, edge) in edges.iter().enumerate() {
        if !scc_set.contains(&edge.from) || !scc_set.contains(&edge.to) {
            continue;
        }
        let canon = canonical_index(edge, idx);
        if canon != idx {
            // This edge's reverse is the canonical representative; skip, the reverse's own
            // iteration (or the fictitious-edge pass below) already covers this connection.
            continue;
        }
        if !seen_canonical.insert(canon) {
            continue;
        }
        let bidirectional = edge.reverse_edge.is_some();
        real[edge.from].push(Link { edge_idx: idx, connection: canon, from: edge.from, to: edge.to, fictitious: false, bidirectional });

        match edge.reverse_edge {
            Some(rev) => {
                // Bidirectional: the reverse nav-edge is the real link walking to->from.
                real[edge.to].push(Link { edge_idx: rev, connection: canon, from: edge.to, to: edge.from, fictitious: false, bidirectional: true });
            }
            None => {
                // One-way edge: to->from has no real edge — only a fictitious reverse, so the
                // working graph stays fully bidirectional for spanning-tree purposes.
                fictitious[edge.to].push(Link { edge_idx: idx, connection: canon, from: edge.to, to: edge.from, fictitious: true, bidirectional: false });
            }
        }
    }

    let mut links: Vec<Vec<Link>> = vec![Vec::new(); n];
    for node in 0..n {
        links[node].extend(real[node].iter().copied());
        links[node].extend(fictitious[node].iter().copied());
    }
    links
}

/// Spanning tree over one SCC's `Link`s, built by a three-pass BFS: bidirectional real links
/// across the whole frontier first, then one-way real links for whatever remains unvisited, then
/// fictitious links for whatever still remains (only possible when an SCC's connectivity to a
/// node relies on a one-way edge with no real path back — see `find_fundamental_cycles`'s doc
/// comment). Bidirectional links are preferred over one-way ones so a tree edge can always be
/// walked in EITHER direction when a later tree-path needs to cross it backward — a one-way tree
/// edge can only be walked forward, and picking one when a bidirectional alternative existed
/// would force an otherwise-avoidable fictitious step (or, before that was itself handled
/// correctly, silently produce a wrong cycle — see the regression test
/// `bidirectional_real_link_is_preferred_over_one_way_real_link_for_tree_edges`). Returns, per
/// visited node, its parent node and the `Link` used to reach it from the parent (`None` for the
/// root), plus the set of tree connections (by `Link::connection`) for fast non-tree membership
/// testing.
fn build_spanning_tree(
    links: &[Vec<Link>],
    root: NavNodeId,
) -> (std::collections::HashMap<NavNodeId, Option<(NavNodeId, Link)>>, HashSet<usize>) {
    let mut parent: std::collections::HashMap<NavNodeId, Option<(NavNodeId, Link)>> = std::collections::HashMap::new();
    let mut tree_connections: HashSet<usize> = HashSet::new(); // by `connection` — one physical
    // wire is one tree/non-tree slot regardless of which direction (real or fictitious) BFS
    // happened to use to reach it.
    parent.insert(root, None);
    let mut queue: std::collections::VecDeque<NavNodeId> = std::collections::VecDeque::new();
    queue.push_back(root);

    // First pass: bidirectional real links only, across the WHOLE frontier, before one-way or
    // fictitious links are considered — a single-pass BFS mixing tiers would let a lower-tier
    // link discovered early (from a node with no other higher-tier link to that neighbor) claim
    // a node that a higher-tier link from a node visited later in the same pass could have
    // reached instead. Only once every bidirectional-reachable node is settled does a lower tier
    // get to claim the rest.
    while let Some(node) = queue.pop_front() {
        for &link in &links[node] {
            if link.fictitious || !link.bidirectional {
                continue;
            }
            if !parent.contains_key(&link.to) {
                parent.insert(link.to, Some((node, link)));
                tree_connections.insert(link.connection);
                queue.push_back(link.to);
            }
        }
    }

    // Second pass: one-way real links, for nodes still unvisited after the bidirectional pass.
    // Sorted seed order, not raw `HashMap` iteration order — see the third pass below for why.
    let mut seeded: Vec<NavNodeId> = parent.keys().copied().collect();
    seeded.sort_unstable();
    queue.extend(seeded);
    while let Some(node) = queue.pop_front() {
        for &link in &links[node] {
            if link.fictitious || link.bidirectional {
                continue;
            }
            if !parent.contains_key(&link.to) {
                parent.insert(link.to, Some((node, link)));
                tree_connections.insert(link.connection);
                queue.push_back(link.to);
            }
        }
    }

    // Third pass: fictitious links only, for nodes still unvisited (only possible when an SCC's
    // connectivity to that node relies on a one-way edge with no real path back). Sorted, not
    // raw `HashMap` iteration order — that order can influence which fictitious link wins a
    // contested node, and `HashMap`'s randomized per-process hasher would make that choice (and
    // therefore the returned cycle) vary run-to-run for the same maze/seed.
    let mut seeded: Vec<NavNodeId> = parent.keys().copied().collect();
    seeded.sort_unstable();
    queue.extend(seeded);
    while let Some(node) = queue.pop_front() {
        for &link in &links[node] {
            if !link.fictitious {
                continue;
            }
            if !parent.contains_key(&link.to) {
                parent.insert(link.to, Some((node, link)));
                tree_connections.insert(link.connection);
                queue.push_back(link.to);
            }
        }
    }

    (parent, tree_connections)
}

/// Ancestor chain of `node` up to (and including) the tree root, nearest-first.
fn ancestors(
    parent: &std::collections::HashMap<NavNodeId, Option<(NavNodeId, Link)>>,
    mut node: NavNodeId,
) -> Vec<NavNodeId> {
    let mut chain = vec![node];
    while let Some(&Some((p, _))) = parent.get(&node) {
        chain.push(p);
        node = p;
    }
    chain
}

/// The single tree-path walk from `from_node` to `to_node`, as `CycleStep`s: `from_node`'s
/// ancestor chain up to (excluding) the LCA, walked child->parent (reversed `Link`s), followed
/// by `to_node`'s ancestor chain from (excluding) the LCA down to `to_node`, walked
/// parent->child (`Link`s as stored).
fn tree_path(
    edges: &[&NavEdge],
    parent: &std::collections::HashMap<NavNodeId, Option<(NavNodeId, Link)>>,
    from_node: NavNodeId,
    to_node: NavNodeId,
) -> Vec<CycleStep> {
    let from_chain = ancestors(parent, from_node);
    let to_chain = ancestors(parent, to_node);
    let from_set: HashSet<NavNodeId> = from_chain.iter().copied().collect();
    let lca = to_chain.iter().copied().find(|n| from_set.contains(n)).unwrap_or(from_node);

    let mut steps = Vec::new();
    // from_node -> ... -> lca (child->parent, reversed links).
    for &n in &from_chain {
        if n == lca {
            break;
        }
        let Some(Some((_, link))) = parent.get(&n) else { break };
        steps.push(reverse_link(edges, *link));
    }
    // lca -> ... -> to_node (parent->child, links as stored) — walk to_chain from the
    // element just before `lca` down to `to_node`, i.e. reverse of `to_chain` truncated
    // at `lca`.
    let to_prefix: Vec<NavNodeId> = to_chain.iter().copied().take_while(|&n| n != lca).collect();
    for &n in to_prefix.iter().rev() {
        let Some(Some((_, link))) = parent.get(&n) else { break };
        steps.push(if link.fictitious { CycleStep::Fictitious(*link) } else { CycleStep::Real(link.edge_idx) });
    }
    steps
}

/// Fallback for when the tree-path between a non-tree link's endpoints is not direction-valid
/// (see `find_fundamental_cycles`'s doc comment): a direct BFS over REAL links only, from
/// `from_node` to `to_node`, restricted to `scc_set`. Always succeeds — every node in an SCC is
/// reachable from every other via real directed edges alone, by definition — so this never
/// returns `None` when called from `find_fundamental_cycles`.
///
/// `exclude_connection` must be the non-tree link's own `connection` — without excluding it, the
/// BFS is free to walk straight back over that same physical connection's own reverse edge,
/// producing a degenerate 2-step "there and back" cycle (an edge immediately followed by its own
/// `reverse_edge`) instead of a real distinct cycle. This is exactly the trivial-reverse-pair
/// case `canonical_index`-based dedup in `build_scc_links` otherwise structurally prevents — the
/// BFS must honor that same exclusion, since it walks `links` directly rather than going through
/// the tree/non-tree partition.
fn real_path_bfs(
    links: &[Vec<Link>],
    scc_set: &HashSet<NavNodeId>,
    from_node: NavNodeId,
    to_node: NavNodeId,
    exclude_connection: usize,
) -> Option<Vec<usize>> {
    if from_node == to_node {
        return Some(Vec::new());
    }
    let mut prev: std::collections::HashMap<NavNodeId, (NavNodeId, usize)> = std::collections::HashMap::new();
    let mut queue: std::collections::VecDeque<NavNodeId> = std::collections::VecDeque::new();
    queue.push_back(from_node);
    while let Some(node) = queue.pop_front() {
        if node == to_node {
            let mut steps = Vec::new();
            let mut cur = to_node;
            while cur != from_node {
                let (p, edge_idx) = prev[&cur];
                steps.push(edge_idx);
                cur = p;
            }
            steps.reverse();
            return Some(steps);
        }
        for &link in &links[node] {
            if link.fictitious || !scc_set.contains(&link.to) || link.connection == exclude_connection {
                continue;
            }
            if link.to != from_node && !prev.contains_key(&link.to) {
                prev.insert(link.to, (node, link.edge_idx));
                queue.push_back(link.to);
            }
        }
    }
    None
}

/// One step of a fundamental cycle's walk: either a real nav-edge index walked in its own
/// stored direction, or a fictitious link (to be resolved/validated in
/// `resolve_fundamental_cycle`).
#[derive(Clone, Copy)]
enum CycleStep {
    Real(usize),
    Fictitious(Link),
}

/// Turn a raw fundamental cycle (as `CycleStep`s, in walk order) into a real directed cycle
/// (nav-edge indices). The `None` branch (a fictitious step outside position 0) means the
/// straight LCA tree-path is not direction-valid — see `find_fundamental_cycles`'s doc comment
/// for why this can genuinely happen even with an all-real tree, and how the caller recovers via
/// `real_path_bfs` instead of dropping the cycle.
fn resolve_fundamental_cycle(steps: &[CycleStep], non_tree_is_fictitious: bool) -> Option<Vec<usize>> {
    let mut result = Vec::with_capacity(steps.len());
    for (i, step) in steps.iter().enumerate() {
        match step {
            CycleStep::Real(idx) => result.push(*idx),
            CycleStep::Fictitious(link) => {
                // The non-tree edge itself, if fictitious, is walked in the fictitious
                // direction by construction — that's always resolvable to the real one-way
                // edge (see caller). Any OTHER fictitious link (inside the tree-path portion)
                // means the walk needs the one-way edge backwards — invalid.
                if non_tree_is_fictitious && i == 0 {
                    result.push(link.edge_idx);
                } else {
                    return None;
                }
            }
        }
    }
    Some(result)
}

/// Find the fundamental cycle basis of `nav`: at most one cycle per SCC's non-tree edge,
/// instead of every simple cycle (Johnson's algorithm) including composite unions of
/// independent loops. See `Specs/graph-analytics.md` for the full rationale.
///
/// **Construction**: per SCC, build a spanning tree over physical connections (an edge and
/// its `reverse_edge` count as one connection). One-way edges (no `reverse_edge`) get a
/// temporary fictitious reverse so the tree-building graph is fully bidirectional; the tree is
/// built in two passes (`build_spanning_tree`) — real connections across the whole frontier
/// first, fictitious ones only for whatever is left unvisited afterward. Each non-tree
/// connection then closes exactly one fundamental cycle: itself plus the tree-path between its
/// endpoints — exactly the SCC's topological β₁ (`E_core - V_core + 1`) cycles.
///
/// **Direction validity is always recovered, never silently discarded.** The straight tree-path
/// (LCA-based, `tree_path`) is not always direction-valid on its own — even when every tree edge
/// used is real (no fictitious link involved), the LCA split can require walking one side of the
/// tree child->parent, and a real one-way tree edge has no real reverse to walk that way. When
/// `resolve_fundamental_cycle` detects this (any fictitious step outside position 0),
/// `find_fundamental_cycles` falls back to `real_path_bfs`: a direct real-edges-only BFS between
/// the non-tree link's endpoints, independent of the tree shape. This always succeeds — every
/// node in an SCC is, by definition, reachable from every other node via real directed edges
/// alone — so no cycle is ever dropped, though the fallback path is not guaranteed to be the
/// shortest one available. See `Specs/graph-analytics.md` and the regression tests
/// `discards_are_recovered_via_fallback_bfs_not_dropped` (an 11-node one-way SCC where the LCA
/// tree-path genuinely needs a backward real edge) and
/// `one_way_only_scc_with_two_independent_loops_never_discards` (a smaller case where the
/// fast path already succeeds) for both code paths recovering the full topological β₁.
///
/// **Trivial reverse-pair cycles** (an edge immediately followed by its own `reverse_edge`)
/// cannot occur here: physical connections are deduped up front, so one connection can never
/// be both a tree edge and someone else's non-tree edge.
///
/// **Self-loops** (`from == to`) are handled outside the spanning-tree machinery, same as
/// before: each is its own one-edge cycle, one entry per self-loop edge.
///
/// No length bound, no ordering guarantee on the edges within a returned cycle beyond "a
/// contiguous directed walk that starts and ends at the same nav-node" — callers
/// (`resolve_to_edge_ids`, `tile_length`, `CycleKind::matches`, `cycle_min_distance`) only rely
/// on that contract, not on any particular edge order.
pub(crate) fn find_fundamental_cycles(nav: &NavGraph) -> Vec<Vec<usize>> {
    let edges: Vec<&NavEdge> = nav.edges().collect();
    let n = nav.nodes.len();
    if n == 0 {
        return Vec::new();
    }

    let mut adjacency: Vec<Vec<(usize, NavNodeId)>> = vec![Vec::new(); n];
    for (idx, edge) in edges.iter().enumerate() {
        adjacency[edge.from].push((idx, edge.to));
    }

    let all_nodes: HashSet<NavNodeId> = (0..n).collect();
    let sccs = strongly_connected_components(&adjacency, &all_nodes);
    crate::diag_log!("DIAG find_fundamental_cycles: n={} edges={} sccs={:?}", n, edges.len(), sccs); // DIAG
    for (idx, edge) in edges.iter().enumerate() {
        crate::diag_log!("DIAG edge[{}]: {}->{} rev={:?} path={:?}", idx, edge.from, edge.to, edge.reverse_edge, edge.path); // DIAG
    }

    let mut cycles: Vec<Vec<usize>> = Vec::new();

    for scc in &sccs {
        let scc_set: HashSet<NavNodeId> = scc.iter().copied().collect();
        crate::diag_log!("DIAG --- scc={:?} ---", scc); // DIAG

        if scc_set.len() == 1 {
            let node = scc[0];
            for &(idx, to) in &adjacency[node] {
                if to == node {
                    crate::diag_log!("DIAG self-loop scc: node={} edge_idx={}", node, idx); // DIAG
                    cycles.push(vec![idx]);
                }
            }
            continue;
        }

        let links = build_scc_links(&edges, &scc_set);
        for node in scc.iter().copied() {
            for &link in &links[node] {
                crate::diag_log!("DIAG link node={} -> connection={} from={} to={} edge_idx={} fictitious={}", node, link.connection, link.from, link.to, link.edge_idx, link.fictitious); // DIAG
            }
        }
        let root = *scc.iter().min().unwrap();
        let (parent, tree_connections) = build_spanning_tree(&links, root);
        crate::diag_log!("DIAG root={} tree_connections={:?}", root, tree_connections); // DIAG
        for (&node, p) in parent.iter() {
            crate::diag_log!("DIAG parent[{}]={:?}", node, p.map(|(pn, l)| (pn, l.connection, l.from, l.to, l.fictitious))); // DIAG
        }

        // Non-tree connections: every physical connection not in `tree_connections`. Each
        // connection appears once or twice in `links` (real forward, and either a real reverse
        // or a fictitious reverse) — prefer the real direction when choosing which one to walk
        // as the non-tree step, so a one-way edge's non-tree cycle is always built from its
        // actual direction, never its fictitious mirror. `BTreeMap`, not `HashMap` — iteration
        // order feeds directly into the returned cycle list's order, and `HashMap`'s per-process
        // random hasher seed would make that order (and therefore any order-sensitive downstream
        // consumer, e.g. `InvalidLoopScoredStrategy`'s candidate scan) vary run-to-run for the
        // same maze/seed, breaking reproducibility.
        let mut best_non_tree: std::collections::BTreeMap<usize, Link> = std::collections::BTreeMap::new();
        for node in scc.iter().copied() {
            for &link in &links[node] {
                if tree_connections.contains(&link.connection) {
                    continue;
                }
                let entry = best_non_tree.entry(link.connection).or_insert(link);
                if entry.fictitious && !link.fictitious {
                    *entry = link;
                }
            }
        }

        crate::diag_log!("DIAG best_non_tree={:?}", best_non_tree.iter().map(|(k, v)| (*k, v.from, v.to, v.edge_idx, v.fictitious)).collect::<Vec<_>>()); // DIAG

        for link in best_non_tree.into_values() {
            // Walk: non-tree link (from -> to) + tree-path (to -> from), closing the loop.
            let mut steps = vec![if link.fictitious { CycleStep::Fictitious(link) } else { CycleStep::Real(link.edge_idx) }];
            steps.extend(tree_path(&edges, &parent, link.to, link.from));
            crate::diag_log!("DIAG non-tree link connection={} from={} to={} edge_idx={} fictitious={} steps={:?}", link.connection, link.from, link.to, link.edge_idx, link.fictitious,
                steps.iter().map(|s| match s { CycleStep::Real(i) => format!("Real({})", i), CycleStep::Fictitious(l) => format!("Fictitious(edge_idx={},from={},to={})", l.edge_idx, l.from, l.to) }).collect::<Vec<_>>()); // DIAG

            let non_tree_fictitious = link.fictitious;
            if let Some(cycle) = resolve_fundamental_cycle(&steps, non_tree_fictitious) {
                crate::diag_log!("DIAG -> resolved via tree-path: cycle={:?}", cycle); // DIAG
                cycles.push(cycle);
            } else if let Some(path) = real_path_bfs(&links, &scc_set, link.to, link.from, link.connection) {
                // Tree-path wasn't direction-valid (some tree edge needed walking backwards
                // with no real reverse) — fall back to a direct real-edges-only BFS between the
                // non-tree link's endpoints inside this SCC. Always succeeds (SCC reachability).
                let mut cycle = vec![link.edge_idx];
                cycle.extend(path.clone());
                crate::diag_log!("DIAG -> tree-path invalid, fallback BFS path={:?} cycle={:?}", path, cycle); // DIAG
                cycles.push(cycle);
            } else {
                crate::diag_log!("DIAG -> DROPPED (fallback BFS found no path!) connection={}", link.connection); // DIAG
            }
        }
    }
    crate::diag_log!("DIAG final cycles: {:?}", cycles); // DIAG

    cycles
}

/// Walking a tree `Link` in the direction opposite to how it was stored (parent->child
/// becomes child->parent, or vice versa): resolves to the real reverse nav-edge if one exists,
/// otherwise the connection has no real edge in this direction and is treated as fictitious
/// (direction-invalid unless later proven otherwise by the resolve step).
fn reverse_link(edges: &[&NavEdge], link: Link) -> CycleStep {
    if link.fictitious {
        // Fictitious link reversed = the real one-way edge in its own (forward) direction.
        return CycleStep::Real(link.edge_idx);
    }
    let edge = edges[link.edge_idx];
    match edge.reverse_edge {
        Some(rev) => CycleStep::Real(rev),
        None => CycleStep::Fictitious(Link { edge_idx: link.edge_idx, connection: link.connection, from: link.to, to: link.from, fictitious: true, bidirectional: false }),
    }
}

/// Expand each cycle's nav-edge indices into the full tile-path, splice consecutive
/// segments without duplicating junction tiles, and resolve each tile-hop to a base
/// Graph::EdgeId via `graph.edge_between`. One entry per input cycle; a tile-hop with
/// no matching base edge is skipped (should not happen for a valid nav graph — defensive only).
pub(crate) fn resolve_to_edge_ids(
    nav: &NavGraph,
    nav_cycles: &[Vec<usize>],
    graph: &Graph,
) -> Vec<Vec<EdgeId>> {
    nav_cycles.iter().map(|nav_cycle| {
        let mut tiles: Vec<u64> = Vec::new();
        for &e_idx in nav_cycle {
            let edge = nav.edge_by_idx(e_idx);
            if tiles.is_empty() {
                tiles.extend(edge.path.iter().copied());
            } else {
                tiles.extend(edge.path[1..].iter().copied());
            }
        }
        tiles.windows(2)
            .filter_map(|pair| graph.edge_between(pair[0], pair[1]))
            .collect()
    }).collect()
}

/// Rounds to the nearest integer, not truncating — a truncating division would silently pass
/// a density threshold for a true density that is actually fractionally past it (e.g. 30.9%
/// reading as 30). Shared by `MinLoopDensityCheck` and `MaxLoopDensityCheck` — same metric,
/// checked against a minimum and a maximum respectively.
pub(crate) fn density_per_100(cells: usize, field_cells: usize) -> u32 {
    ((cells * 100 + field_cells / 2) / field_cells) as u32
}

#[cfg(test)]
#[path = "cycles/tests.rs"]
mod tests;
