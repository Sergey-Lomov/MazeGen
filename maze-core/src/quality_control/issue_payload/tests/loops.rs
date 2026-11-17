use super::*;

#[test]
fn invalid_loop_group_issue_resolves_flagged_cycle_edges_keyed_by_source_check() {
    let (graph, e1, e2, e3) = loop_graph();
    let scc = empty_scc();

    let cycle = vec![e1, e2, e3];
    let key = canonical_cycle_key(&cycle);
    let mut invalid_sources = HashMap::new();
    invalid_sources.insert(key, vec!["max_loop_density".to_string()]);
    let issue = InvalidLoopGroupIssue::new_from_check(
        "max_loop_density",
        vec![cycle],
        vec![],
        invalid_sources,
    );

    let payload = resolve(&issue, &graph, &scc);
    let_payload!(InvalidLoop { edges } = payload);
    assert_eq!(edges.len(), 1);
    let check1_cycles = &edges["max_loop_density"];
    assert_eq!(check1_cycles.len(), 1);
    let mut pairs = check1_cycles[0].edges.clone();
    pairs.sort();
    assert_eq!(pairs, vec![[1, 2], [2, 3], [3, 1]]);
    assert!(
        !check1_cycles[0].preset_locked,
        "no preset state given -- must not be locked"
    );
}

#[test]
fn invalid_loop_issue_resolves_flagged_cycle_edges_keyed_by_source_check() {
    let (graph, e1, e2, e3) = loop_graph();
    let scc = empty_scc();

    let cycle = vec![e1, e2, e3];
    let key = canonical_cycle_key(&cycle);
    let mut invalid_sources = HashMap::new();
    invalid_sources.insert(key, vec!["check1".to_string()]);
    let issue = InvalidLoopIssue::new_from_check("check1", vec![cycle], vec![0], invalid_sources);

    let payload = resolve(&issue, &graph, &scc);
    let_payload!(InvalidLoop { edges } = payload);
    assert_eq!(edges.len(), 1);
    let check1_cycles = &edges["check1"];
    assert_eq!(check1_cycles.len(), 1);
    let mut pairs = check1_cycles[0].edges.clone();
    pairs.sort();
    assert_eq!(pairs, vec![[1, 2], [2, 3], [3, 1]]);
}

#[test]
fn invalid_loop_issue_fans_a_shared_cycle_out_to_every_source_check() {
    let mut graph = Graph::new();
    graph.add_node(1);
    graph.add_node(2);
    let e1 = graph.add_edge(1, 2, EdgeKind::Basic);
    let e2 = graph.add_edge(2, 1, EdgeKind::Basic);
    let scc = empty_scc();

    let cycle = vec![e1, e2];
    let key = canonical_cycle_key(&cycle);
    let mut invalid_sources = HashMap::new();
    invalid_sources.insert(key, vec!["check1".to_string(), "check2".to_string()]);
    let issue = InvalidLoopIssue::new_from_check("check1", vec![cycle], vec![0], invalid_sources);

    let_payload!(InvalidLoop { edges } = resolve(&issue, &graph, &scc));
    assert_eq!(edges.len(), 2);
    assert!(edges.contains_key("check1"));
    assert!(edges.contains_key("check2"));
}

#[test]
fn invalid_loop_issue_marks_cycle_preset_locked_when_every_edge_is_preset_protected() {
    let (graph, e1, e2, e3) = loop_graph();
    let scc = empty_scc();

    let cycle = vec![e1, e2, e3];
    let key = canonical_cycle_key(&cycle);
    let mut invalid_sources = HashMap::new();
    invalid_sources.insert(key, vec!["check1".to_string()]);
    let issue = InvalidLoopIssue::new_from_check("check1", vec![cycle], vec![0], invalid_sources);

    let preset_state = preset_with_edges(&[(1, 2), (2, 3), (3, 1)]);

    let payload = resolve_with_preset(&issue, &graph, &scc, &preset_state);
    let_payload!(InvalidLoop { edges } = payload);
    assert!(
        edges["check1"][0].preset_locked,
        "every edge in the cycle is preset-protected"
    );
}

#[test]
fn invalid_loop_issue_not_preset_locked_when_only_part_of_the_cycle_is_protected() {
    let (graph, e1, e2, e3) = loop_graph();
    let scc = empty_scc();

    let cycle = vec![e1, e2, e3];
    let key = canonical_cycle_key(&cycle);
    let mut invalid_sources = HashMap::new();
    invalid_sources.insert(key, vec!["check1".to_string()]);
    let issue = InvalidLoopIssue::new_from_check("check1", vec![cycle], vec![0], invalid_sources);

    let preset_state = preset_with_edges(&[(1, 2), (2, 3)]);
    // (3, 1) intentionally left unprotected.

    let payload = resolve_with_preset(&issue, &graph, &scc, &preset_state);
    let_payload!(InvalidLoop { edges } = payload);
    assert!(
        !edges["check1"][0].preset_locked,
        "one unprotected edge is enough to keep the whole cycle fixable"
    );
}

#[test]
fn invalid_loop_issue_reports_preset_locked_per_element_not_per_issue() {
    // One issue, two flagged cycles -- one fully preset-locked, the other not. Both elements
    // must appear in the resolved payload with their own independent flag (GitHub issue #245:
    // granularity is per-element, not a single bool for the whole issue).
    let mut graph = Graph::new();
    graph.add_node(1);
    graph.add_node(2);
    graph.add_node(3);
    graph.add_node(4);
    graph.add_node(5);
    graph.add_node(6);
    let e1 = graph.add_edge(1, 2, EdgeKind::Basic);
    let e2 = graph.add_edge(2, 3, EdgeKind::Basic);
    let e3 = graph.add_edge(3, 1, EdgeKind::Basic);
    let e4 = graph.add_edge(4, 5, EdgeKind::Basic);
    let e5 = graph.add_edge(5, 6, EdgeKind::Basic);
    let e6 = graph.add_edge(6, 4, EdgeKind::Basic);
    let scc = empty_scc();

    let locked_cycle = vec![e1, e2, e3];
    let unlocked_cycle = vec![e4, e5, e6];
    let mut invalid_sources = HashMap::new();
    invalid_sources.insert(
        canonical_cycle_key(&locked_cycle),
        vec!["check1".to_string()],
    );
    invalid_sources.insert(
        canonical_cycle_key(&unlocked_cycle),
        vec!["check1".to_string()],
    );
    let issue = InvalidLoopIssue::new_from_check(
        "check1",
        vec![locked_cycle, unlocked_cycle],
        vec![0, 1],
        invalid_sources,
    );

    let preset_state = preset_with_edges(&[(1, 2), (2, 3), (3, 1)]);

    let payload = resolve_with_preset(&issue, &graph, &scc, &preset_state);
    let_payload!(InvalidLoop { edges } = payload);
    let elements = &edges["check1"];
    assert_eq!(elements.len(), 2);
    let locked_count = elements.iter().filter(|e| e.preset_locked).count();
    assert_eq!(
        locked_count, 1,
        "exactly one of the two cycles must be preset_locked"
    );
}

#[test]
fn resolve_edge_group_map_treats_empty_group_as_not_preset_locked() {
    // `Iterator::all` on an empty iterator is vacuously true -- `all_preset_locked` must guard
    // against that explicitly, since an element with zero edges can't meaningfully be "locked".
    let (graph, _) = empty_graph_and_scc();
    let preset_state = PresetState::empty();
    assert!(!all_preset_locked(&[], &graph, &preset_state));
}
