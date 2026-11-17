use super::*;

#[test]
fn invalid_one_way_issue_resolves_flagged_edge_as_one_element_group() {
    let (graph, e1, _) = one_way_graph();
    let scc = empty_scc();
    let issue = InvalidOneWayIssue::new_from_check("one_way_waypoint_distance", vec![e1]);

    let payload = resolve(&issue, &graph, &scc);
    let_payload!(InvalidOneWay { groups } = payload);
    assert_eq!(groups.len(), 1);
    assert_eq!(groups["one_way_waypoint_distance"][0].edges, vec![[1, 2]]);
}

#[test]
fn invalid_one_way_issue_preset_locked_only_when_forward_direction_is_the_actual_preset_direction()
{
    // GitHub issue #245: a one-way preset only ever occupies one direction (`preset_edges`
    // stores the exact directed pair, `blocked` covers the reverse) -- the resolver must not
    // treat the flagged forward edge as locked when the "protection" it's checking against is
    // actually the reverse direction's `blocked` entry, not a `preset_edges` membership.
    let (graph, e1, _) = one_way_graph();
    let scc = empty_scc();
    let issue = InvalidOneWayIssue::new_from_check("one_way_waypoint_distance", vec![e1]);

    // Only the reverse direction is "protected" (as `blocked`, mirroring a real OneWayForward
    // preset's own bookkeeping) -- the forward edge itself (1 -> 2) is not in `preset_edges`.
    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((2, 1));

    let payload = resolve_with_preset(&issue, &graph, &scc, &preset_state);
    let_payload!(InvalidOneWay { groups } = payload);
    assert!(
        !groups["one_way_waypoint_distance"][0].preset_locked,
        "reverse-direction blocked must not count as this edge being preset-protected"
    );

    // Now actually protect the flagged direction -- must become locked.
    let preset_state = preset_with_edges(&[(1, 2)]);
    let payload = resolve_with_preset(&issue, &graph, &scc, &preset_state);
    let_payload!(InvalidOneWay { groups } = payload);
    assert!(
        groups["one_way_waypoint_distance"][0].preset_locked,
        "the actual preset direction must be reported locked"
    );
}

#[test]
fn invalid_one_way_group_issue_resolves_flagged_group_edges() {
    let (graph, e1, e2) = one_way_graph();
    let scc = empty_scc();
    let issue = InvalidOneWayGroupIssue::new_from_check(
        "one_way_group_graph_proximity",
        vec![(vec![e1, e2], 1)],
    );

    let payload = resolve(&issue, &graph, &scc);
    let_payload!(InvalidOneWay { groups } = payload);
    assert_eq!(groups.len(), 1);
    let group_edges = &groups["one_way_group_graph_proximity"];
    assert_eq!(group_edges.len(), 1);
    let mut pairs = group_edges[0].edges.clone();
    pairs.sort();
    assert_eq!(pairs, vec![[1, 2], [2, 3]]);
}

#[test]
fn invalid_one_way_group_issue_silently_skips_a_group_with_a_stale_edge_id() {
    let (graph, e1, e2) = one_way_graph();
    let scc = empty_scc();
    let stale_id = e2 + 1000;
    let issue = InvalidOneWayGroupIssue::new_from_check(
        "one_way_group_graph_proximity",
        vec![(vec![e1, stale_id], 1)],
    );

    let payload = resolve(&issue, &graph, &scc);
    let_payload!(InvalidOneWay { groups } = payload);
    assert_eq!(
        groups["one_way_group_graph_proximity"][0].edges,
        vec![[1, 2]],
        "the stale edge id must be dropped, not panic, leaving only the resolvable edge"
    );
}

#[test]
fn invalid_one_way_group_issue_preset_locked_ignores_to_remove_count() {
    // GitHub issue #245: confirmed with the user -- `preset_locked` for a partial-fix group
    // (`to_remove < group size`) still means "every edge in the group is preset-protected",
    // ignoring `to_remove`. Every individual removal attempt refuses on a preset edge
    // regardless of how many total removals were needed, so a fully-protected group is truly
    // unfixable even though its nominal fix only demanded removing one of its two edges.
    let (graph, e1, e2) = one_way_graph();
    let scc = empty_scc();
    let issue = InvalidOneWayGroupIssue::new_from_check(
        "one_way_group_graph_proximity",
        vec![(vec![e1, e2], 1)],
    );

    let preset_state = preset_with_edges(&[(1, 2), (2, 3)]);

    let payload = resolve_with_preset(&issue, &graph, &scc, &preset_state);
    let_payload!(InvalidOneWay { groups } = payload);
    assert!(
        groups["one_way_group_graph_proximity"][0].preset_locked,
        "to_remove=1 must not exempt the group from being fully locked when both edges are protected"
    );
}

stale_edge_is_dropped_test!(
    invalid_one_way_issue_silently_skips_a_stale_edge_id_absent_from_the_graph,
    InvalidOneWayIssue,
    InvalidOneWay,
    one_way_graph(),
    "one_way_waypoint_distance"
);
