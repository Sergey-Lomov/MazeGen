use super::teleport_count_core::count_distinct_teleports;
use crate::Maze;
use crate::quality_control::MissingTeleportsIssue;
use crate::quality_control::check::Check;
use crate::space::Tessellation;
use rand::RngCore;

pub const MIN_TELEPORT_RATIO_DEFAULT: f64 = 10.0;

/// Flags a deficit against the share of distinct teleports (see `count_distinct_teleports`)
/// relative to the field's size — see GitHub issue #211. Mirrors `MinOneWayRatioCheck`'s role for
/// one-ways: a count expressed per 100 field cells (via `maze.scoped_cell_count()`).
///
/// Compares `count * 100` against `min_teleport_ratio * field_cells` directly instead of computing an
/// intermediate `count * 100 / field_cells` ratio — the intermediate division floors, which can
/// wrongly pass a ratio that's actually just short of the minimum (e.g. 29.9% floors to 29%,
/// comparing fine against a minimum of 29 when the true share is under it only if the minimum
/// were 30). Comparing the cross-multiplied products is exact, no rounding involved.
pub struct MinTeleportRatioCheck {
    pub instance_id: String,
    pub min_teleport_ratio: f64,
}

impl<T: Tessellation> Check<T, MissingTeleportsIssue> for MinTeleportRatioCheck {
    fn check_type_id(&self) -> &'static str {
        "min_teleport_ratio"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<MissingTeleportsIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let min_teleport_ratio = self.min_teleport_ratio;

        let field_cells = maze.scoped_cell_count() as u64;
        let missing = Self::missing_for(
            count_distinct_teleports(maze) as u64,
            field_cells,
            min_teleport_ratio,
        );
        if missing == 0 {
            return;
        }

        let issue = MissingTeleportsIssue::new_from_check(&self.instance_id, missing).with_detail(
            &self.instance_id,
            "missing",
            missing.to_string(),
        );
        issues.push(issue);
    }
}

impl MinTeleportRatioCheck {
    /// Deficit teleport count for one region given its own teleport
    /// count and cell count.
    fn missing_for(count: u64, field_cells: u64, min_teleport_ratio: f64) -> u32 {
        if field_cells == 0 || count as f64 * 100.0 >= min_teleport_ratio * field_cells as f64 {
            return 0;
        }
        // `required` rounds to the nearest integer (not ceil), matching
        // `MaxOneWayRatioCheck::to_remove_for`'s round-to-nearest `target_count`.
        let required = (min_teleport_ratio * field_cells as f64 / 100.0).round() as u64;
        required.saturating_sub(count) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::quality_control::Issue;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;
    use std::sync::Arc;

    const TEST_ID: &str = "min_teleport_ratio";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// 10 field cells, 1 teleport edge -> 10 per 100 cells.
    fn maze_with_one_teleport_on_ten_cells() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(10, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Teleport);
        Maze::new(field, g)
    }

    #[test]
    fn silent_when_ratio_meets_minimum() {
        let maze = maze_with_one_teleport_on_ten_cells();
        let check = MinTeleportRatioCheck {
            instance_id: TEST_ID.to_string(),
            min_teleport_ratio: 10.0,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "10 per 100 cells meets a minimum of 10");
    }

    #[test]
    fn fires_with_missing_count_when_below_minimum() {
        // 10 per 100 cells, min_teleport_ratio 30 -> missing_ratio 20 -> ceil(20*10/100) = 2.
        let maze = maze_with_one_teleport_on_ten_cells();
        let check = MinTeleportRatioCheck {
            instance_id: TEST_ID.to_string(),
            min_teleport_ratio: 30.0,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, 2);
        assert_eq!(
            issues[0]
                .details()
                .get(TEST_ID)
                .and_then(|kv| kv.get("missing")),
            Some(&"2".to_string()),
        );
    }

    #[test]
    fn missing_count_rounds_to_nearest_not_down() {
        // 10 per 100 cells, min_teleport_ratio 13 -> required = round(13*10/100) = round(1.3) = 1,
        // missing = 0 (required already met by rounding, not truncated away by a stricter ceil).
        let maze = maze_with_one_teleport_on_ten_cells();
        let check = MinTeleportRatioCheck {
            instance_id: TEST_ID.to_string(),
            min_teleport_ratio: 13.0,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "round(1.3) = 1, already met by the existing single teleport"
        );
    }

    /// 1000 field cells, 100 distinct teleports -> a clean 10 per 100 cells ratio fine-grained
    /// enough that a `.1`-scale fractional threshold isn't swallowed by the `required` rounding
    /// step.
    fn maze_with_100_teleports_on_1000_cells() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(1000, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        for i in 0..100 {
            g.add_edge(p(i * 2), p(i * 2 + 1), EdgeKind::Teleport);
        }
        Maze::new(field, g)
    }

    #[test]
    fn min_teleport_ratio_accepts_a_genuinely_fractional_threshold() {
        // 100/1000 = 10 per 100 cells. min_teleport_ratio 9.9 must stay silent (ratio clears it);
        // 10.1 must fire (ratio falls fractionally short) -- pins that the gate compares the true
        // ratio, not one rounded to a whole number first.
        let maze = maze_with_100_teleports_on_1000_cells();
        let check = MinTeleportRatioCheck {
            instance_id: TEST_ID.to_string(),
            min_teleport_ratio: 9.9,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "10 per 100 cells must clear a fractional minimum of 9.9"
        );

        let check = MinTeleportRatioCheck {
            instance_id: TEST_ID.to_string(),
            min_teleport_ratio: 10.1,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(
            issues.len(),
            1,
            "10 per 100 cells must fall short of a fractional minimum of 10.1"
        );
        assert_eq!(
            issues[0].missing, 1,
            "required=round(10.1*1000/100)=101, missing=1"
        );
    }

    #[test]
    fn missing_count_rounds_to_nearest_not_up() {
        // 10 per 100 cells, min_teleport_ratio 17 -> required = round(17*10/100) = round(1.7) = 2, missing = 1.
        let maze = maze_with_one_teleport_on_ten_cells();
        let check = MinTeleportRatioCheck {
            instance_id: TEST_ID.to_string(),
            min_teleport_ratio: 17.0,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].missing, 1,
            "round(1.7) = 2, not ceil to 2 via truncation-then-up"
        );
    }

    #[test]
    fn does_not_count_a_basic_edge() {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(2, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        g.add_bidirectional_edge(p(0), p(1), EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MinTeleportRatioCheck {
            instance_id: TEST_ID.to_string(),
            min_teleport_ratio: 50.0,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(
            issues.len(),
            1,
            "a Basic edge must not count toward the ratio"
        );
    }

    #[test]
    fn does_not_floor_the_true_ratio_before_comparing() {
        // 1000 field cells, 299 teleports -> true ratio is 29.9%, which the old
        // `count * 100 / field_cells` intermediate would floor to 29 -- silently passing a
        // minimum of 29 even though 29.9% genuinely doesn't meet a 30% minimum's neighborhood.
        // Exercise the boundary the cross-multiplied comparison must get right: 299*100 = 29900
        // < 30*1000 = 30000, so this must still fire.
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(1000, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        for i in 0..299 {
            g.add_edge(p(i), p(i + 1), EdgeKind::Teleport);
        }
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MinTeleportRatioCheck {
            instance_id: TEST_ID.to_string(),
            min_teleport_ratio: 30.0,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(
            issues.len(),
            1,
            "29.9% must not silently pass a 30% minimum via floor rounding"
        );
        assert_eq!(issues[0].missing, 1);
    }

    #[test]
    fn a_bidirectional_teleport_pair_counts_as_one_for_the_ratio() {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(10, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Teleport);
        g.add_edge(p(1), p(0), EdgeKind::Teleport);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MinTeleportRatioCheck {
            instance_id: TEST_ID.to_string(),
            min_teleport_ratio: 10.0,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "A<->B is one logical portal (10 per 100 cells), not two (20 per 100)"
        );
    }
}
