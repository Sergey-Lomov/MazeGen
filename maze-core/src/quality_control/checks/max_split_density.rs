use crate::Maze;
use crate::graph::cycles::rounded_excess_over_density;
use crate::quality_control::check::Check;
use crate::quality_control::{InvalidSplitTileGroupIssue, SplitTileNodes};
use crate::space::{LevelId, Tessellation};
use rand::RngCore;

pub const MAX_SPLIT_DENSITY_DEFAULT: f64 = 30.0;

/// Flags every split tile on the field invalid when their density (share of field cells carrying
/// a split tile, per 100 — see `density_per_100`) exceeds `max_density` — see GitHub issue #249,
/// part of epic #246. Mirrors `MaxLoopDensityCheck`'s identical rationale: a field-wide/aggregate
/// decision, which tiles to actually collapse is `SplitGroupSelectStrategy`'s job. One group
/// covering every split tile on the field (each as its own `SplitTileNodes` candidate), `to_remove`
/// computed the same way as `MaxOneWayRatioCheck::to_remove_for`: `target_count` rounds
/// `max_density * field_cells / 100` to the nearest integer, `to_remove = count - target_count`.
pub struct MaxSplitDensityCheck {
    pub instance_id: String,
    pub max_density: f64,
}

impl<T: Tessellation> Check<T, InvalidSplitTileGroupIssue> for MaxSplitDensityCheck {
    fn check_type_id(&self) -> &'static str {
        "max_split_density"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidSplitTileGroupIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let tiles: Vec<(LevelId, SplitTileNodes)> = maze
            .scoped_split_cells()
            .map(|(level, point)| {
                let nodes = maze.field.nodes_at(level, point);
                (level, SplitTileNodes::new(nodes.to_vec()))
            })
            .collect();

        let (group, to_remove) = {
            let field_cells = maze.scoped_cell_count();
            if field_cells == 0 {
                return;
            }
            match Self::to_remove_for(tiles.len(), field_cells, self.max_density) {
                0 => return,
                n => (tiles.into_iter().map(|(_, tile)| tile).collect(), n),
            }
        };

        let issue =
            InvalidSplitTileGroupIssue::new_from_check(&self.instance_id, vec![(group, to_remove)])
                .with_detail(
                    &self.instance_id,
                    "max_density",
                    self.max_density.to_string(),
                );
        issues.push(issue);
    }
}

impl MaxSplitDensityCheck {
    fn to_remove_for(count: usize, field_cells: usize, max_density: f64) -> u32 {
        rounded_excess_over_density(count, field_cells, max_density)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::Issue;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;
    use std::sync::Arc;

    const TEST_ID: &str = "max_split_density";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// 10 field cells, `count` of them carrying a split tile (one extra node each).
    fn maze_with_split_tiles(count: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(10, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        for x in 0..count as i32 {
            field.add_node_at(level, SquarePoint { x, y: 0 }, &mut ids);
        }
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        Maze::new(field, g)
    }

    #[test]
    fn fires_and_flags_every_split_tile_when_density_exceeds_max() {
        // 3 split tiles / 10 cells = 30% density.
        let maze = maze_with_split_tiles(3);
        let check = MaxSplitDensityCheck {
            instance_id: TEST_ID.to_string(),
            max_density: 20.0,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].groups[0].0.len(), 3);
        assert_eq!(
            issues[0].groups[0].1, 1,
            "collapsing 1 tile brings density to 20%, at the max"
        );
        assert_eq!(
            issues[0]
                .details()
                .get(TEST_ID)
                .and_then(|kv| kv.get("max_density")),
            Some(&"20".to_string()),
        );
    }

    #[test]
    fn silent_when_density_at_or_below_max() {
        let maze = maze_with_split_tiles(2);
        let check = MaxSplitDensityCheck {
            instance_id: TEST_ID.to_string(),
            max_density: 20.0,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "20% density must not fire against a max of 20"
        );
    }

    #[test]
    fn silent_when_no_split_tiles() {
        let maze = maze_with_split_tiles(0);
        let check = MaxSplitDensityCheck {
            instance_id: TEST_ID.to_string(),
            max_density: 0.0,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    /// 1000 field cells, 300 of them carrying a split tile -> a clean 30% density fine-grained
    /// enough that a `.1`-scale fractional threshold isn't swallowed by the `target_count`
    /// rounding step.
    fn maze_with_300_of_1000_split_tiles() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(1000, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        for x in 0..300 {
            field.add_node_at(level, SquarePoint { x, y: 0 }, &mut ids);
        }
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        Maze::new(field, g)
    }

    #[test]
    fn max_density_accepts_a_genuinely_fractional_threshold() {
        // 300/1000 = 30% density. max_density 30.1 must stay silent (density clears it); 29.9
        // must fire (density exceeds it fractionally) -- pins that the gate compares the true
        // density, not one rounded to a whole percentage first.
        let maze = maze_with_300_of_1000_split_tiles();
        let check = MaxSplitDensityCheck {
            instance_id: TEST_ID.to_string(),
            max_density: 30.1,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "30% density must not exceed a fractional maximum of 30.1"
        );

        let check = MaxSplitDensityCheck {
            instance_id: TEST_ID.to_string(),
            max_density: 29.9,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(
            issues.len(),
            1,
            "30% density must exceed a fractional maximum of 29.9"
        );
        assert_eq!(
            issues[0].groups[0].1, 1,
            "target_count=round(29.9*1000/100)=299, to_remove=300-299=1"
        );
    }
}
