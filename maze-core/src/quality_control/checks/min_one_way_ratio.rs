use crate::Maze;
use crate::quality_control::MissingOneWaysIssue;
use crate::quality_control::check::Check;
use crate::quality_control::checks::one_way_core::one_way_edge_ids;
use crate::space::Tessellation;
use rand::RngCore;

pub const MIN_ONE_WAY_RATIO_DEFAULT: f64 = 10.0;

/// Flags a deficit against the share of one-way passage edges (`EdgeKind::Basic`, single
/// direction) relative to the field's size — see GitHub issue #201, part of the one-way
/// management epic (#92). Mirrors `MinLoopDensityCheck`'s role for loops: **not** a share of the
/// total edge count, but a count of one-way edges expressed per 100 field cells (via
/// `maze.scoped_cell_count()`) — same normalization `MinLoopDensityCheck`/`MaxLoopDensityCheck` use
/// for their own density metric, so this check's threshold means "one-ways per 100 cells", not
/// "percent of all passages".
///
/// Compares `count * 100` against `min_ratio * field_cells` directly instead of computing an
/// intermediate `count * 100 / field_cells` ratio — the intermediate division floors, which can
/// wrongly pass a ratio that's actually just short of the minimum (e.g. a true 29.9% floors to
/// 29%, comparing fine against a minimum of 30% it doesn't actually meet). Comparing the
/// cross-multiplied products is exact, no rounding involved. (Follow-up fix alongside GitHub
/// issue #211's `MinTeleportRatioCheck`, which shares this exact bug via copy-paste.)
pub struct MinOneWayRatioCheck {
    pub instance_id: String,
    pub min_ratio: f64,
}

impl<T: Tessellation> Check<T, MissingOneWaysIssue> for MinOneWayRatioCheck {
    fn check_type_id(&self) -> &'static str {
        "min_one_way_ratio"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<MissingOneWaysIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let one_ways = one_way_edge_ids(maze);
        let min_ratio = self.min_ratio;

        let field_cells = maze.scoped_cell_count() as u64;
        let missing = Self::missing_for(one_ways.len() as u64, field_cells, min_ratio);
        if missing == 0 {
            return;
        }

        let issue = MissingOneWaysIssue::new_from_check(&self.instance_id, missing).with_detail(
            &self.instance_id,
            "missing",
            missing.to_string(),
        );
        issues.push(issue);
    }
}

impl MinOneWayRatioCheck {
    /// Deficit one-way count for one region given its own one-way count
    /// and cell count.
    fn missing_for(count: u64, field_cells: u64, min_ratio: f64) -> u32 {
        if field_cells == 0 || count as f64 * 100.0 >= min_ratio * field_cells as f64 {
            return 0;
        }
        // `required` rounds to the nearest integer (not ceil), matching
        // `MaxOneWayRatioCheck::to_remove_for`'s round-to-nearest `target_count`.
        let required = (min_ratio * field_cells as f64 / 100.0).round() as u64;
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

    const TEST_ID: &str = "min_one_way_ratio";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// 10 field cells, 1 one-way edge -> 10 per 100 cells.
    fn maze_with_one_one_way_on_ten_cells() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(10, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Basic);
        Maze::new(field, g)
    }

    #[test]
    fn silent_when_ratio_meets_minimum() {
        let maze = maze_with_one_one_way_on_ten_cells();
        let check = MinOneWayRatioCheck {
            instance_id: TEST_ID.to_string(),
            min_ratio: 10.0,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "10 per 100 cells meets a minimum of 10");
    }

    #[test]
    fn fires_with_missing_count_when_below_minimum() {
        // 10 per 100 cells, min_ratio 30 -> missing_ratio 20 -> ceil(20*10/100) = 2.
        let maze = maze_with_one_one_way_on_ten_cells();
        let check = MinOneWayRatioCheck {
            instance_id: TEST_ID.to_string(),
            min_ratio: 30.0,
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
        // 10 per 100 cells, min_ratio 13 -> required = round(13*10/100) = round(1.3) = 1, missing = 0
        // (required already met by rounding, not truncated away by a stricter ceil).
        let maze = maze_with_one_one_way_on_ten_cells();
        let check = MinOneWayRatioCheck {
            instance_id: TEST_ID.to_string(),
            min_ratio: 13.0,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "round(1.3) = 1, already met by the existing single one-way"
        );
    }

    #[test]
    fn missing_count_rounds_to_nearest_not_up() {
        // 10 per 100 cells, min_ratio 17 -> required = round(17*10/100) = round(1.7) = 2, missing = 1.
        let maze = maze_with_one_one_way_on_ten_cells();
        let check = MinOneWayRatioCheck {
            instance_id: TEST_ID.to_string(),
            min_ratio: 17.0,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].missing, 1,
            "round(1.7) = 2, not ceil to 2 via truncation-then-up"
        );
    }

    /// 1000 field cells, 100 one-way edges (100 distinct source cells) -> a clean 10 per 100
    /// cells ratio fine-grained enough that a `.1`-scale fractional threshold isn't swallowed by
    /// the `required` rounding step.
    fn maze_with_100_one_ways_on_1000_cells() -> Maze<SquareTessellation> {
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
            g.add_edge(p(i * 2), p(i * 2 + 1), EdgeKind::Basic);
        }
        Maze::new(field, g)
    }

    #[test]
    fn min_ratio_accepts_a_genuinely_fractional_threshold() {
        // 100/1000 = 10 per 100 cells. min_ratio 9.9 must stay silent (ratio clears it); 10.1
        // must fire (ratio falls fractionally short) -- pins that the gate compares the true
        // ratio, not one rounded to a whole number first.
        let maze = maze_with_100_one_ways_on_1000_cells();
        let check = MinOneWayRatioCheck {
            instance_id: TEST_ID.to_string(),
            min_ratio: 9.9,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "10 per 100 cells must clear a fractional minimum of 9.9"
        );

        let check = MinOneWayRatioCheck {
            instance_id: TEST_ID.to_string(),
            min_ratio: 10.1,
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
    fn does_not_count_bidirectional_passage_as_one_way() {
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

        let check = MinOneWayRatioCheck {
            instance_id: TEST_ID.to_string(),
            min_ratio: 50.0,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(
            issues.len(),
            1,
            "bidirectional passage must not count toward the ratio"
        );
    }

    #[test]
    fn does_not_floor_the_true_ratio_before_comparing() {
        // 1000 field cells, 299 one-ways -> true ratio is 29.9%, which the old
        // `count * 100 / field_cells` intermediate would floor to 29 -- silently passing a
        // minimum of 29 even though 29.9% genuinely doesn't meet a 30% minimum's neighborhood.
        // 299*100 = 29900 < 30*1000 = 30000, so this must still fire.
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
            g.add_edge(p(i), p(i + 1), EdgeKind::Basic);
        }
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MinOneWayRatioCheck {
            instance_id: TEST_ID.to_string(),
            min_ratio: 30.0,
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
}
