use crate::Maze;
use crate::ids::EdgeId;
use crate::graph::EdgeKind;
use crate::graph::route_protection::is_teleport_route_protected;
use crate::space::{Tessellation, geometric_distance};
use crate::quality_control::{Comparison, InvalidTeleportIssue};

/// Shared filter/issue-building logic for `TeleportGeometricLengthCheck` — see GitHub issue
/// #74/#78/#177.
pub fn find_invalid_teleports<T: Tessellation>(
    maze: &Maze<T>,
    protect_route: bool,
    comparison: Comparison,
    length: f64,
) -> Vec<EdgeId> {
    maze.graph.edges()
        .filter(|e| e.kind == EdgeKind::Teleport)
        .filter(|t| {
            let (Some(from), Some(to)) = (maze.field.point_of(t.from), maze.field.point_of(t.to)) else {
                return false;
            };
            comparison.compare_f64(geometric_distance::<T>(from, to), length)
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
