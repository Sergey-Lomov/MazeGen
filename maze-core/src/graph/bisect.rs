use std::collections::{HashMap, HashSet, VecDeque};
use crate::dsu::Dsu;
use crate::ids::NodeId;
use super::Graph;

/// Groups `nodes` by merging every pair joined by an edge (either direction, present in `graph`)
/// that `is_unremovable` flags — e.g. a preset-protected or route-critical connection. Two nodes
/// end up in the same group iff they're connected through a chain of such edges; a group of size
/// 1 just means that node has no unremovable edge to any other node in `nodes`.
///
/// Shared by any caller that needs to know which nodes *must* stay together before attempting to
/// split a node set into two parts (e.g. `RegionShrinkSplitStrategy` grouping a region's nodes by
/// preset/critical-path edges before choosing where to cut).
pub fn group_by_unremovable_edges(
    graph: &Graph,
    nodes: &[NodeId],
    is_unremovable: impl Fn(NodeId, NodeId) -> bool,
) -> HashMap<NodeId, Vec<NodeId>> {
    let index_of: HashMap<NodeId, usize> = nodes.iter().enumerate().map(|(i, &n)| (n, i)).collect();
    let mut dsu = Dsu::new(nodes.len());

    let node_set: HashSet<NodeId> = nodes.iter().copied().collect();
    for &node in nodes {
        for neighbor in graph.outgoing_neighbors(node) {
            if !node_set.contains(&neighbor) {
                continue;
            }
            if is_unremovable(node, neighbor) {
                dsu.union_by_min(index_of[&node], index_of[&neighbor]);
            }
        }
    }

    let mut groups: HashMap<usize, Vec<NodeId>> = HashMap::new();
    for &node in nodes {
        let root = dsu.find(index_of[&node]);
        groups.entry(root).or_default().push(node);
    }
    // Re-key by each group's own lowest-`NodeId` member — deterministic, independent of `Dsu`'s
    // internal root choice (`union_by_min` already picks the lower index, but re-deriving the key
    // from `NodeId` values keeps this function's output independent of that implementation detail).
    groups.into_values()
        .map(|mut members| {
            members.sort_unstable();
            (members[0], members)
        })
        .collect()
}

/// Finds two nodes, each from a different key of `groups`, that are farthest apart by hop-count
/// over the underlying undirected adjacency of `graph` restricted to `groups`' own members —
/// approximated via double-BFS (BFS from an arbitrary node to find its farthest node, then BFS
/// from that node to find *its* farthest node), the standard near-linear tree/graph diameter
/// heuristic. Exact all-pairs distance is not computed (would be quadratic).
///
/// The second BFS starts from the first BFS's farthest node and excludes that node's own group
/// from its result (`exclude_group`), so the returned pair can never accidentally land both
/// endpoints in the same group.
///
/// `None` if `groups` has fewer than 2 keys, or fewer than 2 total nodes.
pub fn farthest_pair_across_groups(
    graph: &Graph,
    groups: &HashMap<NodeId, Vec<NodeId>>,
) -> Option<(NodeId, NodeId)> {
    if groups.len() < 2 {
        return None;
    }
    let node_group: HashMap<NodeId, NodeId> = groups.iter()
        .flat_map(|(&key, members)| members.iter().map(move |&n| (n, key)))
        .collect();
    let all_nodes: Vec<NodeId> = node_group.keys().copied().collect();
    if all_nodes.len() < 2 {
        return None;
    }

    let seed = *all_nodes.iter().min().unwrap();
    let (first_far, _) = farthest_node(graph, &node_group, seed, None)?;
    let first_far_group = node_group[&first_far];
    let (second_far, _) = farthest_node(graph, &node_group, first_far, Some(first_far_group))?;

    Some((first_far, second_far))
}

/// BFS from `start` over `node_group`'s keys (restricted to nodes present in `node_group`, both
/// edge directions treated as adjacency), returning the visited node with the greatest hop-count
/// that lies outside `exclude_group` (if given) — ties broken by lowest `NodeId` for determinism.
/// `None` if no such node is reachable.
fn farthest_node(
    graph: &Graph,
    node_group: &HashMap<NodeId, NodeId>,
    start: NodeId,
    exclude_group: Option<NodeId>,
) -> Option<(NodeId, usize)> {
    let mut dist: HashMap<NodeId, usize> = HashMap::new();
    dist.insert(start, 0);
    let mut queue = VecDeque::new();
    queue.push_back(start);

    while let Some(current) = queue.pop_front() {
        let d = dist[&current];
        let neighbors = graph.outgoing_neighbors(current).chain(graph.incoming_neighbors(current));
        for neighbor in neighbors {
            if !node_group.contains_key(&neighbor) {
                continue;
            }
            if dist.contains_key(&neighbor) {
                continue;
            }
            dist.insert(neighbor, d + 1);
            queue.push_back(neighbor);
        }
    }

    dist.into_iter()
        .filter(|(node, _)| exclude_group != Some(node_group[node]))
        .max_by(|(n1, d1), (n2, d2)| d1.cmp(d2).then(n2.cmp(n1)))
        .map(|(node, d)| (node, d))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;

    fn chain(n: u64) -> Graph {
        let mut g = Graph::new();
        for i in 0..n {
            g.add_node(i);
        }
        for i in 0..n - 1 {
            g.add_bidirectional_edge(i, i + 1, EdgeKind::Basic);
        }
        g
    }

    #[test]
    fn group_by_unremovable_edges_splits_isolated_nodes() {
        let g = chain(4); // 0-1-2-3
        let nodes: Vec<NodeId> = (0..4).collect();
        let groups = group_by_unremovable_edges(&g, &nodes, |_, _| false);
        assert_eq!(groups.len(), 4, "no unremovable edges: every node its own group");
    }

    #[test]
    fn group_by_unremovable_edges_merges_flagged_chain() {
        let g = chain(4); // 0-1-2-3
        let nodes: Vec<NodeId> = (0..4).collect();
        // Mark 1-2 unremovable: merges 1 and 2 into one group, 0 and 3 stay alone.
        let groups = group_by_unremovable_edges(&g, &nodes, |a, b| (a, b) == (1, 2) || (a, b) == (2, 1));
        assert_eq!(groups.len(), 3);
        let sizes: Vec<usize> = {
            let mut s: Vec<usize> = groups.values().map(|v| v.len()).collect();
            s.sort_unstable();
            s
        };
        assert_eq!(sizes, vec![1, 1, 2]);
    }

    #[test]
    fn group_by_unremovable_edges_transitive_merge() {
        let g = chain(4); // 0-1-2-3
        let nodes: Vec<NodeId> = (0..4).collect();
        // All edges unremovable: whole chain collapses into one group.
        let groups = group_by_unremovable_edges(&g, &nodes, |_, _| true);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups.values().next().unwrap().len(), 4);
    }

    #[test]
    fn farthest_pair_across_groups_picks_chain_endpoints() {
        let g = chain(5); // 0-1-2-3-4
        let nodes: Vec<NodeId> = (0..5).collect();
        let groups = group_by_unremovable_edges(&g, &nodes, |_, _| false);
        let (a, b) = farthest_pair_across_groups(&g, &groups).unwrap();
        let mut pair = [a, b];
        pair.sort_unstable();
        assert_eq!(pair, [0, 4]);
    }

    #[test]
    fn farthest_pair_across_groups_never_same_group() {
        let g = chain(5); // 0-1-2-3-4
        let nodes: Vec<NodeId> = (0..5).collect();
        // Merge 3 and 4 together so the "farthest" endpoint 4 is unusable alone.
        let groups = group_by_unremovable_edges(&g, &nodes, |a, b| (a, b) == (3, 4) || (a, b) == (4, 3));
        let (a, b) = farthest_pair_across_groups(&g, &groups).unwrap();
        let group_of = |n: NodeId| groups.iter().find(|(_, m)| m.contains(&n)).unwrap().0;
        assert_ne!(group_of(a), group_of(b));
    }

    #[test]
    fn farthest_pair_across_groups_none_for_single_group() {
        let g = chain(3);
        let nodes: Vec<NodeId> = (0..3).collect();
        let groups = group_by_unremovable_edges(&g, &nodes, |_, _| true);
        assert!(farthest_pair_across_groups(&g, &groups).is_none());
    }

    #[test]
    fn group_by_unremovable_edges_ignores_neighbors_outside_the_given_node_set() {
        let g = chain(6); // 0-1-2-3-4-5, but only 0..4 is the caller's subset
        let nodes: Vec<NodeId> = (0..4).collect();
        // Every edge unremovable, including 3-4 (4 is outside `nodes`) -- 4 must never affect
        // grouping since it was never in the input set to begin with.
        let groups = group_by_unremovable_edges(&g, &nodes, |_, _| true);
        assert_eq!(groups.len(), 1, "the whole subset 0..4 still merges into one group");
        let members = groups.values().next().unwrap();
        assert_eq!(members.len(), 4, "node 4 must never be pulled into a group it was never a member of");
        assert!(!members.contains(&4));
    }

    #[test]
    fn farthest_pair_across_groups_ignores_neighbors_outside_the_group_set() {
        let g = chain(6); // 0-1-2-3-4-5, but only 0..4 is the caller's subset
        let nodes: Vec<NodeId> = (0..4).collect();
        let groups = group_by_unremovable_edges(&g, &nodes, |_, _| false);
        let (a, b) = farthest_pair_across_groups(&g, &groups).unwrap();
        // The BFS must never wander into node 4/5 (outside every group) while computing distance --
        // the farthest pair within the 0..4 subset is exactly its own endpoints, 0 and 3.
        let mut pair = [a, b];
        pair.sort_unstable();
        assert_eq!(pair, [0, 3]);
    }
}
