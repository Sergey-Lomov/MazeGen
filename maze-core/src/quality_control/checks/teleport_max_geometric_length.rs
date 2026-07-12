use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::InvalidTeleportIssue;
use super::teleport_geometric_length_core::{build_issue, find_invalid_teleports};

pub const TELEPORT_MAX_GEOMETRIC_LENGTH_DEFAULT: f64 = 1_000.0;

/// Flags a teleport edge whose geometric (Euclidean, unit tile scale — see
/// `space::geometric_distance`) distance between its entry and exit exceeds a configured maximum
/// — see GitHub issue #74. Symmetric counterpart to `TeleportMinGeometricLengthCheck`: caps how
/// far apart a teleport's endpoints may be, e.g. to keep teleports from spanning the entire field
/// when a more local "jump" is desired.
pub struct TeleportMaxGeometricLengthCheck {
    pub instance_id: String,
    pub max_length: f64,
    /// GitHub issue #78, default `true`: a teleport lying on the maze's current start->finish
    /// route (`is_teleport_route_protected`) is never included in `invalid`.
    pub protect_route: bool,
}

impl<T: Tessellation> Check<T, InvalidTeleportIssue> for TeleportMaxGeometricLengthCheck {
    fn check_type_id(&self) -> &'static str { "teleport_max_geometric_length" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidTeleportIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let invalid = find_invalid_teleports(maze, self.protect_route, |d| d > self.max_length);
        if let Some(issue) = build_issue(invalid, &self.instance_id, "max_length", self.max_length) {
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
    use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};

    const TEST_ID: &str = "teleport_max_geometric_length";

    fn maze_with_teleport(from: (i32, i32), to: (i32, i32)) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(20, 20), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let a = field.node_at(SquarePoint { x: from.0, y: from.1 }).unwrap();
        let b = field.node_at(SquarePoint { x: to.0, y: to.1 }).unwrap();
        g.add_edge(a, b, EdgeKind::Teleport);
        Maze::new(field, g)
    }

    #[test]
    fn fires_when_longer_than_maximum() {
        let maze = maze_with_teleport((0, 0), (10, 0)); // distance 10.0
        let check = TeleportMaxGeometricLengthCheck { instance_id: TEST_ID.to_string(), max_length: 5.0, protect_route: true };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        let teleport_id = maze.graph.edges().find(|e| e.kind == EdgeKind::Teleport).unwrap().id;
        assert_eq!(issues[0].invalid, vec![teleport_id]);
    }

    #[test]
    fn protect_route_excludes_a_route_critical_long_teleport() {
        let mut maze = maze_with_teleport((0, 0), (10, 0)); // distance 10.0
        let teleport = maze.graph.edges().find(|e| e.kind == EdgeKind::Teleport).unwrap();
        let (start, finish) = (teleport.from, teleport.to);
        maze.meta.start = Some(start);
        maze.meta.finish = Some(finish);

        let check = TeleportMaxGeometricLengthCheck { instance_id: TEST_ID.to_string(), max_length: 5.0, protect_route: true };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty(), "route-critical teleport must not be flagged when protect_route is enabled");
    }

    #[test]
    fn silent_when_shorter_than_maximum() {
        let maze = maze_with_teleport((0, 0), (1, 0)); // distance 1.0
        let check = TeleportMaxGeometricLengthCheck { instance_id: TEST_ID.to_string(), max_length: 5.0, protect_route: true };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }

    #[test]
    fn ignores_basic_edges() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(20, 20), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let a = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let b = field.node_at(SquarePoint { x: 19, y: 19 }).unwrap();
        g.add_edge(a, b, EdgeKind::Basic);
        let maze = Maze::new(field, g);

        let check = TeleportMaxGeometricLengthCheck { instance_id: TEST_ID.to_string(), max_length: 0.0, protect_route: true };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_for_both_directions_of_a_two_way_long_teleport() {
        // Each direction of a two-way teleport is its own Teleport edge and must be flagged
        // independently, since the check operates per-edge, not per-pair.
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(20, 20), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let a = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let b = field.node_at(SquarePoint { x: 10, y: 0 }).unwrap(); // distance 10.0
        g.add_edge(a, b, EdgeKind::Teleport);
        g.add_edge(b, a, EdgeKind::Teleport);
        let maze = Maze::new(field, g);

        let check = TeleportMaxGeometricLengthCheck { instance_id: TEST_ID.to_string(), max_length: 5.0, protect_route: true };
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
