use super::proximity_scan_core::{ScanAnchor, pairwise_graph_proximity_scan};
use crate::Maze;
use crate::graph::EdgeKind;
use crate::graph::route_protection::is_teleport_route_protected;
use crate::ids::{EdgeId, NodeId};
use crate::quality_control::InvalidTeleportGroupIssue;
use crate::quality_control::check::Check;
use crate::space::Tessellation;
use rand::RngCore;
use std::collections::HashSet;

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
/// of this scan, same as every other per-teleport check from issue #74 — **except** against its
/// own opposite-direction counterpart (`Graph::teleport_reverse`), which is excluded from the
/// candidate scan (GitHub issue #190): both directions belong to the same physical teleport, so
/// they are never a legitimate "two teleports too close to each other" pair, however close the
/// teleport's own entry/exit happen to sit.
///
/// Multiple instances may be active at once (multiple instances, see the WASM
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
    /// candidate for `TeleportGroupSelectStrategy` to act on.
    pub protect_route: bool,
}

/// Returns the `ScanAnchor` `edge` selects — a single node for `Entry`/`Exit`, both ends
/// (`ScanAnchor::Endpoints`) for `EntryOrExit`.
fn anchor_of(edge: TeleportProximityEdge, from: NodeId, to: NodeId) -> ScanAnchor {
    match edge {
        TeleportProximityEdge::Entry => ScanAnchor::Single(from),
        TeleportProximityEdge::Exit => ScanAnchor::Single(to),
        TeleportProximityEdge::EntryOrExit => ScanAnchor::Endpoints(from, to),
    }
}

impl<T: Tessellation> Check<T, InvalidTeleportGroupIssue> for TeleportGroupProximityCheck {
    fn check_type_id(&self) -> &'static str {
        "teleport_group_proximity"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidTeleportGroupIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let teleports: Vec<(EdgeId, NodeId, NodeId)> = maze
            .graph
            .edges()
            .filter(|e| e.kind == EdgeKind::Teleport)
            .map(|e| (e.id, e.from, e.to))
            .collect();
        if teleports.len() < 2 {
            return;
        }

        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        // Largest tile-hop distance `dist < self.distance` can ever hold for — e.g.
        // distance=5.0 admits dist=4 but not 5, distance=1.5 admits dist=1 but not 2. Bounds
        // every Dijkstra pass to this radius (GitHub issue #196) instead of always walking the
        // full reachable nav-graph, since a hit farther than this can never pass the `<` check
        // below regardless of its exact distance.
        let max_dist = (self.distance.ceil() as isize - 1).max(0) as usize;

        // Excludes both directions of the scanned teleport's own physical pair (GitHub issue
        // #512, superseding #190's blanket "every teleport hop" exclusion) — a pedestrian could
        // otherwise "cheat" one tile via the opposite-direction ride of the very teleport being
        // scanned, but a hop through some *other* teleport is a genuine pedestrian option (that
        // teleport ride is itself a candidate this check scans separately). `own_hop_kind_guard`
        // additionally requires `NavEdge::is_teleport` (GitHub issue #197's parallel-edge
        // disambiguation) — a plain `Basic` edge sharing the same node pair as the teleport must
        // still count as pedestrian proximity, not be excluded alongside it.
        let own_hop_pairs = |&(_, own_from, own_to): &(EdgeId, NodeId, NodeId)| {
            HashSet::from([(own_from, own_to), (own_to, own_from)])
        };
        let own_hop_kind_guard =
            |_: &(EdgeId, NodeId, NodeId), edge: &crate::graph::nav::NavEdge| edge.is_teleport;

        let groups = pairwise_graph_proximity_scan(
            &nav,
            &teleports,
            max_dist,
            true, // directed: min(forward, reverse), see the check's own doc comment.
            own_hop_pairs,
            own_hop_kind_guard,
            |&(_, from, to)| anchor_of(self.own_edge, from, to),
            |&(_, from, to)| anchor_of(self.other_edge, from, to),
            |dist| (dist as f64) < self.distance,
            |&(own_id, ..), &(other_id, ..)| {
                // The opposite-direction Teleport edge of the same physical two-way teleport is
                // not a distinct teleport to be close to — it's the same entity, so it's excluded
                // from the candidate scan alongside `own_id` itself (GitHub issue #190).
                other_id == own_id
                    || Some(other_id) == maze.graph.teleport_reverse(own_id)
                    || (self.protect_route
                        && is_teleport_route_protected(maze, own_id)
                        && is_teleport_route_protected(maze, other_id))
            },
            |&(own_id, ..), &(other_id, ..)| (vec![own_id, other_id], 1),
        );

        if groups.is_empty() {
            return;
        }
        let issue = InvalidTeleportGroupIssue::new_from_check(&self.instance_id, groups)
            .with_detail(&self.instance_id, "distance", self.distance.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
#[path = "teleport_group_proximity_tests.rs"]
mod tests;
