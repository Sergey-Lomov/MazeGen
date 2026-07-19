use rand::RngCore;
use crate::Maze;
use crate::graph::EdgeKind;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::InvalidOneWayGroupIssue;

pub const MAX_ONE_WAY_COUNT_DEFAULT: u32 = 1_000;

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
}

impl<T: Tessellation> Check<T, InvalidOneWayGroupIssue> for MaxOneWayCountCheck {
    fn check_type_id(&self) -> &'static str { "max_one_way_count" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidOneWayGroupIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        // Same kind-filtered reverse lookup as MinOneWayCountCheck/OneWayWaypointDistanceCheck.
        let one_ways: Vec<_> = maze.graph.edges()
            .filter(|e| e.kind == EdgeKind::Basic)
            .filter(|e| maze.graph.edge_between_kind(e.to, e.from, &EdgeKind::Basic).is_none())
            .map(|e| e.id)
            .collect();

        let count = one_ways.len() as u32;
        if count <= self.max_one_ways {
            return;
        }

        let to_remove = count - self.max_one_ways;
        let issue = InvalidOneWayGroupIssue::new_from_check(&self.instance_id, vec![(one_ways, to_remove)])
            .with_detail(&self.instance_id, "max_one_ways", self.max_one_ways.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
#[path = "max_one_way_count_tests.rs"]
mod tests;
