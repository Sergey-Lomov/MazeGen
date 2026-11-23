use crate::Maze;
use crate::ids::EdgeId;
use crate::quality_control::InvalidOneWayGroupIssue;
use crate::quality_control::check::Check;
use crate::quality_control::checks::one_way_core::one_way_edge_ids;
use crate::space::Tessellation;
use rand::RngCore;

pub const MAX_ONE_WAY_RATIO_DEFAULT: f64 = 100.0;

/// Flags an excess against the share of one-way passage edges (`EdgeKind::Basic`, single
/// direction) relative to the field's size — see GitHub issue #202, part of the one-way
/// management epic (#92). Symmetric counterpart to `MinOneWayRatioCheck` (issue #201): same
/// "one-ways per 100 field cells" normalization (via `maze.scoped_cell_count()`, not a share of
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
    pub max_ratio: f64,
}

impl<T: Tessellation> Check<T, InvalidOneWayGroupIssue> for MaxOneWayRatioCheck {
    fn check_type_id(&self) -> &'static str {
        "max_one_way_ratio"
    }
    fn is_batch_edge_group(&self) -> bool {
        true
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidOneWayGroupIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let one_ways: Vec<EdgeId> = one_way_edge_ids(maze);
        let max_ratio = self.max_ratio;

        let (group, to_remove) = {
            let field_cells = maze.scoped_cell_count() as u64;
            if field_cells == 0 {
                return;
            }
            let count = one_ways.len() as u64;
            match Self::to_remove_for(count, field_cells, max_ratio) {
                0 => return,
                n => (one_ways, n),
            }
        };

        let issue =
            InvalidOneWayGroupIssue::new_from_check(&self.instance_id, vec![(group, to_remove)])
                .with_detail(&self.instance_id, "max_ratio", self.max_ratio.to_string());
        issues.push(issue);
    }
}

impl MaxOneWayRatioCheck {
    /// Excess one-way count for one region given its own one-way count
    /// and cell count.
    fn to_remove_for(count: u64, field_cells: u64, max_ratio: f64) -> u32 {
        if field_cells == 0 || count as f64 * 100.0 <= max_ratio * field_cells as f64 {
            return 0;
        }
        // Round-to-nearest can push target_count above count on a small enough field (rounding
        // error can exceed the margin the exact gate above guarantees) -- saturating_sub keeps
        // the result at 0 rather than underflowing in that edge case.
        let target_count = (max_ratio * field_cells as f64 / 100.0).round() as u64;
        count.saturating_sub(target_count) as u32
    }
}

#[cfg(test)]
#[path = "max_one_way_ratio_tests.rs"]
mod tests;
