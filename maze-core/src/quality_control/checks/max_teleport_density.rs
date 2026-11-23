use super::teleport_count_core::distinct_teleport_representatives;
use crate::Maze;
use crate::graph::cycles::rounded_excess_over_density;
use crate::ids::EdgeId;
use crate::quality_control::check::Check;
use crate::quality_control::{
    InvalidTeleportGroupIssue, TeleportDirectionFilter, TeleportFloorKindFilter,
};
use crate::space::Tessellation;
use rand::RngCore;

pub const MAX_TELEPORT_DENSITY_DEFAULT: f64 = 30.0;
pub const MAX_TELEPORT_DENSITY_DEFAULT_DIRECTION: TeleportDirectionFilter =
    TeleportDirectionFilter::Any;
pub const MAX_TELEPORT_DENSITY_DEFAULT_FLOOR_KIND: TeleportFloorKindFilter =
    TeleportFloorKindFilter::Any;

/// Flags every teleport on the maze invalid when their density (share of field cells, per 100 —
/// see `density_per_100`) exceeds `max_density` — see GitHub issue #379. Counts distinct portals
/// (see `distinct_teleport_representatives` — a bidirectional teleport is one, not two), mirrors
/// `MaxSplitDensityCheck`'s identical rationale: a field-wide/aggregate decision, which teleports
/// to actually remove is `TeleportGroupSelectStrategy`'s job, not this check's. `to_remove`
/// computed the same way as `MaxSplitDensityCheck::to_remove_for`: `target_count` rounds
/// `max_density * field_cells / 100` to the nearest integer, `to_remove = count - target_count`.
pub struct MaxTeleportDensityCheck {
    pub instance_id: String,
    pub max_density: f64,
    pub direction: TeleportDirectionFilter,
    pub floor_kind: TeleportFloorKindFilter,
}

impl<T: Tessellation> Check<T, InvalidTeleportGroupIssue> for MaxTeleportDensityCheck {
    fn check_type_id(&self) -> &'static str {
        "max_teleport_density"
    }
    fn is_batch_edge_group(&self) -> bool {
        true
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidTeleportGroupIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let groups: Vec<(Vec<EdgeId>, u32)> = {
            let field_cells = maze.scoped_cell_count();
            if field_cells == 0 {
                return;
            }
            let representatives =
                distinct_teleport_representatives(maze, self.direction, self.floor_kind);
            let to_remove =
                Self::to_remove_for(representatives.len(), field_cells, self.max_density);
            if to_remove == 0 {
                return;
            }
            vec![(representatives, to_remove)]
        };

        let mut issue = InvalidTeleportGroupIssue::new_from_check(&self.instance_id, groups)
            .with_detail(
                &self.instance_id,
                "max_teleport_density",
                self.max_density.to_string(),
            );
        if self.direction != TeleportDirectionFilter::Any {
            issue = issue.with_detail(
                &self.instance_id,
                "teleport_direction",
                self.direction.as_str().to_string(),
            );
        }
        if self.floor_kind != TeleportFloorKindFilter::Any {
            issue = issue.with_detail(
                &self.instance_id,
                "teleport_floor_kind",
                self.floor_kind.as_str().to_string(),
            );
        }
        issues.push(issue);
    }
}

impl MaxTeleportDensityCheck {
    fn to_remove_for(count: usize, field_cells: usize, max_density: f64) -> u32 {
        rounded_excess_over_density(count, field_cells, max_density)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::quality_control::Issue;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;
    use std::sync::Arc;

    const TEST_ID: &str = "max_teleport_density";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// 10 field cells total, `count` of them carrying a teleport.
    fn maze_with_teleports(count: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(10, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        for i in 0..count as i32 {
            g.add_edge(p(i * 2), p(i * 2 + 1), EdgeKind::Teleport);
        }
        Maze::new(field, g)
    }

    #[test]
    fn fires_and_flags_every_teleport_when_density_exceeds_max() {
        // 3 teleports / 10 cells = 30% density.
        let maze = maze_with_teleports(3);
        let check = MaxTeleportDensityCheck {
            instance_id: TEST_ID.to_string(),
            max_density: 10.0,
            direction: TeleportDirectionFilter::Any,
            floor_kind: TeleportFloorKindFilter::Any,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].groups[0].0.len(), 3);
        assert_eq!(
            issues[0].groups[0].1, 2,
            "target_count=round(10*10/100)=1, to_remove=3-1=2"
        );
        assert_eq!(
            issues[0]
                .details()
                .get(TEST_ID)
                .and_then(|kv| kv.get("max_teleport_density")),
            Some(&"10".to_string()),
        );
    }

    #[test]
    fn silent_when_density_at_or_below_max() {
        let maze = maze_with_teleports(1);
        let check = MaxTeleportDensityCheck {
            instance_id: TEST_ID.to_string(),
            max_density: 10.0,
            direction: TeleportDirectionFilter::Any,
            floor_kind: TeleportFloorKindFilter::Any,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "10% density must not fire against a max of 10"
        );
    }

    #[test]
    fn silent_when_no_teleports() {
        let maze = maze_with_teleports(0);
        let check = MaxTeleportDensityCheck {
            instance_id: TEST_ID.to_string(),
            max_density: 0.0,
            direction: TeleportDirectionFilter::Any,
            floor_kind: TeleportFloorKindFilter::Any,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn a_bidirectional_teleport_pair_counts_as_one() {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(10, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Teleport);
        g.add_edge(p(1), p(0), EdgeKind::Teleport);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MaxTeleportDensityCheck {
            instance_id: TEST_ID.to_string(),
            max_density: 0.0,
            direction: TeleportDirectionFilter::Any,
            floor_kind: TeleportFloorKindFilter::Any,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].groups[0].0.len(),
            1,
            "A<->B is one logical portal, not two"
        );
    }

    /// 1000 field cells total, 300 of them carrying a teleport -- 30% density.
    fn maze_with_300_of_1000_teleports() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(1000, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        for i in 0..300 {
            g.add_edge(p(i * 2 % 1000), p((i * 2 + 1) % 1000), EdgeKind::Teleport);
        }
        Maze::new(field, g)
    }

    #[test]
    fn max_density_accepts_a_genuinely_fractional_threshold() {
        // 300/1000 = 30% density. max_density 30.1 must stay silent (density clears it); 29.9
        // must fire (density exceeds it fractionally) -- pins that the gate compares the true
        // density, not one rounded to a whole percentage first.
        let maze = maze_with_300_of_1000_teleports();
        let check = MaxTeleportDensityCheck {
            instance_id: TEST_ID.to_string(),
            max_density: 30.1,
            direction: TeleportDirectionFilter::Any,
            floor_kind: TeleportFloorKindFilter::Any,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "30% density must not exceed a fractional maximum of 30.1"
        );

        let check = MaxTeleportDensityCheck {
            instance_id: TEST_ID.to_string(),
            max_density: 29.9,
            direction: TeleportDirectionFilter::Any,
            floor_kind: TeleportFloorKindFilter::Any,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(
            issues.len(),
            1,
            "30% density must exceed a fractional maximum of 29.9"
        );
        assert_eq!(
            issues[0].groups[0].1, 1,
            "target_count=round(29.9*1000/100)=299, to_remove=300-299=1"
        );
    }

    #[test]
    fn non_any_filters_are_recorded_as_details() {
        let maze = maze_with_teleports(3);
        let check = MaxTeleportDensityCheck {
            instance_id: TEST_ID.to_string(),
            max_density: 10.0,
            direction: TeleportDirectionFilter::Unidirectional,
            floor_kind: TeleportFloorKindFilter::SameFloor,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        let details = issues[0].details().get(TEST_ID).unwrap();
        assert_eq!(
            details.get("teleport_direction"),
            Some(&"unidirectional".to_string())
        );
        assert_eq!(
            details.get("teleport_floor_kind"),
            Some(&"same_floor".to_string())
        );
    }

    #[test]
    fn any_filters_are_not_recorded_as_details() {
        let maze = maze_with_teleports(3);
        let check = MaxTeleportDensityCheck {
            instance_id: TEST_ID.to_string(),
            max_density: 10.0,
            direction: TeleportDirectionFilter::Any,
            floor_kind: TeleportFloorKindFilter::Any,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        let details = issues[0].details().get(TEST_ID).unwrap();
        assert!(details.get("teleport_direction").is_none());
        assert!(details.get("teleport_floor_kind").is_none());
    }
}
