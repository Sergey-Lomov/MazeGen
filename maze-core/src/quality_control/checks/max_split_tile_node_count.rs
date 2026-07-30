use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::ids::NodeId;
use crate::quality_control::check::Check;
use crate::quality_control::InvalidSplitNodeGroupIssue;

pub const MAX_SPLIT_TILE_NODE_COUNT_DEFAULT: u32 = 3;

/// Flags a split tile invalid when its node count exceeds `max` — see GitHub issue #252, part of
/// epic #246. Distinct from `SplitNodeConnectionPerNeighborCheck`/`SplitNodeConnectionPerFaceCheck`
/// (which flag excess *connections*): this one flags excess *node count* within one tile,
/// regardless of how those nodes are connected. Slot-0 counts toward the tile's node count like
/// any other node (epic #246's "slot-0 is not otherwise special" rule), even though the paired
/// repair strategy never selects it for removal. Fixed "too many" semantics only (unlike
/// `SplitNodeConnectionCountCheck`'s generic `Comparison`) — the only registered repair strategy
/// for `INVALID_SPLIT_NODE_GROUP` (`SplitNodeGroupSelectStrategy`) can only remove nodes, so a
/// "too few" comparison would have no way to ever resolve and would spin the repair fixpoint to
/// `RepairLimitReached`.
pub struct MaxSplitTileNodeCountCheck {
    pub instance_id: String,
    pub max: u32,
}

impl<T: Tessellation> Check<T, InvalidSplitNodeGroupIssue> for MaxSplitTileNodeCountCheck {
    fn check_type_id(&self) -> &'static str { "max_split_tile_node_count" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidSplitNodeGroupIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let mut seen_points = std::collections::HashSet::new();
        let mut groups: Vec<(Vec<NodeId>, u32)> = Vec::new();

        for point in maze.field.all_points() {
            if !seen_points.insert(point) {
                continue;
            }
            let nodes = maze.field.nodes_at(point);
            if nodes.len() < 2 {
                continue; // not a split point.
            }
            let node_count = nodes.len() as u32;
            if node_count <= self.max {
                continue;
            }
            let to_remove = node_count - self.max;
            let mut nodes = nodes.to_vec();
            nodes.sort_unstable();
            groups.push((nodes, to_remove));
        }

        if groups.is_empty() {
            return;
        }
        let issue = InvalidSplitNodeGroupIssue::new_from_check(&self.instance_id, groups)
            .with_detail(&self.instance_id, "max", self.max.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};

    const TEST_ID: &str = "max_split_tile_node_count";

    #[test]
    fn silent_when_no_split_points() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MaxSplitTileNodeCountCheck { instance_id: TEST_ID.to_string(), max: 2 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_when_tile_exceeds_the_limit() {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let p = SquarePoint { x: 1, y: 0 };
        let slot0 = field.node_at(p).unwrap();
        let extra1 = field.add_node_at(p, &mut ids);
        let extra2 = field.add_node_at(p, &mut ids);
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MaxSplitTileNodeCountCheck { instance_id: TEST_ID.to_string(), max: 2 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].groups.len(), 1);
        let (group, to_remove) = &issues[0].groups[0];
        let mut expected = vec![slot0, extra1, extra2];
        expected.sort_unstable();
        assert_eq!(group, &expected);
        assert_eq!(*to_remove, 1, "3 nodes against a limit of 2 leaves one excess node");
    }

    #[test]
    fn does_not_fire_when_tile_is_at_the_limit() {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let p = SquarePoint { x: 1, y: 0 };
        field.node_at(p).unwrap();
        field.add_node_at(p, &mut ids);
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MaxSplitTileNodeCountCheck { instance_id: TEST_ID.to_string(), max: 2 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }

    #[test]
    fn flags_every_exceeding_tile_in_one_call() {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> = Field::new(square_rect(5, 1), &mut ids).unwrap();
        let p1 = SquarePoint { x: 1, y: 0 };
        field.node_at(p1).unwrap();
        field.add_node_at(p1, &mut ids);
        field.add_node_at(p1, &mut ids);
        let p3 = SquarePoint { x: 3, y: 0 };
        field.node_at(p3).unwrap();
        field.add_node_at(p3, &mut ids);
        field.add_node_at(p3, &mut ids);
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MaxSplitTileNodeCountCheck { instance_id: TEST_ID.to_string(), max: 2 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1, "both flagged tiles must batch into a single issue call, not one issue each");
        assert_eq!(issues[0].groups.len(), 2);
    }
}
