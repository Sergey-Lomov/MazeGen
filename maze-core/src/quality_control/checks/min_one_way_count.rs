use rand::RngCore;
use crate::Maze;
use crate::graph::EdgeKind;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::{MissingOneWaysIssue};

pub const MIN_ONE_WAY_COUNT_DEFAULT: u32 = 1;

/// Flags a deficit against a raw count of one-way passage edges (`EdgeKind::Basic`, single
/// direction) — see GitHub issue #201, part of the one-way management epic (#92). Mirrors
/// `MinLoopsCountCheck`'s role for loops.
pub struct MinOneWayCountCheck {
    pub instance_id: String,
    pub min_one_ways: u32,
}

impl<T: Tessellation> Check<T, MissingOneWaysIssue> for MinOneWayCountCheck {
    fn check_type_id(&self) -> &'static str { "min_one_way_count" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<MissingOneWaysIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        // Same kind-filtered reverse lookup as OneWayWaypointDistanceCheck: only plain Basic
        // edges count, and only when no Basic reverse exists (a bidirectional passage is not a
        // one-way even though each direction is itself EdgeKind::Basic). A parallel opposite-
        // direction Teleport must not be mistaken for the Basic edge's own reverse.
        let count = maze.graph.edges()
            .filter(|e| e.kind == EdgeKind::Basic)
            .filter(|e| maze.graph.edge_between_kind(e.to, e.from, &EdgeKind::Basic).is_none())
            .count() as u32;

        let missing = self.min_one_ways.saturating_sub(count);
        if missing == 0 {
            return;
        }
        let issue = MissingOneWaysIssue::new_from_check(&self.instance_id, missing)
            .with_detail(&self.instance_id, "missing", missing.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
mod tests {
    use crate::quality_control::Issue;
    use super::*;
    use rand::SeedableRng;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};

    const TEST_ID: &str = "min_one_way_count";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// 4-tile corridor with one one-way edge (0->1) and one bidirectional passage (1<->2<->3).
    fn maze_with_one_one_way() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Basic);
        g.add_bidirectional_edge(p(1), p(2), EdgeKind::Basic);
        g.add_bidirectional_edge(p(2), p(3), EdgeKind::Basic);
        Maze::new(field, g)
    }

    #[test]
    fn silent_when_count_meets_minimum() {
        let maze = maze_with_one_one_way();
        let check = MinOneWayCountCheck { instance_id: TEST_ID.to_string(), min_one_ways: 1 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_with_missing_count_when_below_minimum() {
        let maze = maze_with_one_one_way();
        let check = MinOneWayCountCheck { instance_id: TEST_ID.to_string(), min_one_ways: 3 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, 2);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("missing")),
            Some(&"2".to_string()),
        );
    }

    #[test]
    fn does_not_count_bidirectional_passage_as_one_way() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        g.add_bidirectional_edge(p(0), p(1), EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MinOneWayCountCheck { instance_id: TEST_ID.to_string(), min_one_ways: 1 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, 1, "bidirectional passage must not count toward the one-way total");
    }

    #[test]
    fn does_not_count_a_teleport_edge() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Teleport);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MinOneWayCountCheck { instance_id: TEST_ID.to_string(), min_one_ways: 1 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, 1, "a Teleport edge must not count toward the Basic one-way total");
    }

    #[test]
    fn flags_a_basic_one_way_paired_with_a_parallel_reverse_teleport() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Basic);
        g.add_edge(p(1), p(0), EdgeKind::Teleport);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MinOneWayCountCheck { instance_id: TEST_ID.to_string(), min_one_ways: 1 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "the parallel reverse Teleport must not mask the Basic one-way");
    }
}
