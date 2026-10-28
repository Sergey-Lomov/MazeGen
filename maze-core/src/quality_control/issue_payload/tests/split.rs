use super::*;

#[test]
fn invalid_split_node_connection_group_issue_carries_preset_locked_through_the_invalid_one_way_reuse()
 {
    // GitHub issue #245: `InvalidSplitNodeConnectionGroupIssue` reuses the `InvalidOneWay`
    // wire variant (see `resolve_issue_payload`'s doc comment on that arm) -- confirms the
    // preset_locked migration wasn't silently dropped for this reused kind.
    use crate::quality_control::issue_kinds::InvalidSplitNodeConnectionGroupIssue;
    let (graph, e1, e2) = one_way_graph();
    let scc = empty_scc();
    let issue = InvalidSplitNodeConnectionGroupIssue::new_from_check(
        "split_node_connection_per_neighbor",
        vec![(vec![e1, e2], 1)],
    );

    let preset_state = preset_with_edges(&[(1, 2), (2, 3)]);

    let payload = resolve_with_preset(&issue, &graph, &scc, &preset_state);
    let_payload!(InvalidOneWay { groups } = payload);
    assert!(groups["split_node_connection_per_neighbor"][0].preset_locked);
}

#[test]
fn invalid_split_route_issue_resolves_flagged_route_edges_keyed_by_source_check() {
    let mut graph = Graph::new();
    graph.add_node(1);
    graph.add_node(2);
    graph.add_node(3);
    let e0 = graph.add_edge(1, 2, EdgeKind::Basic);
    let e1 = graph.add_edge(2, 3, EdgeKind::Basic);
    let scc = empty_scc();

    let route: Vec<SplitRouteEdge> = vec![(e0, true), (e1, false)];
    let issue = InvalidSplitRouteIssue::new_from_check(
        "split_node_connection_traversal_distance",
        vec![route],
    );

    let payload = resolve(&issue, &graph, &scc);
    let_payload!(InvalidSplitRoute { routes } = payload);
    assert_eq!(routes.len(), 1);
    let check_routes = &routes["split_node_connection_traversal_distance"];
    assert_eq!(check_routes.len(), 1);
    assert_eq!(
        check_routes[0].edges,
        vec![
            IssueRouteEdge {
                from: 1,
                to: 2,
                is_split_edge: true
            },
            IssueRouteEdge {
                from: 2,
                to: 3,
                is_split_edge: false
            },
        ],
        "edge order and the is_split_edge flag must be preserved exactly, not sorted or dropped"
    );
    assert!(
        !check_routes[0].preset_locked,
        "no preset state given -- must not be locked"
    );
}

#[test]
fn invalid_split_route_issue_silently_drops_a_stale_edge_id_from_the_middle_of_a_route() {
    let mut graph = Graph::new();
    graph.add_node(1);
    graph.add_node(2);
    graph.add_node(3);
    let e0 = graph.add_edge(1, 2, EdgeKind::Basic);
    let e2 = graph.add_edge(2, 3, EdgeKind::Basic);
    let scc = empty_scc();
    let stale_id = e2 + 1000;

    let route: Vec<SplitRouteEdge> = vec![(e0, true), (stale_id, false), (e2, true)];
    let issue = InvalidSplitRouteIssue::new_from_check("check", vec![route]);

    let payload = resolve(&issue, &graph, &scc);
    let_payload!(InvalidSplitRoute { routes } = payload);
    assert_eq!(routes["check"].len(), 1);
    assert_eq!(
        routes["check"][0].edges,
        vec![
            IssueRouteEdge {
                from: 1,
                to: 2,
                is_split_edge: true
            },
            IssueRouteEdge {
                from: 2,
                to: 3,
                is_split_edge: true
            },
        ],
        "the stale edge id must be dropped, not panic, leaving the two resolvable edges"
    );
}

// --- Split node/route preset_locked support (extends GitHub issue #245 to node/route-based
// split issue kinds: invalid_split_node, invalid_split_node_group, invalid_split_route,
// invalid_split_tile, invalid_split_tile_group) ---

fn split_node_graph() -> (Graph, NodeId, NodeId) {
    let mut graph = Graph::new();
    graph.add_node(1);
    graph.add_node(2);
    graph.add_edge(1, 2, EdgeKind::Basic);
    (graph, 1, 2)
}

#[test]
fn invalid_split_node_issue_marks_node_preset_locked_via_is_node_locked_for_removal() {
    let (graph, split_node, _other) = split_node_graph();
    let scc = empty_scc();
    let issue =
        InvalidSplitNodeIssue::new_from_check("split_node_connection_count", vec![split_node]);

    // `preset_locked` now mirrors `remove_node_feasible`'s own predicate (GitHub issue #245's
    // review fix) -- a preset edge touching the node blocks removal regardless of whether the
    // node is also `preset_declared` (minted by a preset `split_points` entry).
    let preset_state = preset_with_edges(&[(1, 2)]);

    let payload = resolve_with_preset(&issue, &graph, &scc, &preset_state);
    let_payload!(InvalidSplitTile { groups } = payload);
    let entry = &groups["split_node_connection_count"][0];
    assert!(entry.preset_locked);
    assert_eq!(
        entry.tiles.len(),
        1,
        "a single flagged node wraps as its own 1-tile group"
    );
    assert!(entry.tiles[0].preset_locked);
}

#[test]
fn invalid_split_node_issue_not_preset_locked_when_no_incident_edge_is_preset_protected() {
    let (graph, split_node, _other) = split_node_graph();
    let scc = empty_scc();
    let issue =
        InvalidSplitNodeIssue::new_from_check("split_node_connection_count", vec![split_node]);

    // No preset edge touches the node, and it isn't locked_out/locked_in either -- repair can
    // freely remove it.
    let preset_state = PresetState::empty();

    let payload = resolve_with_preset(&issue, &graph, &scc, &preset_state);
    let_payload!(InvalidSplitTile { groups } = payload);
    assert!(!groups["split_node_connection_count"][0].preset_locked);
}

#[test]
fn invalid_split_node_group_issue_resolves_via_the_new_arm_and_carries_preset_locked() {
    // `InvalidSplitNodeGroupIssue` previously had no resolve arm at all -- confirms it now
    // resolves (reusing the `InvalidSplitTile` wire shape) and carries `preset_locked`. Its
    // `groups[i]` is already exactly one overflowing tile's node list, so this resolves to one
    // single-tile group per entry (GitHub issue #245's review fix: group-as-instance and
    // tile-as-instance coincide here, unlike the multi-tile proximity case below).
    let (graph, split_node, other) = split_node_graph();
    let scc = empty_scc();
    let issue = InvalidSplitNodeGroupIssue::new_from_check(
        "split_tile_node_count",
        vec![(vec![split_node, other], 1)],
    );

    // Only the (1, 2) direction is preset-protected -- both endpoints of that directed edge
    // are touched by `preset_edges`, so the whole tile is locked.
    let preset_state = preset_with_edges(&[(1, 2)]);

    let payload = resolve_with_preset(&issue, &graph, &scc, &preset_state);
    let_payload!(InvalidSplitTile { groups } = payload);
    let entries = &groups["split_tile_node_count"];
    assert_eq!(
        entries.len(),
        1,
        "one group entry -- the check's whole node list is one overflowing tile"
    );
    assert!(
        entries[0].preset_locked,
        "both nodes of the tile are locked for removal"
    );
    assert_eq!(entries[0].tiles.len(), 1);
    let mut tile_nodes = entries[0].tiles[0].nodes.clone();
    tile_nodes.sort_unstable();
    assert_eq!(tile_nodes, vec![split_node as u32, other as u32]);
}

#[test]
fn invalid_split_tile_issue_locks_the_whole_tile_when_a_non_declared_base_node_has_a_preset_edge() {
    // Regression: a split tile's base node (never `preset_declared` -- only `add_node_at`-
    // minted nodes are) still blocks the whole tile's `remove_split` collapse if its own edge
    // is preset-protected (`replace_point_nodes_feasible` checks every node at the point, base
    // included). `preset_locked` must reflect that, not `is_preset_locked_node`'s
    // declared-only criterion.
    let (graph, base, _other) = split_node_graph();
    let scc = empty_scc();
    let tile = SplitTileNodes::new(vec![base]);
    let issue = InvalidSplitTileIssue::new_from_check("split_distance_from_waypoint", vec![tile]);

    let preset_state = preset_with_edges(&[(1, 2)]); // touches `base` (id 1), never declared

    let payload = resolve_with_preset(&issue, &graph, &scc, &preset_state);
    let_payload!(InvalidSplitTile { groups } = payload);
    assert!(groups["split_distance_from_waypoint"][0].preset_locked);
}

#[test]
fn invalid_split_tile_issue_not_preset_locked_when_no_node_is_removal_locked() {
    let (graph, base, _other) = split_node_graph();
    let scc = empty_scc();
    let tile = SplitTileNodes::new(vec![base]);
    let issue = InvalidSplitTileIssue::new_from_check("split_distance_from_waypoint", vec![tile]);

    let payload = resolve_with_preset(&issue, &graph, &scc, &PresetState::empty());
    let_payload!(InvalidSplitTile { groups } = payload);
    assert!(!groups["split_distance_from_waypoint"][0].preset_locked);
}

#[test]
fn invalid_split_tile_issue_resolves_one_group_per_flagged_tile_each_a_single_tile() {
    // Two independently-flagged tiles must resolve as two separate single-tile
    // `IssueSplitGroupPayload` entries, not merged into one.
    let mut graph = Graph::new();
    graph.add_node(1);
    graph.add_node(2);
    graph.add_node(3);
    graph.add_node(4);
    let scc = empty_scc();
    let tile_a = SplitTileNodes::new(vec![1, 2]);
    let tile_b = SplitTileNodes::new(vec![3, 4]);
    let issue =
        InvalidSplitTileIssue::new_from_check("split_distance_from_waypoint", vec![tile_a, tile_b]);

    let payload = resolve_with_preset(&issue, &graph, &scc, &PresetState::empty());
    let_payload!(InvalidSplitTile { groups } = payload);
    let entries = &groups["split_distance_from_waypoint"];
    assert_eq!(
        entries.len(),
        2,
        "each flagged tile resolves as its own group entry"
    );
    assert!(entries.iter().all(|e| e.tiles.len() == 1));
}

#[test]
fn invalid_split_tile_group_issue_preserves_a_multi_tile_group_and_locks_only_when_every_tile_is_locked()
 {
    // A proximity pair's group must resolve as ONE entry carrying BOTH tiles (not flattened
    // into 2 separate entries) -- GitHub issue #245's review fix: web-side needs the real group
    // boundary to count "1 instance" for a pair, not "2 instances" (one per node/tile).
    let mut graph = Graph::new();
    graph.add_node(1);
    graph.add_node(2);
    graph.add_node(3);
    graph.add_node(4);
    graph.add_edge(1, 3, crate::graph::EdgeKind::Basic);
    let scc = empty_scc();
    let tile_a = SplitTileNodes::new(vec![1, 2]);
    let tile_b = SplitTileNodes::new(vec![3, 4]);
    let issue = InvalidSplitTileGroupIssue::new_from_check(
        "split_group_geometric_proximity",
        vec![(vec![tile_a.clone(), tile_b.clone()], 1)],
    );

    // Only node 1 is preset-locked (touches a preset edge) -- tile_a is NOT fully locked (node
    // 2 isn't), so the whole group must not be locked either, even though it contains a locked
    // node.
    let preset_state = preset_with_edges(&[(1, 3)]);

    let payload = resolve_with_preset(&issue, &graph, &scc, &preset_state);
    let_payload!(InvalidSplitTile { groups } = payload);
    let entries = &groups["split_group_geometric_proximity"];
    assert_eq!(
        entries.len(),
        1,
        "the pair resolves as one group entry, not two"
    );
    assert_eq!(
        entries[0].tiles.len(),
        2,
        "both tiles of the pair are preserved in the group"
    );
    assert!(
        !entries[0].preset_locked,
        "tile_a has an unlocked node, so the group as a whole is not locked"
    );
}

#[test]
fn invalid_split_tile_group_issue_locks_the_group_when_every_tile_is_fully_locked() {
    let mut graph = Graph::new();
    graph.add_node(1);
    graph.add_node(2);
    graph.add_edge(1, 2, crate::graph::EdgeKind::Basic);
    let scc = empty_scc();
    let tile_a = SplitTileNodes::new(vec![1]);
    let tile_b = SplitTileNodes::new(vec![2]);
    let issue = InvalidSplitTileGroupIssue::new_from_check(
        "split_group_geometric_proximity",
        vec![(vec![tile_a, tile_b], 1)],
    );

    let preset_state = preset_with_edges(&[(1, 2)]);

    let payload = resolve_with_preset(&issue, &graph, &scc, &preset_state);
    let_payload!(InvalidSplitTile { groups } = payload);
    assert!(groups["split_group_geometric_proximity"][0].preset_locked);
}

#[test]
fn invalid_split_route_issue_preset_locked_when_every_route_edge_is_protected() {
    let (graph, a, b) = split_node_graph();
    let scc = empty_scc();
    let eid = graph.edge_between(a, b).unwrap();
    let route: Vec<SplitRouteEdge> = vec![(eid, true)];
    let issue = InvalidSplitRouteIssue::new_from_check(
        "split_node_connection_traversal_distance",
        vec![route],
    );

    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((a, b));

    let payload = resolve_with_preset(&issue, &graph, &scc, &preset_state);
    let_payload!(InvalidSplitRoute { routes } = payload);
    assert!(routes["split_node_connection_traversal_distance"][0].preset_locked);
}

#[test]
fn invalid_split_route_issue_preset_locked_is_independent_of_is_split_edge() {
    // GitHub issue #245's split-route extension: `is_split_edge` is purely a render flag and
    // must not influence `preset_locked` -- an edge flagged `is_split_edge: true` that is NOT
    // preset-protected, mixed with other protected edges, must still resolve `preset_locked`
    // to false for the whole route, and `is_split_edge` must survive unmodified in the output.
    let mut graph = Graph::new();
    graph.add_node(1);
    graph.add_node(2);
    graph.add_node(3);
    let e1 = graph.add_edge(1, 2, EdgeKind::Basic);
    let e2 = graph.add_edge(2, 3, EdgeKind::Basic);
    let scc = empty_scc();

    let route: Vec<SplitRouteEdge> = vec![(e1, true), (e2, false)];
    let issue = InvalidSplitRouteIssue::new_from_check("check", vec![route]);

    let mut preset_state = PresetState::empty();
    // Only e2 (1,2)->(2,3) is protected; e1 (is_split_edge: true) is not.
    preset_state.preset_edges.insert((2, 3));

    let payload = resolve_with_preset(&issue, &graph, &scc, &preset_state);
    let_payload!(InvalidSplitRoute { routes } = payload);
    let resolved = &routes["check"][0];
    assert!(
        !resolved.preset_locked,
        "one unprotected edge is enough to keep the whole route fixable"
    );
    assert_eq!(
        resolved.edges,
        vec![
            IssueRouteEdge {
                from: 1,
                to: 2,
                is_split_edge: true
            },
            IssueRouteEdge {
                from: 2,
                to: 3,
                is_split_edge: false
            },
        ],
        "is_split_edge must be preserved as-is, independent of preset protection"
    );
}

#[test]
fn invalid_split_route_issue_empty_route_is_not_preset_locked_and_is_skipped() {
    // Explicit vacuous-truth guard, same rationale as `resolve_edge_group_map_treats_empty_group_as_not_preset_locked`.
    let (graph, scc) = empty_graph_and_scc();
    let empty_route: Vec<SplitRouteEdge> = vec![];
    let issue = InvalidSplitRouteIssue::new_from_check("check", vec![empty_route]);
    assert_eq!(
        resolve(&issue, &graph, &scc),
        IssuePayload::None,
        "an empty route carries nothing to resolve or highlight"
    );
}
