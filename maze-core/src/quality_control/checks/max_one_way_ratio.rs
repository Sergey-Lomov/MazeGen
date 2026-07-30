use rand::RngCore;
use crate::Maze;
use crate::graph::EdgeKind;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::InvalidOneWayGroupIssue;

pub const MAX_ONE_WAY_RATIO_DEFAULT: u32 = 100;

/// Flags an excess against the share of one-way passage edges (`EdgeKind::Basic`, single
/// direction) relative to the field's size — see GitHub issue #202, part of the one-way
/// management epic (#92). Symmetric counterpart to `MinOneWayRatioCheck` (issue #201): same
/// "one-ways per 100 field cells" normalization (via `maze.field.point_count()`, not a share of
/// the total edge count), just the excess side of the threshold rather than the deficit side.
/// Mirrors `MaxOneWayCountCheck`'s "single group, whole one-way edge set" reporting shape:
/// `to_remove` (GitHub issue #202 follow-up) is `count - target_count`, where `target_count` is
/// `max_ratio * field_cells / 100` rounded to the nearest integer (`(max_ratio * field_cells + 50)
/// / 100` in integer arithmetic) — round-to-nearest, not floor/ceil, so a fractional target count
/// (e.g. 3.92) resolves to the intuitively "closest" edge count (4) rather than always rounding
/// down; see GitHub issue #202 follow-up review for the reasoning.
///
/// The excess *gate* itself (`count * 100` vs `max_ratio * field_cells`, cross-multiplied instead
/// of computing an intermediate `count * 100 / field_cells` ratio) is a separate fix from the
/// `target_count` rounding above: the intermediate division floors, which can wrongly stay silent
/// on a ratio that's actually just over the maximum (e.g. a true 30.9% floors to 30%, comparing
/// fine against a maximum of 30% it actually exceeds). Comparing the cross-multiplied products is
/// exact. (Follow-up fix alongside GitHub issue #211's `MinTeleportRatioCheck`, which shares this
/// exact bug via copy-paste from `MinOneWayRatioCheck`.)
pub struct MaxOneWayRatioCheck {
    pub instance_id: String,
    pub max_ratio: u32,
}

impl<T: Tessellation> Check<T, InvalidOneWayGroupIssue> for MaxOneWayRatioCheck {
    fn check_type_id(&self) -> &'static str { "max_one_way_ratio" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidOneWayGroupIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let field_cells = maze.field.point_count() as u64;
        if field_cells == 0 {
            return;
        }

        // Same kind-filtered reverse lookup as MaxOneWayCountCheck/MinOneWayRatioCheck.
        let one_ways: Vec<_> = maze.graph.edges()
            .filter(|e| e.kind == EdgeKind::Basic)
            .filter(|e| maze.graph.edge_between_kind(e.to, e.from, &EdgeKind::Basic).is_none())
            .map(|e| e.id)
            .collect();

        let count = one_ways.len() as u64;
        let max_ratio = self.max_ratio as u64;
        if count * 100 <= max_ratio * field_cells {
            return;
        }

        // Round-to-nearest can push target_count above count on a small enough field (rounding
        // error can exceed the margin the exact gate above guarantees) -- saturating_sub keeps
        // to_remove at 0 rather than underflowing in that edge case.
        let target_count = (max_ratio * field_cells + 50) / 100;
        let to_remove = count.saturating_sub(target_count) as u32;
        if to_remove == 0 {
            return;
        }
        let issue = InvalidOneWayGroupIssue::new_from_check(&self.instance_id, vec![(one_ways, to_remove)])
            .with_detail(&self.instance_id, "max_ratio", self.max_ratio.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
#[path = "max_one_way_ratio_tests.rs"]
mod tests;
