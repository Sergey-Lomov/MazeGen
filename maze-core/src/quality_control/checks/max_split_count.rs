use crate::Maze;
use crate::quality_control::check::Check;
use crate::quality_control::{FloorScope, InvalidSplitTileGroupIssue, SplitTileNodes};
use crate::space::{LevelId, Tessellation};
use rand::RngCore;
use std::collections::HashMap;

pub const MAX_SPLIT_COUNT_DEFAULT: u32 = 20;
pub const MAX_SPLIT_COUNT_DEFAULT_FLOOR_SCOPE: FloorScope = FloorScope::WholeMaze;

/// Flags every split tile on the field invalid when their total count exceeds `max_split_count`
/// — see GitHub issue #249, part of epic #246. A field-wide/aggregate decision (mirrors
/// `MaxLoopsCountCheck`'s identical rationale, GitHub issue #37/#183): which tiles to actually
/// collapse is `SplitGroupSelectStrategy`'s job, not this check's. One group covering every split
/// tile on the field (each as its own `SplitTileNodes` candidate, carrying every node at that
/// point including slot-0 — see the epic's own doc comment: slot-0 is an equal member of the tile
/// everywhere except the removal step itself), `to_remove` equal to the excess tile count over
/// the maximum.
pub struct MaxSplitCountCheck {
    pub instance_id: String,
    pub max_split_count: u32,
    pub floor_scope: FloorScope,
}

impl<T: Tessellation> Check<T, InvalidSplitTileGroupIssue> for MaxSplitCountCheck {
    fn check_type_id(&self) -> &'static str {
        "max_split_count"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidSplitTileGroupIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let tiles: Vec<(LevelId, SplitTileNodes)> = maze
            .field
            .split_points()
            .map(|(level, point)| {
                let nodes = maze.field.nodes_at(level, point);
                (level, SplitTileNodes::new(nodes.to_vec()))
            })
            .collect();

        // A split tile belongs to exactly one floor (unlike edges/nodes spanning floors), so
        // under `PerFloor` this is a plain per-floor grouping/filter, not a counts-toward-both
        // case (GitHub issue #369).
        let (group, to_remove) = match self.floor_scope {
            FloorScope::WholeMaze => {
                let count = tiles.len() as u32;
                if count <= self.max_split_count {
                    return;
                }
                let to_remove = count - self.max_split_count;
                (tiles.into_iter().map(|(_, tile)| tile).collect(), to_remove)
            }
            FloorScope::PerFloor => {
                let mut per_floor_count: HashMap<LevelId, u32> =
                    maze.field.levels_ordered().map(|l| (l, 0)).collect();
                for &(level, _) in &tiles {
                    *per_floor_count.entry(level).or_insert(0) += 1;
                }
                // A split tile belongs to exactly one floor, so each over-budget floor's own
                // tiles and excess form their own independent group -- collapsing every
                // over-budget floor's tiles into one group with a single (e.g. max) `to_remove`
                // would let the repair strategy resolve a smaller floor's excess by removing
                // tiles that actually belong to a different, larger floor's own quota.
                let mut tiles_by_level: HashMap<LevelId, Vec<SplitTileNodes>> = HashMap::new();
                for (level, tile) in tiles {
                    tiles_by_level.entry(level).or_default().push(tile);
                }
                let mut groups: Vec<(Vec<SplitTileNodes>, u32)> = per_floor_count
                    .into_iter()
                    .filter(|&(_, count)| count > self.max_split_count)
                    .filter_map(|(level, count)| {
                        let to_remove = count - self.max_split_count;
                        tiles_by_level
                            .remove(&level)
                            .map(|tiles| (tiles, to_remove))
                    })
                    .collect();
                if groups.is_empty() {
                    return;
                }
                let issue = InvalidSplitTileGroupIssue::new_from_check(
                    &self.instance_id,
                    std::mem::take(&mut groups),
                )
                .with_detail(
                    &self.instance_id,
                    "max_split_count",
                    self.max_split_count.to_string(),
                );
                issues.push(issue);
                return;
            }
        };

        let issue =
            InvalidSplitTileGroupIssue::new_from_check(&self.instance_id, vec![(group, to_remove)])
                .with_detail(
                    &self.instance_id,
                    "max_split_count",
                    self.max_split_count.to_string(),
                );
        issues.push(issue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::Issue;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;

    const TEST_ID: &str = "max_split_count";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    fn maze_with_split_tiles(count: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(count.max(1) + 1, 1), &mut ids).unwrap();
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
    fn fires_and_flags_every_split_tile_when_count_exceeds_max() {
        let maze = maze_with_split_tiles(3);
        let check = MaxSplitCountCheck {
            instance_id: TEST_ID.to_string(),
            max_split_count: 1,
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].groups.len(), 1);
        assert_eq!(
            issues[0].groups[0].0.len(),
            3,
            "every split tile must be offered to the repair strategy"
        );
        assert_eq!(
            issues[0].groups[0].1, 2,
            "to_remove must equal the excess tile count over the max"
        );
        assert_eq!(
            issues[0]
                .details()
                .get(TEST_ID)
                .and_then(|kv| kv.get("max_split_count")),
            Some(&"1".to_string()),
        );
    }

    #[test]
    fn silent_when_count_at_or_below_max() {
        let maze = maze_with_split_tiles(2);
        let check = MaxSplitCountCheck {
            instance_id: TEST_ID.to_string(),
            max_split_count: 2,
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "count equal to the max must not fire");
    }

    #[test]
    fn silent_when_no_split_tiles() {
        let maze = maze_with_split_tiles(0);
        let check = MaxSplitCountCheck {
            instance_id: TEST_ID.to_string(),
            max_split_count: 0,
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    fn maze_with_split_tiles_on_two_floors(
        bottom_count: usize,
        top_count: usize,
    ) -> Maze<SquareTessellation> {
        use crate::space::Field;
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom = mf.add_level(
            Field::<SquareTessellation>::new(square_rect(bottom_count.max(1) + 1, 1), &mut ids)
                .unwrap(),
        );
        let top = mf.add_level(
            Field::<SquareTessellation>::new(square_rect(top_count.max(1) + 1, 1), &mut ids)
                .unwrap(),
        );
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
    fn per_floor_flags_each_over_budget_floor_with_its_own_group_and_excess() {
        // Bottom floor: 3 split tiles (excess 2 over max 1). Top floor: 2 split tiles (excess 1).
        let maze = maze_with_split_tiles_on_two_floors(3, 2);
        let check = MaxSplitCountCheck {
            instance_id: TEST_ID.to_string(),
            max_split_count: 1,
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
        assert_eq!(groups[0].0.len(), 2, "top floor's own tiles only");
        assert_eq!(
            groups[0].1, 1,
            "top floor's own excess, not the max across floors"
        );
        assert_eq!(groups[1].0.len(), 3, "bottom floor's own tiles only");
        assert_eq!(
            groups[1].1, 2,
            "bottom floor's own excess, not the max across floors"
        );
    }
}
