use rand::RngCore;
use crate::Maze;
use crate::graph::EdgeKind;
use crate::graph::route_protection::is_edge_on_route;
use crate::space::{Tessellation, geometric_edge_distance};
use crate::quality_control::check::Check;
use crate::quality_control::{InvalidOneWayGroupIssue};

pub const ONE_WAY_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT: f64 = 0.0;

/// Flags a pair of one-way passage edges (`EdgeKind::Basic`, single direction) placed too close
/// to each other in geometric (Euclidean, unit tile scale — see `space::geometric_edge_distance`)
/// space — see GitHub issue #199. Individual one-way checks (issue #198) only ever look at one
/// edge at a time; this check instead catches problems that emerge from *pairs* of one-way edges
/// being close to each other, which no single-edge check can detect. Mirrors
/// `TeleportGroupProximityCheck`'s role, but for one-way edges and a geometric (not topological)
/// metric — see `OneWayGroupGraphProximityCheck` for the topological counterpart.
///
/// Unlike `TeleportGroupProximityCheck`, there is no edge-role selector: a one-way edge renders
/// visually on the tile border it crosses, not at either endpoint node, so distance is measured
/// between the two edges' `Tessellation::edge_position`s directly (`geometric_edge_distance`) —
/// there is no "entry"/"exit" endpoint pairing to reduce over the way there is for a teleport
/// jump (or the node-to-node distance the pre-#199-followup version of this check used).
///
/// For each one-way edge, scans every other one-way edge for the first one closer than
/// `distance` — as soon as one problematic pair is found for an edge, it's recorded and the scan
/// moves to the next edge (no need to enumerate every pair).
pub struct OneWayGroupGeometricProximityCheck {
    pub instance_id: String,
    pub distance: f64,
    /// GitHub issue #199's path protection: a pair is only excluded when *both* one-way edges lie
    /// on the maze's current start->finish route (`is_edge_on_route`) — mirrors
    /// `TeleportGroupProximityCheck`'s `protect_route` rule (issue #78): if only one side of the
    /// pair sits on the route, the pair is still recorded, since the non-route side remains a
    /// legitimate repair candidate.
    pub protect_route: bool,
}

impl<T: Tessellation> Check<T, InvalidOneWayGroupIssue> for OneWayGroupGeometricProximityCheck {
    fn check_type_id(&self) -> &'static str { "one_way_group_geometric_proximity" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidOneWayGroupIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let one_ways: Vec<_> = maze.graph.edges()
            .filter(|e| e.kind == EdgeKind::Basic)
            .filter(|e| maze.graph.edge_between_kind(e.to, e.from, &EdgeKind::Basic).is_none())
            .filter_map(|e| {
                let from = maze.field.point_of(e.from)?;
                let to = maze.field.point_of(e.to)?;
                Some((e.id, from, to))
            })
            .collect();
        if one_ways.len() < 2 {
            return;
        }

        let mut groups: Vec<(Vec<crate::ids::EdgeId>, u32)> = Vec::new();

        for &(own_id, own_from, own_to) in &one_ways {
            for &(other_id, other_from, other_to) in &one_ways {
                if other_id == own_id {
                    continue;
                }

                let dist = geometric_edge_distance::<T>(own_from, own_to, other_from, other_to);

                if dist < self.distance {
                    let both_route_protected = self.protect_route
                        && is_edge_on_route(maze, own_id)
                        && is_edge_on_route(maze, other_id);
                    if !both_route_protected {
                        // Fixing either edge in the pair breaks the pair -- one fix resolves it.
                        groups.push((vec![own_id, other_id], 1));
                        break;
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
#[path = "one_way_group_geometric_proximity_tests.rs"]
mod tests;
