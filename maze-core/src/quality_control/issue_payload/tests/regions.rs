use super::*;

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
    let_payload!(RegionNeedsExpansion { nodes } = payload);
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
    let_payload!(RegionNeedsShrink { nodes } = payload);
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

    let payload = resolve_with_preset(&issue, &graph, &scc, &preset_state);
    let_payload!(RegionNeedsShrink { nodes } = payload);
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

    let payload = resolve_with_preset(&issue, &graph, &scc, &preset_state);
    let_payload!(RegionNeedsShrink { nodes } = payload);
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

    let payload = resolve_with_preset(&issue, &graph, &scc, &preset_state);
    let_payload!(RegionNeedsShrink { nodes } = payload);
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
    let_payload!(RegionNeedsExpansion { nodes } = payload);
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
    let_payload!(RegionNeedsExpansion { nodes } = payload);
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
    let_payload!(RegionNeedsExpansion { nodes } = payload);
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
    let_payload!(RegionNeedsExpansion { nodes } = payload);
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
    let_payload!(RegionNeedsExpansion { nodes } = payload);
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
    let_payload!(ExcessiveSccCount { preset_locked } = payload);
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
    let_payload!(ExcessiveSccCount { preset_locked } = payload);
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
    let_payload!(ExcessiveSccCount { preset_locked } = payload);
    assert!(preset_locked["check1"]);
}
