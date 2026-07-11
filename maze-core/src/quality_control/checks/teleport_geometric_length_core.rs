use crate::Maze;
use crate::ids::EdgeId;
use crate::graph::EdgeKind;
use crate::graph::route_protection::is_teleport_route_protected;
use crate::space::{Tessellation, geometric_distance};
use crate::quality_control::InvalidTeleportIssue;

/// Shared filter/issue-building logic for `TeleportMinGeometricLengthCheck` and
/// `TeleportMaxGeometricLengthCheck` — see GitHub issue #74/#78. Each check owns only its
/// threshold comparison (`<` vs `>`) and detail key name (`min_length` vs `max_length`), passed
/// in via `beyond_threshold` and `detail_key`.
pub fn find_invalid_teleports<T: Tessellation>(
    maze: &Maze<T>,
    protect_route: bool,
    beyond_threshold: impl Fn(f64) -> bool,
) -> Vec<EdgeId> {
    maze.graph.edges()
        .filter(|e| e.kind == EdgeKind::Teleport)
        .filter(|t| {
            let (Some(from), Some(to)) = (maze.field.point_of(t.from), maze.field.point_of(t.to)) else {
                return false;
            };
            beyond_threshold(geometric_distance::<T>(from, to))
        })
        .filter(|t| !protect_route || !is_teleport_route_protected(maze, t.id))
        .map(|e| e.id)
        .collect()
}

pub fn build_issue(invalid: Vec<EdgeId>, instance_id: &str, detail_key: &'static str, threshold: f64) -> Option<InvalidTeleportIssue> {
    if invalid.is_empty() {
        return None;
    }
    let issue = InvalidTeleportIssue::new_from_check(instance_id, invalid)
        .with_detail(instance_id, detail_key, threshold.to_string());
    Some(issue)
}
