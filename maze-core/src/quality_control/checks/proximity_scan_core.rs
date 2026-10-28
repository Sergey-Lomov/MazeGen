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
#[path = "proximity_scan_core_tests.rs"]
mod tests;
