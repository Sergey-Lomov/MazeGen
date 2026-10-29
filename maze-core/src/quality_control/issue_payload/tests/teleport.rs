use super::*;

fn teleport_graph() -> (Graph, EdgeId, EdgeId) {
    chain_graph(EdgeKind::Teleport)
}

#[test]
fn invalid_teleport_issue_resolves_flagged_edge_as_one_element_group() {
    let (graph, e1, _) = teleport_graph();
    let scc = empty_scc();
    let issue = InvalidTeleportIssue::new_from_check("teleport_duplicates_connection", vec![e1]);

    let payload = resolve(&issue, &graph, &scc);
    let_payload!(InvalidTeleport { groups } = payload);
    assert_eq!(groups.len(), 1);
    let check1_groups = &groups["teleport_duplicates_connection"];
    assert_eq!(check1_groups.len(), 1);
    assert_eq!(check1_groups[0].edges, vec![[1, 2]]);
}

#[test]
fn invalid_teleport_group_issue_resolves_flagged_pair_as_two_element_group() {
    let (graph, e1, e2) = teleport_graph();
    let scc = empty_scc();
    let issue = InvalidTeleportGroupIssue::new_from_check(
        "teleport_group_proximity",
        vec![(vec![e1, e2], 1)],
    );

    let payload = resolve(&issue, &graph, &scc);
    let_payload!(InvalidTeleport { groups } = payload);
    assert_eq!(groups.len(), 1);
    let check1_groups = &groups["teleport_group_proximity"];
    assert_eq!(check1_groups.len(), 1);
    assert_eq!(check1_groups[0].edges, vec![[1, 2], [2, 3]]);
}

/// GitHub issue #379's follow-up: `max_teleport_count`/`max_teleport_density` (and the sibling
/// one-way/vertical-passage max checks) bundle every over-budget portal into one big
/// `InvalidTeleportGroupIssue` group, purely so a single repair-strategy call can pick which ones
/// to remove -- unlike `teleport_group_proximity`'s genuinely interdependent pairs, each portal in
/// this batch is independent. Before the fix, `preset_locked` was computed once for the whole
/// batch via `all_preset_locked`, so a batch mixing one preset-locked portal with two removable
/// ones reported zero locked instances -- severely undercounting "instances set by presets" in the
/// UI. The fix must resolve the batch into one payload per edge, each with its own `preset_locked`.
#[test]
fn invalid_teleport_group_issue_for_a_max_count_batch_check_locks_only_the_preset_edge() {
    let mut graph = Graph::new();
    for n in 1..=6 {
        graph.add_node(n);
    }
    let e1 = graph.add_edge(1, 2, EdgeKind::Teleport);
    let e2 = graph.add_edge(3, 4, EdgeKind::Teleport);
    let e3 = graph.add_edge(5, 6, EdgeKind::Teleport);
    let scc = empty_scc();
    let issue = InvalidTeleportGroupIssue::new_from_check(
        "max_teleport_count",
        vec![(vec![e1, e2, e3], 2)],
    );

    let preset_state = preset_with_edges(&[(1, 2)]);

    let payload = resolve_with_preset(&issue, &graph, &scc, &preset_state);
    let_payload!(InvalidTeleport { groups } = payload);
    let batch = &groups["max_teleport_count"];
    assert_eq!(
        batch.len(),
        3,
        "batch check must split into one payload per edge, not one per group"
    );
    let locked: Vec<_> = batch.iter().filter(|p| p.preset_locked).collect();
    assert_eq!(
        locked.len(),
        1,
        "only the actually preset-protected portal must be locked"
    );
    assert_eq!(locked[0].edges, vec![[1, 2]]);
}

/// Same as `invalid_teleport_group_issue_for_a_max_count_batch_check_locks_only_the_preset_edge`,
/// but sourced by a real check *instance* id (`"rule_1:0"`, what `Rule::run_checks_typed`/
/// `MaxTeleportCountCheck::instance_id` actually produce -- see `check.check_type_id()` vs
/// `self.instance_id` in `rule.rs`/`max_teleport_count.rs`) resolved through `check_types`, not
/// the type id itself -- this is the exact shape that shipped broken: `BATCH_EDGE_GROUP_CHECKS`
/// was being matched against the instance id directly, which never matches, so every batch stayed
/// on the old whole-group `all_preset_locked` path regardless of this fix.
#[test]
fn invalid_teleport_group_issue_for_a_max_count_batch_check_resolves_instance_id_via_check_types() {
    let mut graph = Graph::new();
    for n in 1..=6 {
        graph.add_node(n);
    }
    let e1 = graph.add_edge(1, 2, EdgeKind::Teleport);
    let e2 = graph.add_edge(3, 4, EdgeKind::Teleport);
    let e3 = graph.add_edge(5, 6, EdgeKind::Teleport);
    let scc = empty_scc();
    let issue = InvalidTeleportGroupIssue::new_from_check("rule_1:0", vec![(vec![e1, e2, e3], 2)]);

    let preset_state = preset_with_edges(&[(1, 2)]);
    let mut check_types = HashMap::new();
    check_types.insert("rule_1:0".to_string(), "max_teleport_count".to_string());

    let payload = resolve_issue_payload(
        &issue,
        &graph,
        &dummy_field(),
        &scc,
        &preset_state,
        Some(&check_types),
    );
    let_payload!(InvalidTeleport { groups } = payload);
    let batch = &groups["rule_1:0"];
    assert_eq!(
        batch.len(),
        3,
        "batch check must split into one payload per edge once resolved via check_types"
    );
    let locked: Vec<_> = batch.iter().filter(|p| p.preset_locked).collect();
    assert_eq!(
        locked.len(),
        1,
        "only the actually preset-protected portal must be locked"
    );
    assert_eq!(locked[0].edges, vec![[1, 2]]);
}

/// Without a `check_types` entry for the source (or no map at all), `resolve_edge_group_map` must
/// fall back to whole-group `all_preset_locked` -- never silently treat an unresolvable source as
/// a batch check just because it happens to look like one.
#[test]
fn invalid_teleport_group_issue_stays_whole_group_when_source_is_missing_from_check_types() {
    let mut graph = Graph::new();
    for n in 1..=6 {
        graph.add_node(n);
    }
    let e1 = graph.add_edge(1, 2, EdgeKind::Teleport);
    let e2 = graph.add_edge(3, 4, EdgeKind::Teleport);
    let e3 = graph.add_edge(5, 6, EdgeKind::Teleport);
    let scc = empty_scc();
    let issue = InvalidTeleportGroupIssue::new_from_check("rule_1:0", vec![(vec![e1, e2, e3], 2)]);

    let preset_state = preset_with_edges(&[(1, 2)]);
    let check_types: HashMap<String, String> = HashMap::new();

    let payload = resolve_issue_payload(
        &issue,
        &graph,
        &dummy_field(),
        &scc,
        &preset_state,
        Some(&check_types),
    );
    let_payload!(InvalidTeleport { groups } = payload);
    let batch = &groups["rule_1:0"];
    assert_eq!(
        batch.len(),
        1,
        "unresolvable source must keep the original whole-group payload"
    );
    assert!(
        !batch[0].preset_locked,
        "not every edge is preset-protected, so the whole group is not locked"
    );
}

#[test]
fn invalid_teleport_group_issue_silently_skips_a_group_with_a_stale_edge_id() {
    let (graph, e1, _) = teleport_graph();
    let scc = empty_scc();
    let stale_id = e1 + 1000;
    let issue = InvalidTeleportGroupIssue::new_from_check(
        "teleport_group_proximity",
        vec![(vec![e1, stale_id], 1)],
    );

    let payload = resolve(&issue, &graph, &scc);
    let_payload!(InvalidTeleport { groups } = payload);
    assert_eq!(
        groups["teleport_group_proximity"][0].edges,
        vec![[1, 2]],
        "the stale edge id must be dropped, not panic, leaving only the resolvable edge"
    );
}

// GitHub issue #195's follow-up: hovering one check's bubble must highlight only the edge that
// check actually flagged, not every merged edge.
merged_checks_keep_own_edges_test!(
    invalid_teleport_issue_merged_from_two_checks_attributes_each_edge_to_only_its_own_check,
    InvalidTeleportIssue,
    InvalidTeleport,
    teleport_graph(),
    "teleport_duplicates_connection",
    "teleport_waypoint_distance"
);

stale_edge_is_dropped_test!(
    invalid_teleport_issue_silently_skips_a_stale_edge_id_absent_from_the_graph,
    InvalidTeleportIssue,
    InvalidTeleport,
    teleport_graph(),
    "teleport_duplicates_connection"
);
