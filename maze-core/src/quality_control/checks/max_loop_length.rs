use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::{Issue, InvalidLoopIssue, InvalidLoopRequirement};
use super::cycle_check_core::{find_invalid_cycles, build_issue, tile_length};

pub const MAX_LOOP_LENGTH_DEFAULT: u32 = 100;

pub struct MaxLoopLengthCheck {
    pub instance_id: String,
    pub max_loop_length: u32,
}

impl<T: Tessellation> Check<T, InvalidLoopIssue> for MaxLoopLengthCheck {
    fn check_type_id(&self) -> &'static str { "max_loop_length" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidLoopIssue>, _rng: &mut dyn RngCore, requirement: InvalidLoopRequirement) {
        // Silently skip on overflow, same rationale as MinLoopLengthCheck (issue #22).
        let Some((nav, cycles, long)) = find_invalid_cycles(maze, |nav, cycle| {
            tile_length(nav, cycle) > self.max_loop_length
        }) else { return };

        issues.push(build_issue(&nav, &cycles, long, &maze.graph, &self.instance_id, "threshold", self.max_loop_length, requirement));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};

    const TEST_ID: &str = "max_loop_length";

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
    fn fires_when_long_cycle_exists() {
        let maze = maze_with_triangle();
        let check = MaxLoopLengthCheck { instance_id: TEST_ID.to_string(), max_loop_length: 2 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid.len(), 1);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("threshold")),
            Some(&"2".to_string()),
        );
    }

    #[test]
    fn silent_when_cycle_not_longer_than_threshold() {
        let maze = maze_with_triangle();
        let check = MaxLoopLengthCheck { instance_id: TEST_ID.to_string(), max_loop_length: 3 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert!(issues.is_empty(), "triangle has 3 tile-hops, not > 3");
    }

    #[test]
    fn silent_when_cycle_enumeration_overflows() {
        // Same 6x6 fully-bidirectional grid as the cycles.rs regression test for issue #22
        // (2,444,782 simple cycles — far past MAX_SIMPLE_CYCLES).
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
        let check = MaxLoopLengthCheck { instance_id: TEST_ID.to_string(), max_loop_length: 10 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
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
        let check = MaxLoopLengthCheck { instance_id: TEST_ID.to_string(), max_loop_length: 10 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert!(issues.is_empty());
    }

    /// Triangle A->B->C->A (3 tile-hops, valid against threshold 9) plus a separate long loop
    /// D->E->F->G->H->I->J->K->L->M->D (10 tile-hops, invalid: > 9) sharing no edges with the
    /// triangle — one flagged cycle, one untouched valid cycle, in the same maze. Mirrors
    /// `min_loop_length.rs`'s `full_resolves_every_cycle_invalid_only_resolves_only_flagged_ones`
    /// — see GitHub issue #105.
    fn maze_with_one_valid_and_one_invalid_cycle() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(13, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        // Triangle: nodes[0..3], 3 tile-hops -- valid against max_loop_length=9.
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        // Separate long loop: nodes[3..13], 10 tile-hops -- invalid (> 9).
        for i in 3..12 {
            g.add_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        g.add_edge(nodes[12], nodes[3], EdgeKind::Basic);
        Maze::new(field, g)
    }

    /// See GitHub issue #105 — `build_issue`'s base-layer branch (`VALID_CYCLES` unset) must skip
    /// resolving/attributing the valid cycle while still flagging exactly the same invalid cycle
    /// as `all()` does. Same shape as `min_loop_length.rs`'s equivalent test, confirming the
    /// `requirement` branching in the shared `cycle_check_core::build_issue` also holds for the
    /// max-length check, not just the min-length one.
    #[test]
    fn full_resolves_every_cycle_invalid_only_resolves_only_flagged_ones() {
        let maze = maze_with_one_valid_and_one_invalid_cycle();
        let check = MaxLoopLengthCheck { instance_id: TEST_ID.to_string(), max_loop_length: 9 };
        let mut rng = crate::random::MazeRng::seed_from_u64(0);

        let mut full_issues = Vec::new();
        check.repair_check(&maze, &mut full_issues, &mut rng, InvalidLoopRequirement::all());
        assert_eq!(full_issues.len(), 1);
        let full = &full_issues[0];
        assert_eq!(full.invalid.len(), 1, "only the long loop is invalid");
        assert_eq!(full.all.len(), 2, "all() resolves both the invalid long loop and the valid triangle");
        assert!(!full.invalid_sources.is_empty(), "all() builds invalid_sources");

        let mut invalid_only_issues = Vec::new();
        check.repair_check(&maze, &mut invalid_only_issues, &mut rng, InvalidLoopRequirement::empty());
        assert_eq!(invalid_only_issues.len(), 1);
        let invalid_only = &invalid_only_issues[0];
        assert_eq!(invalid_only.all.len(), invalid_only.invalid.len(), "empty() resolves only the flagged cycles, all == invalid in length");
        assert_eq!(invalid_only.all.len(), 1, "only the long loop was resolved, the triangle was skipped entirely");
        assert!(invalid_only.invalid_sources.is_empty(), "empty() does not build invalid_sources");

        // The one cycle each variant does resolve must be the same edge set (the long loop) --
        // the optimization changes how much is computed, never which cycle is found invalid.
        let full_cycle_edges: std::collections::HashSet<_> = full.all[full.invalid[0]].iter().copied().collect();
        let invalid_only_cycle_edges: std::collections::HashSet<_> = invalid_only.all[invalid_only.invalid[0]].iter().copied().collect();
        assert_eq!(full_cycle_edges, invalid_only_cycle_edges, "both variants must flag the exact same cycle");
    }
}
