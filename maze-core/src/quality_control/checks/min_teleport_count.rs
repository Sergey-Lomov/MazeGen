use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::{Issue, MissingTeleportsIssue};
use super::teleport_count_core::count_distinct_teleports;

pub const MIN_TELEPORT_COUNT_DEFAULT: u32 = 1;

/// Flags a deficit against a count of distinct teleports — see GitHub issue #211. Mirrors
/// `MinOneWayCountCheck`'s role for one-ways, but counts via `count_distinct_teleports` (a
/// bidirectional teleport is one portal, not two) rather than a reverse-lookup filter — see that
/// function's doc comment for why `EdgeKind::Teleport` needs different dedup than one-ways.
pub struct MinTeleportCountCheck {
    pub instance_id: String,
    pub min_teleports: u32,
}

impl<T: Tessellation> Check<T, MissingTeleportsIssue> for MinTeleportCountCheck {
    fn check_type_id(&self) -> &'static str { "min_teleport_count" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<MissingTeleportsIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let count = count_distinct_teleports(maze);

        let missing = self.min_teleports.saturating_sub(count);
        if missing == 0 {
            return;
        }
        let issue = MissingTeleportsIssue::new_from_check(&self.instance_id, missing)
            .with_detail(&self.instance_id, "missing", missing.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::{Graph, IdGenerator};
    use crate::graph::EdgeKind;
    use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};

    const TEST_ID: &str = "min_teleport_count";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// 4-tile corridor with one teleport edge (0->1) and one bidirectional passage (1<->2<->3).
    fn maze_with_one_teleport() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Teleport);
        g.add_bidirectional_edge(p(1), p(2), EdgeKind::Basic);
        g.add_bidirectional_edge(p(2), p(3), EdgeKind::Basic);
        Maze::new(field, g)
    }

    #[test]
    fn silent_when_count_meets_minimum() {
        let maze = maze_with_one_teleport();
        let check = MinTeleportCountCheck { instance_id: TEST_ID.to_string(), min_teleports: 1 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_with_missing_count_when_below_minimum() {
        let maze = maze_with_one_teleport();
        let check = MinTeleportCountCheck { instance_id: TEST_ID.to_string(), min_teleports: 3 };
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
    fn does_not_count_a_basic_edge() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        g.add_bidirectional_edge(p(0), p(1), EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MinTeleportCountCheck { instance_id: TEST_ID.to_string(), min_teleports: 1 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, 1, "a Basic edge must not count toward the teleport total");
    }

    #[test]
    fn a_bidirectional_teleport_pair_counts_as_one() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Teleport);
        g.add_edge(p(1), p(0), EdgeKind::Teleport);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MinTeleportCountCheck { instance_id: TEST_ID.to_string(), min_teleports: 2 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, 1, "A<->B is one logical portal, not two");
    }
}
