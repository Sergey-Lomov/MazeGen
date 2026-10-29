use super::teleport_count_core::{
    distinct_teleport_representatives, distinct_teleport_representatives_per_floor,
};
use crate::Maze;
use crate::graph::cycles::rounded_excess_over_density;
use crate::ids::EdgeId;
use crate::quality_control::check::Check;
use crate::quality_control::floor_group::floor_point_count;
use crate::quality_control::{
    FloorScope, InvalidTeleportGroupIssue, TeleportDirectionFilter, TeleportFloorKindFilter,
};
use crate::space::{LevelId, Tessellation};
use rand::RngCore;
use std::collections::HashMap;

pub const MAX_TELEPORT_DENSITY_DEFAULT: f64 = 30.0;
pub const MAX_TELEPORT_DENSITY_DEFAULT_FLOOR_SCOPE: FloorScope = FloorScope::PerFloor;
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
///
/// `floor_scope` (mirrors `MinTeleportRatioCheck`'s own): under `PerFloor`, `max_density` is
/// evaluated independently per floor (a teleport crossing floors counts toward both) and each
/// over-budget floor's own portals/excess form their own independent group — same rationale as
/// `MaxSplitDensityCheck`'s `PerFloor` branch.
pub struct MaxTeleportDensityCheck {
    pub instance_id: String,
    pub max_density: f64,
    pub floor_scope: FloorScope,
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
        let groups: Vec<(Vec<EdgeId>, u32)> = match self.floor_scope {
            FloorScope::WholeMaze => {
                let field_cells = maze.field.cell_count();
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
            }
            FloorScope::PerFloor => {
                let mut per_floor: HashMap<LevelId, Vec<EdgeId>> =
                    distinct_teleport_representatives_per_floor(
                        maze,
                        self.direction,
                        self.floor_kind,
                    );
                let mut over_budget: Vec<(LevelId, u32)> = per_floor
                    .iter()
                    .filter_map(|(&level, ids)| {
                        let field_cells = floor_point_count(&maze.field, level);
                        let n = Self::to_remove_for(ids.len(), field_cells, self.max_density);
                        (n > 0).then_some((level, n))
                    })
                    .collect();
                if over_budget.is_empty() {
                    return;
                }
                // `HashMap` iteration order is randomized per run -- sort by level so repair
                // strategies that loop over `issue.groups` consume RNG in a deterministic order.
                over_budget.sort_by_key(|&(level, _)| level);
                over_budget
                    .into_iter()
                    .filter_map(|(level, to_remove)| {
                        per_floor.remove(&level).map(|ids| (ids, to_remove))
                    })
                    .collect()
            }
        };

        let mut issue = InvalidTeleportGroupIssue::new_from_check(&self.instance_id, groups)
            .with_detail(
                &self.instance_id,
                "max_teleport_density",
                self.max_density.to_string(),
            );
        if self.floor_scope != FloorScope::WholeMaze {
            issue = issue.with_detail(
                &self.instance_id,
                "floor_scope",
                self.floor_scope.as_str().to_string(),
            );
        }
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
    use crate::space::{Field, MultiLevelField, SquarePoint, SquareTessellation, square_rect};
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
            floor_scope: FloorScope::WholeMaze,
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
            floor_scope: FloorScope::WholeMaze,
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
            floor_scope: FloorScope::WholeMaze,
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
            floor_scope: FloorScope::WholeMaze,
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
            floor_scope: FloorScope::WholeMaze,
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
            floor_scope: FloorScope::WholeMaze,
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

    /// Each floor is 10 field cells; `bottom_count`/`top_count` teleports.
    fn maze_with_teleports_on_two_floors(
        bottom_count: usize,
        top_count: usize,
    ) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let bottom = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(10, 1), &mut ids).unwrap(),
        );
        let top = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(10, 1), &mut ids).unwrap(),
        );
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let pb = |x: i32| mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
        let pt = |x: i32| mf.node_at(top, SquarePoint { x, y: 0 }).unwrap();
        for i in 0..bottom_count as i32 {
            g.add_edge(pb(i * 2), pb(i * 2 + 1), EdgeKind::Teleport);
        }
        for i in 0..top_count as i32 {
            g.add_edge(pt(i * 2), pt(i * 2 + 1), EdgeKind::Teleport);
        }
        Maze::new(mf, g)
    }

    #[test]
    fn per_floor_flags_each_over_budget_floor_with_its_own_group_and_to_remove() {
        // Bottom: 3/10 = 30% density (to_remove 1 to reach 20%). Top: 4/10 = 40% (to_remove 2).
        let maze = maze_with_teleports_on_two_floors(3, 4);
        let check = MaxTeleportDensityCheck {
            instance_id: TEST_ID.to_string(),
            max_density: 20.0,
            floor_scope: FloorScope::PerFloor,
            direction: TeleportDirectionFilter::Any,
            floor_kind: TeleportFloorKindFilter::Any,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        let mut groups = issues[0].groups.clone();
        groups.sort_by_key(|(g, _)| g.len());
        assert_eq!(
            groups.len(),
            2,
            "each over-budget floor must get its own independent group"
        );
        assert_eq!(groups[0].0.len(), 3, "bottom floor's own teleports only");
        assert_eq!(
            groups[0].1, 1,
            "bottom floor's own to_remove, not the max across floors"
        );
        assert_eq!(groups[1].0.len(), 4, "top floor's own teleports only");
        assert_eq!(
            groups[1].1, 2,
            "top floor's own to_remove, not the max across floors"
        );
    }

    #[test]
    fn non_any_filters_are_recorded_as_details() {
        let maze = maze_with_teleports(3);
        let check = MaxTeleportDensityCheck {
            instance_id: TEST_ID.to_string(),
            max_density: 10.0,
            floor_scope: FloorScope::WholeMaze,
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
            floor_scope: FloorScope::WholeMaze,
            direction: TeleportDirectionFilter::Any,
            floor_kind: TeleportFloorKindFilter::Any,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        let details = issues[0].details().get(TEST_ID).unwrap();
        assert!(details.get("teleport_direction").is_none());
        assert!(details.get("teleport_floor_kind").is_none());
        assert!(
            details.get("floor_scope").is_none(),
            "WholeMaze is not the default -- but WholeMaze still must not be recorded"
        );
    }

    #[test]
    fn per_floor_scope_is_recorded_as_a_detail() {
        let maze = maze_with_teleports_on_two_floors(3, 4);
        let check = MaxTeleportDensityCheck {
            instance_id: TEST_ID.to_string(),
            max_density: 20.0,
            floor_scope: FloorScope::PerFloor,
            direction: TeleportDirectionFilter::Any,
            floor_kind: TeleportFloorKindFilter::Any,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        let details = issues[0].details().get(TEST_ID).unwrap();
        assert_eq!(details.get("floor_scope"), Some(&"per_floor".to_string()));
    }
}
