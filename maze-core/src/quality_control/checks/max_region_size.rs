use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::graph::region_class::RegionClass;
use crate::quality_control::check::Check;
use crate::quality_control::{Issue, RegionNeedsShrinkIssue};
use super::region_shrink_check_core::{find_oversized_regions, build_issue};

pub const MAX_REGION_SIZE_DEFAULT: u32 = 1_000;

/// Flags SCC regions with more tiles than a configured absolute maximum — see GitHub issue #177.
/// Symmetric counterpart to `MinRegionSizeCheck`, but flags `REGION_NEEDS_SHRINK` (a distinct
/// issue kind, not the same `REGION_NEEDS_EXPANSION`/`Comparison` pair — see `REGION_NEEDS_SHRINK`'s
/// doc comment for why min/max region size don't merge like `LoopLengthCheck`'s min/max did).
///
/// `region_classes`: same filter semantics as `MinRegionSizeCheck` — see GitHub issue #54.
pub struct MaxRegionSizeCheck {
    pub instance_id: String,
    pub max_region_size: u32,
    pub region_classes: Vec<RegionClass>,
}

impl<T: Tessellation> Check<T, RegionNeedsShrinkIssue> for MaxRegionSizeCheck {
    fn check_type_id(&self) -> &'static str { "max_region_size" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<RegionNeedsShrinkIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let max_region_size = self.max_region_size;
        let Some(invalid) = find_oversized_regions(maze, &self.region_classes, |len| (len as u32) > max_region_size) else {
            return;
        };
        issues.push(build_issue(maze, invalid, &self.instance_id, "max_region_size", self.max_region_size));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::graph::EdgeKind;
    use crate::graph::region_class::ALL_REGION_CLASSES;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, square_rect};

    const TEST_ID: &str = "max_region_size";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// 4 cells, one 3-node SCC (triangle) + one singleton.
    fn maze_with_large_region() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        Maze::new(field, g)
    }

    #[test]
    fn silent_when_all_regions_meet_maximum() {
        let maze = maze_with_large_region();
        let check = MaxRegionSizeCheck { instance_id: TEST_ID.to_string(), max_region_size: 3, region_classes: ALL_REGION_CLASSES.to_vec() };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_when_a_region_is_larger_than_maximum() {
        let maze = maze_with_large_region();
        let check = MaxRegionSizeCheck { instance_id: TEST_ID.to_string(), max_region_size: 2, region_classes: ALL_REGION_CLASSES.to_vec() };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
        assert_eq!(issues[0].invalid.len(), 1, "only the triangle region is oversized");
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("max_region_size")),
            Some(&"2".to_string()),
        );
    }

    #[test]
    fn silent_when_region_size_equals_maximum() {
        let maze = maze_with_large_region();
        let check = MaxRegionSizeCheck { instance_id: TEST_ID.to_string(), max_region_size: 3, region_classes: ALL_REGION_CLASSES.to_vec() };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "triangle region has size 3, not above a maximum of 3");
    }

    #[test]
    fn silent_when_region_classes_empty() {
        let maze = maze_with_large_region();
        let check = MaxRegionSizeCheck { instance_id: TEST_ID.to_string(), max_region_size: 2, region_classes: Vec::new() };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "no region class is selected, so no region can match");
    }
}
