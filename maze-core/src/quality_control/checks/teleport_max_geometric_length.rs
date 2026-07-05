use rand::RngCore;
use crate::Maze;
use crate::graph::EdgeKind;
use crate::space::{Tessellation, geometric_distance};
use crate::quality_control::check::Check;
use crate::quality_control::issue::{Issue, INVALID_TELEPORT};
use crate::quality_control::issue_data::IssueData;

pub const TELEPORT_MAX_GEOMETRIC_LENGTH_DEFAULT: f64 = 1_000.0;

/// Flags a teleport edge whose geometric (Euclidean, unit tile scale — see
/// `space::geometric_distance`) distance between its entry and exit exceeds a configured maximum
/// — see GitHub issue #74. Symmetric counterpart to `TeleportMinGeometricLengthCheck`: caps how
/// far apart a teleport's endpoints may be, e.g. to keep teleports from spanning the entire field
/// when a more local "jump" is desired.
pub struct TeleportMaxGeometricLengthCheck {
    pub instance_id: String,
    pub max_length: f64,
}

impl<T: Tessellation> Check<T> for TeleportMaxGeometricLengthCheck {
    fn check_type_id(&self) -> &'static str { "teleport_max_geometric_length" }

    fn check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>, _rng: &mut dyn RngCore) {
        let invalid: Vec<_> = maze.graph.edges()
            .filter(|e| e.kind == EdgeKind::Teleport)
            .filter(|t| {
                let (Some(from), Some(to)) = (maze.field.point_of(t.from), maze.field.point_of(t.to)) else {
                    return false;
                };
                geometric_distance::<T>(from, to) > self.max_length
            })
            .map(|e| e.id)
            .collect();

        if invalid.is_empty() {
            return;
        }
        let issue = Issue::with_data_from_check(INVALID_TELEPORT, IssueData::InvalidTeleports { invalid }, &self.instance_id)
            .with_detail(&self.instance_id, "max_length", self.max_length.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::{Graph, IdGenerator};
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
        let check = TeleportMaxGeometricLengthCheck { instance_id: TEST_ID.to_string(), max_length: 5.0 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, INVALID_TELEPORT);
        let teleport_id = maze.graph.edges().find(|e| e.kind == EdgeKind::Teleport).unwrap().id;
        assert_eq!(issues[0].data, Some(IssueData::InvalidTeleports { invalid: vec![teleport_id] }));
    }

    #[test]
    fn silent_when_shorter_than_maximum() {
        let maze = maze_with_teleport((0, 0), (1, 0)); // distance 1.0
        let check = TeleportMaxGeometricLengthCheck { instance_id: TEST_ID.to_string(), max_length: 5.0 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
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

        let check = TeleportMaxGeometricLengthCheck { instance_id: TEST_ID.to_string(), max_length: 0.0 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
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

        let check = TeleportMaxGeometricLengthCheck { instance_id: TEST_ID.to_string(), max_length: 5.0 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);

        assert_eq!(issues.len(), 1, "both directions merge into one issue from a single check call");
        let IssueData::InvalidTeleports { invalid } = issues[0].data.as_ref().unwrap() else { panic!() };
        let mut teleport_ids: Vec<_> = maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport).map(|e| e.id).collect();
        teleport_ids.sort_unstable();
        let mut flagged = invalid.clone();
        flagged.sort_unstable();
        assert_eq!(flagged, teleport_ids, "both teleport directions must be flagged, not just one");
    }
}
