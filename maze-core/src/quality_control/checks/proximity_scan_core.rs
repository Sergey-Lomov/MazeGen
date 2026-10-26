use crate::comparison::Comparison;
use crate::graph::nav::{NavEdge, NavGraph, NavNodeId};
use crate::graph::pathfinding::{
    dijkstra_forward_visit_edges_bounded, dijkstra_reverse_visit_edges_bounded,
};
use crate::ids::NodeId;
use crate::quality_control::{DistanceDiagnostics, IndeterminateReason};
use crate::space::{DistanceError, DistanceResult, WithinLimit};
use std::collections::{HashMap, HashSet};

/// A candidate's nav-graph anchor point(s) for `pairwise_graph_proximity_scan` — most checks
/// anchor on a single `NodeId` (`Single`), a two-ended element (a teleport portal, a one-way edge)
/// anchors on both its `from` and `to` (`Endpoints`), and a split tile (`SplitGroupGraphProximityCheck`)
/// anchors on every node sharing its point, however many (`Multi`). Each variant is scanned exactly
/// like that many independent `Single` occurrences of the same candidate would be, mirroring
/// `TeleportProximityEdge::EntryOrExit`'s own "closest across every combination of ends" reduction,
/// then reduced back to one nearest result for that candidate.
pub enum ScanAnchor {
    Single(NodeId),
    Endpoints(NodeId, NodeId),
    Multi(Vec<NodeId>),
}

impl ScanAnchor {
    fn nodes(&self) -> Vec<NodeId> {
        match self {
            ScanAnchor::Single(n) => vec![*n],
            ScanAnchor::Endpoints(a, b) => vec![*a, *b],
            ScanAnchor::Multi(ns) => ns.clone(),
        }
    }
}

/// Shared pairwise proximity scan for topological (nav-graph, own-group-hop-excluded) QC checks —
/// see GitHub issue #413, and GitHub issue #512 for the per-candidate exclusion set. Mirrors every
/// graph-proximity check's identical shape: for each `own` candidate, find the *nearest*
/// non-excluded `other` candidate accepted by `close_enough` (not merely the first one in
/// `candidates` order — see `nearest_candidate_within`'s own doc comment for why that distinction
/// matters), excluding hops through `own`'s own exclusion set (`own_hop_pairs(own)` — e.g. the
/// other stops of `own`'s own elevator, or `own`'s own teleport pair, computed once per `own`). A
/// hop through some *other* candidate's fast-travel connection is traversed normally — only
/// `own`'s own connection is excluded, so it never pressures a neighbour merely by being one of
/// several ends/stops of the same physical element (GitHub issue #512).
///
/// `own_hop_kind_guard` additionally filters by the full `NavEdge` (not just its `(from, to)`
/// pair) — most callers pass `|_, _| true` (any edge on that node pair counts, `own_hop_pairs`
/// alone is enough), but a caller whose own fast-travel kind can coexist with a plain `Basic` edge
/// on the very same node pair (GitHub issue #197's parallel-edge case) must check
/// `NavEdge::is_teleport`/`is_elevator`/`is_vertical` too, so that parallel `Basic` edge still
/// counts as pedestrian proximity instead of being excluded alongside its own fast-travel sibling
/// (see `TeleportGroupProximityCheck`'s own `is_teleport` guard).
///
/// `max_dist` bounds every Dijkstra pass (GitHub issue #196) — the largest raw tile-hop count
/// `close_enough` can ever accept; a caller applying its own offset (e.g.
/// `OneWayGroupGraphProximityCheck`'s `+1`, below) must adjust `max_dist` down by that same offset,
/// same as that check already does for its own bounded passes. `close_enough` receives the raw
/// tile-hop count and decides whether it counts as close — plain `|d| d < distance` for most
/// callers, or `OneWayGroupGraphProximityCheck`'s `|d| (d + 1) < distance` for its own
/// border-vs-node offset; kept as a predicate rather than a bare `u32` threshold so a caller's own
/// offset stays local to the caller instead of this shared helper growing a parameter per caller's
/// quirk.
///
/// `own_anchor`/`other_anchor` return a candidate's `ScanAnchor` — a single maze `NodeId` for most
/// checks, or both ends of a two-ended element (`Endpoints`) for
/// `TeleportGroupProximityCheck`/`OneWayGroupGraphProximityCheck`-shaped callers, reduced to the
/// closest combination automatically. They're separate accessors (not one shared `own`/`other`
/// accessor) because a caller like `TeleportGroupProximityCheck` picks a different
/// `TeleportProximityEdge` role for its own side vs. the side it compares against (`own_edge`
/// independently configurable from `other_edge`); a caller with one uniform accessor simply passes
/// the same closure for both. `directed`: when `true`, both the forward and the reverse
/// nav-graph traversal are run and the closer of the two wins per anchor combination (the directed
/// "either direction is equally a proximity problem" reduction `TeleportGroupProximityCheck`/
/// `OneWayGroupGraphProximityCheck` need); `false` runs forward only (every other current caller,
/// which only ever needs pedestrian-forward closeness).
///
/// Distance is measured via `nearest_candidate_within`, which resolves a corridor-interior node
/// (no `NavNodeId` of its own, e.g. a `Split` occurrence sitting on an otherwise-plain 2-degree
/// tile) to its exact tile-hop count instead of silently dropping it (GitHub issue #512
/// follow-up) — the naive `NavGraph::nav_node_for` lookup this helper used to key on returns `None`
/// for such a node, which previously excluded it from every scan outright. One bounded traversal
/// per `own` anchor (two when `directed`) visits every candidate it can reach (on a nav-node or
/// corridor-interior tile alike) in a single pass — same asymptotic cost as the pre-#512
/// shared-`dist_map` version, just with the corridor-interior resolution and nearest-wins
/// selection added on top.
#[allow(clippy::too_many_arguments)]
pub fn pairwise_graph_proximity_scan<C, K>(
    nav: &NavGraph,
    candidates: &[C],
    max_dist: usize,
    directed: bool,
    own_hop_pairs: impl Fn(&C) -> HashSet<(NodeId, NodeId)>,
    own_hop_kind_guard: impl Fn(&C, &NavEdge) -> bool,
    own_anchor: impl Fn(&C) -> ScanAnchor,
    other_anchor: impl Fn(&C) -> ScanAnchor,
    mut close_enough: impl FnMut(usize) -> bool,
    mut pair_excluded: impl FnMut(&C, &C) -> bool,
    mut on_close: impl FnMut(&C, &C) -> (Vec<K>, u32),
) -> Vec<(Vec<K>, u32)> {
    let mut groups = Vec::new();

    for own in candidates {
        let hop_pairs = own_hop_pairs(own);
        let is_not_a_hop = |edge: &NavEdge| {
            !(edge.path.len() == 2
                && hop_pairs.contains(&(edge.path[0], edge.path[1]))
                && own_hop_kind_guard(own, edge))
        };

        // Index every non-excluded `other`'s anchor node(s), so the traversal below can recognize
        // a candidate the moment it walks over its tile, however many candidates (or anchor ends)
        // share that exact node (e.g. several `Split` occurrences at the same point, or a
        // two-ended element's own `from`/`to`).
        let mut others_by_node: HashMap<NodeId, Vec<usize>> = HashMap::new();
        for (other_idx, other) in candidates.iter().enumerate() {
            if pair_excluded(own, other) {
                continue;
            }
            for node in other_anchor(other).nodes() {
                others_by_node.entry(node).or_default().push(other_idx);
            }
        }
        if others_by_node.is_empty() {
            continue;
        }

        let best = own_anchor_nearest(
            nav,
            &own_anchor(own),
            is_not_a_hop,
            max_dist,
            directed,
            &others_by_node,
        );

        if let Some((dist, other_idx)) = best
            && close_enough(dist)
        {
            groups.push(on_close(own, &candidates[other_idx]));
        }
    }
    groups
}

/// Reduces `own`'s anchor(s) down to the single nearest `(distance, other candidate index)` —
/// tries every one of `own`'s own anchor nodes (both ends for `Endpoints`), and forward as well as
/// reverse when `directed`, keeping the closest result across all of them, same "closest
/// combination across every relevant anchor" reduction `TeleportProximityEdge::EntryOrExit` and
/// `TeleportGroupProximityCheck`'s own directed `min(forward, reverse)` use.
fn own_anchor_nearest(
    nav: &NavGraph,
    own: &ScanAnchor,
    edge_filter: impl Fn(&NavEdge) -> bool,
    max_dist: usize,
    directed: bool,
    targets: &HashMap<NodeId, Vec<usize>>,
) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize)> = None;
    for own_node in own.nodes() {
        if let Some((d, i)) = nearest_candidate_within(
            nav,
            own_node,
            &edge_filter,
            max_dist,
            ScanDirection::Forward,
            targets,
        ) && best.is_none_or(|(bd, _)| d < bd)
        {
            best = Some((d, i));
        }
        if directed
            && let Some((d, i)) = nearest_candidate_within(
                nav,
                own_node,
                &edge_filter,
                max_dist,
                ScanDirection::Reverse,
                targets,
            )
            && best.is_none_or(|(bd, _)| d < bd)
        {
            best = Some((d, i));
        }
    }
    best
}

/// Which nav-graph traversal direction `nearest_candidate_within` should use — see
/// `pairwise_graph_proximity_scan`'s own `directed` parameter.
#[derive(Clone, Copy)]
enum ScanDirection {
    Forward,
    Reverse,
}

/// Finds the nearest of `targets` (keyed by maze `NodeId`, possibly several per node) reachable
/// from `from` within `max_dist` tile-hops, honoring `edge_filter` on every nav-domain hop
/// considered — the graph-proximity counterpart of `pairwise_geometric_scan`'s per-`own` nearest
/// search, but over the nav graph instead of raw Euclidean distance.
///
/// A pure "first close candidate in list order, then stop" scan (this function's predecessor)
/// can report an arbitrary farther candidate as the pair simply because it happens to sit earlier
/// in the candidates list, leaving a genuinely nearer one unrecorded — e.g. a `VerticalPassage`'s
/// far endpoint could shadow its own near endpoint, or vice versa, purely by iteration order, even
/// though both ends belong to the same physical element and either should be reported if either is
/// close enough. Selecting the nearest instead removes that ordering dependency.
///
/// Every target is resolved in one traversal instead of one per target
/// (`ExactTileDistanceFromSource`'s per-pair predecessor, GitHub issue #512 follow-up): a target
/// sitting on a nav-node is seen when the edge reaching it is relaxed (distance = the edge's own
/// `from`-side distance plus its full length); a target sitting on a corridor-interior tile (e.g.
/// a `Split` occurrence with no `NavNodeId` of its own) is seen the same way, just at a shorter
/// offset partway along the same edge's `path` — both checked via `dijkstra_forward_visit_edges_bounded`'s
/// per-edge callback, so a corridor-interior target is never silently dropped by only resolving
/// `NavNodeId`s (the bug this whole call chain exists to avoid, see GitHub issue #512 follow-up).
///
/// `from` itself is never matched even if it also appears in `targets` — a caller must exclude the
/// candidate representing its own scanned occurrence via `targets` (or `pair_excluded` upstream)
/// before calling this, same as every other proximity scan's own identity exclusion.
///
/// `direction` picks which nav-graph traversal to run: `Forward` measures "how close is something
/// `from` can walk to", `Reverse` measures "how close is something that can walk to `from`" (same
/// distinction `DistanceDirection` makes elsewhere) — both walk `edge.path` in the same array order
/// regardless of direction (a `NavEdge`'s `path` is always stored `from`-to-`to`), only the
/// distance accounting differs: `Forward` counts up from `from`'s own position in the path,
/// `Reverse` counts up from `from`'s position toward the path's start, since a `Reverse` traversal
/// arrives at edges from their `to` end.
fn nearest_candidate_within<V: Copy>(
    nav: &NavGraph,
    from: NodeId,
    edge_filter: impl Fn(&NavEdge) -> bool,
    max_dist: usize,
    direction: ScanDirection,
    targets: &HashMap<NodeId, Vec<V>>,
) -> Option<(usize, V)> {
    let mut best: Option<(usize, V)> = None;
    let mut consider = |dist: usize, node: NodeId| {
        if dist > max_dist {
            return;
        }
        let Some(vs) = targets.get(&node) else {
            return;
        };
        for &v in vs {
            if best.is_none_or(|(best_dist, _)| dist < best_dist) {
                best = Some((dist, v));
            }
        }
    };

    // `from` itself, at distance 0 — legitimate when `targets` holds a *different* candidate that
    // happens to anchor on this very node (e.g. two one-way edges sharing a node,
    // `OneWayGroupGraphProximityCheck`'s own `Endpoints` anchors): Dijkstra/the corridor walk below
    // never calls `consider` for the zero-cost starting point itself, only for nodes reached by
    // walking an edge outward, so it's checked explicitly here instead. `targets` never contains
    // `from`'s own candidate (the caller excludes `own` from `other_anchor`'s index via
    // `pair_excluded` before building it), so this can never spuriously match `own` against
    // itself.
    consider(0, from);

    // Same same-corridor-edge short-circuit `exact_tile_distance_filtered` uses: `from` itself
    // may be corridor-interior, in which case a target elsewhere on the very same edge is
    // reachable without ever going through a nav-node at all — `Forward` looks further along the
    // path (`from`'s position is `path`'s own `from`-to-`to` order), `Reverse` looks earlier in it
    // (a `Reverse` walk moves from `to` back toward `from`).
    for &(edge_idx, from_i) in &nav.corridor_edge_positions(from).collect::<Vec<_>>() {
        let edge = nav.edge_by_idx(edge_idx);
        match direction {
            ScanDirection::Forward => {
                for (to_i, &tile) in edge.path.iter().enumerate().skip(from_i + 1) {
                    consider(to_i - from_i, tile);
                }
            }
            ScanDirection::Reverse => {
                for (to_i, &tile) in edge.path.iter().enumerate().take(from_i) {
                    consider(from_i - to_i, tile);
                }
            }
        }
    }

    let from_exits: Vec<(NavNodeId, usize)> = match direction {
        ScanDirection::Forward => match nav.nav_node_for(from) {
            Some(nav_id) => vec![(nav_id, 0)],
            None => nav.corridor_exit_offsets(from).collect(),
        },
        ScanDirection::Reverse => match nav.nav_node_for(from) {
            Some(nav_id) => vec![(nav_id, 0)],
            None => nav.corridor_entry_offsets(from).collect(),
        },
    };

    for (from_nav, from_offset) in from_exits {
        if from_offset > max_dist {
            continue;
        }
        let remaining = Some(max_dist - from_offset);
        match direction {
            ScanDirection::Forward => {
                dijkstra_forward_visit_edges_bounded(
                    nav,
                    from_nav,
                    &edge_filter,
                    remaining,
                    |edge, cost_at_from| {
                        let base = from_offset + cost_at_from;
                        for (i, &tile) in edge.path.iter().enumerate().skip(1) {
                            consider(base + i, tile);
                        }
                        true
                    },
                );
            }
            ScanDirection::Reverse => {
                dijkstra_reverse_visit_edges_bounded(
                    nav,
                    from_nav,
                    &edge_filter,
                    remaining,
                    |edge, cost_at_to| {
                        let base = from_offset + cost_at_to;
                        let last = edge.path.len() - 1;
                        for (i, &tile) in edge.path.iter().enumerate().take(last).rev() {
                            consider(base + (last - i), tile);
                        }
                        true
                    },
                );
            }
        }
    }

    best
}

/// Shared pairwise proximity scan for geometric-distance QC checks — see GitHub issue #413 (and
/// GitHub issue #838 for the fold-aware `distance`, see `pairwise_surface_scan` below).
///
/// `candidates` is scanned as an own/other double loop: for each `own` candidate, every `other`
/// candidate is tried in order until `pair_excluded` skips it or `distance` reports it closer
/// than `threshold`, at which point `own`'s scan stops (mirrors every geometric proximity check's
/// own "first close pair wins, no need to enumerate every pair for the same candidate" shape).
/// `on_close` builds the group entry (a two-element `Vec<K>` plus `to_remove`, though the closure
/// decides both) recorded for that pair.
///
/// `pair_excluded` covers a check's own extra exclusion rule (same-elevator stops, same tile
/// point, same edge id, `same_type_only`/route protection, ...) on top of the identity check
/// every caller already needs (`own`/`other` being literally the same slot is the caller's
/// responsibility to encode into `pair_excluded` too, since "same slot" differs per candidate
/// shape — an index, an id, ...).
/// A pair the scan could neither flag nor clear: the candidate indices and the pair's
/// representative nodes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IndeterminatePair {
    pub own: usize,
    pub other: usize,
    pub nodes: (NodeId, NodeId),
    pub reason: IndeterminateReason,
}

/// Result of `pairwise_surface_scan`: the flagged groups plus the pairs that could not be decided.
pub struct SurfaceScan<K> {
    pub groups: Vec<(Vec<K>, u32)>,
    pub indeterminate: Vec<IndeterminatePair>,
}

impl<K> SurfaceScan<K> {
    /// Records the undecidable pairs in `diagnostics` (surfaced by the engine as an
    /// `IndeterminateDistanceIssue`) and returns the flagged groups.
    pub fn into_groups(self, diagnostics: &DistanceDiagnostics) -> Vec<(Vec<K>, u32)> {
        for pair in &self.indeterminate {
            diagnostics.record(pair.nodes.0, pair.nodes.1, pair.reason);
        }
        self.groups
    }
}

/// `pairwise_geometric_scan` over fold-aware distances (GitHub issue #838): `distance` returns
/// the pair's `DistanceResult` bracket (or `Unsupported`), compared with `< threshold`. `Yes`
/// flags the pair, `No` clears it, and an undecidable pair (`Unknown`, `Unsupported`) is neither
/// flagged nor silently passed: it is reported in `SurfaceScan::indeterminate`, and the scan goes
/// on to the next `other`, so a later definite match still counts. Each unordered pair is
/// reported at most once, although the scan visits it from both sides. `pair_nodes` names the
/// representative maze node of each candidate for the report; a pair it cannot name is dropped.
pub fn pairwise_surface_scan<C, K>(
    candidates: &[C],
    threshold: f64,
    mut pair_excluded: impl FnMut(&C, &C) -> bool,
    mut distance: impl FnMut(&C, &C) -> Result<DistanceResult, DistanceError>,
    mut on_close: impl FnMut(&C, &C) -> (Vec<K>, u32),
    mut pair_nodes: impl FnMut(&C, &C) -> Option<(NodeId, NodeId)>,
) -> SurfaceScan<K> {
    let mut scan = SurfaceScan {
        groups: Vec::new(),
        indeterminate: Vec::new(),
    };
    let mut reported = std::collections::HashSet::new();
    for (own_idx, own) in candidates.iter().enumerate() {
        for (other_idx, other) in candidates.iter().enumerate() {
            if pair_excluded(own, other) {
                continue;
            }
            let reason = match distance(own, other) {
                Ok(result) => match result.compare(Comparison::Lt, threshold) {
                    WithinLimit::Yes => {
                        scan.groups.push(on_close(own, other));
                        break;
                    }
                    WithinLimit::No => continue,
                    WithinLimit::Unknown => IndeterminateReason::DistanceUnknown,
                },
                Err(DistanceError::Unsupported) => IndeterminateReason::UnsupportedTopology,
            };
            if let Some(nodes) = pair_nodes(own, other)
                && reported.insert((own_idx.min(other_idx), own_idx.max(other_idx)))
            {
                scan.indeterminate.push(IndeterminatePair {
                    own: own_idx,
                    other: other_idx,
                    nodes,
                    reason,
                });
            }
        }
    }
    scan
}

#[cfg(test)]
mod tests {
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
}
