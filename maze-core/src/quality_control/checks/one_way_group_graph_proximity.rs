use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::graph::EdgeKind;
use crate::graph::distance_map::{compute_distance_map_filtered_bounded, min_optional_distance, DistanceDirection};
use crate::graph::nav::{NavEdge, NavNodeId};
use crate::graph::route_protection::is_edge_on_route;
use crate::ids::EdgeId;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::{Issue, InvalidOneWayGroupIssue};

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
pub struct OneWayGroupGraphProximityCheck {
    pub instance_id: String,
    /// Tile-hop threshold — `f64` (not `u32`) so a fractional value (e.g. `1.5`) can cleanly
    /// separate an integer tile-hop count without off-by-one ambiguity.
    pub distance: f64,
    pub protect_route: bool,
}

/// Per-node distance maps, recomputed lazily and cached for one scan's duration — mirrors
/// `TeleportGroupProximityCheck`'s own `DirectedDistanceCache`.
struct DirectedDistanceCache<'a> {
    nav: &'a crate::graph::nav::NavGraph,
    max_dist: usize,
    forward: HashMap<NavNodeId, HashMap<NavNodeId, usize>>,
    reverse: HashMap<NavNodeId, HashMap<NavNodeId, usize>>,
}

impl<'a> DirectedDistanceCache<'a> {
    fn new(nav: &'a crate::graph::nav::NavGraph, max_dist: usize) -> Self {
        Self { nav, max_dist, forward: HashMap::new(), reverse: HashMap::new() }
    }

    fn is_not_teleport_hop(edge: &NavEdge) -> bool {
        !edge.is_teleport
    }

    fn distance(&mut self, a: NavNodeId, b: NavNodeId) -> Option<usize> {
        if a == b {
            return Some(0);
        }
        let max_dist = self.max_dist;
        let fwd = self.forward.entry(a)
            .or_insert_with(|| compute_distance_map_filtered_bounded(self.nav, a, DistanceDirection::Forward, |e| Self::is_not_teleport_hop(e), max_dist))
            .get(&b).copied();
        let rev = self.reverse.entry(a)
            .or_insert_with(|| compute_distance_map_filtered_bounded(self.nav, a, DistanceDirection::Reverse, |e| Self::is_not_teleport_hop(e), max_dist))
            .get(&b).copied();
        min_optional_distance(fwd, rev)
    }
}

impl<T: Tessellation> Check<T, InvalidOneWayGroupIssue> for OneWayGroupGraphProximityCheck {
    fn check_type_id(&self) -> &'static str { "one_way_group_graph_proximity" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidOneWayGroupIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let one_ways: Vec<(EdgeId, crate::ids::NodeId, crate::ids::NodeId)> = maze.graph.edges()
            .filter(|e| e.kind == EdgeKind::Basic)
            .filter(|e| maze.graph.edge_between_kind(e.to, e.from, &EdgeKind::Basic).is_none())
            .map(|e| (e.id, e.from, e.to))
            .collect();
        if one_ways.len() < 2 {
            return;
        }

        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        // Largest raw tile-hop count that can still pass `(dist + 1) < self.distance` — one less
        // than without the +1 offset (see the check's own doc comment), since a raw distance one
        // hop farther now already crosses the threshold.
        let max_dist = (self.distance.ceil() as isize - 2).max(0) as usize;
        let mut dist_cache = DirectedDistanceCache::new(&nav, max_dist);
        let mut groups: Vec<Vec<EdgeId>> = Vec::new();

        for &(own_id, own_from, own_to) in &one_ways {
            let own_navs: Vec<NavNodeId> = [own_from, own_to].into_iter()
                .filter_map(|n| nav.nav_node_for(n))
                .collect();
            if own_navs.is_empty() {
                continue;
            }

            for &(other_id, other_from, other_to) in &one_ways {
                if other_id == own_id {
                    continue;
                }
                let other_navs: Vec<NavNodeId> = [other_from, other_to].into_iter()
                    .filter_map(|n| nav.nav_node_for(n))
                    .collect();
                if other_navs.is_empty() {
                    continue;
                }

                let closest = own_navs.iter()
                    .flat_map(|&a| other_navs.iter().map(move |&b| (a, b)))
                    .filter_map(|(a, b)| dist_cache.distance(a, b))
                    .min();

                if let Some(dist) = closest {
                    // +1 offset — see the check's doc comment.
                    if ((dist + 1) as f64) < self.distance {
                        let both_route_protected = self.protect_route
                            && is_edge_on_route(maze, own_id)
                            && is_edge_on_route(maze, other_id);
                        if !both_route_protected {
                            groups.push(vec![own_id, other_id]);
                            break;
                        }
                    }
                }
            }
        }

        if groups.is_empty() {
            return;
        }
        let issue = InvalidOneWayGroupIssue::new_from_check(&self.instance_id, groups)
            .with_detail(&self.instance_id, "distance", self.distance.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
#[path = "one_way_group_graph_proximity_tests.rs"]
mod tests;
