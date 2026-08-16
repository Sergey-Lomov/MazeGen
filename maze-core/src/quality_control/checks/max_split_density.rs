use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::space::{LevelId, Tessellation};
use crate::graph::cycles::density_per_100;
use crate::quality_control::check::Check;
use crate::quality_control::{InvalidSplitTileGroupIssue, SplitTileNodes, FloorScope};
use crate::quality_control::floor_group::floor_point_count;

pub const MAX_SPLIT_DENSITY_DEFAULT: u32 = 30;
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
    pub max_density: u32,
    pub floor_scope: FloorScope,
}

impl<T: Tessellation> Check<T, InvalidSplitTileGroupIssue> for MaxSplitDensityCheck {
    fn check_type_id(&self) -> &'static str { "max_split_density" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidSplitTileGroupIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let mut seen_points = std::collections::HashSet::new();
        let tiles: Vec<(LevelId, SplitTileNodes)> = maze.field.all_points_with_level()
            .filter(|&(level, point)| seen_points.insert((level, point)))
            .filter_map(|(level, point)| {
                let nodes = maze.field.nodes_at(level, point);
                if nodes.len() < 2 { None } else { Some((level, SplitTileNodes::new(nodes.to_vec()))) }
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
                let max_to_remove = over_budget.values().copied().max().unwrap_or(0);
                let flagged: Vec<SplitTileNodes> = tiles.into_iter()
                    .filter(|(level, _)| over_budget.contains_key(level))
                    .map(|(_, tile)| tile)
                    .collect();
                (flagged, max_to_remove)
            }
        };

        let issue = InvalidSplitTileGroupIssue::new_from_check(&self.instance_id, vec![(group, to_remove)])
            .with_detail(&self.instance_id, "max_density", self.max_density.to_string());
        issues.push(issue);
    }
}

impl MaxSplitDensityCheck {
    /// Excess tile count for one region (whole maze or one floor) given its own tile/cell counts
    /// — shared by both `floor_scope` branches so the round-to-nearest `target_count` logic stays
    /// identical either way. Mirrors `MaxOneWayRatioCheck::to_remove_for` exactly.
    fn to_remove_for(count: usize, field_cells: usize, max_density: u32) -> u32 {
        if field_cells == 0 || density_per_100(count, field_cells) <= max_density {
            return 0;
        }
        // Round-to-nearest can push target_count above count on a small enough field (rounding
        // error can exceed the margin the gate above guarantees) -- saturating_sub keeps the
        // result at 0 rather than underflowing in that edge case.
        let target_count = (max_density as usize * field_cells + 50) / 100;
        count.saturating_sub(target_count) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::{Graph, IdGenerator};
    use crate::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};
    use crate::quality_control::Issue;

    const TEST_ID: &str = "max_split_density";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// 10 field cells, `count` of them carrying a split tile (one extra node each).
    fn maze_with_split_tiles(count: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(10, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        for x in 0..count as i32 {
            field.add_node_at(level, SquarePoint { x, y: 0 }, &mut ids);
        }
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        Maze::new(field, g)
    }

    #[test]
    fn fires_and_flags_every_split_tile_when_density_exceeds_max() {
        // 3 split tiles / 10 cells = 30% density.
        let maze = maze_with_split_tiles(3);
        let check = MaxSplitDensityCheck { instance_id: TEST_ID.to_string(), max_density: 20, floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].groups[0].0.len(), 3);
        assert_eq!(issues[0].groups[0].1, 1, "collapsing 1 tile brings density to 20%, at the max");
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("max_density")),
            Some(&"20".to_string()),
        );
    }

    #[test]
    fn silent_when_density_at_or_below_max() {
        let maze = maze_with_split_tiles(2);
        let check = MaxSplitDensityCheck { instance_id: TEST_ID.to_string(), max_density: 20, floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "20% density must not fire against a max of 20");
    }

    #[test]
    fn silent_when_no_split_tiles() {
        let maze = maze_with_split_tiles(0);
        let check = MaxSplitDensityCheck { instance_id: TEST_ID.to_string(), max_density: 0, floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }
}
