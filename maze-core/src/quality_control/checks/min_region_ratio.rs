use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::graph::region_class::{RegionClass, ALL_REGION_CLASSES};
use crate::quality_control::check::Check;
use crate::quality_control::issue::{Issue, REGION_NEEDS_EXPANSION};
use crate::quality_control::issue_data::IssueData;

pub const MIN_REGION_RATIO_DEFAULT: u32 = 25;

/// Flags SCC regions smaller than a configured share of the field — see GitHub issue #50.
/// Counterpart to `MinRegionSizeCheck` using a relative threshold (a percentage of
/// `maze.field.node_count()`) instead of an absolute tile count.
///
/// `region_classes`: SCC regions whose `RegionClass` (see `graph::region_class`) is not in this
/// list are ignored entirely — never flagged, never assigned for expansion repair. Empty means no
/// region matches (the check is always silent); all four classes means every region is checked,
/// same as before this filter existed — see GitHub issue #54.
pub struct MinRegionRatioCheck {
    pub instance_id: String,
    pub min_region_ratio: u32,
    pub region_classes: Vec<RegionClass>,
}

impl<T: Tessellation> Check<T> for MinRegionRatioCheck {
    fn check_type_id(&self) -> &'static str { "min_region_ratio" }

    fn check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>, _rng: &mut dyn RngCore) {
        if self.region_classes.is_empty() {
            return;
        }
        let field_cells = maze.field.node_count();
        if field_cells == 0 {
            return;
        }
        let scc = maze.analysis.scc(&maze.graph);
        let classes = if self.region_classes.len() == ALL_REGION_CLASSES.len() {
            None
        } else {
            let (Some(start), Some(finish)) = (maze.meta.start, maze.meta.finish) else {
                return;
            };
            Some(maze.analysis.region_classes(&maze.graph, start, finish))
        };
        let invalid: Vec<usize> = scc.components.iter().enumerate()
            .filter(|(idx, region)| {
                region.len() as u64 * 100 < self.min_region_ratio as u64 * field_cells as u64
                    && classes.as_ref().is_none_or(|c| c.get(idx).is_some_and(|class| self.region_classes.contains(class)))
            })
            .map(|(idx, _)| idx)
            .collect();
        if invalid.is_empty() {
            return;
        }
        let mut invalid_sources: HashMap<usize, Vec<String>> = HashMap::new();
        for &idx in &invalid {
            invalid_sources.entry(idx).or_default().push(self.instance_id.clone());
        }
        let issue = Issue::with_data_from_check(REGION_NEEDS_EXPANSION, IssueData::RegionsNeedingExpansion { invalid, invalid_sources }, &self.instance_id)
            .with_detail(&self.instance_id, "min_region_ratio", self.min_region_ratio.to_string());
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

    const TEST_ID: &str = "min_region_ratio";

    fn rng() -> rand::rngs::SmallRng {
        rand::rngs::SmallRng::seed_from_u64(0)
    }

    /// 10 cells: a 3-node SCC (30%) + 7 singleton SCCs (10% each).
    fn maze_with_small_region() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(10, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        Maze::new(field, g)
    }

    #[test]
    fn silent_when_all_regions_meet_minimum_ratio() {
        let maze = maze_with_small_region();
        let check = MinRegionRatioCheck { instance_id: TEST_ID.to_string(), min_region_ratio: 10, region_classes: ALL_REGION_CLASSES.to_vec() };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues, &mut rng());
        assert!(issues.is_empty(), "every region is at least 10% of the field");
    }

    #[test]
    fn fires_when_a_region_is_below_minimum_ratio() {
        let maze = maze_with_small_region();
        let check = MinRegionRatioCheck { instance_id: TEST_ID.to_string(), min_region_ratio: 20, region_classes: ALL_REGION_CLASSES.to_vec() };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues, &mut rng());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, REGION_NEEDS_EXPANSION);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
        match &issues[0].data {
            Some(IssueData::RegionsNeedingExpansion { invalid, .. }) => assert_eq!(invalid.len(), 7, "the seven 10%-of-field singleton regions are below a 20% minimum"),
            other => panic!("expected RegionsNeedingExpansion, got {other:?}"),
        }
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("min_region_ratio")),
            Some(&"20".to_string()),
        );
    }

    /// 2 cells, one bidirectional pair forming a single 2-node SCC -> 100% density, no singletons.
    fn maze_with_one_region() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[0], EdgeKind::Basic);
        Maze::new(field, g)
    }

    #[test]
    fn silent_when_region_ratio_equals_minimum() {
        let maze = maze_with_one_region();
        let check = MinRegionRatioCheck { instance_id: TEST_ID.to_string(), min_region_ratio: 100, region_classes: ALL_REGION_CLASSES.to_vec() };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues, &mut rng());
        assert!(issues.is_empty(), "the single region is exactly 100% of the field, not below a minimum of 100");
    }

    #[test]
    fn silent_when_region_classes_empty() {
        let maze = maze_with_small_region();
        let check = MinRegionRatioCheck { instance_id: TEST_ID.to_string(), min_region_ratio: 20, region_classes: Vec::new() };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues, &mut rng());
        assert!(issues.is_empty(), "no region class is selected, so no region can match");
    }

    #[test]
    fn silent_when_filtered_to_specific_class_without_endpoints() {
        let maze = maze_with_small_region();
        let check = MinRegionRatioCheck {
            instance_id: TEST_ID.to_string(),
            min_region_ratio: 20,
            region_classes: vec![crate::graph::region_class::RegionClass::Trap],
        };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues, &mut rng());
        assert!(issues.is_empty(), "start/finish are unset, so RegionClass can't be computed for a non-All filter");
    }

    #[test]
    fn fires_only_for_regions_matching_the_selected_class() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let mut maze = Maze::new(field, g);
        maze.meta.start = Some(nodes[0]);
        maze.meta.finish = Some(nodes[1]);
        let check = MinRegionRatioCheck {
            instance_id: TEST_ID.to_string(),
            min_region_ratio: 50,
            region_classes: vec![crate::graph::region_class::RegionClass::Unreachable],
        };
        let mut issues = Vec::new();
        check.check(&maze, &mut issues, &mut rng());
        assert_eq!(issues.len(), 1);
        match &issues[0].data {
            Some(IssueData::RegionsNeedingExpansion { invalid, .. }) => assert_eq!(invalid.len(), 1, "only node 2's Unreachable region should be flagged, not the Path regions 0/1"),
            other => panic!("expected RegionsNeedingExpansion, got {other:?}"),
        }
    }
}
