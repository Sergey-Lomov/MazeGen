use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::graph::region_class::{RegionClass, ALL_REGION_CLASSES};
use crate::quality_control::check::Check;
use crate::quality_control::issue::{Issue, REGION_NEEDS_EXPANSION};
use crate::quality_control::issue_data::IssueData;

pub const MIN_REGION_SIZE_DEFAULT: u32 = 20;

/// `region_classes`: SCC regions whose `RegionClass` (see `graph::region_class`) is not in this
/// list are ignored entirely — never flagged, never assigned for expansion repair. Empty means no
/// region matches (the check is always silent); all four classes means every region is checked,
/// same as before this filter existed — see GitHub issue #54.
pub struct MinRegionSizeCheck {
    pub instance_id: String,
    pub min_region_size: u32,
    pub region_classes: Vec<RegionClass>,
}

impl<T: Tessellation> Check<T> for MinRegionSizeCheck {
    fn check_type_id(&self) -> &'static str { "min_region_size" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>, _rng: &mut dyn RngCore) {
        if self.region_classes.is_empty() {
            return;
        }
        let scc = maze.analysis.scc(&maze.graph);
        let classes = if self.region_classes.len() == ALL_REGION_CLASSES.len() {
            None
        } else {
            if maze.meta.start.is_none() || maze.meta.finish.is_none() {
                return;
            }
            Some(maze.analysis.region_classes(&maze.graph, &maze.meta))
        };
        let invalid: Vec<usize> = scc.components.iter().enumerate()
            .filter(|(idx, region)| {
                (region.len() as u32) < self.min_region_size
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

        // `region_classes` detail: the actual `RegionClass`es among the flagged regions (not the
        // full configured filter — a filter covering several classes may still have only one of
        // them actually undersized this pass), so the UI can name which region class is short
        // instead of a generic "region(s) below N tiles". Needs `classes` computed even when the
        // filter is "all classes" (where the fast `None` path above skips it) — falls back to no
        // detail (generic label) if start/finish aren't set yet, same as the `None`-filter case
        // above already tolerates for detection itself.
        if let Some(classes) = classes.or_else(|| {
            (maze.meta.start.is_some() && maze.meta.finish.is_some())
                .then(|| maze.analysis.region_classes(&maze.graph, &maze.meta))
        }) {
            let mut detail_classes: Vec<&'static str> = invalid.iter()
                .filter_map(|idx| classes.get(idx))
                .map(|c| c.as_str())
                .collect();
            detail_classes.sort_unstable();
            detail_classes.dedup();
            let issue = Issue::with_data_from_check(REGION_NEEDS_EXPANSION, IssueData::RegionsNeedingExpansion { invalid, invalid_sources }, &self.instance_id)
                .with_detail(&self.instance_id, "min_region_size", self.min_region_size.to_string())
                .with_detail(&self.instance_id, "region_classes", detail_classes.join(","));
            issues.push(issue);
        } else {
            let issue = Issue::with_data_from_check(REGION_NEEDS_EXPANSION, IssueData::RegionsNeedingExpansion { invalid, invalid_sources }, &self.instance_id)
                .with_detail(&self.instance_id, "min_region_size", self.min_region_size.to_string());
            issues.push(issue);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::graph::EdgeKind;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, square_rect};

    const TEST_ID: &str = "min_region_size";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
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
        let check = MinRegionSizeCheck { instance_id: TEST_ID.to_string(), min_region_size: 1, region_classes: ALL_REGION_CLASSES.to_vec() };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_when_a_region_is_smaller_than_minimum() {
        let maze = maze_with_small_region();
        let check = MinRegionSizeCheck { instance_id: TEST_ID.to_string(), min_region_size: 2, region_classes: ALL_REGION_CLASSES.to_vec() };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, REGION_NEEDS_EXPANSION);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
        match &issues[0].data {
            Some(IssueData::RegionsNeedingExpansion { invalid, .. }) => assert_eq!(invalid.len(), 1, "only the singleton region is undersized"),
            other => panic!("expected RegionsNeedingExpansion, got {other:?}"),
        }
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("min_region_size")),
            Some(&"2".to_string()),
        );
    }

    #[test]
    fn silent_when_region_size_equals_minimum() {
        let maze = maze_with_small_region();
        let check = MinRegionSizeCheck { instance_id: TEST_ID.to_string(), min_region_size: 1, region_classes: ALL_REGION_CLASSES.to_vec() };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng());
        assert!(issues.is_empty(), "singleton region has size 1, not below a minimum of 1");
    }

    #[test]
    fn silent_when_region_classes_empty() {
        let maze = maze_with_small_region();
        let check = MinRegionSizeCheck { instance_id: TEST_ID.to_string(), min_region_size: 2, region_classes: Vec::new() };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng());
        assert!(issues.is_empty(), "no region class is selected, so no region can match");
    }

    #[test]
    fn silent_when_filtered_to_specific_class_without_endpoints() {
        let maze = maze_with_small_region();
        let check = MinRegionSizeCheck {
            instance_id: TEST_ID.to_string(),
            min_region_size: 2,
            region_classes: vec![crate::graph::region_class::RegionClass::Trap],
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng());
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
        // node 2 has no edges at all -> unreachable from start.
        let check = MinRegionSizeCheck {
            instance_id: TEST_ID.to_string(),
            min_region_size: 2,
            region_classes: vec![crate::graph::region_class::RegionClass::Unreachable],
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng());
        assert_eq!(issues.len(), 1);
        match &issues[0].data {
            Some(IssueData::RegionsNeedingExpansion { invalid, .. }) => assert_eq!(invalid.len(), 1, "only node 2's Unreachable region should be flagged, not the Path regions 0/1"),
            other => panic!("expected RegionsNeedingExpansion, got {other:?}"),
        }
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("region_classes")),
            Some(&"unreachable".to_string()),
            "region_classes detail should name the actual flagged region's class, not the whole configured filter",
        );
    }

    #[test]
    fn region_classes_detail_omitted_without_endpoints() {
        let maze = maze_with_small_region();
        let check = MinRegionSizeCheck { instance_id: TEST_ID.to_string(), min_region_size: 2, region_classes: ALL_REGION_CLASSES.to_vec() };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("region_classes")),
            None,
            "start/finish unset -> RegionClass can't be computed, so no region_classes detail is added",
        );
    }
}
