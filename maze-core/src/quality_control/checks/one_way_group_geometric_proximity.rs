use super::proximity_scan_core::pairwise_geometric_scan;
use crate::Maze;
use crate::graph::route_protection::is_edge_on_route;
use crate::quality_control::check::Check;
use crate::quality_control::checks::one_way_core::one_way_edges_with_endpoints;
use crate::quality_control::{GeometricFloorMode, InvalidOneWayGroupIssue};
use crate::space::{Tessellation, edge_position, floor_aware_xy_distance};
use rand::RngCore;

pub const ONE_WAY_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT: f64 = 0.0;
pub const ONE_WAY_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_FLOOR_MODE: GeometricFloorMode =
    GeometricFloorMode::SameFloorOnly;

/// Flags a pair of one-way passage edges (`EdgeKind::Basic`, single direction) placed too close
/// to each other in geometric (Euclidean, `cell_scale` units — see `space::floor_aware_xy_distance`)
/// space — see GitHub issue #199/#342. Individual one-way checks (issue #198) only ever look at one
/// edge at a time; this check instead catches problems that emerge from *pairs* of one-way edges
/// being close to each other, which no single-edge check can detect. Mirrors
/// `TeleportGroupProximityCheck`'s role, but for one-way edges and a geometric (not topological)
/// metric — see `OneWayGroupGraphProximityCheck` for the topological counterpart.
///
/// Unlike `TeleportGroupProximityCheck`, there is no edge-role selector: a one-way edge renders
/// visually on the tile border it crosses, not at either endpoint node, so distance is measured
/// between the two edges' `space::edge_position`s directly (`floor_aware_xy_distance`) —
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
    /// GitHub issue #342: how a cross-floor one-way pair is treated by this geometric check.
    pub floor_mode: GeometricFloorMode,
}

impl<T: Tessellation> Check<T, InvalidOneWayGroupIssue> for OneWayGroupGeometricProximityCheck {
    fn check_type_id(&self) -> &'static str {
        "one_way_group_geometric_proximity"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidOneWayGroupIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        // Each edge's position is resolved once here, not once per compared pair.
        let tessellation = maze.field.tessellation();
        let one_ways: Vec<_> = one_way_edges_with_endpoints(maze)
            .into_iter()
            .filter_map(|(id, e_from, e_to)| {
                let level = maze.field.level_index_of(e_from)?;
                let from = maze.field.cell_of(e_from)?;
                let to = maze.field.cell_of(e_to)?;
                Some((id, level, edge_position(tessellation, from, to)))
            })
            .collect();
        if one_ways.len() < 2 {
            return;
        }

        let groups = pairwise_geometric_scan(
            &one_ways,
            self.distance,
            |&(own_id, own_level, ..), &(other_id, other_level, ..)| {
                other_id == own_id
                    || (self.floor_mode == GeometricFloorMode::SameFloorOnly
                        && own_level != other_level)
            },
            |&(own_id, own_level, own_position), &(other_id, other_level, other_position)| {
                let dist = floor_aware_xy_distance(
                    own_level,
                    own_position,
                    other_level,
                    other_position,
                    self.floor_mode.include_height(),
                );
                let both_route_protected = self.protect_route
                    && is_edge_on_route(maze, own_id)
                    && is_edge_on_route(maze, other_id);
                // A route-protected pair must never register as "close" -- the scan keeps trying
                // farther candidates for `own_id` instead of stopping on this one, same as the
                // pre-extraction loop's own `if !both_route_protected { ...; break }` shape.
                if both_route_protected {
                    f64::INFINITY
                } else {
                    dist
                }
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
#[path = "one_way_group_geometric_proximity_tests.rs"]
mod tests;
