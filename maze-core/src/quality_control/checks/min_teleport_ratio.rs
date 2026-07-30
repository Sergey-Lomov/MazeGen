use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::{Issue, MissingTeleportsIssue};
use super::teleport_count_core::count_distinct_teleports;

pub const MIN_TELEPORT_RATIO_DEFAULT: u32 = 10;

/// Flags a deficit against the share of distinct teleports (see `count_distinct_teleports`)
/// relative to the field's size — see GitHub issue #211. Mirrors `MinOneWayRatioCheck`'s role for
/// one-ways: a count expressed per 100 field cells (via `maze.field.point_count()`).
///
/// Compares `count * 100` against `min_teleport_ratio * field_cells` directly instead of computing an
/// intermediate `count * 100 / field_cells` ratio — the intermediate division floors, which can
/// wrongly pass a ratio that's actually just short of the minimum (e.g. 29.9% floors to 29%,
/// comparing fine against a minimum of 29 when the true share is under it only if the minimum
/// were 30). Comparing the cross-multiplied products is exact, no rounding involved.
pub struct MinTeleportRatioCheck {
    pub instance_id: String,
    pub min_teleport_ratio: u32,
}

impl<T: Tessellation> Check<T, MissingTeleportsIssue> for MinTeleportRatioCheck {
    fn check_type_id(&self) -> &'static str { "min_teleport_ratio" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<MissingTeleportsIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let field_cells = maze.field.point_count() as u64;
        if field_cells == 0 {
            return;
        }

        let count = count_distinct_teleports(maze) as u64;
        let min_teleport_ratio = self.min_teleport_ratio as u64;

        if count * 100 >= min_teleport_ratio * field_cells {
            return;
        }

        // Smallest `missing` such that (count + missing) * 100 >= min_teleport_ratio * field_cells.
        // Always > 0 here: the gate above already ruled out count * 100 >= required, so
        // required.div_ceil(100) is always strictly greater than count.
        let required = min_teleport_ratio * field_cells;
        let missing = required.div_ceil(100).saturating_sub(count) as u32;
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

    const TEST_ID: &str = "min_teleport_ratio";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// 10 field cells, 1 teleport edge -> 10 per 100 cells.
    fn maze_with_one_teleport_on_ten_cells() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(10, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Teleport);
        Maze::new(field, g)
    }

    #[test]
    fn silent_when_ratio_meets_minimum() {
        let maze = maze_with_one_teleport_on_ten_cells();
        let check = MinTeleportRatioCheck { instance_id: TEST_ID.to_string(), min_teleport_ratio: 10 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "10 per 100 cells meets a minimum of 10");
    }

    #[test]
    fn fires_with_missing_count_when_below_minimum() {
        // 10 per 100 cells, min_teleport_ratio 30 -> missing_ratio 20 -> ceil(20*10/100) = 2.
        let maze = maze_with_one_teleport_on_ten_cells();
        let check = MinTeleportRatioCheck { instance_id: TEST_ID.to_string(), min_teleport_ratio: 30 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, 2);
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("missing")),
            Some(&"2".to_string()),
        );
    }

    #[test]
    fn missing_count_rounds_up() {
        // 10 per 100 cells, min_teleport_ratio 11 -> missing_ratio 1 -> ceil(1*10/100) = ceil(0.1) = 1.
        let maze = maze_with_one_teleport_on_ten_cells();
        let check = MinTeleportRatioCheck { instance_id: TEST_ID.to_string(), min_teleport_ratio: 11 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, 1, "ceil must round up, not truncate to 0");
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

        let check = MinTeleportRatioCheck { instance_id: TEST_ID.to_string(), min_teleport_ratio: 1 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1, "a Basic edge must not count toward the ratio");
    }

    #[test]
    fn does_not_floor_the_true_ratio_before_comparing() {
        // 1000 field cells, 299 teleports -> true ratio is 29.9%, which the old
        // `count * 100 / field_cells` intermediate would floor to 29 -- silently passing a
        // minimum of 29 even though 29.9% genuinely doesn't meet a 30% minimum's neighborhood.
        // Exercise the boundary the cross-multiplied comparison must get right: 299*100 = 29900
        // < 30*1000 = 30000, so this must still fire.
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(1000, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        for i in 0..299 {
            g.add_edge(p(i), p(i + 1), EdgeKind::Teleport);
        }
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MinTeleportRatioCheck { instance_id: TEST_ID.to_string(), min_teleport_ratio: 30 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1, "29.9% must not silently pass a 30% minimum via floor rounding");
        assert_eq!(issues[0].missing, 1);
    }

    #[test]
    fn a_bidirectional_teleport_pair_counts_as_one_for_the_ratio() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(10, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Teleport);
        g.add_edge(p(1), p(0), EdgeKind::Teleport);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MinTeleportRatioCheck { instance_id: TEST_ID.to_string(), min_teleport_ratio: 10 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "A<->B is one logical portal (10 per 100 cells), not two (20 per 100)");
    }
}
