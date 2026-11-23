use super::teleport_count_core::distinct_teleport_representatives;
use crate::Maze;
use crate::ids::EdgeId;
use crate::quality_control::check::Check;
use crate::quality_control::{
    InvalidTeleportGroupIssue, TeleportDirectionFilter, TeleportFloorKindFilter,
};
use crate::space::Tessellation;
use rand::RngCore;

pub const MAX_TELEPORT_COUNT_DEFAULT: u32 = 20;
pub const MAX_TELEPORT_COUNT_DEFAULT_DIRECTION: TeleportDirectionFilter =
    TeleportDirectionFilter::Any;
pub const MAX_TELEPORT_COUNT_DEFAULT_FLOOR_KIND: TeleportFloorKindFilter =
    TeleportFloorKindFilter::Any;

/// Flags every teleport on the maze invalid when their distinct count (see
/// `distinct_teleport_representatives` — a bidirectional teleport is one logical portal, not two)
/// exceeds `max_teleports` — see GitHub issue #379. Mirrors `MaxElevatorCountCheck`'s/
/// `MaxSplitDensityCheck`'s identical rationale: a field-wide/aggregate decision, which teleports
/// to actually remove is `TeleportGroupSelectStrategy`'s job, not this check's. One group of
/// representative edge ids (one per distinct portal), `to_remove` equal to the excess portal count
/// over the maximum.
pub struct MaxTeleportCountCheck {
    pub instance_id: String,
    pub max_teleports: u32,
    pub direction: TeleportDirectionFilter,
    pub floor_kind: TeleportFloorKindFilter,
}

impl<T: Tessellation> Check<T, InvalidTeleportGroupIssue> for MaxTeleportCountCheck {
    fn check_type_id(&self) -> &'static str {
        "max_teleport_count"
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
            let representatives =
                distinct_teleport_representatives(maze, self.direction, self.floor_kind);
            let count = representatives.len() as u32;
            if count <= self.max_teleports {
                return;
            }
            vec![(representatives, count - self.max_teleports)]
        };

        let mut issue = InvalidTeleportGroupIssue::new_from_check(&self.instance_id, groups)
            .with_detail(
                &self.instance_id,
                "max_teleport_count",
                self.max_teleports.to_string(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::quality_control::Issue;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;
    use std::sync::Arc;

    const TEST_ID: &str = "max_teleport_count";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    fn maze_with_teleports(count: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(
            Arc::default(),
            square_rect(count.max(1) * 2, 1),
            &mut ids,
        )
        .unwrap();
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
    fn fires_and_flags_every_teleport_when_count_exceeds_max() {
        let maze = maze_with_teleports(3);
        let check = MaxTeleportCountCheck {
            instance_id: TEST_ID.to_string(),
            max_teleports: 1,
            direction: TeleportDirectionFilter::Any,
            floor_kind: TeleportFloorKindFilter::Any,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].groups.len(), 1);
        assert_eq!(
            issues[0].groups[0].0.len(),
            3,
            "every distinct teleport must be offered to the repair strategy"
        );
        assert_eq!(
            issues[0].groups[0].1, 2,
            "to_remove must equal the excess teleport count over the max"
        );
        assert_eq!(
            issues[0]
                .details()
                .get(TEST_ID)
                .and_then(|kv| kv.get("max_teleport_count")),
            Some(&"1".to_string()),
        );
    }

    #[test]
    fn silent_when_count_at_or_below_max() {
        let maze = maze_with_teleports(2);
        let check = MaxTeleportCountCheck {
            instance_id: TEST_ID.to_string(),
            max_teleports: 2,
            direction: TeleportDirectionFilter::Any,
            floor_kind: TeleportFloorKindFilter::Any,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "count equal to the max must not fire");
    }

    #[test]
    fn silent_when_no_teleports() {
        let maze = maze_with_teleports(0);
        let check = MaxTeleportCountCheck {
            instance_id: TEST_ID.to_string(),
            max_teleports: 0,
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
            MultiLevelField::single_level(Arc::default(), square_rect(2, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Teleport);
        g.add_edge(p(1), p(0), EdgeKind::Teleport);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MaxTeleportCountCheck {
            instance_id: TEST_ID.to_string(),
            max_teleports: 0,
            direction: TeleportDirectionFilter::Any,
            floor_kind: TeleportFloorKindFilter::Any,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].groups[0].1, 1,
            "A<->B is one logical portal, not two"
        );
    }

    #[test]
    fn direction_filter_counts_only_matching_portals() {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(4, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Teleport);
        g.add_edge(p(1), p(0), EdgeKind::Teleport);
        g.add_edge(p(2), p(3), EdgeKind::Teleport);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MaxTeleportCountCheck {
            instance_id: TEST_ID.to_string(),
            max_teleports: 0,
            direction: TeleportDirectionFilter::Bidirectional,
            floor_kind: TeleportFloorKindFilter::Any,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].groups[0].0.len(),
            1,
            "only the bidirectional portal must be counted"
        );
    }

    #[test]
    fn non_any_filters_are_recorded_as_details() {
        let maze = maze_with_teleports(3);
        let check = MaxTeleportCountCheck {
            instance_id: TEST_ID.to_string(),
            max_teleports: 1,
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
        let check = MaxTeleportCountCheck {
            instance_id: TEST_ID.to_string(),
            max_teleports: 1,
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
