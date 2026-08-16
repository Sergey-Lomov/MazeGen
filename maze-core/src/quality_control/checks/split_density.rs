use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::graph::cycles::density_per_100;
use crate::generation::SplitPattern;
use crate::quality_control::check::Check;
use crate::quality_control::{MissingSplitTilesIssue, FloorScope, RepairArea};
use crate::quality_control::floor_group::floor_point_count;
use super::split_count::{count_matching_split_tiles, count_matching_split_tiles_per_floor};

pub const SPLIT_DENSITY_DEFAULT: f64 = 10.0;
pub const SPLIT_DENSITY_DEFAULT_FLOOR_SCOPE: FloorScope = FloorScope::PerFloor;

/// Flags a deficit against a share (per 100 field cells) of the field covered by split tiles —
/// see GitHub issue #247, part of epic #246. Mirrors `MinLoopDensityCheck`'s shape exactly: same
/// deficit-to-count conversion (`required_cells` rounds to the nearest integer), same optional
/// `patterns` filter as `SplitCountCheck` (empty = every split tile counts).
pub struct SplitDensityCheck {
    pub instance_id: String,
    pub min_density: f64,
    pub patterns: Vec<SplitPattern>,
    pub floor_scope: FloorScope,
}

impl<T: Tessellation> Check<T, MissingSplitTilesIssue> for SplitDensityCheck {
    fn check_type_id(&self) -> &'static str { "split_density" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<MissingSplitTilesIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let missing: Vec<(RepairArea, u32)> = match self.floor_scope {
            FloorScope::WholeMaze => {
                let field_cells = maze.field.point_count();
                if field_cells == 0 {
                    return;
                }
                let missing = self.missing_for(count_matching_split_tiles(maze, &self.patterns), field_cells);
                if missing == 0 { vec![] } else { vec![(RepairArea::WholeMaze, missing)] }
            }
            FloorScope::PerFloor => {
                let mut missing: Vec<(RepairArea, u32)> = count_matching_split_tiles_per_floor(maze, &self.patterns).into_iter()
                    .filter_map(|(level, count)| {
                        let missing = self.missing_for(count, floor_point_count(&maze.field, level));
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
        let issue = MissingSplitTilesIssue::new_from_check(&self.instance_id, missing)
            .with_detail(&self.instance_id, "missing", total.to_string());
        issues.push(issue);
    }
}

impl SplitDensityCheck {
    /// Deficit split-tile count for one region (whole maze or one floor) given its own tile/cell
    /// counts — shared by both `floor_scope` branches so the rounding/conversion logic stays
    /// identical either way.
    fn missing_for(&self, count: usize, field_cells: usize) -> u32 {
        if field_cells == 0 {
            return 0;
        }
        let density = density_per_100(count, field_cells);
        if density >= self.min_density {
            return 0;
        }
        // `required_cells` rounds the fractional target cell count to the nearest integer, not
        // ceil — matches `MinLoopDensityCheck::missing_for`'s rounding direction.
        let required_cells = (self.min_density * field_cells as f64 / 100.0).round() as usize;
        required_cells.saturating_sub(count) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::{Graph, IdGenerator};
    use crate::quality_control::Issue;
    use crate::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};

    const TEST_ID: &str = "split_density";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// 10 field cells, `count` of them carrying a split tile.
    fn maze_with_split_tiles(count: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(10, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        for x in 0..count as i32 {
            field.add_node_at(field_level, SquarePoint { x, y: 0 }, &mut ids);
        }
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        Maze::new(field, g)
    }

    #[test]
    fn silent_when_density_at_or_above_min() {
        let maze = maze_with_split_tiles(3);
        let check = SplitDensityCheck { instance_id: TEST_ID.to_string(), min_density: 30.0, patterns: vec![], floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "30% density meets a minimum of 30");
    }

    #[test]
    fn fires_with_missing_count_when_below_min() {
        // 30% density, min_density 60 -> required=round(60*10/100)=6, missing_cells=3 split
        // tiles requested.
        let maze = maze_with_split_tiles(3);
        let check = SplitDensityCheck { instance_id: TEST_ID.to_string(), min_density: 60.0, patterns: vec![], floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, vec![(RepairArea::WholeMaze, 3)]);
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("missing")),
            Some(&"3".to_string()),
        );
    }

    #[test]
    fn required_cells_rounds_to_nearest_not_down() {
        // 30% density, min_density 31 -> required = round(31*10/100) = round(3.1) = 3, already met
        // by the 3 existing split tiles -> silent, not a stricter ceil-driven false positive.
        let maze = maze_with_split_tiles(3);
        let check = SplitDensityCheck { instance_id: TEST_ID.to_string(), min_density: 31.0, patterns: vec![], floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "round(3.1) = 3, already met by the 3 existing split tiles");
    }

    #[test]
    fn required_cells_rounds_to_nearest_not_up() {
        // 30% density, min_density 35 -> required = round(35*10/100) = round(3.5) = 4, missing_cells = 1.
        let maze = maze_with_split_tiles(3);
        let check = SplitDensityCheck { instance_id: TEST_ID.to_string(), min_density: 35.0, patterns: vec![], floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, vec![(RepairArea::WholeMaze, 1)], "round(3.5) = 4, missing_cells = 1");
    }

    #[test]
    fn silent_when_no_split_tiles() {
        let maze = maze_with_split_tiles(0);
        let check = SplitDensityCheck { instance_id: TEST_ID.to_string(), min_density: 0.0, patterns: vec![], floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    /// 1000 field cells, 300 of them carrying a split tile -> a clean 30% density fine-grained
    /// enough that a `.1`-scale fractional threshold isn't swallowed by the `required_cells`
    /// rounding step.
    fn maze_with_300_of_1000_split_tiles() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(1000, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        for x in 0..300 {
            field.add_node_at(field_level, SquarePoint { x, y: 0 }, &mut ids);
        }
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        Maze::new(field, g)
    }

    #[test]
    fn min_density_accepts_a_genuinely_fractional_threshold() {
        // 300/1000 = 30% density on a fine-grained field. min_density 29.9 must stay silent
        // (density clears it); 30.1 must fire (density falls fractionally short) -- pins that the
        // gate compares the true density, not one rounded to a whole percentage first.
        let maze = maze_with_300_of_1000_split_tiles();
        let check = SplitDensityCheck { instance_id: TEST_ID.to_string(), min_density: 29.9, patterns: vec![], floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "30% density must clear a fractional minimum of 29.9");

        let check = SplitDensityCheck { instance_id: TEST_ID.to_string(), min_density: 30.1, patterns: vec![], floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1, "30% density must fall short of a fractional minimum of 30.1");
        assert_eq!(issues[0].missing, vec![(RepairArea::WholeMaze, 1)], "required=round(30.1*1000/100)=301, missing_cells=1, ceil(1/1)=1");
    }

    /// Bottom floor: 10 cells, 3 split tiles (30%). Top floor: 10 cells, 0 split tiles (0%).
    fn maze_with_split_tiles_on_two_floors() -> Maze<SquareTessellation> {
        use crate::space::Field;
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom = mf.add_level(Field::<SquareTessellation>::new(square_rect(10, 1), &mut ids).unwrap());
        let top = mf.add_level(Field::<SquareTessellation>::new(square_rect(10, 1), &mut ids).unwrap());
        for x in 0..3 {
            mf.add_node_at(bottom, SquarePoint { x, y: 0 }, &mut ids);
        }
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let _ = top;
        Maze::new(mf, g)
    }

    #[test]
    fn per_floor_flags_each_deficient_floor_with_its_own_area_and_amount() {
        // Bottom: 30% density, needs round(60*10/100)=6, missing_cells=3. Top: 0%, needs 6.
        let maze = maze_with_split_tiles_on_two_floors();
        let check = SplitDensityCheck { instance_id: TEST_ID.to_string(), min_density: 60.0, patterns: vec![], floor_scope: FloorScope::PerFloor };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        let mut missing = issues[0].missing.clone();
        missing.sort_by_key(|&(_, amount)| amount);
        assert_eq!(missing.len(), 2, "each deficient floor gets its own RepairArea::Level entry");
        assert_eq!(missing[0].1, 3, "bottom floor: 30%, needs 3 more cells");
        assert_eq!(missing[1].1, 6, "top floor: 0%, needs 6 more cells");
    }
}
