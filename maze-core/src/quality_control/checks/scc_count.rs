use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::issue::{Issue, EXCESSIVE_SCC_COUNT};

pub const MAX_SCC_COUNT_DEFAULT: u32 = 1;

pub struct SccCountCheck {
    pub instance_id: String,
    pub max_scc_count: u32,
}

impl<T: Tessellation> Check<T> for SccCountCheck {
    fn check_type_id(&self) -> &'static str { "scc_count" }

    fn check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>, _rng: &mut dyn RngCore) {
        let scc = maze.analysis.scc(&maze.graph);
        let count = scc.components.len() as u32;
        if count <= self.max_scc_count {
            return;
        }
        let issue = Issue::new_from_check(EXCESSIVE_SCC_COUNT, &self.instance_id)
            .with_detail(&self.instance_id, "max_scc_count", self.max_scc_count.to_string())
            .with_detail(&self.instance_id, "scc_count", count.to_string());
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

    const TEST_ID: &str = "scc_count";

    fn maze_with_two_isolated_components() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        // Two disconnected directed edges -> 4 singleton-ish components (no mutual reachability).
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[3], EdgeKind::Basic);
        Maze::new(field, g)
    }

    fn maze_with_one_scc() -> Maze<SquareTessellation> {
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
    fn silent_when_scc_count_within_limit() {
        let maze = maze_with_one_scc();
        let check = SccCountCheck { instance_id: TEST_ID.to_string(), max_scc_count: 1 };
        let mut issues = Vec::new();
        let mut rng = rand::rngs::SmallRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_when_scc_count_exceeds_limit() {
        let maze = maze_with_two_isolated_components();
        let check = SccCountCheck { instance_id: TEST_ID.to_string(), max_scc_count: 1 };
        let mut issues = Vec::new();
        let mut rng = rand::rngs::SmallRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, EXCESSIVE_SCC_COUNT);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("max_scc_count")),
            Some(&"1".to_string()),
        );
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("scc_count")),
            Some(&"4".to_string()),
        );
    }

    #[test]
    fn silent_when_scc_count_equals_limit() {
        let maze = maze_with_two_isolated_components();
        let check = SccCountCheck { instance_id: TEST_ID.to_string(), max_scc_count: 4 };
        let mut issues = Vec::new();
        let mut rng = rand::rngs::SmallRng::seed_from_u64(0);
        check.check(&maze, &mut issues, &mut rng);
        assert!(issues.is_empty());
    }
}
