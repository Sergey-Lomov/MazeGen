use crate::Maze;
use crate::graph::cycles::density_per_100;
use crate::quality_control::check::Check;
use crate::quality_control::floor_group::floor_point_count;
use crate::quality_control::{FloorScope, InvalidSplitTileGroupIssue, SplitTileNodes};
use crate::space::{LevelId, Tessellation};
use rand::RngCore;
use std::collections::HashMap;

pub const MAX_SPLIT_DENSITY_DEFAULT: f64 = 30.0;
pub const MAX_SPLIT_DENSITY_DEFAULT_FLOOR_SCOPE: FloorScope = FloorScope::PerFloor;

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
    pub floor_scope: FloorScope,
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
        let mut seen_points = std::collections::HashSet::new();
        let tiles: Vec<(LevelId, SplitTileNodes)> = maze
            .field
            .all_points_with_level()
            .filter(|&(level, point)| seen_points.insert((level, point)))
            .filter_map(|(level, point)| {
                let nodes = maze.field.nodes_at(level, point);
                if nodes.len() < 2 {
                    None
                } else {
                    Some((level, SplitTileNodes::new(nodes.to_vec())))
                }
            })
            .collect();

        // A split tile belongs to exactly one floor, so under `PerFloor` this is a plain
        // per-floor grouping/filter, not a counts-toward-both case (GitHub issue #369).
        let (group, to_remove) = match self.floor_scope {
            FloorScope::WholeMaze => {
                let field_cells = maze.field.point_count();
                if field_cells == 0 {
                    return;
                }
                match Self::to_remove_for(tiles.len(), field_cells, self.max_density) {
                    0 => return,
                    n => (tiles.into_iter().map(|(_, tile)| tile).collect(), n),
                }
            }
            FloorScope::PerFloor => {
                let mut per_floor_count: HashMap<LevelId, usize> =
                    maze.field.levels_ordered().map(|l| (l, 0)).collect();
                for &(level, _) in &tiles {
                    *per_floor_count.entry(level).or_insert(0) += 1;
                }
                // A split tile belongs to exactly one floor, so each over-budget floor's own
                // tiles and excess form their own independent group -- collapsing every
                // over-budget floor's tiles into one group with a single (e.g. max) `to_remove`
                // would let the repair strategy resolve a smaller floor's excess by removing
                // tiles that actually belong to a different, larger floor's own quota.
                let mut over_budget: HashMap<LevelId, u32> = HashMap::new();
                for (&level, &count) in &per_floor_count {
                    let field_cells = floor_point_count(&maze.field, level);
                    let n = Self::to_remove_for(count, field_cells, self.max_density);
                    if n > 0 {
                        over_budget.insert(level, n);
                    }
                }
                if over_budget.is_empty() {
                    return;
                }
                let mut tiles_by_level: HashMap<LevelId, Vec<SplitTileNodes>> = HashMap::new();
                for (level, tile) in tiles {
                    tiles_by_level.entry(level).or_default().push(tile);
                }
                let groups: Vec<(Vec<SplitTileNodes>, u32)> = over_budget
                    .into_iter()
                    .filter_map(|(level, to_remove)| {
                        tiles_by_level
                            .remove(&level)
                            .map(|tiles| (tiles, to_remove))
                    })
                    .collect();
                let issue = InvalidSplitTileGroupIssue::new_from_check(&self.instance_id, groups)
                    .with_detail(
                        &self.instance_id,
                        "max_density",
                        self.max_density.to_string(),
                    );
                issues.push(issue);
                return;
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
    /// Excess tile count for one region (whole maze or one floor) given its own tile/cell counts
    /// — shared by both `floor_scope` branches so the round-to-nearest `target_count` logic stays
    /// identical either way. Mirrors `MaxOneWayRatioCheck::to_remove_for` exactly.
    fn to_remove_for(count: usize, field_cells: usize, max_density: f64) -> u32 {
        if field_cells == 0 || density_per_100(count, field_cells) <= max_density {
            return 0;
        }
        // Round-to-nearest can push target_count above count on a small enough field (rounding
        // error can exceed the margin the gate above guarantees) -- saturating_sub keeps the
        // result at 0 rather than underflowing in that edge case.
        let target_count = (max_density * field_cells as f64 / 100.0).round() as usize;
        count.saturating_sub(target_count) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::Issue;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;

    const TEST_ID: &str = "max_split_density";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// 10 field cells, `count` of them carrying a split tile (one extra node each).
    fn maze_with_split_tiles(count: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(10, 1), &mut ids).unwrap();
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
            floor_scope: FloorScope::WholeMaze,
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
            floor_scope: FloorScope::WholeMaze,
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
            floor_scope: FloorScope::WholeMaze,
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
            MultiLevelField::single_level(square_rect(1000, 1), &mut ids).unwrap();
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
            floor_scope: FloorScope::WholeMaze,
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
            floor_scope: FloorScope::WholeMaze,
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

    /// Each floor is 10 field cells; `bottom_count`/`top_count` of them carry a split tile.
    fn maze_with_split_tiles_on_two_floors(
        bottom_count: usize,
        top_count: usize,
    ) -> Maze<SquareTessellation> {
        use crate::space::Field;
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(10, 1), &mut ids).unwrap());
        let top =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(10, 1), &mut ids).unwrap());
        for x in 0..bottom_count as i32 {
            mf.add_node_at(bottom, SquarePoint { x, y: 0 }, &mut ids);
        }
        for x in 0..top_count as i32 {
            mf.add_node_at(top, SquarePoint { x, y: 0 }, &mut ids);
        }
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        Maze::new(mf, g)
    }

    #[test]
    fn per_floor_flags_each_over_budget_floor_with_its_own_group_and_to_remove() {
        // Bottom: 3/10 = 30% density (to_remove 1 to reach 20%). Top: 4/10 = 40% (to_remove 2).
        let maze = maze_with_split_tiles_on_two_floors(3, 4);
        let check = MaxSplitDensityCheck {
            instance_id: TEST_ID.to_string(),
            max_density: 20.0,
            floor_scope: FloorScope::PerFloor,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        let mut groups = issues[0].groups.clone();
        groups.sort_by_key(|(g, _)| g.len());
        assert_eq!(
            groups.len(),
            2,
            "each over-budget floor must get its own independent group"
        );
        assert_eq!(groups[0].0.len(), 3, "bottom floor's own tiles only");
        assert_eq!(
            groups[0].1, 1,
            "bottom floor's own to_remove, not the max across floors"
        );
        assert_eq!(groups[1].0.len(), 4, "top floor's own tiles only");
        assert_eq!(
            groups[1].1, 2,
            "top floor's own to_remove, not the max across floors"
        );
    }
}
