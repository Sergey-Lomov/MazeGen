use super::*;
use crate::graph::EdgeKind;
use crate::graph::nav::build_nav_graph;
use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
use crate::{Graph, IdGenerator};
use std::sync::Arc;

/// Plain f64 distances through the surface scan (every result exact).
fn pairwise_geometric_scan<C, K>(
    candidates: &[C],
    threshold: f64,
    pair_excluded: impl FnMut(&C, &C) -> bool,
    mut distance: impl FnMut(&C, &C) -> f64,
    on_close: impl FnMut(&C, &C) -> (Vec<K>, u32),
) -> Vec<(Vec<K>, u32)> {
    pairwise_surface_scan(
        candidates,
        threshold,
        pair_excluded,
        |own, other| Ok(DistanceResult::exact(distance(own, other))),
        on_close,
        |_, _| None,
    )
    .groups
}

/// A straight `width`-tile corridor, each pair of neighbors joined by a bidirectional `Basic`
/// edge. Returns the nav graph and a `NodeId` accessor by x-coordinate.
fn corridor(width: usize) -> (NavGraph, impl Fn(i32) -> NodeId) {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(width, 1), &mut ids).unwrap();
    let level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let p = move |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
    for x in 0..(width as i32 - 1) {
        g.add_bidirectional_edge(p(x), p(x + 1), EdgeKind::Basic);
    }
    let nav = build_nav_graph(&g);
    (nav, p)
}

/// Candidate shape used across these tests: a plain node position, no hop exclusion, `Single`
/// anchor on both sides.
fn scan_single(
    nav: &NavGraph,
    candidates: &[NodeId],
    max_dist: usize,
    directed: bool,
    close_enough: impl FnMut(usize) -> bool,
) -> Vec<(Vec<NodeId>, u32)> {
    pairwise_graph_proximity_scan(
        nav,
        candidates,
        max_dist,
        directed,
        |_: &NodeId| HashSet::new(),
        |_, _| true,
        |&n| ScanAnchor::Single(n),
        |&n| ScanAnchor::Single(n),
        close_enough,
        |a, b| a == b,
        |&own, &other| (vec![own, other], 1),
    )
}

#[test]
fn graph_scan_picks_the_nearest_candidate_not_the_first_in_list_order() {
    // Corridor 0..=5. Scanning from x=0: candidate at x=4 (far) is listed BEFORE the candidate
    // at x=1 (near) -- a "first in list order" scan would wrongly report x=4. The nearest-match
    // engine must report x=1 instead. This is the direct-engine proof of the "nearest, not
    // first" contract `nearest_candidate_within`'s own doc comment describes.
    let (nav, p) = corridor(6);
    let candidates = vec![p(0), p(4), p(1)];
    let groups = scan_single(&nav, &candidates, 10, false, |d| d < 10);
    let own_zero_group = groups
        .iter()
        .find(|(g, _)| g[0] == p(0))
        .expect("x=0's own scan must produce a group");
    assert_eq!(
        own_zero_group.0,
        vec![p(0), p(1)],
        "must report the nearer candidate (x=1, dist 1), not the farther one (x=4) despite its earlier list position"
    );
}

#[test]
fn graph_scan_respects_max_dist_bound() {
    let (nav, p) = corridor(6);
    let candidates = vec![p(0), p(5)];
    let groups = scan_single(&nav, &candidates, 3, false, |d| d < 100);
    assert!(
        groups.is_empty(),
        "x=5 is 5 hops from x=0, past max_dist=3 -- must never be found, not merely filtered afterward"
    );
}

#[test]
fn graph_scan_close_enough_predicate_gates_the_result() {
    let (nav, p) = corridor(6);
    let candidates = vec![p(0), p(2)];
    let groups = scan_single(&nav, &candidates, 10, false, |d| d < 2);
    assert!(
        groups.is_empty(),
        "distance is 2, close_enough requires strictly less than 2"
    );
    let groups = scan_single(&nav, &candidates, 10, false, |d| d < 3);
    assert_eq!(
        groups.len(),
        2,
        "distance 2 satisfies < 3 -- both candidates find each other (bidirectional corridor)"
    );
}

#[test]
fn graph_scan_forward_only_misses_a_one_way_reverse_pair_unless_directed() {
    // One-way edge x=1 -> x=0 only. Scanning forward-only from x=0 can never reach x=1.
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(2, 1), &mut ids).unwrap();
    let level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
    g.add_edge(p(1), p(0), EdgeKind::Basic);
    let nav = build_nav_graph(&g);

    let candidates = vec![p(0), p(1)];
    let forward_only = scan_single(&nav, &candidates, 10, false, |d| d < 10);
    assert!(
        !forward_only.iter().any(|(g, _)| g[0] == p(0)),
        "forward-only traversal from x=0 has no outgoing edge, so x=1 is unreachable from x=0's own scan"
    );

    let directed = scan_single(&nav, &candidates, 10, true, |d| d < 10);
    assert!(
        directed.iter().any(|(g, _)| g[0] == p(0)),
        "directed=true also tries the reverse traversal from x=0, reaching x=1 via its own outgoing edge to x=0"
    );
}

#[test]
fn graph_scan_own_hop_pairs_excludes_only_the_scanned_candidates_own_hop() {
    // A's own hop is a single-hop Teleport edge x=0 -> x=1 (own_hop_pairs only ever matches a
    // single-hop `NavEdge`, by design -- a fast-travel edge is always single-hop, see the
    // doc comment on `pairwise_graph_proximity_scan`). x=1 continues via a plain Basic corridor
    // to x=3 (B's own position). Scanning A must exclude its own teleport hop, stranding it;
    // scanning B (whose own_hop_pairs is empty) can still walk that same teleport hop as a
    // genuine pedestrian option, reaching A.
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(4, 1), &mut ids).unwrap();
    let level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
    g.add_edge(p(0), p(1), EdgeKind::Teleport);
    g.add_bidirectional_edge(p(1), p(2), EdgeKind::Basic);
    g.add_bidirectional_edge(p(2), p(3), EdgeKind::Basic);
    let nav = build_nav_graph(&g);

    let candidates: Vec<(NodeId, HashSet<(NodeId, NodeId)>)> = vec![
        (p(0), HashSet::from([(p(0), p(1))])),
        (p(3), HashSet::new()),
    ];
    let groups = pairwise_graph_proximity_scan(
        &nav,
        &candidates,
        10,
        true, // directed -- B needs its reverse traversal to walk the one-way teleport hop backward
        |(_, hops)| hops.clone(),
        |_, _| true,
        |&(n, _)| ScanAnchor::Single(n),
        |&(n, _)| ScanAnchor::Single(n),
        |d| d < 10,
        |a, b| a.0 == b.0,
        |&(own, _), &(other, _)| (vec![own, other], 1),
    );
    assert!(
        !groups.iter().any(|(g, _)| g[0] == p(0)),
        "A's own teleport hop (x=0->x=1) is excluded from A's own traversal, stranding it before it can reach x=3"
    );
    assert!(
        groups.iter().any(|(g, _)| g[0] == p(3)),
        "B owns no hop of its own, so its reverse traversal can walk back through the teleport hop to reach A at x=0"
    );
}

#[test]
fn graph_scan_own_hop_kind_guard_lets_a_parallel_edge_still_count() {
    // x=0 -> x=1 carries BOTH a Teleport edge and a plain Basic edge (Graph::add_edge's
    // kind-aware dedup allows this). own_hop_kind_guard requiring `!edge.is_teleport` must
    // still let the parallel Basic edge count as pedestrian proximity.
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(2, 1), &mut ids).unwrap();
    let level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
    g.add_edge(p(0), p(1), EdgeKind::Teleport);
    g.add_edge(p(0), p(1), EdgeKind::Basic);
    let nav = build_nav_graph(&g);

    let candidates = vec![p(0), p(1)];
    let groups = pairwise_graph_proximity_scan(
        &nav,
        &candidates,
        10,
        false,
        |&n| HashSet::from([(n, p(1))]), // "own hop" only matches when own == p(0)
        |_, edge: &NavEdge| edge.is_teleport, // exclude only the teleport-kind hop
        |&n| ScanAnchor::Single(n),
        |&n| ScanAnchor::Single(n),
        |d| d < 10,
        |a, b| a == b,
        |&own, &other| (vec![own, other], 1),
    );
    assert_eq!(
        groups.len(),
        1,
        "the parallel Basic edge must still make x=0 and x=1 look close despite the excluded Teleport hop"
    );
}

#[test]
fn graph_scan_multi_anchor_reduces_to_the_nearest_across_every_node() {
    // Multi anchor with two nodes (x=0, x=5) on a 6-wide corridor -- the nearer of the two
    // (x=5, 1 hop from a candidate at x=4) must win over x=0 (4 hops).
    let (nav, p) = corridor(6);
    let candidates: Vec<(Vec<NodeId>, ())> = vec![(vec![p(0), p(5)], ()), (vec![p(4)], ())];
    let groups = pairwise_graph_proximity_scan(
        &nav,
        &candidates,
        10,
        false,
        |_: &(Vec<NodeId>, ())| HashSet::new(),
        |_, _| true,
        |(nodes, _)| ScanAnchor::Multi(nodes.clone()),
        |(nodes, _)| ScanAnchor::Multi(nodes.clone()),
        |d| d < 10,
        |a, b| a.0 == b.0,
        |(own, _), (other, _)| ([own.clone(), other.clone()].concat(), 1),
    );
    assert_eq!(groups.len(), 2, "each side finds the other");
}

#[test]
fn graph_scan_pair_excluded_skips_a_candidate_without_ending_the_scan() {
    // Nearest candidate to x=0 is x=1, but it's excluded (identity exclusion stand-in); the
    // scan must still find x=2 rather than reporting nothing.
    let (nav, p) = corridor(6);
    let candidates = vec![p(0), p(1), p(2)];
    let groups = pairwise_graph_proximity_scan(
        &nav,
        &candidates,
        10,
        false,
        |_: &NodeId| HashSet::new(),
        |_, _| true,
        |&n| ScanAnchor::Single(n),
        |&n| ScanAnchor::Single(n),
        |d| d < 10,
        |&own, &other| own == other || other == p(1),
        |&own, &other| (vec![own, other], 1),
    );
    assert_eq!(
        groups.iter().filter(|(g, _)| g[0] == p(0)).count(),
        1,
        "x=0's scan must skip excluded x=1 and still find x=2"
    );
    assert_eq!(
        groups.iter().find(|(g, _)| g[0] == p(0)).unwrap().0[1],
        p(2)
    );
}

#[test]
fn graph_scan_empty_candidates_produce_no_groups() {
    let (nav, _p) = corridor(3);
    let candidates: Vec<NodeId> = Vec::new();
    let groups = scan_single(&nav, &candidates, 10, false, |d| d < 10);
    assert!(groups.is_empty());
}

#[test]
fn fires_for_every_pair_closer_than_threshold() {
    let candidates: Vec<f64> = vec![0.0, 1.0, 10.0];
    let groups = pairwise_geometric_scan(
        &candidates,
        5.0,
        |a, b| a == b,
        |a, b| (a - b).abs(),
        |a, b| (vec![*a as i64, *b as i64], 1),
    );
    assert_eq!(
        groups.len(),
        2,
        "0.0 and 1.0 both find each other close (dist 1.0 < 5.0); 10.0 finds nothing"
    );
}

#[test]
fn stops_at_first_close_pair_per_candidate() {
    let candidates: Vec<f64> = vec![0.0, 1.0, 2.0];
    let mut visits = 0;
    let groups = pairwise_geometric_scan(
        &candidates,
        5.0,
        |a, b| a == b,
        |a, b| {
            visits += 1;
            (a - b).abs()
        },
        |a, b| (vec![*a as i64, *b as i64], 1),
    );
    assert_eq!(groups.len(), 3, "every candidate finds a close partner");
    assert_eq!(
        visits,
        1 + 1 + 1,
        "each own candidate stops scanning right after its first close other, never visiting the remaining candidates"
    );
}

#[test]
fn pair_excluded_skips_without_counting_as_a_scan_stop() {
    let candidates: Vec<f64> = vec![0.0, 0.5, 1.0];
    let groups = pairwise_geometric_scan(
        &candidates,
        5.0,
        |a, b| a == b || (*a == 0.0 && *b == 0.5),
        |a, b| (a - b).abs(),
        |a, b| (vec![*a as i64, *b as i64], 1),
    );
    // own=0.0: other=0.5 excluded, other=1.0 close -> records (0.0, 1.0)
    assert!(groups.iter().any(|(g, _)| g == &vec![0i64, 1i64]));
}

#[test]
fn empty_candidates_produce_no_groups() {
    let candidates: Vec<f64> = Vec::new();
    let groups = pairwise_geometric_scan(
        &candidates,
        5.0,
        |_, _| false,
        |a, b| (a - b).abs(),
        |a, b| (vec![*a as i64, *b as i64], 1),
    );
    assert!(groups.is_empty());
}

#[test]
fn surface_scan_reports_a_symmetric_undecidable_pair_once() {
    let candidates: Vec<f64> = vec![0.0, 1.0];
    let scan = pairwise_surface_scan(
        &candidates,
        5.0,
        |a, b| a == b,
        |_, _| Err(DistanceError::Unsupported),
        |a, b| (vec![*a as i64, *b as i64], 1),
        |a, b| Some((*a as u64, *b as u64)),
    );
    assert!(scan.groups.is_empty());
    assert_eq!(scan.indeterminate.len(), 1);
}

#[test]
fn surface_scan_reports_undecidable_pairs_and_keeps_scanning() {
    let candidates: Vec<f64> = vec![0.0, 1.0, 2.0];
    let scan = pairwise_surface_scan(
        &candidates,
        5.0,
        |a, b| a == b,
        |a, b| match (*a as i64, *b as i64) {
            (0, 1) => Err(DistanceError::Unsupported),
            (0, 2) => Ok(DistanceResult {
                lower_bound: 1.0,
                upper_bound: 9.0,
                exact: false,
            }),
            _ => Ok(DistanceResult::exact((a - b).abs())),
        },
        |a, b| (vec![*a as i64, *b as i64], 1),
        |a, b| Some((*a as u64, *b as u64)),
    );
    // own=0.0 has no decidable partner: both pairs are reported, no group.
    assert!(scan.groups.iter().all(|(g, _)| g[0] != 0));
    let own_zero: Vec<_> = scan.indeterminate.iter().filter(|p| p.own == 0).collect();
    assert_eq!(own_zero.len(), 2);
    assert_eq!(own_zero[0].nodes, (0, 1));
    assert_eq!(own_zero[0].reason, IndeterminateReason::UnsupportedTopology);
    assert_eq!(own_zero[1].reason, IndeterminateReason::DistanceUnknown);
    // own=1.0 and own=2.0 are decided normally.
    assert_eq!(scan.groups.len(), 2);
}
