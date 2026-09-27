use super::proximity_scan_core::{ScanAnchor, pairwise_graph_proximity_scan};
use crate::Maze;
use crate::graph::route_protection::is_edge_on_route;
use crate::ids::EdgeId;
use crate::quality_control::InvalidOneWayGroupIssue;
use crate::quality_control::check::Check;
use crate::quality_control::checks::one_way_core::one_way_edges_with_endpoints;
use crate::space::Tessellation;
use rand::RngCore;
use std::collections::HashSet;

pub const ONE_WAY_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT: f64 = 0.0;

/// Flags a pair of one-way passage edges (`EdgeKind::Basic`, single direction) placed too close
/// to each other topologically (tile-hops via the shared nav-graph distance map) — see GitHub
/// issue #199. The topological counterpart of `OneWayGroupGeometricProximityCheck`; same
/// scanning/`protect_route` rules, different metric — see that check's doc comment.
///
/// Distance is directed: for a given ordered pair (scanned edge, other edge), distance is
/// `min(forward, reverse)` across every combination of the two edges' own endpoints (`from`/
/// `to`), mirroring `TeleportGroupProximityCheck`'s "worst-case/either-direction" reduction, with
/// no edge-role selector (same rationale as `OneWayGroupGeometricProximityCheck`'s own "min
/// across both endpoints").
///
/// **+1 offset (GitHub issue #199 follow-up)**: the raw tile-hop count between two node
/// endpoints is bumped by one before comparing against `distance`. One-way edges render visually
/// on tile *borders*, not at nodes — a user sees two one-ways sharing a `from` node as adjacent
/// (intuitively distance 1, not the raw node-distance 0), and two one-ways leaving neighboring
/// tiles as distance 2 (not the raw 1). The +1 offset is applied once, to the final `min` across
/// every endpoint combination, not to each individual `dist_cache.distance()` call — equivalent
/// for the `min` itself, but keeps the cache's own values as plain tile-hop counts.
///
/// Traversal excludes only the scanned edge's *own* directed hop (GitHub issue #512) — a one-way
/// owns no fast-travel connection, so unlike `TeleportGroupProximityCheck`/
/// `ElevatorStopGroupGraphProximityCheck` there is no multi-end/multi-stop over-pressuring problem
/// to solve here; every other hop (including through a `Teleport`/`VerticalPassage`/`Elevator`
/// elsewhere in the maze) is a genuine pedestrian option. This exclusion never changes a reported
/// pair: without it, scanning from `own_from` would walk straight across the one-way to `own_to`
/// and only ever reach any `other` one hop farther than a scan from `own_to` already does, and the
/// `min` across both endpoints (below) always keeps `own_to`'s shorter number. It exists purely to
/// skip that redundant, always-discarded Dijkstra work.
pub struct OneWayGroupGraphProximityCheck {
    pub instance_id: String,
    /// Tile-hop threshold — `f64` (not `u32`) so a fractional value (e.g. `1.5`) can cleanly
    /// separate an integer tile-hop count without off-by-one ambiguity.
    pub distance: f64,
    pub protect_route: bool,
}

impl<T: Tessellation> Check<T, InvalidOneWayGroupIssue> for OneWayGroupGraphProximityCheck {
    fn check_type_id(&self) -> &'static str {
        "one_way_group_graph_proximity"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidOneWayGroupIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let one_ways: Vec<(EdgeId, crate::ids::NodeId, crate::ids::NodeId)> =
            one_way_edges_with_endpoints(maze);
        if one_ways.len() < 2 {
            return;
        }

        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        // Largest raw tile-hop count that can still pass `(dist + 1) < self.distance` — one less
        // than without the +1 offset (see the check's own doc comment), since a raw distance one
        // hop farther now already crosses the threshold.
        let max_dist = (self.distance.ceil() as isize - 2).max(0) as usize;

        // Excludes only the scanned one-way's own directed hop (`own_from` -> `own_to`) — every
        // other hop, including the reverse direction (which a one-way can't traverse anyway) and
        // any other element's fast-travel connection, is a genuine pedestrian option (GitHub
        // issue #512).
        let own_hop_pairs = |&(_, own_from, own_to): &(EdgeId, crate::ids::NodeId, crate::ids::NodeId)| {
            HashSet::from([(own_from, own_to)])
        };

        let groups = pairwise_graph_proximity_scan(
            &nav,
            &one_ways,
            max_dist,
            true, // directed: min(forward, reverse), see the check's own doc comment.
            own_hop_pairs,
            |_, _| true,
            |&(_, from, to)| ScanAnchor::Endpoints(from, to),
            |&(_, from, to)| ScanAnchor::Endpoints(from, to),
            |dist| ((dist + 1) as f64) < self.distance, // +1 offset -- see the check's doc comment.
            |&(own_id, ..), &(other_id, ..)| {
                own_id == other_id
                    || (self.protect_route
                        && is_edge_on_route(maze, own_id)
                        && is_edge_on_route(maze, other_id))
            },
            |&(own_id, ..), &(other_id, ..)| (vec![own_id, other_id], 1),
        );

        if groups.is_empty() {
            return;
        }
        let issue = InvalidOneWayGroupIssue::new_from_check(&self.instance_id, groups).with_detail(
            &self.instance_id,
            "distance",
            self.distance.to_string(),
        );
        issues.push(issue);
    }
}

#[cfg(test)]
#[path = "one_way_group_graph_proximity_tests.rs"]
mod tests;
