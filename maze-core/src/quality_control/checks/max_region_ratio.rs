use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::graph::region_class::RegionClass;
use crate::quality_control::check::Check;
use crate::quality_control::{Issue, RegionNeedsShrinkIssue};
use super::region_shrink_check_core::{find_oversized_regions, build_issue};

pub const MAX_REGION_RATIO_DEFAULT: u32 = 75;

/// Counterpart to `MaxRegionSizeCheck` using a relative threshold instead of an absolute tile
/// count — see GitHub issue #177, mirrors `MinRegionRatioCheck`'s relationship to
/// `MinRegionSizeCheck`.
///
/// `region_classes`: same filter semantics as `MinRegionSizeCheck` — see GitHub issue #54.
pub struct MaxRegionRatioCheck {
    pub instance_id: String,
    pub max_region_ratio: u32,
    pub region_classes: Vec<RegionClass>,
}

impl<T: Tessellation> Check<T, RegionNeedsShrinkIssue> for MaxRegionRatioCheck {
    fn check_type_id(&self) -> &'static str { "max_region_ratio" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<RegionNeedsShrinkIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let field_cells = maze.field.node_count();
        if field_cells == 0 {
            return;
        }
        let max_region_ratio = self.max_region_ratio;
        let Some(invalid) = find_oversized_regions(maze, &self.region_classes, |len| {
            len as u64 * 100 > max_region_ratio as u64 * field_cells as u64
        }) else {
            return;
        };
        issues.push(build_issue(maze, invalid, &self.instance_id, "max_region_ratio", self.max_region_ratio));
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

    const TEST_ID: &str = "max_region_ratio";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// 10 cells: a 3-node SCC (30%) + 7 singleton SCCs (10% each).
    fn maze_with_large_region() -> Maze<SquareTessellation> {
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
    fn silent_when_all_regions_meet_maximum_ratio() {
        let maze = maze_with_large_region();
        let check = MaxRegionRatioCheck { instance_id: TEST_ID.to_string(), max_region_ratio: 30, region_classes: ALL_REGION_CLASSES.to_vec() };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "every region is at most 30% of the field");
    }

    #[test]
    fn fires_when_a_region_is_above_maximum_ratio() {
        let maze = maze_with_large_region();
        let check = MaxRegionRatioCheck { instance_id: TEST_ID.to_string(), max_region_ratio: 20, region_classes: ALL_REGION_CLASSES.to_vec() };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
        assert_eq!(issues[0].invalid.len(), 1, "the 30%-of-field triangle region exceeds a 20% maximum");
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("max_region_ratio")),
            Some(&"20".to_string()),
        );
    }

    #[test]
    fn silent_when_region_ratio_equals_maximum() {
        let maze = maze_with_large_region();
        let check = MaxRegionRatioCheck { instance_id: TEST_ID.to_string(), max_region_ratio: 30, region_classes: ALL_REGION_CLASSES.to_vec() };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "the triangle region is exactly 30% of the field, not above a maximum of 30");
    }

    #[test]
    fn silent_when_region_classes_empty() {
        let maze = maze_with_large_region();
        let check = MaxRegionRatioCheck { instance_id: TEST_ID.to_string(), max_region_ratio: 20, region_classes: Vec::new() };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "no region class is selected, so no region can match");
    }
}
