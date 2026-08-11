use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::graph::cycles::density_per_100;
use crate::quality_control::check::Check;
use crate::quality_control::{InvalidSplitTileGroupIssue, SplitTileNodes};

pub const MAX_SPLIT_DENSITY_DEFAULT: u32 = 30;

/// Flags every split tile on the field invalid when their density (share of field cells carrying
/// a split tile, per 100 — see `density_per_100`) exceeds `max_density` — see GitHub issue #249,
/// part of epic #246. Mirrors `MaxLoopDensityCheck`'s identical rationale: a field-wide/aggregate
/// decision, which tiles to actually collapse is `SplitGroupSelectStrategy`'s job. One group
/// covering every split tile on the field (each as its own `SplitTileNodes` candidate),
/// `to_remove` computed by rounding the excess density back down into a tile count (the smallest
/// tile count that would bring density back to `max_density`).
pub struct MaxSplitDensityCheck {
    pub instance_id: String,
    pub max_density: u32,
}

impl<T: Tessellation> Check<T, InvalidSplitTileGroupIssue> for MaxSplitDensityCheck {
    fn check_type_id(&self) -> &'static str { "max_split_density" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidSplitTileGroupIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let field_cells = maze.field.point_count();
        if field_cells == 0 {
            return;
        }

        let mut seen_points = std::collections::HashSet::new();
        let tiles: Vec<SplitTileNodes> = maze.field.all_points_with_level()
            .filter(|&(level, point)| seen_points.insert((level, point)))
            .filter_map(|(level, point)| {
                let nodes = maze.field.nodes_at(level, point);
                if nodes.len() < 2 { None } else { Some(SplitTileNodes::new(nodes.to_vec())) }
            })
            .collect();

        if density_per_100(tiles.len(), field_cells) <= self.max_density {
            return;
        }

        // Largest tile count whose density_per_100 is still at or below max_density -- density is
        // monotonic increasing in count, so this is the fewest tiles that need collapsing.
        let allowed_count = (0..=tiles.len()).rev()
            .find(|&c| density_per_100(c, field_cells) <= self.max_density)
            .unwrap_or(0);
        let to_remove = (tiles.len() - allowed_count) as u32;

        let issue = InvalidSplitTileGroupIssue::new_from_check(&self.instance_id, vec![(tiles, to_remove)])
            .with_detail(&self.instance_id, "max_density", self.max_density.to_string());
        issues.push(issue);
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
        let check = MaxSplitDensityCheck { instance_id: TEST_ID.to_string(), max_density: 20 };
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
        let check = MaxSplitDensityCheck { instance_id: TEST_ID.to_string(), max_density: 20 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "20% density must not fire against a max of 20");
    }

    #[test]
    fn silent_when_no_split_tiles() {
        let maze = maze_with_split_tiles(0);
        let check = MaxSplitDensityCheck { instance_id: TEST_ID.to_string(), max_density: 0 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }
}
