use crate::Maze;
use crate::ids::EdgeId;
use crate::graph::EdgeKind;
use crate::graph::route_protection::is_teleport_route_protected;
use crate::space::{Tessellation, floor_aware_distance};
use crate::quality_control::{Comparison, GeometricFloorMode, InvalidTeleportIssue};

/// Shared filter/issue-building logic for `TeleportGeometricLengthCheck` — see GitHub issue
/// #74/#78/#177/#342.
pub fn find_invalid_teleports<T: Tessellation>(
    maze: &Maze<T>,
    protect_route: bool,
    comparison: Comparison,
    length: f64,
    floor_mode: GeometricFloorMode,
) -> Vec<EdgeId> {
    maze.graph.edges()
        .filter(|e| e.kind == EdgeKind::Teleport)
        .filter(|t| {
            let (Some(from_level), Some(from)) = (maze.field.level_index_of(t.from), maze.field.point_of(t.from)) else {
                return false;
            };
            let (Some(to_level), Some(to)) = (maze.field.level_index_of(t.to), maze.field.point_of(t.to)) else {
                return false;
            };
            if floor_mode == GeometricFloorMode::SameFloorOnly && from_level != to_level {
                return false;
            }
            let dist = floor_aware_distance::<T>(from_level, from, to_level, to, floor_mode.include_height());
            comparison.compare_f64(dist, length)
        })
        .filter(|t| !protect_route || !is_teleport_route_protected(maze, t.id))
        .map(|e| e.id)
        .collect()
}

pub fn build_issue(invalid: Vec<EdgeId>, instance_id: &str, threshold: f64) -> Option<InvalidTeleportIssue> {
    if invalid.is_empty() {
        return None;
    }
    let issue = InvalidTeleportIssue::new_from_check(instance_id, invalid)
        .with_detail(instance_id, "length", threshold.to_string());
    Some(issue)
}
