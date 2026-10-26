use crate::Maze;
use crate::graph::EdgeKind;
use crate::graph::route_protection::is_teleport_route_protected;
use crate::ids::EdgeId;
use crate::quality_control::{
    Comparison, GeometricFloorMode, IndeterminateReason, InvalidTeleportIssue,
};
use crate::space::{
    DistanceError, DistancePolicy, FloorMetrics, Tessellation, WithinLimit, cell_position,
};

/// Shared filter/issue-building logic for `TeleportGeometricLengthCheck` — see GitHub issue
/// #74/#78/#177/#342. The distance is the surface distance (GitHub issue #838): a teleport whose
/// comparison is `Unknown` (bracket straddles `length`) or `Unsupported` (topological-only fold)
/// is neither flagged nor cleared by this function: it is recorded in
/// `Maze::distance_diagnostics`.
pub fn find_invalid_teleports<T: Tessellation>(
    maze: &Maze<T>,
    protect_route: bool,
    comparison: Comparison,
    length: f64,
    floor_mode: GeometricFloorMode,
    approximate_topology: bool,
) -> Vec<EdgeId> {
    let metrics = FloorMetrics::new(
        &maze.field,
        DistancePolicy::from_approximate(approximate_topology),
    );
    let tessellation = maze.field.tessellation();
    maze.graph
        .edges()
        .filter(|e| e.kind == EdgeKind::Teleport)
        .filter(|t| {
            let (Some(from_level), Some(from)) = (
                maze.field.level_index_of(t.from),
                maze.field.cell_of(t.from),
            ) else {
                return false;
            };
            let (Some(to_level), Some(to)) =
                (maze.field.level_index_of(t.to), maze.field.cell_of(t.to))
            else {
                return false;
            };
            if floor_mode == GeometricFloorMode::SameFloorOnly && from_level != to_level {
                return false;
            }
            match metrics.compare(
                from_level,
                cell_position(tessellation, from),
                to_level,
                cell_position(tessellation, to),
                floor_mode.include_height(),
                comparison,
                length,
            ) {
                Ok(WithinLimit::Yes) => true,
                Ok(WithinLimit::No) => false,
                Ok(WithinLimit::Unknown) => {
                    maze.distance_diagnostics.record(
                        t.from,
                        t.to,
                        IndeterminateReason::DistanceUnknown,
                    );
                    false
                }
                Err(DistanceError::Unsupported) => {
                    maze.distance_diagnostics.record(
                        t.from,
                        t.to,
                        IndeterminateReason::UnsupportedTopology,
                    );
                    false
                }
            }
        })
        .filter(|t| !protect_route || !is_teleport_route_protected(maze, t.id))
        .map(|e| e.id)
        .collect()
}

pub fn build_issue(
    invalid: Vec<EdgeId>,
    instance_id: &str,
    threshold: f64,
) -> Option<InvalidTeleportIssue> {
    if invalid.is_empty() {
        return None;
    }
    let issue = InvalidTeleportIssue::new_from_check(instance_id, invalid).with_detail(
        instance_id,
        "length",
        threshold.to_string(),
    );
    Some(issue)
}
