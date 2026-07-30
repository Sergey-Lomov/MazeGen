use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::graph::cycles::density_per_100;
use crate::generation::SplitPattern;
use crate::quality_control::check::Check;
use crate::quality_control::{Issue, MissingSplitTilesIssue};
use super::split_count::count_matching_split_tiles;

pub const SPLIT_DENSITY_DEFAULT: u32 = 10;
pub const SPLIT_DENSITY_ESTIMATE_DEFAULT: u32 = 1;

/// Flags a deficit against a share (per 100 field cells) of the field covered by split tiles —
/// see GitHub issue #247, part of epic #246. Mirrors `MinLoopDensityCheck`'s shape exactly: same
/// deficit-to-count conversion (`missing_cells` rounds up, then divided by an estimate — here
/// `split_tile_estimate`, always 1 field cell per split tile since a split tile occupies exactly
/// one field cell regardless of its own node count, but kept as a configurable estimate for
/// symmetry with `MinLoopDensityCheck` and in case a future check wants a coarser request), same
/// optional `patterns` filter as `SplitCountCheck` (empty = every split tile counts).
pub struct SplitDensityCheck {
    pub instance_id: String,
    pub min_density: u32,
    pub split_tile_estimate: u32,
    pub patterns: Vec<SplitPattern>,
}

impl<T: Tessellation> Check<T, MissingSplitTilesIssue> for SplitDensityCheck {
    fn check_type_id(&self) -> &'static str { "split_density" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<MissingSplitTilesIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let field_cells = maze.field.point_count();
        if field_cells == 0 {
            return;
        }

        let count = count_matching_split_tiles(maze, &self.patterns);
        let density = density_per_100(count, field_cells);
        if density >= self.min_density {
            return;
        }

        let missing_cells = ((self.min_density - density) as usize * field_cells).div_ceil(100);
        let missing = missing_cells.div_ceil(self.split_tile_estimate.max(1) as usize) as u32;
        if missing == 0 {
            return;
        }
        let issue = MissingSplitTilesIssue::new_from_check(&self.instance_id, missing)
            .with_detail(&self.instance_id, "missing", missing.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::{Graph, IdGenerator};
    use crate::quality_control::Issue;
    use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};

    const TEST_ID: &str = "split_density";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// 10 field cells, `count` of them carrying a split tile.
    fn maze_with_split_tiles(count: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> = Field::new(square_rect(10, 1), &mut ids).unwrap();
        for x in 0..count as i32 {
            field.add_node_at(SquarePoint { x, y: 0 }, &mut ids);
        }
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        Maze::new(field, g)
    }

    #[test]
    fn silent_when_density_at_or_above_min() {
        let maze = maze_with_split_tiles(3);
        let check = SplitDensityCheck { instance_id: TEST_ID.to_string(), min_density: 30, split_tile_estimate: 1, patterns: vec![] };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "30% density meets a minimum of 30");
    }

    #[test]
    fn fires_with_missing_count_when_below_min() {
        // 30% density, min_density 60 -> 30 missing points -> 3 missing cells out of 10 field
        // cells -> ceil(3 / 1) = 3 split tiles requested.
        let maze = maze_with_split_tiles(3);
        let check = SplitDensityCheck { instance_id: TEST_ID.to_string(), min_density: 60, split_tile_estimate: 1, patterns: vec![] };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, 3);
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("missing")),
            Some(&"3".to_string()),
        );
    }

    #[test]
    fn missing_cells_rounds_up_instead_of_truncating() {
        // 30% density, min_density 31 -> 1 missing point -> ceil(10*1/100) = 1 missing cell, not
        // floor(10*1/100) = 0 (see GitHub issue #207's analogous loop-density rationale).
        let maze = maze_with_split_tiles(3);
        let check = SplitDensityCheck { instance_id: TEST_ID.to_string(), min_density: 31, split_tile_estimate: 1, patterns: vec![] };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1, "1 missing point must round up to 1 missing cell, not truncate to 0");
        assert_eq!(issues[0].missing, 1);
    }

    #[test]
    fn silent_when_no_split_tiles() {
        let maze = maze_with_split_tiles(0);
        let check = SplitDensityCheck { instance_id: TEST_ID.to_string(), min_density: 0, split_tile_estimate: 1, patterns: vec![] };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }
}
