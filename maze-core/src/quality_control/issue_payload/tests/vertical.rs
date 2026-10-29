use super::*;

fn vertical_passage_graph() -> (Graph, EdgeId, EdgeId) {
    chain_graph(EdgeKind::VerticalPassage)
}

#[test]
fn invalid_vertical_passage_issue_resolves_flagged_edge_as_one_element_group() {
    let (graph, e1, _) = vertical_passage_graph();
    let scc = empty_scc();
    let issue = InvalidVerticalPassageIssue::new_from_check(
        "vertical_passage_group_geometric_proximity",
        vec![e1],
    );

    let payload = resolve(&issue, &graph, &scc);
    let_payload!(InvalidVerticalPassage { groups } = payload);
    assert_eq!(groups.len(), 1);
    let check1_groups = &groups["vertical_passage_group_geometric_proximity"];
    assert_eq!(check1_groups.len(), 1);
    assert_eq!(check1_groups[0].edges, vec![[1, 2]]);
}

#[test]
fn invalid_vertical_passage_group_issue_resolves_flagged_pair_as_two_element_group() {
    let (graph, e1, e2) = vertical_passage_graph();
    let scc = empty_scc();
    let issue = InvalidVerticalPassageGroupIssue::new_from_check(
        "vertical_passage_group_graph_proximity",
        vec![(vec![e1, e2], 1)],
    );

    let payload = resolve(&issue, &graph, &scc);
    let_payload!(InvalidVerticalPassage { groups } = payload);
    assert_eq!(groups.len(), 1);
    let check1_groups = &groups["vertical_passage_group_graph_proximity"];
    assert_eq!(check1_groups.len(), 1);
    assert_eq!(check1_groups[0].edges, vec![[1, 2], [2, 3]]);
}

merged_checks_keep_own_edges_test!(
    invalid_vertical_passage_issue_merged_from_two_checks_attributes_each_edge_to_only_its_own_check,
    InvalidVerticalPassageIssue,
    InvalidVerticalPassage,
    vertical_passage_graph(),
    "vertical_passage_group_geometric_proximity",
    "vertical_passage_group_graph_proximity"
);

stale_edge_is_dropped_test!(
    invalid_vertical_passage_issue_silently_skips_a_stale_edge_id_absent_from_the_graph,
    InvalidVerticalPassageIssue,
    InvalidVerticalPassage,
    vertical_passage_graph(),
    "vertical_passage_group_geometric_proximity"
);
