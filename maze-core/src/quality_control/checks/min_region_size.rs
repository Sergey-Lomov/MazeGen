use super::region_size_check_core::{build_issue, find_invalid_regions};
use crate::Maze;
use crate::graph::region_class::RegionClass;
use crate::quality_control::RegionNeedsExpansionIssue;
use crate::quality_control::check::Check;
use crate::space::Tessellation;
use rand::RngCore;

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

impl<T: Tessellation> Check<T, RegionNeedsExpansionIssue> for MinRegionSizeCheck {
    fn check_type_id(&self) -> &'static str {
        "min_region_size"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<RegionNeedsExpansionIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let min_region_size = self.min_region_size;
        let Some(invalid) = find_invalid_regions(maze, &self.region_classes, |len| {
            (len as u32) < min_region_size
        }) else {
            return;
        };
        issues.push(build_issue(
            maze,
            invalid,
            &self.instance_id,
            "min_region_size",
            self.min_region_size,
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::graph::region_class::ALL_REGION_CLASSES;
    use crate::quality_control::Issue;
    use crate::space::{MultiLevelField, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;
    use std::sync::Arc;

    const TEST_ID: &str = "min_region_size";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// 4 cells, one 3-node SCC (triangle) + one singleton (no mutual reachability).
    fn maze_with_small_region() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(4, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_points()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        // nodes[3] stays isolated -> singleton SCC.
        Maze::new(field, g)
    }

    #[test]
    fn silent_when_all_regions_meet_minimum() {
        let maze = maze_with_small_region();
        let check = MinRegionSizeCheck {
            instance_id: TEST_ID.to_string(),
            min_region_size: 1,
            region_classes: ALL_REGION_CLASSES.to_vec(),
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_when_a_region_is_smaller_than_minimum() {
        let maze = maze_with_small_region();
        let check = MinRegionSizeCheck {
            instance_id: TEST_ID.to_string(),
            min_region_size: 2,
            region_classes: ALL_REGION_CLASSES.to_vec(),
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
        assert_eq!(
            issues[0].invalid.len(),
            1,
            "only the singleton region is undersized"
        );
        assert_eq!(
            issues[0]
                .details()
                .get(TEST_ID)
                .and_then(|kv| kv.get("min_region_size")),
            Some(&"2".to_string()),
        );
    }

    #[test]
    fn silent_when_region_size_equals_minimum() {
        let maze = maze_with_small_region();
        let check = MinRegionSizeCheck {
            instance_id: TEST_ID.to_string(),
            min_region_size: 1,
            region_classes: ALL_REGION_CLASSES.to_vec(),
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "singleton region has size 1, not below a minimum of 1"
        );
    }

    #[test]
    fn silent_when_region_classes_empty() {
        let maze = maze_with_small_region();
        let check = MinRegionSizeCheck {
            instance_id: TEST_ID.to_string(),
            min_region_size: 2,
            region_classes: Vec::new(),
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "no region class is selected, so no region can match"
        );
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
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "start/finish are unset, so RegionClass can't be computed for a non-All filter"
        );
    }

    #[test]
    fn fires_only_for_regions_matching_the_selected_class() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_points()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
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
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].invalid.len(),
            1,
            "only node 2's Unreachable region should be flagged, not the Path regions 0/1"
        );
        assert_eq!(
            issues[0]
                .details()
                .get(TEST_ID)
                .and_then(|kv| kv.get("region_classes")),
            Some(&"unreachable".to_string()),
            "region_classes detail should name the actual flagged region's class, not the whole configured filter",
        );
    }

    #[test]
    fn region_classes_detail_omitted_without_endpoints() {
        let maze = maze_with_small_region();
        let check = MinRegionSizeCheck {
            instance_id: TEST_ID.to_string(),
            min_region_size: 2,
            region_classes: ALL_REGION_CLASSES.to_vec(),
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0]
                .details()
                .get(TEST_ID)
                .and_then(|kv| kv.get("region_classes")),
            None,
            "start/finish unset -> RegionClass can't be computed, so no region_classes detail is added",
        );
    }
}
