use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::{InvalidSplitTileGroupIssue, SplitTileNodes};

pub const MAX_SPLIT_COUNT_DEFAULT: u32 = 20;

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
}

impl<T: Tessellation> Check<T, InvalidSplitTileGroupIssue> for MaxSplitCountCheck {
    fn check_type_id(&self) -> &'static str { "max_split_count" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidSplitTileGroupIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let mut seen_points = std::collections::HashSet::new();
        let tiles: Vec<SplitTileNodes> = maze.field.all_points()
            .filter(|&point| seen_points.insert(point))
            .filter_map(|point| {
                let nodes = maze.field.nodes_at(point);
                if nodes.len() < 2 { None } else { Some(SplitTileNodes::new(nodes.to_vec())) }
            })
            .collect();

        let count = tiles.len() as u32;
        if count <= self.max_split_count {
            return;
        }
        let to_remove = count - self.max_split_count;

        let issue = InvalidSplitTileGroupIssue::new_from_check(&self.instance_id, vec![(tiles, to_remove)])
            .with_detail(&self.instance_id, "max_split_count", self.max_split_count.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};
    use crate::quality_control::Issue;

    const TEST_ID: &str = "max_split_count";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    fn maze_with_split_tiles(count: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> = Field::new(square_rect(count.max(1) + 1, 1), &mut ids).unwrap();
        for x in 0..count as i32 {
            field.add_node_at(SquarePoint { x, y: 0 }, &mut ids);
        }
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        Maze::new(field, g)
    }

    #[test]
    fn fires_and_flags_every_split_tile_when_count_exceeds_max() {
        let maze = maze_with_split_tiles(3);
        let check = MaxSplitCountCheck { instance_id: TEST_ID.to_string(), max_split_count: 1 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].groups.len(), 1);
        assert_eq!(issues[0].groups[0].0.len(), 3, "every split tile must be offered to the repair strategy");
        assert_eq!(issues[0].groups[0].1, 2, "to_remove must equal the excess tile count over the max");
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("max_split_count")),
            Some(&"1".to_string()),
        );
    }

    #[test]
    fn silent_when_count_at_or_below_max() {
        let maze = maze_with_split_tiles(2);
        let check = MaxSplitCountCheck { instance_id: TEST_ID.to_string(), max_split_count: 2 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "count equal to the max must not fire");
    }

    #[test]
    fn silent_when_no_split_tiles() {
        let maze = maze_with_split_tiles(0);
        let check = MaxSplitCountCheck { instance_id: TEST_ID.to_string(), max_split_count: 0 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }
}
