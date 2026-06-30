use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::issue::{Issue, MISSING_LOOPS};
use crate::quality_control::issue_data::IssueData;

pub const MIN_LOOPS_DEFAULT: u32 = 1;

pub struct MinLoopsCountCheck {
    pub instance_id: String,
    pub min_loops: u32,
}

impl<T: Tessellation> Check<T> for MinLoopsCountCheck {
    fn check_type_id(&self) -> &'static str { "min_loops_count" }

    fn check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>, _rng: &mut dyn RngCore) {
        // Uses the same independent-cycle count (Euler: E - V + C on the pure-cycle core) shown
        // to the user as the "Cycle count" analytics stat — not `find_deduped_simple_cycles`'s
        // raw simple-cycle enumeration, which is a different (usually much larger) metric and
        // would make this check disagree with what the UI displays. Silently skips (no issue) on
        // `cycle_analysis_overflowed`, same rationale as the simple-cycle checks' overflow skip.
        let analytics = maze.analysis.graph_analytics(&maze.graph, &maze.meta);
        if analytics.cycle_analysis_overflowed {
            return;
        }

        let missing = self.min_loops.saturating_sub(analytics.cycle_count as u32);
        if missing == 0 {
            return;
        }
        let issue = Issue::with_data_from_check(MISSING_LOOPS, IssueData::Missing { missing }, &self.instance_id)
            .with_detail(&self.instance_id, "missing", missing.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};

    const TEST_ID: &str = "min_loops_count";

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
    fn silent_when_loop_count_meets_minimum() {
        let maze = maze_with_triangle();
        let check = MinLoopsCountCheck { instance_id: TEST_ID.to_string(), min_loops: 1 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_with_missing_count_when_below_minimum() {
        let maze = maze_with_triangle();
        let check = MinLoopsCountCheck { instance_id: TEST_ID.to_string(), min_loops: 3 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, MISSING_LOOPS);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
        match &issues[0].data {
            Some(IssueData::Missing { missing }) => assert_eq!(*missing, 2),
            other => panic!("expected Missing, got {other:?}"),
        }
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("missing")),
            Some(&"2".to_string()),
        );
    }

    #[test]
    fn fires_when_no_loop_exists() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let check = MinLoopsCountCheck { instance_id: TEST_ID.to_string(), min_loops: 1 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert_eq!(issues.len(), 1);
        match &issues[0].data {
            Some(IssueData::Missing { missing }) => assert_eq!(*missing, 1),
            other => panic!("expected Missing, got {other:?}"),
        }
    }

    #[test]
    fn silent_when_graph_analytics_overflows() {
        // Same 6x6 fully-bidirectional grid as the cycles.rs regression test for issue #22
        // (2,444,782 simple cycles — far past MAX_SIMPLE_CYCLES, the same bound
        // `compute_graph_analytics` hits internally, setting `cycle_analysis_overflowed`).
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
        let check = MinLoopsCountCheck { instance_id: TEST_ID.to_string(), min_loops: 1 };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert!(issues.is_empty(), "overflow must skip silently, not surface a partial/incorrect issue");
    }
}
