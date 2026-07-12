use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::{InvalidLoopIssue, InvalidLoopRequirement};
use super::cycle_check_core::{find_invalid_cycles, build_repair_issue, build_report_issues, tile_length};

pub const MIN_LOOP_LENGTH_DEFAULT: u32 = 10;

pub struct MinLoopLengthCheck {
    pub instance_id: String,
    pub min_loop_length: u32,
}

impl<T: Tessellation> Check<T, InvalidLoopIssue> for MinLoopLengthCheck {
    fn check_type_id(&self) -> &'static str { "min_loop_length" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidLoopIssue>, _rng: &mut dyn RngCore, requirement: InvalidLoopRequirement) {
        // Silently skip on overflow (see `CycleSearchResult::TooManyCycles`) rather than
        // hang on a dense, heavily preset-connected graph (issue #22) — this check is
        // toggleable, so a maze that can't be analyzed here just doesn't get this check,
        // same as if it were disabled.
        let Some((nav, cycles, short, valid)) = find_invalid_cycles(maze, |nav, cycle| {
            tile_length(nav, cycle) < self.min_loop_length
        }) else { return };

        issues.push(build_repair_issue(&nav, &cycles, &maze.graph, &short, &valid, &self.instance_id, "threshold", self.min_loop_length, requirement));
    }

    fn report_check(&self, maze: &Maze<T>, _rng: &mut dyn RngCore) -> Vec<InvalidLoopIssue> {
        let Some((nav, cycles, short, _valid)) = find_invalid_cycles(maze, |nav, cycle| {
            tile_length(nav, cycle) < self.min_loop_length
        }) else { return Vec::new() };

        build_report_issues(&nav, &cycles, &maze.graph, &short, &self.instance_id, "threshold", self.min_loop_length)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::Issue;
    use rand::SeedableRng;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};

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
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].cycle.len(), 3, "the triangle is 3 edges");
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
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
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
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
        let check = MinLoopLengthCheck { instance_id: TEST_ID.to_string(), min_loop_length: 10 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, InvalidLoopRequirement::all());
        assert!(issues.is_empty());
    }

    /// Triangle A->B->C->A (3 tile-hops, invalid against threshold 10) plus a separate long loop
    /// D->E->F->G->H->I->J->K->L->D (10 tile-hops, valid) sharing no edges with the triangle — one
    /// flagged cycle, one untouched valid cycle, in the same maze. See GitHub issue #105/#98.
    fn maze_with_one_invalid_and_one_valid_cycle() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(13, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        // Triangle: nodes[0..3], 3 tile-hops -- invalid against min_loop_length=10.
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        // Separate long loop: nodes[3..13], 10 tile-hops -- valid (not < 10).
        for i in 3..12 {
            g.add_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        g.add_edge(nodes[12], nodes[3], EdgeKind::Basic);
        Maze::new(field, g)
    }

    /// See GitHub issue #105 — `build_repair_issue`'s `OTHER_VALID`-unset branch must skip
    /// resolving/attributing the valid cycle while still flagging exactly the same invalid cycle
    /// as `all()` does.
    #[test]
    fn full_resolves_other_valid_empty_resolves_none() {
        let maze = maze_with_one_invalid_and_one_valid_cycle();
        let check = MinLoopLengthCheck { instance_id: TEST_ID.to_string(), min_loop_length: 10 };
        let mut rng = crate::random::MazeRng::seed_from_u64(0);

        let mut full_issues = Vec::new();
        check.repair_check(&maze, &mut full_issues, &mut rng, InvalidLoopRequirement::all());
        assert_eq!(full_issues.len(), 1);
        let full = &full_issues[0];
        assert_eq!(full.other_valid.len(), 1, "all() resolves the valid long loop's index too");

        let mut invalid_only_issues = Vec::new();
        check.repair_check(&maze, &mut invalid_only_issues, &mut rng, InvalidLoopRequirement::empty());
        assert_eq!(invalid_only_issues.len(), 1);
        let invalid_only = &invalid_only_issues[0];
        assert!(invalid_only.other_valid.is_empty(), "empty() must not resolve the valid cycle's index");

        // The main cycle each variant flags must be the same edge set (the triangle) -- the
        // requirement only changes how much auxiliary data is computed, never which cycle is
        // flagged as the issue's own `cycle`.
        assert_eq!(full.cycle, invalid_only.cycle, "both variants must flag the exact same cycle");
    }

    #[test]
    fn report_check_produces_one_issue_per_invalid_cycle() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(9, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        // Two disjoint short triangles -- both invalid against min_loop_length=10.
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        g.add_edge(nodes[3], nodes[4], EdgeKind::Basic);
        g.add_edge(nodes[4], nodes[5], EdgeKind::Basic);
        g.add_edge(nodes[5], nodes[3], EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let check = MinLoopLengthCheck { instance_id: TEST_ID.to_string(), min_loop_length: 10 };
        let mut rng = crate::random::MazeRng::seed_from_u64(0);

        let report = check.report_check(&maze, &mut rng);
        assert_eq!(report.len(), 2, "report_check must produce one issue per invalid cycle, not one merged issue");
        for issue in &report {
            assert!(issue.other_invalid.is_empty(), "report-path issues never carry other_invalid");
            assert!(issue.other_valid.is_empty(), "report-path issues never carry other_valid");
        }

        // repair_check (batch path) instead folds both into one issue.
        let mut repair_issues = Vec::new();
        check.repair_check(&maze, &mut repair_issues, &mut rng, InvalidLoopRequirement::all());
        assert_eq!(repair_issues.len(), 1, "repair_check must still produce one issue per rule dispatch");
    }
}
