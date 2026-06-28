use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::graph::region_class::RegionClass;
use crate::quality_control::check::Check;
use crate::quality_control::issue::{Issue, MISSING_REGIONS};
use crate::quality_control::issue_data::IssueData;

pub const MIN_REGION_COUNT_DEFAULT: u32 = 1;

/// Flags too few SCC regions of a configured `RegionClass` — see GitHub issue #55. Lets a user
/// enforce structural variety (e.g. guarantee at least N trap or alternative-route regions)
/// instead of only constraining individual region size/ratio). `instance_id` is the opaque
/// per-check routing/attribution key (`maze-wasm/src/runner.rs`'s composite id) — see GitHub
/// issue #60: multiple `MinRegionCountCheck` instances (different `region_class`/`min_count`
/// each) can be active independently, so this id can't be a fixed per-type constant.
pub struct MinRegionCountCheck {
    pub instance_id: String,
    pub region_class: RegionClass,
    pub min_count: u32,
}

impl<T: Tessellation> Check<T> for MinRegionCountCheck {
    fn check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>, _rng: &mut dyn RngCore) {
        let (Some(start), Some(finish)) = (maze.meta.start, maze.meta.finish) else {
            return;
        };
        let classes = maze.analysis.region_classes(&maze.graph, start, finish);
        let count = classes.values().filter(|&&class| class == self.region_class).count() as u32;
        if count >= self.min_count {
            return;
        }
        let missing = self.min_count - count;
        let issue = Issue::with_data_from_check(
            MISSING_REGIONS,
            IssueData::MissingRegions { missing_by_class: HashMap::from([(self.region_class, missing)]) },
            &self.instance_id,
        )
            .with_detail(&self.instance_id, "region_class", self.region_class.as_str().to_string())
            .with_detail(&self.instance_id, "count", self.min_count.to_string());
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

    const TEST_ID: &str = "min_region_count";

    fn rng() -> rand::rngs::SmallRng {
        rand::rngs::SmallRng::seed_from_u64(0)
    }

    /// 5 cells in a line, all one-way: 0 -> 1 -> 2 -> 3 -> 4. Each node its own SCC.
    /// start=0, finish=2: nodes 0,1,2 are Path; nodes 3,4 are reachable from start but can't
    /// reach finish (finish=2 is upstream of them) -> both Trap.
    fn maze_with_trap_tail() -> (Maze<SquareTessellation>, crate::ids::NodeId, crate::ids::NodeId) {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(5, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[3], EdgeKind::Basic);
        g.add_edge(nodes[3], nodes[4], EdgeKind::Basic);
        let start = nodes[0];
        let finish = nodes[2];
        let mut maze = Maze::new(field, g);
        maze.meta.start = Some(start);
        maze.meta.finish = Some(finish);
        (maze, start, finish)
    }

    #[test]
    fn silent_when_skipped_without_endpoints() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let maze = Maze::new(field, g);
        let check = MinRegionCountCheck { instance_id: TEST_ID.to_string(), region_class: RegionClass::Trap, min_count: 1 };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues, &mut rng());
        assert!(issues.is_empty(), "endpoints unset — classification unavailable, not this check's failure mode");
    }

    #[test]
    fn silent_when_class_count_meets_minimum() {
        let (maze, _, _) = maze_with_trap_tail();
        let check = MinRegionCountCheck { instance_id: TEST_ID.to_string(), region_class: RegionClass::Trap, min_count: 2 };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues, &mut rng());
        assert!(issues.is_empty(), "nodes 3 and 4 are both Trap regions, meeting a minimum of 2");
    }

    #[test]
    fn fires_when_class_count_is_below_minimum() {
        let (maze, _, _) = maze_with_trap_tail();
        let check = MinRegionCountCheck { instance_id: TEST_ID.to_string(), region_class: RegionClass::Trap, min_count: 3 };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues, &mut rng());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, MISSING_REGIONS);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
        match &issues[0].data {
            Some(IssueData::MissingRegions { missing_by_class }) => {
                assert_eq!(missing_by_class, &HashMap::from([(RegionClass::Trap, 1)]), "2 trap regions found, 3 required");
            }
            other => panic!("expected MissingRegions, got {other:?}"),
        }
    }

    #[test]
    fn silent_when_no_class_count_is_below_minimum_default() {
        let (maze, _, _) = maze_with_trap_tail();
        let check = MinRegionCountCheck { instance_id: TEST_ID.to_string(), region_class: RegionClass::Unreachable, min_count: 0 };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues, &mut rng());
        assert!(issues.is_empty(), "0 unreachable regions, minimum of 0 is met");
    }
}
