use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::issue::{Issue, REGION_NEEDS_EXPANSION};
use crate::quality_control::issue_data::IssueData;
use crate::repair::CheckId;

pub const MIN_REGION_SIZE_DEFAULT: u32 = 20;
pub const MIN_REGION_SIZE_CHECK_ID: CheckId = CheckId::MinRegionSize;

pub struct MinRegionSizeCheck {
    pub min_region_size: u32,
}

impl<T: Tessellation> Check<T> for MinRegionSizeCheck {
    fn check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>, _rng: &mut dyn RngCore) {
        let scc = maze.analysis.scc(&maze.graph);
        let invalid: Vec<usize> = scc.components.iter().enumerate()
            .filter(|(_, region)| (region.len() as u32) < self.min_region_size)
            .map(|(idx, _)| idx)
            .collect();
        if invalid.is_empty() {
            return;
        }
        let mut invalid_sources: HashMap<usize, Vec<CheckId>> = HashMap::new();
        for &idx in &invalid {
            invalid_sources.entry(idx).or_default().push(MIN_REGION_SIZE_CHECK_ID);
        }
        let issue = Issue::with_data_from_check(REGION_NEEDS_EXPANSION, IssueData::RegionsNeedingExpansion { invalid, invalid_sources }, MIN_REGION_SIZE_CHECK_ID)
            .with_detail(MIN_REGION_SIZE_CHECK_ID, "min_region_size", self.min_region_size.to_string());
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

    fn rng() -> rand::rngs::SmallRng {
        rand::rngs::SmallRng::seed_from_u64(0)
    }

    /// 4 cells, one 3-node SCC (triangle) + one singleton (no mutual reachability).
    fn maze_with_small_region() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        // nodes[3] stays isolated -> singleton SCC.
        Maze::new(field, g)
    }

    #[test]
    fn silent_when_all_regions_meet_minimum() {
        let maze = maze_with_small_region();
        let check = MinRegionSizeCheck { min_region_size: 1 };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues, &mut rng());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_when_a_region_is_smaller_than_minimum() {
        let maze = maze_with_small_region();
        let check = MinRegionSizeCheck { min_region_size: 2 };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues, &mut rng());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, REGION_NEEDS_EXPANSION);
        assert_eq!(issues[0].source_checks(), vec![CheckId::MinRegionSize]);
        match &issues[0].data {
            Some(IssueData::RegionsNeedingExpansion { invalid, .. }) => assert_eq!(invalid.len(), 1, "only the singleton region is undersized"),
            other => panic!("expected RegionsNeedingExpansion, got {other:?}"),
        }
        assert_eq!(
            issues[0].details().get(&CheckId::MinRegionSize).and_then(|kv| kv.get("min_region_size")),
            Some(&"2".to_string()),
        );
    }

    #[test]
    fn silent_when_region_size_equals_minimum() {
        let maze = maze_with_small_region();
        let check = MinRegionSizeCheck { min_region_size: 1 };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues, &mut rng());
        assert!(issues.is_empty(), "singleton region has size 1, not below a minimum of 1");
    }
}
