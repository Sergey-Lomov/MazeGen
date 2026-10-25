use super::super::issue::Issue;
use super::super::issue_kinds::*;
use super::super::repair_area::RepairArea;
use super::resolve_issue_payload;
use super::resolvers::*;
use super::types::*;
use crate::generation::PresetState;
use crate::graph::Graph;
use crate::graph::scc::ComponentId;
use crate::graph::scc::ConnectedComponents;
use crate::ids::IdGenerator;
use crate::ids::NodeId;
use crate::space::MultiLevelField;
use crate::space::{SquareTessellation, square_rect};
use std::collections::HashMap;
use std::sync::Arc;

fn empty_graph_and_scc() -> (Graph, ConnectedComponents) {
    let graph = Graph::new();
    let scc = ConnectedComponents {
        components: Vec::new(),
        node_component: HashMap::new(),
    };
    (graph, scc)
}

/// A `Field` big enough for every hand-built test graph's node ids to be meaningless within it
/// (tests that don't exercise `RegionNeedsExpansion` never call `Field::neighbors` on ids
/// outside it, so an arbitrary small field is a safe stand-in) — only region-expansion tests
/// build a field whose points actually correspond to their graph's nodes.
fn dummy_field() -> MultiLevelField<SquareTessellation> {
    let mut ids = IdGenerator::new();
    MultiLevelField::single_level(Arc::default(), square_rect(1, 1), &mut ids).unwrap()
}

fn resolve(issue: &dyn Issue, graph: &Graph, scc: &ConnectedComponents) -> IssuePayload {
    resolve_issue_payload(
        issue,
        graph,
        &dummy_field(),
        scc,
        &PresetState::empty(),
        None,
    )
}

#[test]
fn missing_endpoints_issue_resolves_to_none() {
    use crate::quality_control::MissingEndpointsIssue;
    let (graph, scc) = empty_graph_and_scc();
    let issue = MissingEndpointsIssue::new_from_check("check", true, true);
    assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
}

#[test]
fn invalid_loop_issue_with_no_flagged_cycles_resolves_to_none() {
    let (graph, scc) = empty_graph_and_scc();
    let issue = InvalidLoopIssue::new_from_check("check", vec![], vec![], HashMap::new());
    assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
}

#[test]
fn invalid_loop_group_issue_with_no_flagged_cycles_resolves_to_none() {
    let (graph, scc) = empty_graph_and_scc();
    let issue = InvalidLoopGroupIssue::new_from_check("check", vec![], vec![], HashMap::new());
    assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
}

#[test]
fn invalid_loop_group_issue_resolves_flagged_cycle_edges_keyed_by_source_check() {
    use crate::graph::EdgeKind;
    let mut graph = Graph::new();
    graph.add_node(1);
    graph.add_node(2);
    graph.add_node(3);
    let e1 = graph.add_edge(1, 2, EdgeKind::Basic);
    let e2 = graph.add_edge(2, 3, EdgeKind::Basic);
    let e3 = graph.add_edge(3, 1, EdgeKind::Basic);
    let (_, scc) = empty_graph_and_scc();

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
    let IssuePayload::InvalidLoop { edges } = payload else {
        panic!("expected InvalidLoop, got {payload:?}")
    };
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
fn region_needs_expansion_issue_with_no_flagged_regions_resolves_to_none() {
    let (graph, scc) = empty_graph_and_scc();
    let issue = RegionNeedsExpansionIssue::new_from_check("check", vec![], HashMap::new());
    assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
}

#[test]
fn invalid_loop_issue_resolves_flagged_cycle_edges_keyed_by_source_check() {
    use crate::graph::EdgeKind;
    let mut graph = Graph::new();
    graph.add_node(1);
    graph.add_node(2);
    graph.add_node(3);
    let e1 = graph.add_edge(1, 2, EdgeKind::Basic);
    let e2 = graph.add_edge(2, 3, EdgeKind::Basic);
    let e3 = graph.add_edge(3, 1, EdgeKind::Basic);
    let (_, scc) = empty_graph_and_scc();

    let cycle = vec![e1, e2, e3];
    let key = canonical_cycle_key(&cycle);
    let mut invalid_sources = HashMap::new();
    invalid_sources.insert(key, vec!["check1".to_string()]);
    let issue = InvalidLoopIssue::new_from_check("check1", vec![cycle], vec![0], invalid_sources);

    let payload = resolve(&issue, &graph, &scc);
    let IssuePayload::InvalidLoop { edges } = payload else {
        panic!("expected InvalidLoop, got {payload:?}")
    };
    assert_eq!(edges.len(), 1);
    let check1_cycles = &edges["check1"];
    assert_eq!(check1_cycles.len(), 1);
    let mut pairs = check1_cycles[0].edges.clone();
    pairs.sort();
    assert_eq!(pairs, vec![[1, 2], [2, 3], [3, 1]]);
}

#[test]
fn invalid_loop_issue_fans_a_shared_cycle_out_to_every_source_check() {
    use crate::graph::EdgeKind;
    let mut graph = Graph::new();
    graph.add_node(1);
    graph.add_node(2);
    let e1 = graph.add_edge(1, 2, EdgeKind::Basic);
    let e2 = graph.add_edge(2, 1, EdgeKind::Basic);
    let (_, scc) = empty_graph_and_scc();

    let cycle = vec![e1, e2];
    let key = canonical_cycle_key(&cycle);
    let mut invalid_sources = HashMap::new();
    invalid_sources.insert(key, vec!["check1".to_string(), "check2".to_string()]);
    let issue = InvalidLoopIssue::new_from_check("check1", vec![cycle], vec![0], invalid_sources);

    let IssuePayload::InvalidLoop { edges } = resolve(&issue, &graph, &scc) else {
        panic!("expected InvalidLoop")
    };
    assert_eq!(edges.len(), 2);
    assert!(edges.contains_key("check1"));
    assert!(edges.contains_key("check2"));
}

#[test]
fn invalid_loop_issue_marks_cycle_preset_locked_when_every_edge_is_preset_protected() {
    use crate::graph::EdgeKind;
    let mut graph = Graph::new();
    graph.add_node(1);
    graph.add_node(2);
    graph.add_node(3);
    let e1 = graph.add_edge(1, 2, EdgeKind::Basic);
    let e2 = graph.add_edge(2, 3, EdgeKind::Basic);
    let e3 = graph.add_edge(3, 1, EdgeKind::Basic);
    let (_, scc) = empty_graph_and_scc();

    let cycle = vec![e1, e2, e3];
    let key = canonical_cycle_key(&cycle);
    let mut invalid_sources = HashMap::new();
    invalid_sources.insert(key, vec!["check1".to_string()]);
    let issue = InvalidLoopIssue::new_from_check("check1", vec![cycle], vec![0], invalid_sources);

    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((1, 2));
    preset_state.preset_edges.insert((2, 3));
    preset_state.preset_edges.insert((3, 1));

    let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state, None);
    let IssuePayload::InvalidLoop { edges } = payload else {
        panic!("expected InvalidLoop, got {payload:?}")
    };
    assert!(
        edges["check1"][0].preset_locked,
        "every edge in the cycle is preset-protected"
    );
}

#[test]
fn invalid_loop_issue_not_preset_locked_when_only_part_of_the_cycle_is_protected() {
    use crate::graph::EdgeKind;
    let mut graph = Graph::new();
    graph.add_node(1);
    graph.add_node(2);
    graph.add_node(3);
    let e1 = graph.add_edge(1, 2, EdgeKind::Basic);
    let e2 = graph.add_edge(2, 3, EdgeKind::Basic);
    let e3 = graph.add_edge(3, 1, EdgeKind::Basic);
    let (_, scc) = empty_graph_and_scc();

    let cycle = vec![e1, e2, e3];
    let key = canonical_cycle_key(&cycle);
    let mut invalid_sources = HashMap::new();
    invalid_sources.insert(key, vec!["check1".to_string()]);
    let issue = InvalidLoopIssue::new_from_check("check1", vec![cycle], vec![0], invalid_sources);

    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((1, 2));
    preset_state.preset_edges.insert((2, 3));
    // (3, 1) intentionally left unprotected.

    let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state, None);
    let IssuePayload::InvalidLoop { edges } = payload else {
        panic!("expected InvalidLoop, got {payload:?}")
    };
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
    use crate::graph::EdgeKind;
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
    let (_, scc) = empty_graph_and_scc();

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

    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((1, 2));
    preset_state.preset_edges.insert((2, 3));
    preset_state.preset_edges.insert((3, 1));

    let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state, None);
    let IssuePayload::InvalidLoop { edges } = payload else {
        panic!("expected InvalidLoop, got {payload:?}")
    };
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

#[test]
fn region_needs_expansion_issue_resolves_flagged_region_node_ids_keyed_by_source_check() {
    let (graph, _) = empty_graph_and_scc();
    let scc = ConnectedComponents {
        components: vec![vec![1, 2, 3]],
        node_component: HashMap::from([(1, 0), (2, 0), (3, 0)]),
    };
    let mut invalid_sources = HashMap::new();
    invalid_sources.insert(0usize, vec!["check1".to_string()]);
    let issue = RegionNeedsExpansionIssue::new_from_check("check1", vec![0], invalid_sources);

    let payload = resolve(&issue, &graph, &scc);
    let IssuePayload::RegionNeedsExpansion { nodes } = payload else {
        panic!("expected RegionNeedsExpansion, got {payload:?}")
    };
    assert_eq!(nodes.len(), 1);
    let check1_regions = &nodes["check1"];
    assert_eq!(check1_regions.len(), 1);
    let mut region = check1_regions[0].region.clone();
    region.sort();
    assert_eq!(region, vec![1, 2, 3]);
    assert!(
        !check1_regions[0].preset_locked,
        "no preset state given -- must not be locked"
    );
}

#[test]
fn region_needs_shrink_issue_with_no_flagged_regions_resolves_to_none() {
    let (graph, scc) = empty_graph_and_scc();
    let issue = RegionNeedsShrinkIssue::new_from_check("check", vec![], HashMap::new());
    assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
}

#[test]
fn region_needs_shrink_issue_resolves_flagged_region_node_ids_keyed_by_source_check() {
    let (graph, _) = empty_graph_and_scc();
    let scc = ConnectedComponents {
        components: vec![vec![1, 2, 3]],
        node_component: HashMap::from([(1, 0), (2, 0), (3, 0)]),
    };
    let mut invalid_sources = HashMap::new();
    invalid_sources.insert(0usize, vec!["check1".to_string()]);
    let issue = RegionNeedsShrinkIssue::new_from_check("check1", vec![0], invalid_sources);

    let payload = resolve(&issue, &graph, &scc);
    let IssuePayload::RegionNeedsShrink { nodes } = payload else {
        panic!("expected RegionNeedsShrink, got {payload:?}")
    };
    assert_eq!(nodes.len(), 1);
    let check1_regions = &nodes["check1"];
    assert_eq!(check1_regions.len(), 1);
    let mut region = check1_regions[0].region.clone();
    region.sort();
    assert_eq!(region, vec![1, 2, 3]);
    assert!(
        !check1_regions[0].preset_locked,
        "no preset edges anywhere -- must not be locked (empty region has no edges to group)"
    );
}

fn teleport_graph() -> (Graph, crate::ids::EdgeId, crate::ids::EdgeId) {
    use crate::graph::EdgeKind;
    let mut graph = Graph::new();
    graph.add_node(1);
    graph.add_node(2);
    graph.add_node(3);
    let e1 = graph.add_edge(1, 2, EdgeKind::Teleport);
    let e2 = graph.add_edge(2, 3, EdgeKind::Teleport);
    (graph, e1, e2)
}

#[test]
fn invalid_teleport_issue_with_no_flagged_edges_resolves_to_none() {
    let (graph, scc) = empty_graph_and_scc();
    let issue = InvalidTeleportIssue::new_from_check("check", vec![]);
    assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
}

#[test]
fn invalid_teleport_issue_resolves_flagged_edge_as_one_element_group() {
    let (graph, e1, _) = teleport_graph();
    let (_, scc) = empty_graph_and_scc();
    let issue = InvalidTeleportIssue::new_from_check("teleport_duplicates_connection", vec![e1]);

    let payload = resolve(&issue, &graph, &scc);
    let IssuePayload::InvalidTeleport { groups } = payload else {
        panic!("expected InvalidTeleport, got {payload:?}")
    };
    assert_eq!(groups.len(), 1);
    let check1_groups = &groups["teleport_duplicates_connection"];
    assert_eq!(check1_groups.len(), 1);
    assert_eq!(check1_groups[0].edges, vec![[1, 2]]);
}

#[test]
fn invalid_teleport_group_issue_with_no_flagged_pairs_resolves_to_none() {
    let (graph, scc) = empty_graph_and_scc();
    let issue = InvalidTeleportGroupIssue::new_from_check("check", vec![]);
    assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
}

#[test]
fn invalid_teleport_group_issue_resolves_flagged_pair_as_two_element_group() {
    let (graph, e1, e2) = teleport_graph();
    let (_, scc) = empty_graph_and_scc();
    let issue = InvalidTeleportGroupIssue::new_from_check(
        "teleport_group_proximity",
        vec![(vec![e1, e2], 1)],
    );

    let payload = resolve(&issue, &graph, &scc);
    let IssuePayload::InvalidTeleport { groups } = payload else {
        panic!("expected InvalidTeleport, got {payload:?}")
    };
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
    use crate::graph::EdgeKind;
    let mut graph = Graph::new();
    for n in 1..=6 {
        graph.add_node(n);
    }
    let e1 = graph.add_edge(1, 2, EdgeKind::Teleport);
    let e2 = graph.add_edge(3, 4, EdgeKind::Teleport);
    let e3 = graph.add_edge(5, 6, EdgeKind::Teleport);
    let (_, scc) = empty_graph_and_scc();
    let issue = InvalidTeleportGroupIssue::new_from_check(
        "max_teleport_count",
        vec![(vec![e1, e2, e3], 2)],
    );

    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((1, 2));

    let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state, None);
    let IssuePayload::InvalidTeleport { groups } = payload else {
        panic!("expected InvalidTeleport, got {payload:?}")
    };
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
    use crate::graph::EdgeKind;
    let mut graph = Graph::new();
    for n in 1..=6 {
        graph.add_node(n);
    }
    let e1 = graph.add_edge(1, 2, EdgeKind::Teleport);
    let e2 = graph.add_edge(3, 4, EdgeKind::Teleport);
    let e3 = graph.add_edge(5, 6, EdgeKind::Teleport);
    let (_, scc) = empty_graph_and_scc();
    let issue = InvalidTeleportGroupIssue::new_from_check("rule_1:0", vec![(vec![e1, e2, e3], 2)]);

    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((1, 2));
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
    let IssuePayload::InvalidTeleport { groups } = payload else {
        panic!("expected InvalidTeleport, got {payload:?}")
    };
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
    use crate::graph::EdgeKind;
    let mut graph = Graph::new();
    for n in 1..=6 {
        graph.add_node(n);
    }
    let e1 = graph.add_edge(1, 2, EdgeKind::Teleport);
    let e2 = graph.add_edge(3, 4, EdgeKind::Teleport);
    let e3 = graph.add_edge(5, 6, EdgeKind::Teleport);
    let (_, scc) = empty_graph_and_scc();
    let issue = InvalidTeleportGroupIssue::new_from_check("rule_1:0", vec![(vec![e1, e2, e3], 2)]);

    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((1, 2));
    let check_types: HashMap<String, String> = HashMap::new();

    let payload = resolve_issue_payload(
        &issue,
        &graph,
        &dummy_field(),
        &scc,
        &preset_state,
        Some(&check_types),
    );
    let IssuePayload::InvalidTeleport { groups } = payload else {
        panic!("expected InvalidTeleport, got {payload:?}")
    };
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
fn invalid_teleport_issue_merged_from_two_checks_attributes_each_edge_to_only_its_own_check() {
    // GitHub issue #195's follow-up: teleport_duplicates_connection flags e1,
    // teleport_waypoint_distance flags e2 -- after merge, hovering one check's bubble must
    // highlight only the edge that check actually flagged, not both.
    use crate::quality_control::issue::IssueMerge;
    let (graph, e1, e2) = teleport_graph();
    let (_, scc) = empty_graph_and_scc();
    let mut issue =
        InvalidTeleportIssue::new_from_check("teleport_duplicates_connection", vec![e1]);
    issue.merge(InvalidTeleportIssue::new_from_check(
        "teleport_waypoint_distance",
        vec![e2],
    ));

    let payload = resolve(&issue, &graph, &scc);
    let IssuePayload::InvalidTeleport { groups } = payload else {
        panic!("expected InvalidTeleport, got {payload:?}")
    };
    assert_eq!(
        groups["teleport_duplicates_connection"][0].edges,
        vec![[1, 2]],
        "must not include e2"
    );
    assert_eq!(
        groups["teleport_waypoint_distance"][0].edges,
        vec![[2, 3]],
        "must not include e1"
    );
}

#[test]
fn invalid_teleport_issue_silently_skips_a_stale_edge_id_absent_from_the_graph() {
    // A flagged EdgeId that no longer resolves in `graph` (e.g. removed by a repair mutation
    // between the check running and the payload being resolved) must be dropped, not panic.
    let (graph, e1, _) = teleport_graph();
    let (_, scc) = empty_graph_and_scc();
    let stale_id = e1 + 1000;
    let issue =
        InvalidTeleportIssue::new_from_check("teleport_duplicates_connection", vec![e1, stale_id]);

    let payload = resolve(&issue, &graph, &scc);
    let IssuePayload::InvalidTeleport { groups } = payload else {
        panic!("expected InvalidTeleport, got {payload:?}")
    };
    assert_eq!(
        groups["teleport_duplicates_connection"][0].edges,
        vec![[1, 2]],
        "stale edge id must be dropped, not panic"
    );
}

#[test]
fn invalid_teleport_group_issue_silently_skips_a_group_with_a_stale_edge_id() {
    let (graph, e1, _) = teleport_graph();
    let (_, scc) = empty_graph_and_scc();
    let stale_id = e1 + 1000;
    let issue = InvalidTeleportGroupIssue::new_from_check(
        "teleport_group_proximity",
        vec![(vec![e1, stale_id], 1)],
    );

    let payload = resolve(&issue, &graph, &scc);
    let IssuePayload::InvalidTeleport { groups } = payload else {
        panic!("expected InvalidTeleport, got {payload:?}")
    };
    assert_eq!(
        groups["teleport_group_proximity"][0].edges,
        vec![[1, 2]],
        "the stale edge id must be dropped, not panic, leaving only the resolvable edge"
    );
}

fn one_way_graph() -> (Graph, crate::ids::EdgeId, crate::ids::EdgeId) {
    use crate::graph::EdgeKind;
    let mut graph = Graph::new();
    graph.add_node(1);
    graph.add_node(2);
    graph.add_node(3);
    let e1 = graph.add_edge(1, 2, EdgeKind::Basic);
    let e2 = graph.add_edge(2, 3, EdgeKind::Basic);
    (graph, e1, e2)
}

#[test]
fn invalid_one_way_issue_with_no_flagged_edges_resolves_to_none() {
    let (graph, scc) = empty_graph_and_scc();
    let issue = InvalidOneWayIssue::new_from_check("check", vec![]);
    assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
}

#[test]
fn invalid_one_way_issue_resolves_flagged_edge_as_one_element_group() {
    let (graph, e1, _) = one_way_graph();
    let (_, scc) = empty_graph_and_scc();
    let issue = InvalidOneWayIssue::new_from_check("one_way_waypoint_distance", vec![e1]);

    let payload = resolve(&issue, &graph, &scc);
    let IssuePayload::InvalidOneWay { groups } = payload else {
        panic!("expected InvalidOneWay, got {payload:?}")
    };
    assert_eq!(groups.len(), 1);
    assert_eq!(groups["one_way_waypoint_distance"][0].edges, vec![[1, 2]]);
}

#[test]
fn invalid_one_way_issue_silently_skips_a_stale_edge_id_absent_from_the_graph() {
    let (graph, e1, _) = one_way_graph();
    let (_, scc) = empty_graph_and_scc();
    let stale_id = e1 + 1000;
    let issue = InvalidOneWayIssue::new_from_check("one_way_waypoint_distance", vec![e1, stale_id]);

    let payload = resolve(&issue, &graph, &scc);
    let IssuePayload::InvalidOneWay { groups } = payload else {
        panic!("expected InvalidOneWay, got {payload:?}")
    };
    assert_eq!(
        groups["one_way_waypoint_distance"][0].edges,
        vec![[1, 2]],
        "stale edge id must be dropped, not panic"
    );
}

#[test]
fn invalid_one_way_issue_preset_locked_only_when_forward_direction_is_the_actual_preset_direction()
{
    // GitHub issue #245: a one-way preset only ever occupies one direction (`preset_edges`
    // stores the exact directed pair, `blocked` covers the reverse) -- the resolver must not
    // treat the flagged forward edge as locked when the "protection" it's checking against is
    // actually the reverse direction's `blocked` entry, not a `preset_edges` membership.
    let (graph, e1, _) = one_way_graph();
    let (_, scc) = empty_graph_and_scc();
    let issue = InvalidOneWayIssue::new_from_check("one_way_waypoint_distance", vec![e1]);

    // Only the reverse direction is "protected" (as `blocked`, mirroring a real OneWayForward
    // preset's own bookkeeping) -- the forward edge itself (1 -> 2) is not in `preset_edges`.
    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((2, 1));

    let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state, None);
    let IssuePayload::InvalidOneWay { groups } = payload else {
        panic!("expected InvalidOneWay, got {payload:?}")
    };
    assert!(
        !groups["one_way_waypoint_distance"][0].preset_locked,
        "reverse-direction blocked must not count as this edge being preset-protected"
    );

    // Now actually protect the flagged direction -- must become locked.
    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((1, 2));
    let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state, None);
    let IssuePayload::InvalidOneWay { groups } = payload else {
        panic!("expected InvalidOneWay, got {payload:?}")
    };
    assert!(
        groups["one_way_waypoint_distance"][0].preset_locked,
        "the actual preset direction must be reported locked"
    );
}

#[test]
fn invalid_one_way_group_issue_with_no_flagged_groups_resolves_to_none() {
    let (graph, scc) = empty_graph_and_scc();
    let issue = InvalidOneWayGroupIssue::new_from_check("check", vec![]);
    assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
}

#[test]
fn invalid_one_way_group_issue_resolves_flagged_group_edges() {
    let (graph, e1, e2) = one_way_graph();
    let (_, scc) = empty_graph_and_scc();
    let issue = InvalidOneWayGroupIssue::new_from_check(
        "one_way_group_graph_proximity",
        vec![(vec![e1, e2], 1)],
    );

    let payload = resolve(&issue, &graph, &scc);
    let IssuePayload::InvalidOneWay { groups } = payload else {
        panic!("expected InvalidOneWay, got {payload:?}")
    };
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
    let (_, scc) = empty_graph_and_scc();
    let stale_id = e2 + 1000;
    let issue = InvalidOneWayGroupIssue::new_from_check(
        "one_way_group_graph_proximity",
        vec![(vec![e1, stale_id], 1)],
    );

    let payload = resolve(&issue, &graph, &scc);
    let IssuePayload::InvalidOneWay { groups } = payload else {
        panic!("expected InvalidOneWay, got {payload:?}")
    };
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
    let (_, scc) = empty_graph_and_scc();
    let issue = InvalidOneWayGroupIssue::new_from_check(
        "one_way_group_graph_proximity",
        vec![(vec![e1, e2], 1)],
    );

    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((1, 2));
    preset_state.preset_edges.insert((2, 3));

    let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state, None);
    let IssuePayload::InvalidOneWay { groups } = payload else {
        panic!("expected InvalidOneWay, got {payload:?}")
    };
    assert!(
        groups["one_way_group_graph_proximity"][0].preset_locked,
        "to_remove=1 must not exempt the group from being fully locked when both edges are protected"
    );
}

#[test]
fn invalid_split_node_connection_group_issue_carries_preset_locked_through_the_invalid_one_way_reuse()
 {
    // GitHub issue #245: `InvalidSplitNodeConnectionGroupIssue` reuses the `InvalidOneWay`
    // wire variant (see `resolve_issue_payload`'s doc comment on that arm) -- confirms the
    // preset_locked migration wasn't silently dropped for this reused kind.
    use crate::quality_control::issue_kinds::InvalidSplitNodeConnectionGroupIssue;
    let (graph, e1, e2) = one_way_graph();
    let (_, scc) = empty_graph_and_scc();
    let issue = InvalidSplitNodeConnectionGroupIssue::new_from_check(
        "split_node_connection_per_neighbor",
        vec![(vec![e1, e2], 1)],
    );

    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((1, 2));
    preset_state.preset_edges.insert((2, 3));

    let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state, None);
    let IssuePayload::InvalidOneWay { groups } = payload else {
        panic!("expected InvalidOneWay (reused wire shape), got {payload:?}")
    };
    assert!(groups["split_node_connection_per_neighbor"][0].preset_locked);
}

#[test]
fn invalid_split_route_issue_with_no_flagged_routes_resolves_to_none() {
    let (graph, scc) = empty_graph_and_scc();
    let issue = InvalidSplitRouteIssue::new_from_check("check", vec![]);
    assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
}

#[test]
fn invalid_split_route_issue_resolves_flagged_route_edges_keyed_by_source_check() {
    use crate::graph::EdgeKind;
    let mut graph = Graph::new();
    graph.add_node(1);
    graph.add_node(2);
    graph.add_node(3);
    let e0 = graph.add_edge(1, 2, EdgeKind::Basic);
    let e1 = graph.add_edge(2, 3, EdgeKind::Basic);
    let (_, scc) = empty_graph_and_scc();

    let route: Vec<SplitRouteEdge> = vec![(e0, true), (e1, false)];
    let issue = InvalidSplitRouteIssue::new_from_check(
        "split_node_connection_traversal_distance",
        vec![route],
    );

    let payload = resolve(&issue, &graph, &scc);
    let IssuePayload::InvalidSplitRoute { routes } = payload else {
        panic!("expected InvalidSplitRoute, got {payload:?}")
    };
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
    use crate::graph::EdgeKind;
    let mut graph = Graph::new();
    graph.add_node(1);
    graph.add_node(2);
    graph.add_node(3);
    let e0 = graph.add_edge(1, 2, EdgeKind::Basic);
    let e2 = graph.add_edge(2, 3, EdgeKind::Basic);
    let (_, scc) = empty_graph_and_scc();
    let stale_id = e2 + 1000;

    let route: Vec<SplitRouteEdge> = vec![(e0, true), (stale_id, false), (e2, true)];
    let issue = InvalidSplitRouteIssue::new_from_check("check", vec![route]);

    let payload = resolve(&issue, &graph, &scc);
    let IssuePayload::InvalidSplitRoute { routes } = payload else {
        panic!("expected InvalidSplitRoute, got {payload:?}")
    };
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
    use crate::graph::EdgeKind;
    let mut graph = Graph::new();
    graph.add_node(1);
    graph.add_node(2);
    graph.add_edge(1, 2, EdgeKind::Basic);
    (graph, 1, 2)
}

#[test]
fn invalid_split_node_issue_marks_node_preset_locked_via_is_node_locked_for_removal() {
    let (graph, split_node, _other) = split_node_graph();
    let (_, scc) = empty_graph_and_scc();
    let issue =
        InvalidSplitNodeIssue::new_from_check("split_node_connection_count", vec![split_node]);

    // `preset_locked` now mirrors `remove_node_feasible`'s own predicate (GitHub issue #245's
    // review fix) -- a preset edge touching the node blocks removal regardless of whether the
    // node is also `preset_declared` (minted by a preset `split_points` entry).
    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((1, 2));

    let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state, None);
    let IssuePayload::InvalidSplitTile { groups } = payload else {
        panic!("expected InvalidSplitTile (reused shape), got {payload:?}")
    };
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
    let (_, scc) = empty_graph_and_scc();
    let issue =
        InvalidSplitNodeIssue::new_from_check("split_node_connection_count", vec![split_node]);

    // No preset edge touches the node, and it isn't locked_out/locked_in either -- repair can
    // freely remove it.
    let preset_state = PresetState::empty();

    let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state, None);
    let IssuePayload::InvalidSplitTile { groups } = payload else {
        panic!("expected InvalidSplitTile (reused shape), got {payload:?}")
    };
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
    let (_, scc) = empty_graph_and_scc();
    let issue = InvalidSplitNodeGroupIssue::new_from_check(
        "split_tile_node_count",
        vec![(vec![split_node, other], 1)],
    );

    // Only the (1, 2) direction is preset-protected -- both endpoints of that directed edge
    // are touched by `preset_edges`, so the whole tile is locked.
    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((1, 2));

    let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state, None);
    let IssuePayload::InvalidSplitTile { groups } = payload else {
        panic!("expected InvalidSplitTile (reused shape), got {payload:?}")
    };
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
    let (_, scc) = empty_graph_and_scc();
    let tile = SplitTileNodes::new(vec![base]);
    let issue = InvalidSplitTileIssue::new_from_check("split_distance_from_waypoint", vec![tile]);

    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((1, 2)); // touches `base` (id 1), never declared

    let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state, None);
    let IssuePayload::InvalidSplitTile { groups } = payload else {
        panic!("expected InvalidSplitTile, got {payload:?}")
    };
    assert!(groups["split_distance_from_waypoint"][0].preset_locked);
}

#[test]
fn invalid_split_tile_issue_not_preset_locked_when_no_node_is_removal_locked() {
    let (graph, base, _other) = split_node_graph();
    let (_, scc) = empty_graph_and_scc();
    let tile = SplitTileNodes::new(vec![base]);
    let issue = InvalidSplitTileIssue::new_from_check("split_distance_from_waypoint", vec![tile]);

    let payload = resolve_issue_payload(
        &issue,
        &graph,
        &dummy_field(),
        &scc,
        &PresetState::empty(),
        None,
    );
    let IssuePayload::InvalidSplitTile { groups } = payload else {
        panic!("expected InvalidSplitTile, got {payload:?}")
    };
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
    let (_, scc) = empty_graph_and_scc();
    let tile_a = SplitTileNodes::new(vec![1, 2]);
    let tile_b = SplitTileNodes::new(vec![3, 4]);
    let issue =
        InvalidSplitTileIssue::new_from_check("split_distance_from_waypoint", vec![tile_a, tile_b]);

    let payload = resolve_issue_payload(
        &issue,
        &graph,
        &dummy_field(),
        &scc,
        &PresetState::empty(),
        None,
    );
    let IssuePayload::InvalidSplitTile { groups } = payload else {
        panic!("expected InvalidSplitTile, got {payload:?}")
    };
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
    let (_, scc) = empty_graph_and_scc();
    let tile_a = SplitTileNodes::new(vec![1, 2]);
    let tile_b = SplitTileNodes::new(vec![3, 4]);
    let issue = InvalidSplitTileGroupIssue::new_from_check(
        "split_group_geometric_proximity",
        vec![(vec![tile_a.clone(), tile_b.clone()], 1)],
    );

    // Only node 1 is preset-locked (touches a preset edge) -- tile_a is NOT fully locked (node
    // 2 isn't), so the whole group must not be locked either, even though it contains a locked
    // node.
    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((1, 3));

    let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state, None);
    let IssuePayload::InvalidSplitTile { groups } = payload else {
        panic!("expected InvalidSplitTile, got {payload:?}")
    };
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
    let (_, scc) = empty_graph_and_scc();
    let tile_a = SplitTileNodes::new(vec![1]);
    let tile_b = SplitTileNodes::new(vec![2]);
    let issue = InvalidSplitTileGroupIssue::new_from_check(
        "split_group_geometric_proximity",
        vec![(vec![tile_a, tile_b], 1)],
    );

    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((1, 2));

    let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state, None);
    let IssuePayload::InvalidSplitTile { groups } = payload else {
        panic!("expected InvalidSplitTile, got {payload:?}")
    };
    assert!(groups["split_group_geometric_proximity"][0].preset_locked);
}

#[test]
fn invalid_split_route_issue_preset_locked_when_every_route_edge_is_protected() {
    let (graph, a, b) = split_node_graph();
    let (_, scc) = empty_graph_and_scc();
    let eid = graph.edge_between(a, b).unwrap();
    let route: Vec<SplitRouteEdge> = vec![(eid, true)];
    let issue = InvalidSplitRouteIssue::new_from_check(
        "split_node_connection_traversal_distance",
        vec![route],
    );

    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((a, b));

    let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state, None);
    let IssuePayload::InvalidSplitRoute { routes } = payload else {
        panic!("expected InvalidSplitRoute, got {payload:?}")
    };
    assert!(routes["split_node_connection_traversal_distance"][0].preset_locked);
}

#[test]
fn invalid_split_route_issue_preset_locked_is_independent_of_is_split_edge() {
    // GitHub issue #245's split-route extension: `is_split_edge` is purely a render flag and
    // must not influence `preset_locked` -- an edge flagged `is_split_edge: true` that is NOT
    // preset-protected, mixed with other protected edges, must still resolve `preset_locked`
    // to false for the whole route, and `is_split_edge` must survive unmodified in the output.
    use crate::graph::EdgeKind;
    let mut graph = Graph::new();
    graph.add_node(1);
    graph.add_node(2);
    graph.add_node(3);
    let e1 = graph.add_edge(1, 2, EdgeKind::Basic);
    let e2 = graph.add_edge(2, 3, EdgeKind::Basic);
    let (_, scc) = empty_graph_and_scc();

    let route: Vec<SplitRouteEdge> = vec![(e1, true), (e2, false)];
    let issue = InvalidSplitRouteIssue::new_from_check("check", vec![route]);

    let mut preset_state = PresetState::empty();
    // Only e2 (1,2)->(2,3) is protected; e1 (is_split_edge: true) is not.
    preset_state.preset_edges.insert((2, 3));

    let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state, None);
    let IssuePayload::InvalidSplitRoute { routes } = payload else {
        panic!("expected InvalidSplitRoute, got {payload:?}")
    };
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

// --- Region preset_locked support (extends GitHub issue #245 to region-based issue kinds:
// region_needs_expansion, region_needs_shrink) ---

fn region_scc(region: Vec<NodeId>) -> ConnectedComponents {
    let node_component = region.iter().map(|&id| (id, 0)).collect();
    ConnectedComponents {
        components: vec![region],
        node_component,
    }
}

/// Like `region_scc`, but also registers `external` nodes in a second component — a real SCC
/// maps every graph node to *some* component, and `region_preset_locked_for_expansion` skips
/// any neighbor missing from `node_component` entirely (treats it as "outside the graph"), so
/// expansion tests need their boundary neighbor actually registered, not just the region itself.
fn region_scc_with_external(region: Vec<NodeId>, external: &[NodeId]) -> ConnectedComponents {
    let mut node_component: HashMap<NodeId, ComponentId> =
        region.iter().map(|&id| (id, 0)).collect();
    for &id in external {
        node_component.insert(id, 1);
    }
    ConnectedComponents {
        components: vec![region, external.to_vec()],
        node_component,
    }
}

fn triangle_graph() -> (Graph, [NodeId; 3]) {
    use crate::graph::EdgeKind;
    let mut graph = Graph::new();
    graph.add_node(1);
    graph.add_node(2);
    graph.add_node(3);
    graph.add_edge(1, 2, EdgeKind::Basic);
    graph.add_edge(2, 1, EdgeKind::Basic);
    graph.add_edge(2, 3, EdgeKind::Basic);
    graph.add_edge(3, 2, EdgeKind::Basic);
    graph.add_edge(3, 1, EdgeKind::Basic);
    graph.add_edge(1, 3, EdgeKind::Basic);
    (graph, [1, 2, 3])
}

#[test]
fn region_needs_shrink_locked_when_the_only_cut_set_is_entirely_preset_protected() {
    // Every edge preset-protected -> group_by_unremovable_edges collapses the whole region into
    // one group (len < 2) -- mirrors region_shrink_split::split_region's own None/Failed signal.
    let (graph, [a, b, c]) = triangle_graph();
    let scc = region_scc(vec![a, b, c]);
    let mut invalid_sources = HashMap::new();
    invalid_sources.insert(0usize, vec!["check1".to_string()]);
    let issue = RegionNeedsShrinkIssue::new_from_check("check1", vec![0], invalid_sources);

    let mut preset_state = PresetState::empty();
    for &(x, y) in &[(a, b), (b, a), (b, c), (c, b), (c, a), (a, c)] {
        preset_state.preset_edges.insert((x, y));
    }

    let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state, None);
    let IssuePayload::RegionNeedsShrink { nodes } = payload else {
        panic!("expected RegionNeedsShrink, got {payload:?}")
    };
    assert!(nodes["check1"][0].preset_locked);
}

#[test]
fn region_needs_shrink_not_locked_when_a_one_directional_preset_pair_leaves_the_reverse_cuttable() {
    // `(A,B)` preset-protected, but `(B,A)` (the same physical passage's reverse direction) is
    // NOT -- `is_preset_edge` is directed-only, so `group_by_unremovable_edges` (which walks
    // `graph.outgoing_neighbors` and calls the predicate in that exact direction) must still see
    // this edge as removable via its un-protected direction, keeping the region splittable.
    let (graph, [a, b, c]) = triangle_graph();
    let scc = region_scc(vec![a, b, c]);
    let mut invalid_sources = HashMap::new();
    invalid_sources.insert(0usize, vec!["check1".to_string()]);
    let issue = RegionNeedsShrinkIssue::new_from_check("check1", vec![0], invalid_sources);

    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((a, b));
    // (b, a), (b, c)/(c, b), (c, a)/(a, c) intentionally left unprotected.

    let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state, None);
    let IssuePayload::RegionNeedsShrink { nodes } = payload else {
        panic!("expected RegionNeedsShrink, got {payload:?}")
    };
    assert!(
        !nodes["check1"][0].preset_locked,
        "the unprotected (b,a) direction keeps a cut available"
    );
}

#[test]
fn region_needs_shrink_not_locked_when_a_cut_through_a_non_preset_edge_exists() {
    // Only one of the triangle's three passages is preset-protected -- group_by_unremovable_edges
    // still finds >= 2 groups (the other two passages are cuttable), so the region is NOT locked.
    let (graph, [a, b, c]) = triangle_graph();
    let scc = region_scc(vec![a, b, c]);
    let mut invalid_sources = HashMap::new();
    invalid_sources.insert(0usize, vec!["check1".to_string()]);
    let issue = RegionNeedsShrinkIssue::new_from_check("check1", vec![0], invalid_sources);

    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((a, b));
    preset_state.preset_edges.insert((b, a));

    let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state, None);
    let IssuePayload::RegionNeedsShrink { nodes } = payload else {
        panic!("expected RegionNeedsShrink, got {payload:?}")
    };
    assert!(!nodes["check1"][0].preset_locked);
}

#[test]
fn region_needs_shrink_criterion_matches_split_region_s_own_none_condition() {
    // Regression: `region_preset_locked_for_shrink`'s `groups.len() < 2` must stay identical to
    // `region_shrink_split::split_region`'s own None/Failed condition -- both evaluated on the
    // same graph/region/preset_state here and compared directly.
    use crate::Maze;
    use crate::space::{MultiLevelField, SquareTessellation, square_rect};
    let (graph, [a, b, c]) = triangle_graph();
    let region = vec![a, b, c];

    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(1, 1), &mut ids).unwrap();
    let maze = Maze::new(field, graph.clone());

    let mut preset_state = PresetState::empty();
    for &(x, y) in &[(a, b), (b, a), (b, c), (c, b), (c, a), (a, c)] {
        preset_state.preset_edges.insert((x, y));
    }

    let resolver_locked = region_preset_locked_for_shrink(&graph, &region, &preset_state);
    let split_region_failed = crate::repair::strategies::region_shrink_split::split_region(
        &maze,
        &region,
        &preset_state,
        false,
    )
    .is_none();
    assert_eq!(
        resolver_locked, split_region_failed,
        "resolver's preset_locked must agree with split_region's None/Failed signal"
    );
    assert!(
        resolver_locked,
        "sanity: this fixture is fully preset-protected"
    );
}

/// 2x1 field: two adjacent points, each with one node -- the region is just node `a`, its only
/// geometric neighbor is `b` (outside the region). Used by every expansion test below.
fn two_point_field_and_region() -> (
    MultiLevelField<crate::space::SquareTessellation>,
    Graph,
    NodeId,
    NodeId,
) {
    use crate::space::{MultiLevelField, SquareTessellation, square_rect};
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(2, 1), &mut ids).unwrap();
    let mut graph = Graph::new();
    for node in field.all_node_ids() {
        graph.add_node(node);
    }
    let level = field.single_level_id();
    let a = field
        .node_at(level, crate::space::SquarePoint { x: 0, y: 0 })
        .unwrap();
    let b = field
        .node_at(level, crate::space::SquarePoint { x: 1, y: 0 })
        .unwrap();
    (field, graph, a, b)
}

#[test]
fn region_needs_expansion_not_locked_when_region_has_no_external_geometric_boundary() {
    // A region spanning the whole field has no neighbor outside itself -- has_boundary stays
    // false, so it must NOT be reported preset_locked (a different, non-preset problem).
    use crate::space::{MultiLevelField, SquareTessellation, square_rect};
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(1, 1), &mut ids).unwrap();
    let mut graph = Graph::new();
    for node in field.all_node_ids() {
        graph.add_node(node);
    }
    let level = field.single_level_id();
    let a = field
        .node_at(level, crate::space::SquarePoint { x: 0, y: 0 })
        .unwrap();
    let scc = region_scc(vec![a]);
    let mut invalid_sources = HashMap::new();
    invalid_sources.insert(0usize, vec!["check1".to_string()]);
    let issue = RegionNeedsExpansionIssue::new_from_check("check1", vec![0], invalid_sources);

    let payload = resolve_issue_payload(&issue, &graph, &field, &scc, &PresetState::empty(), None);
    let IssuePayload::RegionNeedsExpansion { nodes } = payload else {
        panic!("expected RegionNeedsExpansion, got {payload:?}")
    };
    assert!(!nodes["check1"][0].preset_locked);
}

#[test]
fn region_needs_expansion_not_locked_when_at_least_one_boundary_is_free() {
    let (field, graph, a, b) = two_point_field_and_region();
    let scc = region_scc_with_external(vec![a], &[b]);
    let mut invalid_sources = HashMap::new();
    invalid_sources.insert(0usize, vec!["check1".to_string()]);
    let issue = RegionNeedsExpansionIssue::new_from_check("check1", vec![0], invalid_sources);

    // No preset at all -- the boundary to b is free.
    let payload = resolve_issue_payload(&issue, &graph, &field, &scc, &PresetState::empty(), None);
    let IssuePayload::RegionNeedsExpansion { nodes } = payload else {
        panic!("expected RegionNeedsExpansion, got {payload:?}")
    };
    assert!(!nodes["check1"][0].preset_locked);
}

#[test]
fn region_needs_expansion_locked_when_every_boundary_is_wall_blocked() {
    let (field, graph, a, b) = two_point_field_and_region();
    let scc = region_scc_with_external(vec![a], &[b]);
    let mut invalid_sources = HashMap::new();
    invalid_sources.insert(0usize, vec!["check1".to_string()]);
    let issue = RegionNeedsExpansionIssue::new_from_check("check1", vec![0], invalid_sources);

    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((a, b));
    preset_state.blocked.insert((b, a));

    let payload = resolve_issue_payload(&issue, &graph, &field, &scc, &preset_state, None);
    let IssuePayload::RegionNeedsExpansion { nodes } = payload else {
        panic!("expected RegionNeedsExpansion, got {payload:?}")
    };
    assert!(nodes["check1"][0].preset_locked);
}

#[test]
fn region_needs_expansion_locked_when_every_boundary_is_locked_out_or_in_not_wall() {
    // Confirms the criterion is `PresetState` as a whole, not just `blocked`/Wall.
    let (field, graph, a, b) = two_point_field_and_region();
    let scc = region_scc_with_external(vec![a], &[b]);
    let mut invalid_sources = HashMap::new();
    invalid_sources.insert(0usize, vec!["check1".to_string()]);
    let issue = RegionNeedsExpansionIssue::new_from_check("check1", vec![0], invalid_sources);

    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(a);
    preset_state.locked_in.insert(a);

    let payload = resolve_issue_payload(&issue, &graph, &field, &scc, &preset_state, None);
    let IssuePayload::RegionNeedsExpansion { nodes } = payload else {
        panic!("expected RegionNeedsExpansion, got {payload:?}")
    };
    assert!(nodes["check1"][0].preset_locked);
}

#[test]
fn region_needs_expansion_locked_via_asymmetric_locked_out_in_across_both_directions() {
    // `locked_out` on the region side, `locked_in` on the external side (different directions,
    // different nodes) -- confirms `bidirectional_edge_feasible`'s symmetry: both fwd_blocked
    // and bwd_blocked are evaluated regardless of which side each lock sits on.
    let (field, graph, a, b) = two_point_field_and_region();
    let scc = region_scc_with_external(vec![a], &[b]);
    let mut invalid_sources = HashMap::new();
    invalid_sources.insert(0usize, vec!["check1".to_string()]);
    let issue = RegionNeedsExpansionIssue::new_from_check("check1", vec![0], invalid_sources);

    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(a);
    preset_state.locked_in.insert(b);

    let payload = resolve_issue_payload(&issue, &graph, &field, &scc, &preset_state, None);
    let IssuePayload::RegionNeedsExpansion { nodes } = payload else {
        panic!("expected RegionNeedsExpansion, got {payload:?}")
    };
    assert!(nodes["check1"][0].preset_locked);
}

fn excessive_scc_count_issue(check: &str, max_scc_count: u32) -> ExcessiveSccCountIssue {
    ExcessiveSccCountIssue::new_from_check(check, max_scc_count)
}

#[test]
fn excessive_scc_count_not_locked_with_no_preset_state() {
    let (field, graph, a, b) = two_point_field_and_region();
    let scc = region_scc_with_external(vec![a], &[b]);
    let issue = excessive_scc_count_issue("check1", 1);

    let payload = resolve_issue_payload(&issue, &graph, &field, &scc, &PresetState::empty(), None);
    let IssuePayload::ExcessiveSccCount { preset_locked } = payload else {
        panic!("expected ExcessiveSccCount, got {payload:?}")
    };
    assert!(!preset_locked["check1"]);
}

#[test]
fn excessive_scc_count_not_locked_when_only_one_region_is_preset_locked() {
    // Both regions must be locked for the whole issue to be locked -- `ReduceSccCountStrategy`
    // can pick either region as a merge target, so one free region is enough to unstick repair.
    // 3x1 field, one node per point: three separate regions a/b/c in a row. Only the a<->b
    // boundary is blocked -- b's other boundary (to c) stays free, so b (and c) remain unlocked
    // even though a is fully locked.
    use crate::space::{MultiLevelField, SquareTessellation, square_rect};
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
    let mut graph = Graph::new();
    for node in field.all_node_ids() {
        graph.add_node(node);
    }
    let level = field.single_level_id();
    let a = field
        .node_at(level, crate::space::SquarePoint { x: 0, y: 0 })
        .unwrap();
    let b = field
        .node_at(level, crate::space::SquarePoint { x: 1, y: 0 })
        .unwrap();
    let c = field
        .node_at(level, crate::space::SquarePoint { x: 2, y: 0 })
        .unwrap();
    let node_component = HashMap::from([(a, 0), (b, 1), (c, 2)]);
    let scc = ConnectedComponents {
        components: vec![vec![a], vec![b], vec![c]],
        node_component,
    };
    let issue = excessive_scc_count_issue("check1", 1);

    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((a, b));
    preset_state.blocked.insert((b, a));

    let payload = resolve_issue_payload(&issue, &graph, &field, &scc, &preset_state, None);
    let IssuePayload::ExcessiveSccCount { preset_locked } = payload else {
        panic!("expected ExcessiveSccCount, got {payload:?}")
    };
    assert!(!preset_locked["check1"]);
}

#[test]
fn excessive_scc_count_locked_when_every_region_is_preset_locked() {
    let (field, graph, a, b) = two_point_field_and_region();
    let scc = region_scc_with_external(vec![a], &[b]);
    let issue = excessive_scc_count_issue("check1", 1);

    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((a, b));
    preset_state.blocked.insert((b, a));
    // `field.neighbors(b)` also sees `a` as its only neighbor, and it's blocked both ways too,
    // so `b`'s region is equally locked -- both of the field's two regions are stuck.

    let payload = resolve_issue_payload(&issue, &graph, &field, &scc, &preset_state, None);
    let IssuePayload::ExcessiveSccCount { preset_locked } = payload else {
        panic!("expected ExcessiveSccCount, got {payload:?}")
    };
    assert!(preset_locked["check1"]);
}

fn vertical_passage_graph() -> (Graph, crate::ids::EdgeId, crate::ids::EdgeId) {
    use crate::graph::EdgeKind;
    let mut graph = Graph::new();
    graph.add_node(1);
    graph.add_node(2);
    graph.add_node(3);
    let e1 = graph.add_edge(1, 2, EdgeKind::VerticalPassage);
    let e2 = graph.add_edge(2, 3, EdgeKind::VerticalPassage);
    (graph, e1, e2)
}

#[test]
fn invalid_vertical_passage_issue_with_no_flagged_edges_resolves_to_none() {
    let (graph, scc) = empty_graph_and_scc();
    let issue = InvalidVerticalPassageIssue::new_from_check("check", vec![]);
    assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
}

#[test]
fn invalid_vertical_passage_issue_resolves_flagged_edge_as_one_element_group() {
    let (graph, e1, _) = vertical_passage_graph();
    let (_, scc) = empty_graph_and_scc();
    let issue = InvalidVerticalPassageIssue::new_from_check(
        "vertical_passage_group_geometric_proximity",
        vec![e1],
    );

    let payload = resolve(&issue, &graph, &scc);
    let IssuePayload::InvalidVerticalPassage { groups } = payload else {
        panic!("expected InvalidVerticalPassage, got {payload:?}")
    };
    assert_eq!(groups.len(), 1);
    let check1_groups = &groups["vertical_passage_group_geometric_proximity"];
    assert_eq!(check1_groups.len(), 1);
    assert_eq!(check1_groups[0].edges, vec![[1, 2]]);
}

#[test]
fn invalid_vertical_passage_group_issue_with_no_flagged_pairs_resolves_to_none() {
    let (graph, scc) = empty_graph_and_scc();
    let issue = InvalidVerticalPassageGroupIssue::new_from_check("check", vec![]);
    assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
}

#[test]
fn invalid_vertical_passage_group_issue_resolves_flagged_pair_as_two_element_group() {
    let (graph, e1, e2) = vertical_passage_graph();
    let (_, scc) = empty_graph_and_scc();
    let issue = InvalidVerticalPassageGroupIssue::new_from_check(
        "vertical_passage_group_graph_proximity",
        vec![(vec![e1, e2], 1)],
    );

    let payload = resolve(&issue, &graph, &scc);
    let IssuePayload::InvalidVerticalPassage { groups } = payload else {
        panic!("expected InvalidVerticalPassage, got {payload:?}")
    };
    assert_eq!(groups.len(), 1);
    let check1_groups = &groups["vertical_passage_group_graph_proximity"];
    assert_eq!(check1_groups.len(), 1);
    assert_eq!(check1_groups[0].edges, vec![[1, 2], [2, 3]]);
}

#[test]
fn invalid_vertical_passage_issue_merged_from_two_checks_attributes_each_edge_to_only_its_own_check()
 {
    use crate::quality_control::issue::IssueMerge;
    let (graph, e1, e2) = vertical_passage_graph();
    let (_, scc) = empty_graph_and_scc();
    let mut issue = InvalidVerticalPassageIssue::new_from_check(
        "vertical_passage_group_geometric_proximity",
        vec![e1],
    );
    issue.merge(InvalidVerticalPassageIssue::new_from_check(
        "vertical_passage_group_graph_proximity",
        vec![e2],
    ));

    let payload = resolve(&issue, &graph, &scc);
    let IssuePayload::InvalidVerticalPassage { groups } = payload else {
        panic!("expected InvalidVerticalPassage, got {payload:?}")
    };
    assert_eq!(
        groups["vertical_passage_group_geometric_proximity"][0].edges,
        vec![[1, 2]],
        "must not include e2"
    );
    assert_eq!(
        groups["vertical_passage_group_graph_proximity"][0].edges,
        vec![[2, 3]],
        "must not include e1"
    );
}

#[test]
fn invalid_vertical_passage_issue_silently_skips_a_stale_edge_id_absent_from_the_graph() {
    let (graph, e1, _) = vertical_passage_graph();
    let (_, scc) = empty_graph_and_scc();
    let stale_id = e1 + 1000;
    let issue = InvalidVerticalPassageIssue::new_from_check(
        "vertical_passage_group_geometric_proximity",
        vec![e1, stale_id],
    );

    let payload = resolve(&issue, &graph, &scc);
    let IssuePayload::InvalidVerticalPassage { groups } = payload else {
        panic!("expected InvalidVerticalPassage, got {payload:?}")
    };
    assert_eq!(
        groups["vertical_passage_group_geometric_proximity"][0].edges,
        vec![[1, 2]],
        "stale edge id must be dropped, not panic"
    );
}

fn elevator_graph() -> (Graph, ElevatorNodes) {
    use crate::graph::EdgeKind;
    let mut graph = Graph::new();
    graph.add_node(1);
    graph.add_node(2);
    graph.add_node(3);
    graph.add_edge(1, 2, EdgeKind::Elevator);
    graph.add_edge(2, 1, EdgeKind::Elevator);
    graph.add_edge(1, 3, EdgeKind::Elevator);
    graph.add_edge(3, 1, EdgeKind::Elevator);
    graph.add_edge(2, 3, EdgeKind::Elevator);
    graph.add_edge(3, 2, EdgeKind::Elevator);
    (graph, ElevatorNodes::new(vec![1, 2, 3]))
}

#[test]
fn invalid_elevator_issue_with_no_flagged_elevators_resolves_to_none() {
    let (graph, scc) = empty_graph_and_scc();
    let issue = InvalidElevatorIssue::new_from_check("check", vec![]);
    assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
}

#[test]
fn invalid_elevator_issue_resolves_flagged_elevator_as_its_full_edge_fan() {
    let (graph, elevator) = elevator_graph();
    let (_, scc) = empty_graph_and_scc();
    let issue = InvalidElevatorIssue::new_from_check("elevator_stop_count", vec![elevator]);

    let payload = resolve(&issue, &graph, &scc);
    let IssuePayload::InvalidElevator { groups } = payload else {
        panic!("expected InvalidElevator, got {payload:?}")
    };
    assert_eq!(groups.len(), 1);
    let check_groups = &groups["elevator_stop_count"];
    assert_eq!(check_groups.len(), 1);
    let mut edges = check_groups[0].edges.clone();
    edges.sort();
    assert_eq!(edges, vec![[1, 2], [1, 3], [2, 1], [2, 3], [3, 1], [3, 2]]);
}

#[test]
fn invalid_elevator_group_issue_with_no_flagged_groups_resolves_to_none() {
    let (graph, scc) = empty_graph_and_scc();
    let issue = InvalidElevatorGroupIssue::new_from_check("check", vec![]);
    assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
}

#[test]
fn invalid_elevator_group_issue_resolves_each_flagged_elevator_as_its_own_edge_fan() {
    // Whole-maze scope group issue (GitHub issue #398) -- unlike the edge-based group kinds
    // (one-way/teleport/vertical-passage), an elevator group's `Vec<ElevatorNodes>` still
    // resolves to one payload entry per flagged elevator, mirroring `resolve_invalid_elevator_payload`.
    let (graph, elevator) = elevator_graph();
    let (_, scc) = empty_graph_and_scc();
    let issue =
        InvalidElevatorGroupIssue::new_from_check("max_elevator_count", vec![(vec![elevator], 1)]);

    let payload = resolve(&issue, &graph, &scc);
    let IssuePayload::InvalidElevator { groups } = payload else {
        panic!("expected InvalidElevator, got {payload:?}")
    };
    assert_eq!(groups.len(), 1);
    let check_groups = &groups["max_elevator_count"];
    assert_eq!(check_groups.len(), 1);
    let mut edges = check_groups[0].edges.clone();
    edges.sort();
    assert_eq!(edges, vec![[1, 2], [1, 3], [2, 1], [2, 3], [3, 1], [3, 2]]);
}

#[test]
fn invalid_elevator_group_issue_preset_locked_when_every_edge_is_preset_protected() {
    let (graph, elevator) = elevator_graph();
    let (_, scc) = empty_graph_and_scc();
    let issue = InvalidElevatorGroupIssue::new_from_check(
        "max_elevator_density",
        vec![(vec![elevator], 1)],
    );

    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((1, 2));
    preset_state.preset_edges.insert((2, 1));
    preset_state.preset_edges.insert((1, 3));
    preset_state.preset_edges.insert((3, 1));
    preset_state.preset_edges.insert((2, 3));
    preset_state.preset_edges.insert((3, 2));

    let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state, None);
    let IssuePayload::InvalidElevator { groups } = payload else {
        panic!("expected InvalidElevator, got {payload:?}")
    };
    assert!(groups["max_elevator_density"][0].preset_locked);
}

#[test]
fn invalid_elevator_stop_issue_with_no_flagged_stops_resolves_to_none() {
    let (graph, scc) = empty_graph_and_scc();
    let issue = InvalidElevatorStopIssue::new_from_check("check", vec![]);
    assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
}

#[test]
fn invalid_elevator_stop_issue_resolves_each_flagged_stop_as_its_own_single_node_region() {
    let (graph, _elevator) = elevator_graph();
    let (_, scc) = empty_graph_and_scc();
    let issue = InvalidElevatorStopIssue::new_from_check("max_elevator_stops", vec![1, 2]);

    let payload = resolve(&issue, &graph, &scc);
    let IssuePayload::InvalidElevatorStop { nodes } = payload else {
        panic!("expected InvalidElevatorStop, got {payload:?}")
    };
    assert_eq!(nodes.len(), 1);
    let check_regions = &nodes["max_elevator_stops"];
    let mut regions: Vec<Vec<u32>> = check_regions.iter().map(|r| r.region.clone()).collect();
    regions.sort();
    assert_eq!(
        regions,
        vec![vec![1], vec![2]],
        "each flagged stop must be its own single-node region, not one merged region"
    );
}

#[test]
fn invalid_elevator_stop_issue_preset_locked_when_stop_touches_a_preset_edge() {
    let (graph, _elevator) = elevator_graph();
    let (_, scc) = empty_graph_and_scc();
    let issue = InvalidElevatorStopIssue::new_from_check("max_elevator_stops", vec![1]);

    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((1, 2));
    let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state, None);
    let IssuePayload::InvalidElevatorStop { nodes } = payload else {
        panic!("expected InvalidElevatorStop, got {payload:?}")
    };
    assert!(nodes["max_elevator_stops"][0].preset_locked);
}

#[test]
fn invalid_elevator_stop_group_issue_with_no_flagged_groups_resolves_to_none() {
    let (graph, scc) = empty_graph_and_scc();
    let issue = InvalidElevatorStopGroupIssue::new_from_check("check", vec![]);
    assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
}

#[test]
fn invalid_elevator_stop_group_issue_resolves_each_stop_in_the_group_as_its_own_region() {
    let (graph, _elevator) = elevator_graph();
    let (_, scc) = empty_graph_and_scc();
    let issue = InvalidElevatorStopGroupIssue::new_from_check(
        "max_elevator_stops_per_floor",
        vec![(vec![1, 2, 3], 1)],
    );

    let payload = resolve(&issue, &graph, &scc);
    let IssuePayload::InvalidElevatorStop { nodes } = payload else {
        panic!("expected InvalidElevatorStop, got {payload:?}")
    };
    let check_regions = &nodes["max_elevator_stops_per_floor"];
    let mut regions: Vec<Vec<u32>> = check_regions.iter().map(|r| r.region.clone()).collect();
    regions.sort();
    assert_eq!(
        regions,
        vec![vec![1], vec![2], vec![3]],
        "every stop in the group must be emitted as its own single-node region"
    );
}

#[test]
fn invalid_elevator_stop_group_issue_preset_locked_when_stop_touches_a_preset_edge() {
    let (graph, _elevator) = elevator_graph();
    let (_, scc) = empty_graph_and_scc();
    let issue =
        InvalidElevatorStopGroupIssue::new_from_check("max_elevator_stops", vec![(vec![1, 2], 1)]);

    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((1, 2));
    let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state, None);
    let IssuePayload::InvalidElevatorStop { nodes } = payload else {
        panic!("expected InvalidElevatorStop, got {payload:?}")
    };
    let check_regions = &nodes["max_elevator_stops"];
    let locked: HashMap<u32, bool> = check_regions
        .iter()
        .map(|r| (r.region[0], r.preset_locked))
        .collect();
    assert!(
        locked[&1],
        "stop 1 touches the preset edge (1,2), must be locked"
    );
    assert!(
        locked[&2],
        "stop 2 also touches the preset edge (1,2), must be locked"
    );
}

#[test]
fn invalid_dead_end_group_resolves_every_candidate_as_an_unlocked_single_node_region() {
    let (graph, scc) = empty_graph_and_scc();
    let issue =
        InvalidDeadEndGroupIssue::new_from_check("max_dead_end_count", vec![(vec![3, 1], 1)]);

    let payload = resolve(&issue, &graph, &scc);
    let IssuePayload::InvalidDeadEnd { nodes } = payload else {
        panic!("expected InvalidDeadEnd, got {payload:?}")
    };
    assert_eq!(
        nodes["max_dead_end_count"],
        vec![
            IssueRegionPayload {
                region: vec![3],
                preset_locked: false
            },
            IssueRegionPayload {
                region: vec![1],
                preset_locked: false
            },
        ]
    );
}

// --- AreaDeficit resolver (hover-highlight follow-up to GitHub issue #408) — covers
// missing_vertical_passages/missing_teleports/missing_elevators/area_missing_elevator_stops, the
// four sibling RepairArea-shaped deficit issues that previously all fell through to
// IssuePayload::None. ---

/// A two-floor field with no nodes wired into any graph — these tests only need `field.levels_ordered()`
/// positions to resolve `RepairArea::Level`, not a real graph.
fn two_level_field() -> (
    MultiLevelField<crate::space::SquareTessellation>,
    crate::space::LevelId,
    crate::space::LevelId,
) {
    use crate::space::{Field, SquareTessellation, square_rect};
    let mut ids = IdGenerator::new();
    let mut mf = MultiLevelField::<SquareTessellation>::new(Arc::default(), []);
    let bottom = mf.add_level(
        Field::<SquareTessellation>::new(Arc::default(), square_rect(1, 1), &mut ids).unwrap(),
    );
    let top = mf.add_level(
        Field::<SquareTessellation>::new(Arc::default(), square_rect(1, 1), &mut ids).unwrap(),
    );
    (mf, bottom, top)
}

#[test]
fn missing_vertical_passages_issue_with_no_missing_areas_resolves_to_none() {
    let (graph, scc) = empty_graph_and_scc();
    let issue = MissingVerticalPassagesIssue::new_from_check("min_vertical_passage_count", vec![]);
    assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
}

#[test]
fn missing_vertical_passages_issue_resolves_whole_maze_and_level_entries_keyed_by_source_check() {
    let (field, bottom, top) = two_level_field();
    let (graph, scc) = empty_graph_and_scc();
    let issue = MissingVerticalPassagesIssue::new_from_check(
        "min_vertical_passage_count",
        vec![(RepairArea::WholeMaze, 2), (RepairArea::Level(top), 1)],
    );

    let payload = resolve_issue_payload(&issue, &graph, &field, &scc, &PresetState::empty(), None);
    let IssuePayload::AreaDeficit { areas } = payload else {
        panic!("expected AreaDeficit, got {payload:?}")
    };
    assert_eq!(areas.len(), 1);
    let entries = &areas["min_vertical_passage_count"];
    assert_eq!(
        entries,
        &vec![None, Some(1)],
        "WholeMaze resolves to None, Level(top) resolves to its levels_ordered() index"
    );
    let _ = bottom; // only used to build the two-level field
}

#[test]
fn missing_teleports_issue_resolves_level_entry_to_its_levels_ordered_index() {
    let (field, bottom, _top) = two_level_field();
    let (graph, scc) = empty_graph_and_scc();
    let issue = MissingTeleportsIssue::new_from_check(
        "min_teleport_count",
        vec![(RepairArea::Level(bottom), 3)],
    );

    let payload = resolve_issue_payload(&issue, &graph, &field, &scc, &PresetState::empty(), None);
    let IssuePayload::AreaDeficit { areas } = payload else {
        panic!("expected AreaDeficit, got {payload:?}")
    };
    assert_eq!(areas["min_teleport_count"], vec![Some(0)]);
}

#[test]
fn missing_elevators_issue_whole_maze_only_resolves_to_a_none_entry() {
    // GitHub issue #401's whole-maze-only scope — no specific floor to highlight, same
    // "no per-element highlight" precedent as ExcessiveSccCount, still routed through AreaDeficit.
    let (graph, scc) = empty_graph_and_scc();
    let issue = MissingElevatorsIssue::new_from_check(
        "min_elevator_count",
        vec![(RepairArea::WholeMaze, 4)],
    );

    let payload = resolve(&issue, &graph, &scc);
    let IssuePayload::AreaDeficit { areas } = payload else {
        panic!("expected AreaDeficit, got {payload:?}")
    };
    assert_eq!(areas["min_elevator_count"], vec![None]);
}

#[test]
fn area_missing_elevator_stops_issue_resolves_level_entry_to_its_levels_ordered_index() {
    let (field, _bottom, top) = two_level_field();
    let (graph, scc) = empty_graph_and_scc();
    let issue = AreaMissingElevatorStopsIssue::new_from_check(
        "min_elevator_stops_per_area_count",
        vec![(RepairArea::Level(top), 2)],
    );

    let payload = resolve_issue_payload(&issue, &graph, &field, &scc, &PresetState::empty(), None);
    let IssuePayload::AreaDeficit { areas } = payload else {
        panic!("expected AreaDeficit, got {payload:?}")
    };
    assert_eq!(areas["min_elevator_stops_per_area_count"], vec![Some(1)]);
}

#[test]
fn area_deficit_fans_the_same_area_list_to_every_source_check() {
    // These four issue kinds don't track per-entry source-check attribution (unlike
    // InvalidLoopIssue's invalid_sources) -- merging two checks' issues must attribute the full
    // area list to both checks uniformly.
    use crate::quality_control::issue::IssueMerge;
    let (field, bottom, _top) = two_level_field();
    let (graph, scc) = empty_graph_and_scc();
    let mut issue = MissingTeleportsIssue::new_from_check(
        "min_teleport_count",
        vec![(RepairArea::Level(bottom), 2)],
    );
    issue.merge(MissingTeleportsIssue::new_from_check(
        "min_teleport_ratio",
        vec![(RepairArea::Level(bottom), 5)],
    ));

    let payload = resolve_issue_payload(&issue, &graph, &field, &scc, &PresetState::empty(), None);
    let IssuePayload::AreaDeficit { areas } = payload else {
        panic!("expected AreaDeficit, got {payload:?}")
    };
    assert_eq!(areas.len(), 2);
    assert_eq!(areas["min_teleport_count"], vec![Some(0)]);
    assert_eq!(
        areas["min_teleport_ratio"],
        vec![Some(0)],
        "merge keeps the larger missing count but both checks still see the same area list"
    );
}

/// Pins every batch-edge-group check's own `Check::is_batch_edge_group()` against
/// `is_batch_edge_group_type`'s type-id-string match -- the two must agree, since
/// `resolve_edge_group_map` only ever has a type id string (not a live check instance) to work
/// with (see its doc comment). If a check overrides `is_batch_edge_group()` to `true` without
/// also adding its `check_type_id()` to `is_batch_edge_group_type`, or vice versa, this fails --
/// that's exactly the silent-drift failure mode GitHub issue #379 shipped once already.
#[test]
fn is_batch_edge_group_type_agrees_with_every_checks_own_is_batch_edge_group() {
    use crate::quality_control::check::Check;
    use crate::quality_control::checks::{
        MaxOneWayCountCheck, MaxOneWayRatioCheck, MaxTeleportCountCheck, MaxTeleportDensityCheck,
        MaxVerticalPassageCountCheck, MaxVerticalPassageRatioCheck,
    };
    use crate::quality_control::{
        FloorScope, TeleportDirectionFilter, TeleportFloorKindFilter, VerticalPassageType,
    };

    fn assert_agrees<T: crate::space::Tessellation, I: crate::quality_control::IssueRequirement>(
        check: &dyn Check<T, I>,
    ) {
        assert_eq!(
            check.is_batch_edge_group(),
            is_batch_edge_group_type(check.check_type_id()),
            "'{}' disagrees between Check::is_batch_edge_group() and is_batch_edge_group_type()",
            check.check_type_id(),
        );
    }

    assert_agrees::<SquareTessellation, _>(&MaxTeleportCountCheck {
        instance_id: "t".into(),
        max_teleports: 1,
        floor_scope: FloorScope::WholeMaze,
        direction: TeleportDirectionFilter::Any,
        floor_kind: TeleportFloorKindFilter::Any,
    });
    assert_agrees::<SquareTessellation, _>(&MaxTeleportDensityCheck {
        instance_id: "t".into(),
        max_density: 1.0,
        floor_scope: FloorScope::WholeMaze,
        direction: TeleportDirectionFilter::Any,
        floor_kind: TeleportFloorKindFilter::Any,
    });
    assert_agrees::<SquareTessellation, _>(&MaxOneWayCountCheck {
        instance_id: "t".into(),
        max_one_ways: 1,
        floor_scope: FloorScope::WholeMaze,
    });
    assert_agrees::<SquareTessellation, _>(&MaxOneWayRatioCheck {
        instance_id: "t".into(),
        max_ratio: 1.0,
        floor_scope: FloorScope::WholeMaze,
    });
    assert_agrees::<SquareTessellation, _>(&MaxVerticalPassageCountCheck {
        instance_id: "t".into(),
        max_vertical_passages: 1,
        floor_scope: FloorScope::WholeMaze,
        passage_type: VerticalPassageType::Any,
        count_incoming: false,
    });
    assert_agrees::<SquareTessellation, _>(&MaxVerticalPassageRatioCheck {
        instance_id: "t".into(),
        max_ratio: 1.0,
        floor_scope: FloorScope::WholeMaze,
        passage_type: VerticalPassageType::Any,
        count_incoming: false,
    });
}
