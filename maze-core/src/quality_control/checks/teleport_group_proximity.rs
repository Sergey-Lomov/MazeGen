use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::graph::EdgeKind;
use crate::graph::distance_map::{compute_distance_map, min_optional_distance, DistanceDirection};
use crate::graph::nav::NavNodeId;
use crate::graph::route_protection::is_teleport_route_protected;
use crate::ids::EdgeId;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::{Issue, TeleportGroupProximityIssue};

pub const TELEPORT_GROUP_PROXIMITY_DISTANCE_DEFAULT: f64 = 0.0;

/// Which end of a teleport edge a `TeleportGroupProximityCheck` instance measures — `own_edge`
/// picks the end of the teleport currently being scanned, `other_edge` picks the end of the
/// candidate teleport it's compared against. `own_edge`/`other_edge` are independently
/// configurable (e.g. "exit of one teleport vs. entry of another"). `EntryOrExit` considers both
/// ends of that side of the pair and takes the closest combination — same "min across every
/// relevant combination" reduction as `TeleportWaypointDistanceCheck`'s own `EntryOrExit`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeleportProximityEdge {
    Entry,
    Exit,
    EntryOrExit,
}

/// Flags a pair of teleport edges placed topologically too close to each other — see GitHub
/// issue #75. Individual teleport checks (issue #74) only ever look at one teleport edge at a
/// time; this check instead catches problems that emerge from *pairs* of teleports being close
/// to each other, which no single-edge check can detect.
///
/// Distance is topological (tile-hops via the shared nav-graph distance map, same mechanism as
/// `TeleportWaypointDistanceCheck`), directed: for a given ordered pair (scanned teleport, other
/// teleport), distance is `min(forward, reverse)` between the scanned teleport's `own_edge`
/// endpoint and the other teleport's `other_edge` endpoint — the graph is directed-only, but a
/// close relationship in either direction is equally a proximity problem, so neither direction is
/// preferred over the other (same "worst-case/either-direction" rationale `LoopDistanceFromStartCheck`
/// and `TeleportWaypointDistanceCheck` use for their own reductions).
///
/// For each teleport edge, scans every other teleport edge for the first one whose relevant
/// endpoint is closer than `distance` — as soon as one problematic pair is found for a teleport,
/// it's recorded and the scan moves to the next teleport (no need to enumerate every pair a
/// teleport participates in). Each direction of a two-way teleport is its own independent element
/// of this scan, same as every other per-teleport check from issue #74.
///
/// Multiple instances may be active at once (`allow_multiple_instances: true`, see the WASM
/// Interface section in `Specs/quality_control.md`) — distinct `own_edge`/`other_edge`/`distance`
/// combinations are a legitimate simultaneous configuration, same rationale as
/// `TeleportWaypointDistanceCheck`.
pub struct TeleportGroupProximityCheck {
    pub instance_id: String,
    /// Tile-hop threshold — `f64` (not `u32`) so a fractional value (e.g. `1.5`) can cleanly
    /// separate an integer tile-hop count (`1` fails, `2` passes) without off-by-one ambiguity.
    pub distance: f64,
    pub own_edge: TeleportProximityEdge,
    pub other_edge: TeleportProximityEdge,
    /// GitHub issue #78, default `true`: a pair is only excluded when *both* teleports are
    /// route-critical (`is_teleport_route_protected`) — if only one side of the pair sits on the
    /// route, the pair is still recorded, since the non-route side remains a legitimate removal
    /// candidate for `TeleportGroupProximityStrategy` to act on.
    pub protect_route: bool,
}

/// Returns the endpoint(s) `edge` selects — one for `Entry`/`Exit`, both for `EntryOrExit`
/// (a smallvec-style inline array avoids allocating a `Vec` per lookup).
fn endpoints_of(edge: TeleportProximityEdge, from: crate::ids::NodeId, to: crate::ids::NodeId) -> [Option<crate::ids::NodeId>; 2] {
    match edge {
        TeleportProximityEdge::Entry => [Some(from), None],
        TeleportProximityEdge::Exit => [Some(to), None],
        TeleportProximityEdge::EntryOrExit => [Some(from), Some(to)],
    }
}

/// Per-teleport-endpoint distance maps, recomputed lazily and cached for one scan's duration (a
/// teleport's own_edge endpoint is queried once per teleport it's scanned against, so without
/// caching the same source would be re-run once per candidate). Cost is O(distinct own endpoints
/// × nav-graph Dijkstra) — linear in teleport count (at most 2 endpoints per teleport with
/// `EntryOrExit`, so bounded by 2 × teleport count), unlike the cycle-enumeration checks
/// (`find_all_simple_cycles`), whose cost can grow exponentially in graph size and therefore need
/// `MAX_SIMPLE_CYCLES`/`TooManyCycles` to cap runaway work. No equivalent cap is needed here since
/// growth stays linear regardless of maze topology.
struct DirectedDistanceCache<'a> {
    nav: &'a crate::graph::nav::NavGraph,
    forward: HashMap<NavNodeId, HashMap<NavNodeId, usize>>,
    reverse: HashMap<NavNodeId, HashMap<NavNodeId, usize>>,
}

impl<'a> DirectedDistanceCache<'a> {
    fn new(nav: &'a crate::graph::nav::NavGraph) -> Self {
        Self { nav, forward: HashMap::new(), reverse: HashMap::new() }
    }

    /// min(forward, reverse) tile-hop distance between two nav-nodes — the graph stays
    /// directed-only throughout (each direction computed via its own Dijkstra pass), but a pair
    /// close in *either* direction is equally a proximity problem.
    fn distance(&mut self, a: NavNodeId, b: NavNodeId) -> Option<usize> {
        if a == b {
            return Some(0);
        }
        let fwd = self.forward.entry(a)
            .or_insert_with(|| compute_distance_map(self.nav, a, DistanceDirection::Forward))
            .get(&b).copied();
        let rev = self.reverse.entry(a)
            .or_insert_with(|| compute_distance_map(self.nav, a, DistanceDirection::Reverse))
            .get(&b).copied();
        min_optional_distance(fwd, rev)
    }
}

impl<T: Tessellation> Check<T, TeleportGroupProximityIssue> for TeleportGroupProximityCheck {
    fn check_type_id(&self) -> &'static str { "teleport_group_proximity" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<TeleportGroupProximityIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let teleports: Vec<_> = maze.graph.edges()
            .filter(|e| e.kind == EdgeKind::Teleport)
            .map(|e| (e.id, e.from, e.to))
            .collect();
        if teleports.len() < 2 {
            return;
        }

        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        let mut dist_cache = DirectedDistanceCache::new(&nav);
        let mut pairs: Vec<(EdgeId, EdgeId)> = Vec::new();

        for &(own_id, own_from, own_to) in &teleports {
            let own_navs: Vec<NavNodeId> = endpoints_of(self.own_edge, own_from, own_to).into_iter()
                .flatten()
                .filter_map(|n| nav.nav_node_for(n))
                .collect();
            if own_navs.is_empty() {
                continue;
            }

            for &(other_id, other_from, other_to) in &teleports {
                if other_id == own_id {
                    continue;
                }
                let other_navs: Vec<NavNodeId> = endpoints_of(self.other_edge, other_from, other_to).into_iter()
                    .flatten()
                    .filter_map(|n| nav.nav_node_for(n))
                    .collect();
                if other_navs.is_empty() {
                    continue;
                }

                // Closest combination across every (own endpoint, other endpoint) pair this
                // instance's selectors expand to — same "min across every relevant combination"
                // reduction TeleportWaypointDistanceCheck's own EntryOrExit uses.
                let closest = own_navs.iter()
                    .flat_map(|&a| other_navs.iter().map(move |&b| (a, b)))
                    .filter_map(|(a, b)| dist_cache.distance(a, b))
                    .min();

                if let Some(dist) = closest {
                    if (dist as f64) < self.distance {
                        let both_route_protected = self.protect_route
                            && is_teleport_route_protected(maze, own_id)
                            && is_teleport_route_protected(maze, other_id);
                        // A pair excluded because both sides are route-critical doesn't stop the
                        // scan for `own_id` — a farther, non-protected candidate may still exist
                        // and would otherwise never be recorded.
                        if !both_route_protected {
                            pairs.push((own_id, other_id));
                            break;
                        }
                    }
                }
            }
        }

        if pairs.is_empty() {
            return;
        }
        let issue = TeleportGroupProximityIssue::new_from_check(&self.instance_id, pairs)
            .with_detail(&self.instance_id, "distance", self.distance.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
#[path = "teleport_group_proximity_tests.rs"]
mod tests;
