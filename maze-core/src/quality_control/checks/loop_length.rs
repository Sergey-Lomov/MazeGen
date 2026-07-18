use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::comparison::Comparison;
use crate::quality_control::{Issue, InvalidLoopIssue, InvalidLoopRequirement};
use super::cycle_check_core::{find_invalid_cycles, build_issue, tile_length};

pub const LOOP_LENGTH_DEFAULT: u32 = 10;
pub const LOOP_LENGTH_DEFAULT_COMPARISON: Comparison = Comparison::Lt;

/// Flags simple cycles whose tile-length compares against a configured threshold — see GitHub
/// issue #177. Merges the former `MinLoopLengthCheck`/`MaxLoopLengthCheck` (a min/max pair
/// validating the same single-cycle property, both flagging `INVALID_LOOP`) into one check type
/// parametrized by `Comparison`, per the "min/max validating one entity share an issue kind"
/// taxonomy rule (`quality_control.md`'s "Comparison operator" section) — `comparison: Lt`
/// reproduces the old `min_loop_length`'s "shorter than" behavior, `Gt` reproduces
/// `max_loop_length`'s "longer than".
pub struct LoopLengthCheck {
    pub instance_id: String,
    pub comparison: Comparison,
    pub length: u32,
}

impl<T: Tessellation> Check<T, InvalidLoopIssue> for LoopLengthCheck {
    fn check_type_id(&self) -> &'static str { "loop_length" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidLoopIssue>, _rng: &mut dyn RngCore, requirement: InvalidLoopRequirement) {
        // Silently skip on overflow (see `CycleSearchResult::TooManyCycles`) — issue #22.
        let Some((nav, cycles, flagged)) = find_invalid_cycles(maze, |nav, cycle| {
            self.comparison.compare(tile_length(nav, cycle), self.length)
        }) else { return };

        issues.push(build_issue(&nav, &cycles, flagged, &maze.graph, &self.instance_id, "threshold", self.length, requirement));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};

    const TEST_ID: &str = "loop_length";

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
    fn lt_fires_when_short_cycle_exists() {
        let maze = maze_with_triangle();
        let check = LoopLengthCheck { instance_id: TEST_ID.to_string(), comparison: Comparison::Lt, length: 10 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid.len(), 1);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("threshold")),
            Some(&"10".to_string()),
        );
    }

    #[test]
    fn lt_silent_when_cycle_not_shorter_than_threshold() {
        let maze = maze_with_triangle();
        let check = LoopLengthCheck { instance_id: TEST_ID.to_string(), comparison: Comparison::Lt, length: 3 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert!(issues.is_empty(), "triangle has 3 tile-hops, not < 3");
    }

    #[test]
    fn gt_fires_when_long_cycle_exists() {
        let maze = maze_with_triangle();
        let check = LoopLengthCheck { instance_id: TEST_ID.to_string(), comparison: Comparison::Gt, length: 2 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid.len(), 1);
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("threshold")),
            Some(&"2".to_string()),
        );
    }

    #[test]
    fn gt_silent_when_cycle_not_longer_than_threshold() {
        let maze = maze_with_triangle();
        let check = LoopLengthCheck { instance_id: TEST_ID.to_string(), comparison: Comparison::Gt, length: 3 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert!(issues.is_empty(), "triangle has 3 tile-hops, not > 3");
    }

    #[test]
    fn le_fires_when_cycle_equals_threshold() {
        let maze = maze_with_triangle();
        let check = LoopLengthCheck { instance_id: TEST_ID.to_string(), comparison: Comparison::Le, length: 3 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert_eq!(issues.len(), 1, "3 <= 3");
    }

    #[test]
    fn ge_fires_when_cycle_equals_threshold() {
        let maze = maze_with_triangle();
        let check = LoopLengthCheck { instance_id: TEST_ID.to_string(), comparison: Comparison::Ge, length: 3 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert_eq!(issues.len(), 1, "3 >= 3");
    }

    #[test]
    fn eq_fires_only_on_exact_match() {
        let maze = maze_with_triangle();
        let matching = LoopLengthCheck { instance_id: TEST_ID.to_string(), comparison: Comparison::Eq, length: 3 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        matching.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert_eq!(issues.len(), 1);

        let non_matching = LoopLengthCheck { instance_id: TEST_ID.to_string(), comparison: Comparison::Eq, length: 4 };
        let mut issues2 = Vec::new();
        non_matching.repair_check(&maze, &mut issues2, &mut rng, InvalidLoopRequirement::all());
        assert!(issues2.is_empty());
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
        let check = LoopLengthCheck { instance_id: TEST_ID.to_string(), comparison: Comparison::Lt, length: 10 };
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
        let check = LoopLengthCheck { instance_id: TEST_ID.to_string(), comparison: Comparison::Lt, length: 10 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert!(issues.is_empty());
    }

    /// Triangle A->B->C->A (3 tile-hops, invalid against threshold 10) plus a separate long loop
    /// D->E->F->G->H->I->J->K->L->D (10 tile-hops, valid) sharing no edges with the triangle — one
    /// flagged cycle, one untouched valid cycle, in the same maze. See GitHub issue #105.
    fn maze_with_one_invalid_and_one_valid_cycle() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(13, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        for i in 3..12 {
            g.add_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        g.add_edge(nodes[12], nodes[3], EdgeKind::Basic);
        Maze::new(field, g)
    }

    /// See GitHub issue #105 — `build_issue`'s base-layer branch (`VALID_CYCLES` unset) must skip
    /// resolving/attributing the valid cycle while still flagging exactly the same invalid cycle
    /// as `all()` does.
    #[test]
    fn full_resolves_every_cycle_invalid_only_resolves_only_flagged_ones() {
        let maze = maze_with_one_invalid_and_one_valid_cycle();
        let check = LoopLengthCheck { instance_id: TEST_ID.to_string(), comparison: Comparison::Lt, length: 10 };
        let mut rng = crate::random::MazeRng::seed_from_u64(0);

        let mut full_issues = Vec::new();
        check.repair_check(&maze, &mut full_issues, &mut rng, InvalidLoopRequirement::all());
        assert_eq!(full_issues.len(), 1);
        let full = &full_issues[0];
        assert_eq!(full.invalid.len(), 1, "only the triangle is invalid");
        assert_eq!(full.all.len(), 2, "all() resolves both the invalid triangle and the valid long loop");
        assert!(!full.invalid_sources.is_empty(), "all() builds invalid_sources");

        let mut invalid_only_issues = Vec::new();
        check.repair_check(&maze, &mut invalid_only_issues, &mut rng, InvalidLoopRequirement::empty());
        assert_eq!(invalid_only_issues.len(), 1);
        let invalid_only = &invalid_only_issues[0];
        assert_eq!(invalid_only.all.len(), invalid_only.invalid.len(), "InvalidOnly resolves only the flagged cycles, all == invalid in length");
        assert_eq!(invalid_only.all.len(), 1, "only the triangle was resolved, the valid loop was skipped entirely");
        assert!(invalid_only.invalid_sources.is_empty(), "InvalidOnly does not build invalid_sources");

        let full_cycle_edges: std::collections::HashSet<_> = full.all[full.invalid[0]].iter().copied().collect();
        let invalid_only_cycle_edges: std::collections::HashSet<_> = invalid_only.all[invalid_only.invalid[0]].iter().copied().collect();
        assert_eq!(full_cycle_edges, invalid_only_cycle_edges, "both variants must flag the exact same cycle");
    }
}
