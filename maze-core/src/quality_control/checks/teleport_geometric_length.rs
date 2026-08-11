use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::comparison::Comparison;
use crate::quality_control::InvalidTeleportIssue;
use super::teleport_geometric_length_core::{build_issue, find_invalid_teleports};

pub const TELEPORT_GEOMETRIC_LENGTH_DEFAULT: f64 = 0.0;
pub const TELEPORT_GEOMETRIC_LENGTH_DEFAULT_COMPARISON: Comparison = Comparison::Lt;

/// Flags a teleport edge whose geometric (Euclidean, unit tile scale — see
/// `space::geometric_distance`) distance between its entry and exit compares against a configured
/// threshold — see GitHub issue #74/#177. Merges the former
/// `TeleportMinGeometricLengthCheck`/`TeleportMaxGeometricLengthCheck` (a min/max pair validating
/// the same single-teleport property, both flagging `INVALID_TELEPORT`) into one check type
/// parametrized by `Comparison` — `comparison: Lt` reproduces the old "shorter than minimum"
/// behavior, `Gt` reproduces "longer than maximum".
pub struct TeleportGeometricLengthCheck {
    pub instance_id: String,
    pub comparison: Comparison,
    pub length: f64,
    /// GitHub issue #78, default `true`: a teleport lying on the maze's current start->finish
    /// route (`is_teleport_route_protected`) is never included in `invalid`.
    pub protect_route: bool,
}

impl<T: Tessellation> Check<T, InvalidTeleportIssue> for TeleportGeometricLengthCheck {
    fn check_type_id(&self) -> &'static str { "teleport_geometric_length" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidTeleportIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let invalid = find_invalid_teleports(maze, self.protect_route, self.comparison, self.length);
        if let Some(issue) = build_issue(invalid, &self.instance_id, self.length) {
            issues.push(issue);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::{Graph, IdGenerator};
    use crate::graph::EdgeKind;
    use crate::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};

    const TEST_ID: &str = "teleport_geometric_length";

    fn maze_with_teleport(from: (i32, i32), to: (i32, i32)) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(20, 20), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let a = field.node_at(field_level, SquarePoint { x: from.0, y: from.1 }).unwrap();
        let b = field.node_at(field_level, SquarePoint { x: to.0, y: to.1 }).unwrap();
        g.add_edge(a, b, EdgeKind::Teleport);
        Maze::new(field, g)
    }

    #[test]
    fn lt_fires_when_shorter_than_minimum() {
        let maze = maze_with_teleport((0, 0), (1, 0)); // distance 1.0
        let check = TeleportGeometricLengthCheck { instance_id: TEST_ID.to_string(), comparison: Comparison::Lt, length: 5.0, protect_route: true };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        let teleport_id = maze.graph.edges().find(|e| e.kind == EdgeKind::Teleport).unwrap().id;
        assert_eq!(issues[0].invalid, vec![teleport_id]);
    }

    #[test]
    fn lt_protect_route_excludes_a_route_critical_short_teleport() {
        let mut maze = maze_with_teleport((0, 0), (1, 0)); // distance 1.0
        let teleport = maze.graph.edges().find(|e| e.kind == EdgeKind::Teleport).unwrap();
        let (start, finish) = (teleport.from, teleport.to);
        maze.meta.start = Some(start);
        maze.meta.finish = Some(finish);

        let check = TeleportGeometricLengthCheck { instance_id: TEST_ID.to_string(), comparison: Comparison::Lt, length: 5.0, protect_route: true };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty(), "route-critical teleport must not be flagged when protect_route is enabled");
    }

    #[test]
    fn lt_silent_when_longer_than_minimum() {
        let maze = maze_with_teleport((0, 0), (10, 0)); // distance 10.0
        let check = TeleportGeometricLengthCheck { instance_id: TEST_ID.to_string(), comparison: Comparison::Lt, length: 5.0, protect_route: true };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }

    #[test]
    fn lt_silent_when_threshold_is_zero() {
        let maze = maze_with_teleport((0, 0), (1, 0));
        let check = TeleportGeometricLengthCheck { instance_id: TEST_ID.to_string(), comparison: Comparison::Lt, length: 0.0, protect_route: true };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty(), "a threshold of 0 should never flag any teleport");
    }

    #[test]
    fn gt_fires_when_longer_than_maximum() {
        let maze = maze_with_teleport((0, 0), (10, 0)); // distance 10.0
        let check = TeleportGeometricLengthCheck { instance_id: TEST_ID.to_string(), comparison: Comparison::Gt, length: 5.0, protect_route: true };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        let teleport_id = maze.graph.edges().find(|e| e.kind == EdgeKind::Teleport).unwrap().id;
        assert_eq!(issues[0].invalid, vec![teleport_id]);
    }

    #[test]
    fn gt_protect_route_excludes_a_route_critical_long_teleport() {
        let mut maze = maze_with_teleport((0, 0), (10, 0)); // distance 10.0
        let teleport = maze.graph.edges().find(|e| e.kind == EdgeKind::Teleport).unwrap();
        let (start, finish) = (teleport.from, teleport.to);
        maze.meta.start = Some(start);
        maze.meta.finish = Some(finish);

        let check = TeleportGeometricLengthCheck { instance_id: TEST_ID.to_string(), comparison: Comparison::Gt, length: 5.0, protect_route: true };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty(), "route-critical teleport must not be flagged when protect_route is enabled");
    }

    #[test]
    fn gt_silent_when_shorter_than_maximum() {
        let maze = maze_with_teleport((0, 0), (1, 0)); // distance 1.0
        let check = TeleportGeometricLengthCheck { instance_id: TEST_ID.to_string(), comparison: Comparison::Gt, length: 5.0, protect_route: true };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }

    #[test]
    fn ignores_basic_edges() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(20, 20), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let a = field.node_at(field_level, SquarePoint { x: 0, y: 0 }).unwrap();
        let b = field.node_at(field_level, SquarePoint { x: 1, y: 0 }).unwrap();
        g.add_edge(a, b, EdgeKind::Basic);
        let maze = Maze::new(field, g);

        let check = TeleportGeometricLengthCheck { instance_id: TEST_ID.to_string(), comparison: Comparison::Lt, length: 100.0, protect_route: true };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_for_both_directions_of_a_two_way_short_teleport() {
        // Each direction of a two-way teleport is its own Teleport edge and must be flagged
        // independently, since the check operates per-edge, not per-pair.
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(20, 20), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let a = field.node_at(field_level, SquarePoint { x: 0, y: 0 }).unwrap();
        let b = field.node_at(field_level, SquarePoint { x: 1, y: 0 }).unwrap(); // distance 1.0
        g.add_edge(a, b, EdgeKind::Teleport);
        g.add_edge(b, a, EdgeKind::Teleport);
        let maze = Maze::new(field, g);

        let check = TeleportGeometricLengthCheck { instance_id: TEST_ID.to_string(), comparison: Comparison::Lt, length: 5.0, protect_route: true };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());

        assert_eq!(issues.len(), 1, "both directions merge into one issue from a single check call");
        let mut teleport_ids: Vec<_> = maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport).map(|e| e.id).collect();
        teleport_ids.sort_unstable();
        let mut flagged = issues[0].invalid.clone();
        flagged.sort_unstable();
        assert_eq!(flagged, teleport_ids, "both teleport directions must be flagged, not just one");
    }
}
