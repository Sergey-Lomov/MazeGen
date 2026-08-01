use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::{Issue, MissingLoopsIssue};

pub const MIN_LOOPS_DEFAULT: u32 = 1;

/// Flags a deficit against a raw independent-cycle count — see GitHub issue #177 (originally
/// merged with `MinLoopDensityCheck` into one `Mode`-switched check, split back out since the two
/// measure genuinely different things: an absolute count vs. a field-coverage share).
pub struct MinLoopsCountCheck {
    pub instance_id: String,
    pub min_loops: u32,
}

impl<T: Tessellation> Check<T, MissingLoopsIssue> for MinLoopsCountCheck {
    fn check_type_id(&self) -> &'static str { "min_loops_count" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<MissingLoopsIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        // Uses `analytics.cycle_count` — the direction-valid fundamental cycle count
        // (`find_fundamental_cycles`, GitHub issue #244), shown to the user as the "Cycle count"
        // analytics stat.
        let analytics = maze.analysis.graph_analytics(&maze.graph, &maze.meta);
        let missing = self.min_loops.saturating_sub(analytics.cycle_count as u32);
        if missing == 0 {
            return;
        }
        let issue = MissingLoopsIssue::new_from_check(&self.instance_id, missing)
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
    use crate::space::{Field, SquareTessellation, square_rect};

    const TEST_ID: &str = "min_loops_count";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

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
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_with_missing_count_when_below_minimum() {
        let maze = maze_with_triangle();
        let check = MinLoopsCountCheck { instance_id: TEST_ID.to_string(), min_loops: 3 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, 2);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("missing")),
            Some(&"2".to_string()),
        );
    }

}
