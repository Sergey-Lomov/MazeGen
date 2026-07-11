use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::issue::Issue;
use super::cycle_check_core::{find_invalid_cycles, build_issue, tile_length};

pub const MIN_LOOP_LENGTH_DEFAULT: u32 = 10;

pub struct MinLoopLengthCheck {
    pub instance_id: String,
    pub min_loop_length: u32,
}

impl<T: Tessellation> Check<T> for MinLoopLengthCheck {
    fn check_type_id(&self) -> &'static str { "min_loop_length" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>, _rng: &mut dyn RngCore) {
        // Silently skip on overflow (see `CycleSearchResult::TooManyCycles`) rather than
        // hang on a dense, heavily preset-connected graph (issue #22) — this check is
        // toggleable, so a maze that can't be analyzed here just doesn't get this check,
        // same as if it were disabled.
        let Some((nav, cycles, short)) = find_invalid_cycles(maze, |nav, cycle| {
            tile_length(nav, cycle) < self.min_loop_length
        }) else { return };

        issues.push(build_issue(&nav, &cycles, short, &maze.graph, &self.instance_id, "threshold", self.min_loop_length));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};
    use crate::quality_control::issue::INVALID_LOOP;
    use crate::quality_control::issue_data::IssueData;

    const TEST_ID: &str = "min_loop_length";

    fn maze_with_triangle() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        Maze::new(field, g)
    }

    #[test]
    fn fires_when_short_cycle_exists() {
        let maze = maze_with_triangle();
        let check = MinLoopLengthCheck { instance_id: TEST_ID.to_string(), min_loop_length: 10 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, INVALID_LOOP);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
        match &issues[0].data {
            Some(IssueData::InvalidLoops { invalid, .. }) => assert_eq!(invalid.len(), 1),
            other => panic!("expected InvalidLoops, got {other:?}"),
        }
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("threshold")),
            Some(&"10".to_string()),
        );
    }

    #[test]
    fn silent_when_cycle_not_shorter_than_threshold() {
        let maze = maze_with_triangle();
        let check = MinLoopLengthCheck { instance_id: TEST_ID.to_string(), min_loop_length: 3 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng);
        assert!(issues.is_empty(), "triangle has 3 tile-hops, not < 3");
    }

    #[test]
    fn silent_when_cycle_enumeration_overflows() {
        // Same 6x6 fully-bidirectional grid as the `cycles.rs` regression test for issue #22
        // (2,444,782 simple cycles — far past MAX_SIMPLE_CYCLES). This check is toggleable, so
        // on overflow it must skip silently (no issue, no panic) rather than hang or surface a
        // spurious result — same effect as if the check were disabled for this maze.
        const SIDE: i32 = 6;
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(SIDE as usize, SIDE as usize), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        for y in 0..SIDE {
            for x in 0..SIDE {
                let here = field.node_at(SquarePoint { x, y }).unwrap();
                if x + 1 < SIDE {
                    let right = field.node_at(SquarePoint { x: x + 1, y }).unwrap();
                    g.add_bidirectional_edge(here, right, EdgeKind::Basic);
                }
                if y + 1 < SIDE {
                    let up = field.node_at(SquarePoint { x, y: y + 1 }).unwrap();
                    g.add_bidirectional_edge(here, up, EdgeKind::Basic);
                }
            }
        }
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let check = MinLoopLengthCheck { instance_id: TEST_ID.to_string(), min_loop_length: 10 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng);
        assert!(issues.is_empty(), "overflow must skip silently, not surface a partial/incorrect issue");
    }

    #[test]
    fn silent_when_no_cycle() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let check = MinLoopLengthCheck { instance_id: TEST_ID.to_string(), min_loop_length: 10 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng);
        assert!(issues.is_empty());
    }
}
