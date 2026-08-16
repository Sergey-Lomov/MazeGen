use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::graph::EdgeKind;
use crate::space::{LevelId, Tessellation};
use crate::quality_control::check::Check;
use crate::quality_control::{MissingOneWaysIssue, FloorScope, RepairArea};
use crate::quality_control::floor_group::{floors_of_edge, floor_point_count};

pub const MIN_ONE_WAY_RATIO_DEFAULT: u32 = 10;
pub const MIN_ONE_WAY_RATIO_DEFAULT_FLOOR_SCOPE: FloorScope = FloorScope::PerFloor;

/// Flags a deficit against the share of one-way passage edges (`EdgeKind::Basic`, single
/// direction) relative to the field's size — see GitHub issue #201, part of the one-way
/// management epic (#92). Mirrors `MinLoopDensityCheck`'s role for loops: **not** a share of the
/// total edge count, but a count of one-way edges expressed per 100 field cells (via
/// `maze.field.point_count()`) — same normalization `MinLoopDensityCheck`/`MaxLoopDensityCheck` use
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
    pub floor_scope: FloorScope,
}

impl<T: Tessellation> Check<T, MissingOneWaysIssue> for MinOneWayRatioCheck {
    fn check_type_id(&self) -> &'static str { "min_one_way_ratio" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<MissingOneWaysIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        // Same kind-filtered reverse lookup as MinOneWayCountCheck/OneWayWaypointDistanceCheck.
        let one_ways: Vec<_> = maze.graph.edges()
            .filter(|e| e.kind == EdgeKind::Basic)
            .filter(|e| maze.graph.edge_between_kind(e.to, e.from, &EdgeKind::Basic).is_none())
            .map(|e| e.id)
            .collect();
        let min_ratio = self.min_ratio as u64;

        let missing: Vec<(RepairArea, u32)> = match self.floor_scope {
            FloorScope::WholeMaze => {
                let field_cells = maze.field.point_count() as u64;
                let missing = Self::missing_for(one_ways.len() as u64, field_cells, min_ratio);
                if missing == 0 { vec![] } else { vec![(RepairArea::WholeMaze, missing)] }
            }
            FloorScope::PerFloor => {
                let mut per_floor_count: HashMap<LevelId, u64> =
                    maze.field.levels_ordered().map(|l| (l, 0)).collect();
                for &id in &one_ways {
                    for level in floors_of_edge(&maze.field, &maze.graph, id) {
                        *per_floor_count.entry(level).or_insert(0) += 1;
                    }
                }
                let mut missing: Vec<(RepairArea, u32)> = per_floor_count.into_iter()
                    .filter_map(|(level, count)| {
                        let missing = Self::missing_for(count, floor_point_count(&maze.field, level) as u64, min_ratio);
                        (missing > 0).then_some((RepairArea::Level(level), missing))
                    })
                    .collect();
                // `HashMap` iteration order is randomized per run -- sort by level so repair
                // strategies that loop over `issue.missing` consume RNG in a deterministic order.
                missing.sort_by_key(|&(area, _)| area);
                missing
            }
        };
        if missing.is_empty() {
            return;
        }
        let total: u32 = missing.iter().map(|(_, m)| m).sum();
        let issue = MissingOneWaysIssue::new_from_check(&self.instance_id, missing)
            .with_detail(&self.instance_id, "missing", total.to_string());
        issues.push(issue);
    }
}

impl MinOneWayRatioCheck {
    /// Deficit one-way count for one region (whole maze or one floor) given its own one-way count
    /// and cell count — shared by both `floor_scope` branches so the cross-multiplied-comparison
    /// rounding logic stays identical either way.
    fn missing_for(count: u64, field_cells: u64, min_ratio: u64) -> u32 {
        if field_cells == 0 || count * 100 >= min_ratio * field_cells {
            return 0;
        }
        // `required` rounds to the nearest integer (not ceil), matching
        // `MaxOneWayRatioCheck::to_remove_for`'s round-to-nearest `target_count`.
        let required = (min_ratio * field_cells + 50) / 100;
        required.saturating_sub(count) as u32
    }
}

#[cfg(test)]
mod tests {
    use crate::quality_control::Issue;
    use super::*;
    use rand::SeedableRng;
    use crate::{Graph, IdGenerator};
    use crate::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};

    const TEST_ID: &str = "min_one_way_ratio";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// 10 field cells, 1 one-way edge -> 10 per 100 cells.
    fn maze_with_one_one_way_on_ten_cells() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(10, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Basic);
        Maze::new(field, g)
    }

    #[test]
    fn silent_when_ratio_meets_minimum() {
        let maze = maze_with_one_one_way_on_ten_cells();
        let check = MinOneWayRatioCheck { instance_id: TEST_ID.to_string(), min_ratio: 10, floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "10 per 100 cells meets a minimum of 10");
    }

    #[test]
    fn fires_with_missing_count_when_below_minimum() {
        // 10 per 100 cells, min_ratio 30 -> missing_ratio 20 -> ceil(20*10/100) = 2.
        let maze = maze_with_one_one_way_on_ten_cells();
        let check = MinOneWayRatioCheck { instance_id: TEST_ID.to_string(), min_ratio: 30, floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, vec![(RepairArea::WholeMaze, 2)]);
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("missing")),
            Some(&"2".to_string()),
        );
    }

    #[test]
    fn missing_count_rounds_to_nearest_not_down() {
        // 10 per 100 cells, min_ratio 13 -> required = round(13*10/100) = round(1.3) = 1, missing = 0
        // (required already met by rounding, not truncated away by a stricter ceil).
        let maze = maze_with_one_one_way_on_ten_cells();
        let check = MinOneWayRatioCheck { instance_id: TEST_ID.to_string(), min_ratio: 13, floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "round(1.3) = 1, already met by the existing single one-way");
    }

    #[test]
    fn missing_count_rounds_to_nearest_not_up() {
        // 10 per 100 cells, min_ratio 17 -> required = round(17*10/100) = round(1.7) = 2, missing = 1.
        let maze = maze_with_one_one_way_on_ten_cells();
        let check = MinOneWayRatioCheck { instance_id: TEST_ID.to_string(), min_ratio: 17, floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, vec![(RepairArea::WholeMaze, 1)], "round(1.7) = 2, not ceil to 2 via truncation-then-up");
    }

    #[test]
    fn does_not_count_bidirectional_passage_as_one_way() {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        g.add_bidirectional_edge(p(0), p(1), EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MinOneWayRatioCheck { instance_id: TEST_ID.to_string(), min_ratio: 50, floor_scope: FloorScope::WholeMaze };
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
        let field = MultiLevelField::single_level(square_rect(1000, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        for i in 0..299 {
            g.add_edge(p(i), p(i + 1), EdgeKind::Basic);
        }
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MinOneWayRatioCheck { instance_id: TEST_ID.to_string(), min_ratio: 30, floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1, "29.9% must not silently pass a 30% minimum via floor rounding");
        assert_eq!(issues[0].missing, vec![(RepairArea::WholeMaze, 1)]);
    }
}
