use std::collections::{HashMap, HashSet};
use rand::RngCore;
use crate::Maze;
use crate::graph::EdgeKind;
use crate::ids::EdgeId;
use crate::space::{LevelId, Tessellation};
use crate::quality_control::check::Check;
use crate::quality_control::{InvalidOneWayGroupIssue, FloorScope};
use crate::quality_control::floor_group::floors_of_edge;

pub const MAX_ONE_WAY_COUNT_DEFAULT: u32 = 1_000;
pub const MAX_ONE_WAY_COUNT_DEFAULT_FLOOR_SCOPE: FloorScope = FloorScope::WholeMaze;

/// Flags an excess against a raw count of one-way passage edges (`EdgeKind::Basic`, single
/// direction) — see GitHub issue #202, part of the one-way management epic (#92). Symmetric
/// counterpart to `MinOneWayCountCheck` (issue #201), but the excess case gets its own issue
/// kind rather than reusing `MissingOneWaysIssue` via a comparison flip — removing an excess
/// one-way is a different corrective action (convert to bidirectional/wall) from adding one,
/// same rationale as `RegionNeedsExpansion`/`RegionNeedsShrink`. All flagged one-ways are reported
/// as a single group (the whole maze's one-way edge set) paired with the excess count as
/// `to_remove` (GitHub issue #202 follow-up) — see `InvalidOneWayGroupIssue`'s/`OneWayGroup`'s doc
/// comments: the strategy, not the check, decides which edges within the group are the ones
/// actually fixed. `OneWayGroupSelectStrategy` (registered against `INVALID_ONE_WAY_GROUP`)
/// already handles groups of any size and already applies its own `protect_route` exclusion when
/// picking a candidate — this check carries no `protect_route` of its own, same as
/// `OneWayGroupSuperHubCheck`.
pub struct MaxOneWayCountCheck {
    pub instance_id: String,
    pub max_one_ways: u32,
    pub floor_scope: FloorScope,
}

impl<T: Tessellation> Check<T, InvalidOneWayGroupIssue> for MaxOneWayCountCheck {
    fn check_type_id(&self) -> &'static str { "max_one_way_count" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidOneWayGroupIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        // Same kind-filtered reverse lookup as MinOneWayCountCheck/OneWayWaypointDistanceCheck.
        let one_ways: Vec<EdgeId> = maze.graph.edges()
            .filter(|e| e.kind == EdgeKind::Basic)
            .filter(|e| maze.graph.edge_between_kind(e.to, e.from, &EdgeKind::Basic).is_none())
            .map(|e| e.id)
            .collect();

        // Under `PerFloor` the whole group is reported (and `to_remove` computed) against
        // whichever floor is over budget -- a one-way crossing floors counts toward, and can be
        // flagged by, every floor it touches (GitHub issue #369).
        let (group, to_remove) = match self.floor_scope {
            FloorScope::WholeMaze => {
                let count = one_ways.len() as u32;
                if count <= self.max_one_ways {
                    return;
                }
                (one_ways, count - self.max_one_ways)
            }
            FloorScope::PerFloor => {
                let mut per_floor_count: HashMap<LevelId, u32> =
                    maze.field.levels_ordered().map(|l| (l, 0)).collect();
                let one_way_floors: Vec<_> = one_ways.iter()
                    .map(|&id| floors_of_edge(&maze.field, &maze.graph, id))
                    .collect();
                for floors in &one_way_floors {
                    for &level in floors {
                        *per_floor_count.entry(level).or_insert(0) += 1;
                    }
                }
                let over_budget: HashSet<LevelId> = per_floor_count.iter()
                    .filter(|&(_, &count)| count > self.max_one_ways)
                    .map(|(&level, _)| level)
                    .collect();
                if over_budget.is_empty() {
                    return;
                }
                // A one-way edge can span multiple floors and thus belong to more than one
                // over-budget floor's group at once -- each over-budget floor gets its own
                // independent group with its own excess count, rather than one merged group with
                // a single (e.g. max) excess, so a repair strategy resolving one floor's excess
                // doesn't silently satisfy a different floor's quota (or leave it unresolved).
                let mut groups: Vec<(Vec<EdgeId>, u32)> = Vec::new();
                for &level in &over_budget {
                    let excess = per_floor_count[&level] - self.max_one_ways;
                    let flagged: Vec<EdgeId> = one_ways.iter().zip(&one_way_floors)
                        .filter(|(_, floors)| floors.contains(&level))
                        .map(|(&id, _)| id)
                        .collect();
                    groups.push((flagged, excess));
                }
                let issue = InvalidOneWayGroupIssue::new_from_check(&self.instance_id, groups)
                    .with_detail(&self.instance_id, "max_one_ways", self.max_one_ways.to_string());
                issues.push(issue);
                return;
            }
        };

        let issue = InvalidOneWayGroupIssue::new_from_check(&self.instance_id, vec![(group, to_remove)])
            .with_detail(&self.instance_id, "max_one_ways", self.max_one_ways.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
#[path = "max_one_way_count_tests.rs"]
mod tests;
