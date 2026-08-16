use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::graph::cycles::density_per_100;
use crate::generation::SplitPattern;
use crate::quality_control::check::Check;
use crate::quality_control::{MissingSplitTilesIssue, FloorScope, RepairArea};
use crate::quality_control::floor_group::floor_point_count;
use super::split_count::{count_matching_split_tiles, count_matching_split_tiles_per_floor};

pub const SPLIT_DENSITY_DEFAULT: u32 = 10;
pub const SPLIT_DENSITY_ESTIMATE_DEFAULT: u32 = 1;
pub const SPLIT_DENSITY_DEFAULT_FLOOR_SCOPE: FloorScope = FloorScope::PerFloor;

/// Flags a deficit against a share (per 100 field cells) of the field covered by split tiles —
/// see GitHub issue #247, part of epic #246. Mirrors `MinLoopDensityCheck`'s shape exactly: same
/// deficit-to-count conversion (`required_cells` rounds to the nearest integer, `missing_cells`
/// then divided by an estimate — here `split_tile_estimate`, always 1 field cell per split tile
/// since a split tile occupies exactly one field cell regardless of its own node count, but kept
/// as a configurable estimate for symmetry with `MinLoopDensityCheck` and in case a future check
/// wants a coarser request), same optional `patterns` filter as `SplitCountCheck` (empty = every
/// split tile counts).
pub struct SplitDensityCheck {
    pub instance_id: String,
    pub min_density: u32,
    pub split_tile_estimate: u32,
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
        // `required_cells` rounds to the nearest integer (not ceil), matching
        // `MaxOneWayRatioCheck::to_remove_for`'s round-to-nearest `target_count`.
        let required_cells = (self.min_density as usize * field_cells + 50) / 100;
        let missing_cells = required_cells.saturating_sub(count);
        missing_cells.div_ceil(self.split_tile_estimate.max(1) as usize) as u32
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
        let check = SplitDensityCheck { instance_id: TEST_ID.to_string(), min_density: 30, split_tile_estimate: 1, patterns: vec![], floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "30% density meets a minimum of 30");
    }

    #[test]
    fn fires_with_missing_count_when_below_min() {
        // 30% density, min_density 60 -> 30 missing points -> 3 missing cells out of 10 field
        // cells -> ceil(3 / 1) = 3 split tiles requested.
        let maze = maze_with_split_tiles(3);
        let check = SplitDensityCheck { instance_id: TEST_ID.to_string(), min_density: 60, split_tile_estimate: 1, patterns: vec![], floor_scope: FloorScope::WholeMaze };
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
        let check = SplitDensityCheck { instance_id: TEST_ID.to_string(), min_density: 31, split_tile_estimate: 1, patterns: vec![], floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "round(3.1) = 3, already met by the 3 existing split tiles");
    }

    #[test]
    fn required_cells_rounds_to_nearest_not_up() {
        // 30% density, min_density 35 -> required = round(35*10/100) = round(3.5) = 4, missing_cells = 1.
        let maze = maze_with_split_tiles(3);
        let check = SplitDensityCheck { instance_id: TEST_ID.to_string(), min_density: 35, split_tile_estimate: 1, patterns: vec![], floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, vec![(RepairArea::WholeMaze, 1)], "round(3.5) = 4, missing_cells = 1");
    }

    #[test]
    fn silent_when_no_split_tiles() {
        let maze = maze_with_split_tiles(0);
        let check = SplitDensityCheck { instance_id: TEST_ID.to_string(), min_density: 0, split_tile_estimate: 1, patterns: vec![], floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }
}
