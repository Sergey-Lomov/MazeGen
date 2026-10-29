use super::super::issue::Issue;
use super::super::issue_kinds::*;
use super::super::repair_area::RepairArea;
use super::resolve_issue_payload;
use super::resolvers::*;
use super::types::*;
use crate::generation::PresetState;
use crate::graph::EdgeKind;
use crate::graph::Graph;
use crate::graph::scc::ComponentId;
use crate::graph::scc::ConnectedComponents;
use crate::ids::EdgeId;
use crate::ids::IdGenerator;
use crate::ids::NodeId;
use crate::space::MultiLevelField;
use crate::space::{SquareTessellation, square_rect};
use std::collections::HashMap;
use std::sync::Arc;

/// `let IssuePayload::<Variant> { fields } = payload else { panic!(..) };` with the payload in the
/// panic message. The bindings land in the caller's scope.
macro_rules! let_payload {
    ($variant:ident { $($fields:tt)* } = $payload:expr) => {
        let payload = $payload;
        let IssuePayload::$variant { $($fields)* } = payload else {
            panic!("expected {}, got {payload:?}", stringify!($variant))
        };
    };
}

/// A flagged `EdgeId` that no longer resolves in the graph (e.g. removed by a repair mutation
/// between the check running and the payload being resolved) must be dropped, not panic.
macro_rules! stale_edge_is_dropped_test {
    ($name:ident, $issue:ident, $variant:ident, $graph:expr, $check:literal) => {
        #[test]
        fn $name() {
            let (graph, e1, _) = $graph;
            let scc = empty_scc();
            let issue = $issue::new_from_check($check, vec![e1, e1 + 1000]);

            let_payload!($variant { groups } = resolve(&issue, &graph, &scc));
            assert_eq!(
                groups[$check][0].edges,
                vec![[1, 2]],
                "stale edge id must be dropped, not panic"
            );
        }
    };
}

/// After two checks' issues merge, each check's group must list only the edge that check flagged.
macro_rules! merged_checks_keep_own_edges_test {
    ($name:ident, $issue:ident, $variant:ident, $graph:expr, $check1:literal, $check2:literal) => {
        #[test]
        fn $name() {
            use crate::quality_control::issue::IssueMerge;
            let (graph, e1, e2) = $graph;
            let scc = empty_scc();
            let mut issue = $issue::new_from_check($check1, vec![e1]);
            issue.merge($issue::new_from_check($check2, vec![e2]));

            let_payload!($variant { groups } = resolve(&issue, &graph, &scc));
            assert_eq!(
                groups[$check1][0].edges,
                vec![[1, 2]],
                "must not include e2"
            );
            assert_eq!(
                groups[$check2][0].edges,
                vec![[2, 3]],
                "must not include e1"
            );
        }
    };
}

mod area;
mod elevator;
mod loops;
mod one_way;
mod regions;
mod split;
mod teleport;
mod vertical;

fn empty_graph_and_scc() -> (Graph, ConnectedComponents) {
    (Graph::new(), empty_scc())
}

fn empty_scc() -> ConnectedComponents {
    ConnectedComponents {
        components: Vec::new(),
        node_component: HashMap::new(),
    }
}

/// A `Field` big enough for every hand-built test graph's node ids to be meaningless within it
/// (tests that don't exercise `RegionNeedsExpansion` never call `Field::neighbors` on ids
/// outside it, so an arbitrary small field is a safe stand-in) -- only region-expansion tests
/// build a field whose points actually correspond to their graph's nodes.
fn dummy_field() -> MultiLevelField<SquareTessellation> {
    let mut ids = IdGenerator::new();
    MultiLevelField::single_level(Arc::default(), square_rect(1, 1), &mut ids).unwrap()
}

fn resolve(issue: &dyn Issue, graph: &Graph, scc: &ConnectedComponents) -> IssuePayload {
    resolve_with_preset(issue, graph, scc, &PresetState::empty())
}

fn resolve_with_preset(
    issue: &dyn Issue,
    graph: &Graph,
    scc: &ConnectedComponents,
    preset_state: &PresetState,
) -> IssuePayload {
    resolve_issue_payload(issue, graph, &dummy_field(), scc, preset_state, None)
}

/// A `PresetState` whose only content is the given preset-protected directed edges.
fn preset_with_edges(edges: &[(NodeId, NodeId)]) -> PresetState {
    let mut state = PresetState::empty();
    for &edge in edges {
        state.preset_edges.insert(edge);
    }
    state
}

/// Nodes 1-3 joined by `1 -> 2` and `2 -> 3` edges of `kind`.
fn chain_graph(kind: EdgeKind) -> (Graph, EdgeId, EdgeId) {
    let mut graph = Graph::new();
    graph.add_node(1);
    graph.add_node(2);
    graph.add_node(3);
    let e1 = graph.add_edge(1, 2, kind);
    let e2 = graph.add_edge(2, 3, kind);
    (graph, e1, e2)
}

/// Nodes 1-3 joined into the directed basic cycle `1 -> 2 -> 3 -> 1`.
fn loop_graph() -> (Graph, EdgeId, EdgeId, EdgeId) {
    let (mut graph, e1, e2) = chain_graph(EdgeKind::Basic);
    let e3 = graph.add_edge(3, 1, EdgeKind::Basic);
    (graph, e1, e2, e3)
}

fn one_way_graph() -> (Graph, EdgeId, EdgeId) {
    chain_graph(EdgeKind::Basic)
}

#[test]
fn issues_with_nothing_flagged_resolve_to_none() {
    use crate::quality_control::MissingEndpointsIssue;
    let (graph, scc) = empty_graph_and_scc();
    let cases: Vec<(&str, Box<dyn Issue>)> = vec![
        (
            "missing_endpoints_issue",
            Box::new(MissingEndpointsIssue::new_from_check("check", true, true)),
        ),
        (
            "invalid_loop_issue_with_no_flagged_cycles",
            Box::new(InvalidLoopIssue::new_from_check(
                "check",
                vec![],
                vec![],
                HashMap::new(),
            )),
        ),
        (
            "invalid_loop_group_issue_with_no_flagged_cycles",
            Box::new(InvalidLoopGroupIssue::new_from_check(
                "check",
                vec![],
                vec![],
                HashMap::new(),
            )),
        ),
        (
            "region_needs_expansion_issue_with_no_flagged_regions",
            Box::new(RegionNeedsExpansionIssue::new_from_check(
                "check",
                vec![],
                HashMap::new(),
            )),
        ),
        (
            "region_needs_shrink_issue_with_no_flagged_regions",
            Box::new(RegionNeedsShrinkIssue::new_from_check(
                "check",
                vec![],
                HashMap::new(),
            )),
        ),
        (
            "invalid_teleport_issue_with_no_flagged_edges",
            Box::new(InvalidTeleportIssue::new_from_check("check", vec![])),
        ),
        (
            "invalid_teleport_group_issue_with_no_flagged_pairs",
            Box::new(InvalidTeleportGroupIssue::new_from_check("check", vec![])),
        ),
        (
            "invalid_one_way_issue_with_no_flagged_edges",
            Box::new(InvalidOneWayIssue::new_from_check("check", vec![])),
        ),
        (
            "invalid_one_way_group_issue_with_no_flagged_groups",
            Box::new(InvalidOneWayGroupIssue::new_from_check("check", vec![])),
        ),
        (
            "invalid_split_route_issue_with_no_flagged_routes",
            Box::new(InvalidSplitRouteIssue::new_from_check("check", vec![])),
        ),
        (
            "invalid_vertical_passage_issue_with_no_flagged_edges",
            Box::new(InvalidVerticalPassageIssue::new_from_check("check", vec![])),
        ),
        (
            "invalid_vertical_passage_group_issue_with_no_flagged_pairs",
            Box::new(InvalidVerticalPassageGroupIssue::new_from_check(
                "check",
                vec![],
            )),
        ),
        (
            "invalid_elevator_issue_with_no_flagged_elevators",
            Box::new(InvalidElevatorIssue::new_from_check("check", vec![])),
        ),
        (
            "invalid_elevator_group_issue_with_no_flagged_groups",
            Box::new(InvalidElevatorGroupIssue::new_from_check("check", vec![])),
        ),
        (
            "invalid_elevator_stop_issue_with_no_flagged_stops",
            Box::new(InvalidElevatorStopIssue::new_from_check("check", vec![])),
        ),
        (
            "invalid_elevator_stop_group_issue_with_no_flagged_groups",
            Box::new(InvalidElevatorStopGroupIssue::new_from_check(
                "check",
                vec![],
            )),
        ),
        (
            "missing_vertical_passages_issue_with_no_missing_areas",
            Box::new(MissingVerticalPassagesIssue::new_from_check(
                "min_vertical_passage_count",
                vec![],
            )),
        ),
    ];
    for (name, issue) in &cases {
        assert_eq!(
            resolve(issue.as_ref(), &graph, &scc),
            IssuePayload::None,
            "{name}"
        );
    }
}
