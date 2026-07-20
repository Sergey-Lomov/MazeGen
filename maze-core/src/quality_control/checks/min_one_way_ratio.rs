use rand::RngCore;
use crate::Maze;
use crate::graph::EdgeKind;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::{Issue, MissingOneWaysIssue};

pub const MIN_ONE_WAY_RATIO_DEFAULT: u32 = 10;

/// Flags a deficit against the share of one-way passage edges (`EdgeKind::Basic`, single
/// direction) relative to the field's size — see GitHub issue #201, part of the one-way
/// management epic (#92). Mirrors `MinLoopDensityCheck`'s role for loops: **not** a share of the
/// total edge count, but a count of one-way edges expressed per 100 field cells (via
/// `maze.field.node_count()`) — same normalization `MinLoopDensityCheck`/`MaxLoopDensityCheck` use
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
    pub min_ratio: u32,
}

impl<T: Tessellation> Check<T, MissingOneWaysIssue> for MinOneWayRatioCheck {
    fn check_type_id(&self) -> &'static str { "min_one_way_ratio" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<MissingOneWaysIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let field_cells = maze.field.node_count() as u64;
        if field_cells == 0 {
            return;
        }

        // Same kind-filtered reverse lookup as MinOneWayCountCheck/OneWayWaypointDistanceCheck.
        let count = maze.graph.edges()
            .filter(|e| e.kind == EdgeKind::Basic)
            .filter(|e| maze.graph.edge_between_kind(e.to, e.from, &EdgeKind::Basic).is_none())
            .count() as u64;
        let min_ratio = self.min_ratio as u64;

        if count * 100 >= min_ratio * field_cells {
            return;
        }

        // Smallest `missing` such that (count + missing) * 100 >= min_ratio * field_cells.
        // Always > 0 here: the gate above already ruled out count * 100 >= required, so
        // required.div_ceil(100) is always strictly greater than count.
        let required = min_ratio * field_cells;
        let missing = required.div_ceil(100).saturating_sub(count) as u32;
        let issue = MissingOneWaysIssue::new_from_check(&self.instance_id, missing)
            .with_detail(&self.instance_id, "missing", missing.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};

    const TEST_ID: &str = "min_one_way_ratio";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// 10 field cells, 1 one-way edge -> 10 per 100 cells.
    fn maze_with_one_one_way_on_ten_cells() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(10, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Basic);
        Maze::new(field, g)
    }

    #[test]
    fn silent_when_ratio_meets_minimum() {
        let maze = maze_with_one_one_way_on_ten_cells();
        let check = MinOneWayRatioCheck { instance_id: TEST_ID.to_string(), min_ratio: 10 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "10 per 100 cells meets a minimum of 10");
    }

    #[test]
    fn fires_with_missing_count_when_below_minimum() {
        // 10 per 100 cells, min_ratio 30 -> missing_ratio 20 -> ceil(20*10/100) = 2.
        let maze = maze_with_one_one_way_on_ten_cells();
        let check = MinOneWayRatioCheck { instance_id: TEST_ID.to_string(), min_ratio: 30 };
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
        // 10 per 100 cells, min_ratio 11 -> missing_ratio 1 -> ceil(1*10/100) = ceil(0.1) = 1.
        let maze = maze_with_one_one_way_on_ten_cells();
        let check = MinOneWayRatioCheck { instance_id: TEST_ID.to_string(), min_ratio: 11 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, 1, "ceil must round up, not truncate to 0");
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

        let check = MinOneWayRatioCheck { instance_id: TEST_ID.to_string(), min_ratio: 1 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1, "bidirectional passage must not count toward the ratio");
    }

    #[test]
    fn does_not_floor_the_true_ratio_before_comparing() {
        // 1000 field cells, 299 one-ways -> true ratio is 29.9%, which the old
        // `count * 100 / field_cells` intermediate would floor to 29 -- silently passing a
        // minimum of 29 even though 29.9% genuinely doesn't meet a 30% minimum's neighborhood.
        // 299*100 = 29900 < 30*1000 = 30000, so this must still fire.
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(1000, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        for i in 0..299 {
            g.add_edge(p(i), p(i + 1), EdgeKind::Basic);
        }
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MinOneWayRatioCheck { instance_id: TEST_ID.to_string(), min_ratio: 30 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1, "29.9% must not silently pass a 30% minimum via floor rounding");
        assert_eq!(issues[0].missing, 1);
    }
}
